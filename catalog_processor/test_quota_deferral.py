"""Regression: Gemini quota exhaustion must not destroy extracted images.

The production failure this covers: a catalog run extracts images fine,
Gemini hits its rate limit partway through, and every remaining image is
logged "REJECTED -- validation could not run" and then DELETED. The tiles
were real; only the classifier was missing.

What must hold instead:

  quota exhausted  ->  image file SURVIVES, status REVIEW_REQUIRED,
                       listed in a manifest, NOT published to the catalog
  quota available  ->  unchanged: tiles approved, non-tiles rejected
                       and their files deleted

The second half matters as much as the first. A "fix" that keeps every
image by weakening validation would pass the first assertions and ruin the
catalog, so this runs the same PDF twice -- once with Gemini answering and
once with Gemini refusing -- and checks both outcomes.

Run:  GEMINI_API_KEY=test python3 test_quota_deferral.py
"""

import json
import os
import shutil
import sys
from pathlib import Path

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-used")

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fitz  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import app.gemini_service as gemini_service  # noqa: E402
import main_step6_complete as pipeline  # noqa: E402
from app.image_validator import (  # noqa: E402
    assess_tile_purity,
    validate_bbox,
    validate_product_decision,
)


OUT = Path(__file__).resolve().parent / "output" / "quota_deferral_test"

TILE_A = (198, 188, 172)
TILE_B = (178, 168, 152)
GROUT = (118, 110, 98)


def build_tile_photo(width=760, height=760):
    canvas = np.zeros((height, width, 3), dtype=np.uint8)
    for y in range(height):
        for x in range(width):
            if x % 95 < 7 or y % 95 < 7:
                canvas[y, x] = GROUT
            else:
                canvas[y, x] = TILE_A if ((x // 95) + (y // 95)) % 2 == 0 else TILE_B
    return Image.fromarray(canvas, "RGB")


def build_logo(width=700, height=420):
    canvas = np.full((height, width, 3), 250, dtype=np.uint8)
    canvas[170:250, 80:620] = (190, 40, 40)
    return Image.fromarray(canvas, "RGB")


def build_pdf(path):
    document = fitz.open()

    page = document.new_page(width=595, height=842)
    page.insert_text((60, 70), "EXOTICA DECOTECH", fontsize=20)
    page.insert_text((60, 96), "Statuario Gold  600x1200mm", fontsize=11)
    tile = OUT / "_src_tile.png"
    build_tile_photo().save(tile)
    page.insert_image(fitz.Rect(60, 120, 460, 520), filename=str(tile))

    page = document.new_page(width=595, height=842)
    page.insert_text((60, 70), "BRAND MARK", fontsize=20)
    logo = OUT / "_src_logo.png"
    build_logo().save(logo)
    page.insert_image(fitz.Rect(60, 120, 460, 360), filename=str(logo))

    document.save(str(path))
    document.close()


class Analysis:
    def __init__(self, image_type, is_product, decision, name="", confidence=0.9,
                 reason=""):
        self.image_type = image_type
        self.is_product_image = is_product
        self.decision = decision
        self.confidence = confidence
        self.product_name = name
        self.product_bbox = None
        self.reason = reason


def install(mode):
    """mode 'live' answers normally; mode 'quota' refuses everything."""
    gemini_service.GEMINI_QUOTA_EXHAUSTED = (mode == "quota")

    def analyze(image_path, page_text=""):
        if mode == "quota":
            # Exactly what analyze_product_image returns once
            # _generate_content_safe starts handing back None.
            return Analysis(
                "UNKNOWN", False, "REVIEW", confidence=0.0,
                reason=("Gemini analysis unavailable because the API quota "
                        "or rate limit was reached. Image requires "
                        "retry/review."),
            )

        name = Path(image_path).name
        if "page_2" in name:
            return Analysis("LOGO", False, "REJECTED", confidence=0.95,
                            reason="brand mark, not a product")
        return Analysis("TILE_SAMPLE", True, "APPROVED", "Statuario Gold", 0.94,
                        reason="standalone tile product")

    pipeline.load_semantic_tile_validator = lambda: (
        analyze, validate_product_decision, validate_bbox,
    )

    # Purity runs on whatever the classifier approves. Under quota it is
    # never reached (nothing gets approved), and it is quota-bound itself,
    # so it reports "no verdict" for the same reason.
    def purity(image_path):
        if mode == "quota":
            return None
        return {
            "tile_fraction": 1.0,
            "material": "TILE",
            "contains_person": False,
            "contains_text": False,
            "contains_logo": False,
            "contains_furniture": False,
            "contains_fixture": False,
            "contains_object": False,
            "is_scene": False,
            "reason": "synthetic tile grid",
        }

    pipeline.load_tile_purity_verifier = lambda: (purity, assess_tile_purity)
    # Region mining is irrelevant here and would need cv2 + a detector;
    # switching it off keeps this test about the quota path only.
    pipeline.load_tile_region_miner = lambda: None


def run(mode):
    directory = OUT / mode
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True, exist_ok=True)

    install(mode)
    images = pipeline.extract_images_from_pdf(OUT / "exotica.pdf", directory)
    return images, directory


def check(label, condition, detail=""):
    mark = "PASS" if condition else "FAIL"
    print(f"  [{mark}] {label}" + (f" -- {detail}" if detail else ""))
    return bool(condition)


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)
    build_pdf(OUT / "exotica.pdf")

    results = []

    print("=" * 72)
    print("RUN 1 -- Gemini available (existing behaviour must be unchanged)")
    print("=" * 72)
    live_images, live_dir = run("live")

    print("")
    results.append(check(
        "the real tile is accepted", len(live_images) == 1,
        f"{len(live_images)} accepted",
    ))
    results.append(check(
        "the logo is still rejected",
        all("page_2" not in r["filename"] for r in live_images),
    ))
    results.append(check(
        "rejected logo's file is deleted",
        not list(live_dir.glob("*page_2*.webp")),
    ))
    results.append(check(
        "nothing deferred when Gemini answers",
        not (live_dir / pipeline.DEFERRED_DIRECTORY_NAME).exists(),
    ))
    results.append(check(
        "accepted tile carries its product name",
        all(r["product_name"] == "Statuario Gold" for r in live_images),
    ))

    print("")
    print("=" * 72)
    print("RUN 2 -- Gemini quota exhausted")
    print("=" * 72)
    quota_images, quota_dir = run("quota")

    review_dir = quota_dir / pipeline.DEFERRED_DIRECTORY_NAME
    preserved = sorted(review_dir.glob("*.webp")) if review_dir.exists() else []
    manifest_files = sorted(review_dir.glob("*_deferred.json")) if review_dir.exists() else []

    print("")
    results.append(check(
        "extracted image files SURVIVE quota exhaustion",
        len(preserved) == 2, f"{len(preserved)} preserved",
    ))
    results.append(check(
        "preserved files are real, non-empty images",
        all(p.stat().st_size > 0 for p in preserved) and bool(preserved),
    ))
    results.append(check(
        "nothing is published to the catalog unvalidated",
        len(quota_images) == 0, f"{len(quota_images)} would have been published",
    ))
    results.append(check(
        "a revalidation manifest is written", len(manifest_files) == 1,
    ))

    if manifest_files:
        manifest = json.loads(manifest_files[0].read_text())
        results.append(check(
            "manifest uses the project's REVIEW_REQUIRED status",
            manifest["status"] == "REVIEW_REQUIRED", manifest["status"],
        ))
        results.append(check(
            "manifest records page + image slot for each deferred image",
            all(
                isinstance(entry.get("page"), int)
                and isinstance(entry.get("image_index"), int)
                for entry in manifest["images"]
            ),
        ))
        results.append(check(
            "manifest explains why, without calling it a rejection",
            all("quota" in entry["reason"].lower() for entry in manifest["images"])
            and "not rejected" in manifest["reason"].lower(),
        ))
        results.append(check(
            "every manifest path exists on disk",
            all(Path(entry["path"]).is_file() for entry in manifest["images"]),
        ))

    results.append(check(
        "no image was left in the extraction folder unaccounted for",
        not list(quota_dir.glob("*.webp")),
    ))

    print("")
    print("Preserved for revalidation:")
    for path in preserved:
        with Image.open(path) as opened:
            print(f"  {path.name}  {opened.width}x{opened.height}")

    results.extend(detection_quota_check())

    passed = sum(1 for r in results if r)
    print("")
    print(f"{passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


def detection_quota_check():
    """Quota dying during REGION DETECTION must not read as 'no tile'.

    The classification path already treated a dead quota as deferred.
    Detection did not: _generate_content_safe returns None the moment
    the quota flag trips, detect_tile_regions turns that into [], and
    the page was dropped with no file and no record -- indistinguishable
    in the log from a page that genuinely has no tile on it. On a real
    catalog that silently lost every page after the quota ran out.
    """
    print("")
    print("=" * 72)
    print("RUN 3 -- quota dies during region DETECTION")
    print("=" * 72)

    directory = OUT / "detection_quota"
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True, exist_ok=True)

    source = directory / "onery_page_5_render.webp"
    build_tile_photo().save(source, "WEBP", quality=92, method=6)

    gemini_service.GEMINI_QUOTA_EXHAUSTED = True

    # Exactly what detect_tile_regions does with a None response.
    accepted, deferred = pipeline.mine_tile_regions(
        source, 5, 0, [], None,
        (lambda *a, **k: None, validate_product_decision, validate_bbox),
        (lambda path, width, height: [], lambda *a, **k: (None, {})),
        directory,
        source_type="rendered-page",
    )

    records = []
    preserved = None
    for path, reason, metadata in deferred:
        preserved = pipeline.defer_for_revalidation(
            path, 5, 0, reason, metadata, directory, records,
        )

    gemini_service.GEMINI_QUOTA_EXHAUSTED = False

    print("")
    outcomes = [
        check("the page is deferred, not silently dropped", len(deferred) == 1,
              f"{len(deferred)} deferred"),
        check("nothing is published from an unsearched page",
              len(accepted) == 0),
        check("the page image survives on disk",
              preserved is not None and preserved.is_file(),
              str(preserved)),
        check("the source file is not left behind in the output folder",
              not source.exists()),
        check("the reason names the quota, not the tile",
              bool(deferred) and "quota" in deferred[0][1].lower()
              and "no tile" not in deferred[0][1].lower(),
              deferred[0][1] if deferred else ""),
        check("a revalidation record is written", len(records) == 1),
    ]
    return outcomes


if __name__ == "__main__":
    raise SystemExit(main())
