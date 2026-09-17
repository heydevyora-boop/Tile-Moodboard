"""Regression: no detected candidate may leave a page without a status.

THE FAILURE THIS COVERS
-----------------------
A page detected nine product surfaces and the run reported on five. The
other four did not appear anywhere -- not as rejections, not as
duplicates, not as errors. They were simply absent, and absence is the
one outcome you cannot debug: "which stage lost it?" had no answer for
exactly the candidates most likely to have been lost.

The tally was the reason. It read:

    len(regions) - len(accepted) - len(deferred)  ->  "rejected"

`regions` had already been reassigned to the SHORTENED, post-dedup list,
and "rejected" was derived by subtraction rather than counted. That
arithmetic cannot disagree with itself: it reports a balanced page no
matter how many candidates vanished on the way, because the missing ones
were removed from both sides of the equation.

So the fix is not a bigger number, it is a different kind of number.
Every candidate's status is RECORDED as it happens and the statuses are
added back up against what the detector found:

    accepted + rejected + duplicate + failed + deferred == detected

WHAT THIS TEST ACTUALLY CHECKS
------------------------------
It runs the real mine_tile_regions over a synthetic page built to
produce one of each outcome at once -- an accept, a rule rejection, a
geometric rejection, an exact duplicate and a save failure -- then reads
the accounting line out of the run's own stdout and does the addition.

A test that only counted accepted swatches would have passed throughout
the bug. This one fails if any candidate goes unaccounted for, which is
the property that was actually missing.

Run:  GEMINI_API_KEY=test python3 test_candidate_accounting.py
"""

import io
import os
import re
import shutil
import sys
from contextlib import redirect_stdout
from pathlib import Path

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-used")

# These checks are about the STRICT gates -- what rejects a room photo, a
# countertop, a logo, a printed graphic. Those gates still exist and still
# decide every catalog that has not been pre-filtered, but they are
# deliberately advisory under CATALOG_TILE_ONLY (see main_step6_complete),
# which now defaults on. Pinned off here so this suite keeps testing the
# rules it was written for whatever the environment's default is;
# test_tile_only_mode.py is where the other mode is covered.
os.environ["CATALOG_TILE_ONLY"] = "0"

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import main_step6_complete as pipeline  # noqa: E402
from app.image_validator import (  # noqa: E402
    validate_bbox,
    validate_product_decision,
)
from app.tile_region_extractor import extract_tile_region  # noqa: E402

OUT = Path(__file__).resolve().parent / "output" / "accounting_test"

TILE_A = (198, 188, 172)
TILE_B = (176, 166, 150)
GROUT = (112, 104, 92)

PAGE_W, PAGE_H = 1200, 800


class FakeClassification:
    def __init__(self, image_type, is_product, product_name="", confidence=0.9):
        self.image_type = image_type
        self.is_product_image = is_product
        self.product_name = product_name
        self.confidence = confidence
        self.decision = "APPROVED" if is_product else "REJECTED"
        self.bbox = None
        self.product_bbox = None
        self.size_text = ""


def tile_patch(width, height, cell=26, tint=0):
    """A synthetic tile grid. `tint` shifts the colours so two patches
    with different tints do NOT read as the same surface."""
    canvas = np.zeros((height, width, 3), dtype=np.uint8)
    a = tuple(max(0, min(255, c + tint)) for c in TILE_A)
    b = tuple(max(0, min(255, c + tint)) for c in TILE_B)
    for y in range(height):
        for x in range(width):
            if x % cell < 5 or y % cell < 5:
                canvas[y, x] = GROUT
            else:
                canvas[y, x] = a if ((x // cell) + (y // cell)) % 2 == 0 else b
    return canvas


def build_page(path):
    """A page carrying four visually distinct product patches.

    Distinct in cell size AND colour, so the content-aware dedup reads
    them as four surfaces rather than one repeated one -- otherwise this
    test would be measuring dedup, not accounting.
    """
    page = np.full((PAGE_H, PAGE_W, 3), 244, dtype=np.uint8)
    page[80:400, 60:460] = tile_patch(400, 320, cell=26, tint=0)
    page[80:400, 520:920] = tile_patch(400, 320, cell=34, tint=26)
    page[460:740, 60:460] = tile_patch(400, 280, cell=18, tint=52)
    page[460:740, 520:920] = tile_patch(400, 280, cell=44, tint=-40)
    Image.fromarray(page, "RGB").save(path, "WEBP", quality=92, method=6)


def quad(x1, y1, x2, y2):
    """Corner pixels, in the shape detect_tile_regions hands downstream."""
    return [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]


def region(x1, y1, x2, y2, surface="SAMPLE", confidence=0.9):
    return {
        "surface": surface,
        "confidence": confidence,
        "quad": quad(x1, y1, x2, y2),
        "occluders": [],
        "coordinate_space": "unit",
    }


# The detector's report. Six candidates, engineered so that between them
# they take four different exits out of the candidate loop plus the
# pre-loop dedup -- one of every status the accounting can record except
# DEFERRED (which test_quota_deferral.py owns).
DETECTED = [
    # 1 -> accepted
    region(60, 80, 460, 400),
    # 2 -> accepted (a different design, so not a duplicate of 1)
    region(520, 80, 920, 400),
    # 3 -> DUPLICATE: an all-but-exact re-report of candidate 2's surface,
    #      caught by the geometric dedup before the loop runs
    region(521, 81, 919, 399),
    # 4 -> FAILED: a real surface whose save is made to raise
    region(60, 460, 460, 740),
    # 5 -> REJECTED: degenerate geometry, no pixels to crop
    region(200, 200, 201, 201),
    # 6 -> REJECTED: a real surface the purity rule turns down
    region(520, 460, 920, 740, surface="WALL"),
]

EXPECTED_DETECTED = len(DETECTED)

# Candidate 3 is removed by dedup, so the loop sees 1, 2, 4, 5, 6 and
# numbers them 1..5. These two names are what that renumbering makes of
# candidate 4 (the save failure) and candidate 6 (the rule rejection).
SAVE_FAILURE_FILE = "page_1_img_1_region_3.webp"
RULE_REJECTION_FILE = "page_1_img_1_region_5.webp"


def run_miner():
    """Runs mine_tile_regions over the page and returns its stdout."""
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)

    page_path = OUT / "page_1_img_1.webp"
    build_page(page_path)

    def fake_detect(image_path, width, height):
        return [dict(candidate) for candidate in DETECTED]

    def fake_analyze(image_path, page_text=""):
        return FakeClassification("TILE_SAMPLE", True, "Terra Grey", 0.93)

    # Keyed on the file, not on call order, so it stays correct whatever
    # order the loop reaches the candidates in.
    def fake_purity(image_path):
        material = (
            "COUNTERTOP" if Path(image_path).name == RULE_REJECTION_FILE
            else "TILE"
        )
        return {
            "tile_fraction": 1.0,
            "material": material,
            "contains_person": False,
            "contains_text": False,
            "contains_logo": False,
            "contains_furniture": False,
            "contains_fixture": False,
            "contains_object": False,
            "is_scene": False,
            "physical_surface": True,
            "distinct_tile_designs": 1,
            "reason": "synthetic",
        }

    import app.gemini_service as gemini_service
    real_verify = gemini_service.verify_tile_only
    gemini_service.verify_tile_only = fake_purity

    real_save = Image.Image.save

    def flaky_save(self, fp, *args, **kwargs):
        if Path(str(fp)).name == SAVE_FAILURE_FILE:
            raise OSError("encoder said no")
        return real_save(self, fp, *args, **kwargs)

    Image.Image.save = flaky_save

    # emit() deliberately writes to the process's ORIGINAL stdout so the
    # clean per-page hierarchy survives quiet_stage(), which means
    # redirect_stdout cannot see it. Collected separately, and both
    # streams are returned together -- the accounting line the operator
    # actually reads goes out through emit().
    captured = io.StringIO()
    real_emit = pipeline.emit
    pipeline.emit = lambda message="": captured.write(f"{message}\n")

    try:
        with redirect_stdout(captured):
            pipeline.mine_tile_regions(
                page_path,
                page_number=1,
                image_counter=1,
                text_spans=[],
                image_rect=None,
                semantic_validator=(
                    fake_analyze, validate_product_decision, validate_bbox,
                ),
                region_miner=(fake_detect, extract_tile_region),
                output_directory=OUT,
                source_type="rendered-page",
            )
    finally:
        Image.Image.save = real_save
        gemini_service.verify_tile_only = real_verify
        pipeline.emit = real_emit

    return captured.getvalue()


ACCOUNTING = re.compile(
    r"(\d+) detected = (\d+) accepted \+ (\d+) rejected \+ "
    r"(\d+) already extracted \+ (\d+) failed \+ (\d+) deferred"
)


def check(label, ok, detail=""):
    return (label, bool(ok), detail)


def main():
    output = run_miner()
    match = ACCOUNTING.search(output)

    results = []
    if match is None:
        results.append(check(
            "the run prints a candidate accounting line", False,
            "no accounting line in the output",
        ))
        print(output)
    else:
        detected, accepted, rejected, duplicate, failed, deferred = (
            int(value) for value in match.groups()
        )
        total = accepted + rejected + duplicate + failed + deferred

        results.append(check(
            "the run prints a candidate accounting line", True))
        results.append(check(
            f"detected matches what the detector reported "
            f"({detected} == {EXPECTED_DETECTED})",
            detected == EXPECTED_DETECTED,
        ))
        results.append(check(
            f"the statuses add up to what was detected "
            f"({accepted}+{rejected}+{duplicate}+{failed}+{deferred} "
            f"= {total} == {detected})",
            total == detected,
        ))
        results.append(check(
            "no ACCOUNTING MISMATCH was reported",
            "ACCOUNTING MISMATCH" not in output,
        ))

        # Each bucket has to be REACHED, not merely summed. A run where
        # everything landed in one bucket would satisfy the arithmetic
        # above while proving nothing about the other exits.
        results.append(check(
            f"at least one candidate was accepted ({accepted})", accepted >= 1))
        results.append(check(
            f"the geometric duplicate was counted as a duplicate ({duplicate})",
            duplicate >= 1))
        results.append(check(
            f"the unsaveable candidate was counted as failed, not rejected "
            f"({failed})",
            failed >= 1))
        results.append(check(
            f"rule and geometry rejections were counted as rejected "
            f"({rejected})",
            rejected >= 2))

        # A failure has to stay a failure in the wording too: "could not
        # be saved" describes an error, and calling it a rejection is how
        # a broken encoder gets mistaken for a catalog with fewer
        # products in it.
        results.append(check(
            "the failed candidate says it was a save error, not a verdict",
            "FAILED" in output and "could not be saved" in output,
        ))

    failures = sum(1 for _label, ok, *_ in results if not ok)
    print("")
    for label, ok, *rest in results:
        detail = rest[0] if rest else ""
        print(("  PASS  " if ok else "  FAIL  ") + label
              + (f"  [{detail}]" if detail and not ok else ""))

    print(f"\n{len(results) - failures}/{len(results)} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
