"""Regression: on a tile-only catalog, three tiles on a page become three.

THE FAILURE THIS COVERS
-----------------------
Straight off a real run, one page at a time:

    Page 1  detected 3  ->  0 accepted, 1 rejected, 2 duplicate
    Page 1  detected 3  ->  0 accepted, 0 rejected, 3 duplicate
    Page 2  detected 3  ->  1 accepted, 1 rejected, 1 duplicate

Page 1 showed three tiles and produced none. Two mechanisms did it, and
neither is the one the numbers appear to blame:

  1. The page's crop signature was recorded BEFORE the candidate had
     been judged. Candidate 1 was extracted, its signature filed, and
     the classifier then rejected it -- but the signature stayed. Its
     two neighbours, from the same range and so the same palette and
     texture, matched that signature and were dropped as "duplicates" of
     a swatch that was never saved. One rejection took the whole page
     down, and the page render afterwards (the second line) found three
     duplicates of nothing.

  2. Appearance was being used to compare a candidate with its own
     NEIGHBOURS on the same sheet. Three tiles laid out side by side are
     three distinct regions of one image; within a single source,
     coordinates decide what is the same surface, not how alike two
     tiles look. A base tile next to its matching highlighter is not a
     duplicate of it.

And behind both, the classifier was still a hard gate on a catalog whose
pages are prepared to contain nothing but products -- where a verdict of
"not a tile" cannot be true and can only delete one.

WHAT THIS TEST ACTUALLY CHECKS
------------------------------
The real mine_tile_regions, the real geometry, the real dedup. Only the
two Gemini calls are stubbed, and one of them is stubbed to REJECT a
valid tile -- because that is the input that caused the collapse.

Both routes are run over one page against a shared signature list,
exactly as extract_images_from_pdf does, so the cross-route behaviour
under test is the one that actually ships.

Run:  GEMINI_API_KEY=test python3 test_tile_only_mode.py
"""

import io
import os
import re
import shutil
import sys
from contextlib import redirect_stdout
from pathlib import Path

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-used")

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import app.gemini_service as gemini_service  # noqa: E402
import main_step6_complete as pipeline  # noqa: E402
from app.image_validator import (  # noqa: E402
    validate_bbox,
    validate_product_decision,
)
from app.tile_region_extractor import extract_tile_region  # noqa: E402

OUT = Path(__file__).resolve().parent / "output" / "tile_only_mode_test"

PAGE_W, PAGE_H = 1200, 900

# One RANGE: a single palette and texture family, the way a real
# collection sheet is laid out. This is the case that was collapsing --
# three products that look like each other because they are meant to.
GROUT = (118, 110, 98)
FAMILY = [
    ((201, 190, 173), (183, 173, 157)),   # base
    ((205, 193, 170), (186, 175, 154)),   # highlighter -- very close
    ((198, 188, 176), (180, 170, 160)),   # border      -- very close
]

# Where each product sits on the sheet. Three separate regions.
SLOTS = [
    (60, 80, 460, 420),
    (520, 80, 920, 420),
    (60, 470, 460, 810),
]


def tile_patch(width, height, colours, cell):
    light, dark = colours
    canvas = np.zeros((height, width, 3), dtype=np.uint8)
    for y in range(height):
        for x in range(width):
            if x % cell < 5 or y % cell < 5:
                canvas[y, x] = GROUT
            else:
                canvas[y, x] = (
                    light if ((x // cell) + (y // cell)) % 2 == 0 else dark
                )
    return canvas


def build_sheet(path):
    page = np.full((PAGE_H, PAGE_W, 3), 246, dtype=np.uint8)
    for (x1, y1, x2, y2), colours in zip(SLOTS, FAMILY):
        page[y1:y2, x1:x2] = tile_patch(x2 - x1, y2 - y1, colours, cell=28)
    Image.fromarray(page, "RGB").save(path, "WEBP", quality=92, method=6)


def quad(x1, y1, x2, y2):
    return [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]


def regions_for_slots():
    return [
        {
            "surface": "SAMPLE",
            "confidence": 0.9,
            "quad": quad(*slot),
            "occluders": [],
            "coordinate_space": "unit",
        }
        for slot in SLOTS
    ]


class Analysis:
    """The broad classifier. Not the gate under test -- see below."""

    def __init__(self, image_type="TILE_SAMPLE", is_product=True):
        self.image_type = image_type
        self.is_product_image = is_product
        self.decision = "APPROVED" if is_product else "REJECTED"
        self.confidence = 0.9
        self.product_name = "Range"
        self.product_bbox = None
        self.size_text = ""
        self.reason = ""


def purity(material="TILE", designs=1):
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
        "distinct_tile_designs": designs,
        "reason": "synthetic",
    }


ACCOUNTING = re.compile(
    r"(\d+) detected = (\d+) accepted \+ (\d+) rejected \+ "
    r"(\d+) duplicate \+ (\d+) failed \+ (\d+) deferred"
)


def run_page(tile_only, reject_first, second_route=True, purity_for=None,
             regions_override=None):
    """Searches ONE page by both routes, the way the pipeline does.

    Returns (accounting_per_route, accepted_paths).
    """
    directory = OUT / (
        f"{'tileonly' if tile_only else 'strict'}"
        f"_{'reject' if reject_first else 'clean'}"
    )
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True, exist_ok=True)

    embedded = directory / "sheet_page_1_image_1.webp"
    rendered = directory / "sheet_page_1_render.webp"
    build_sheet(embedded)
    build_sheet(rendered)

    rejected = {"done": False}

    def fake_purity(image_path):
        if purity_for is not None:
            return purity_for(image_path)
        if reject_first and not rejected["done"]:
            rejected["done"] = True
            # The verdict that started the collapse: a real tile the
            # classifier calls something else.
            return purity("ARCHITECTURE")
        return purity()

    real_verify = gemini_service.verify_tile_only
    real_flag = pipeline.TILE_ONLY_CATALOG
    gemini_service.verify_tile_only = fake_purity
    pipeline.TILE_ONLY_CATALOG = tile_only

    page_signatures = []
    accounting = []
    accepted_paths = []
    captured = io.StringIO()
    real_emit = pipeline.emit
    pipeline.emit = lambda message="": captured.write(f"{message}\n")

    try:
        with redirect_stdout(captured):
            routes = [(embedded, "embedded-image", 1)]
            if second_route:
                routes.append((rendered, "rendered-page", 0))

            for source_path, source_type, counter in routes:
                accepted, _deferred = pipeline.mine_tile_regions(
                    source_path,
                    page_number=1,
                    image_counter=counter,
                    text_spans=[],
                    image_rect=None,
                    semantic_validator=(
                        lambda path, page_text="": Analysis(),
                        validate_product_decision,
                        validate_bbox,
                    ),
                    region_miner=(
                        lambda path, width, height: [
                            dict(r) for r in (
                                regions_override or regions_for_slots()
                            )
                        ],
                        extract_tile_region,
                    ),
                    output_directory=directory,
                    source_type=source_type,
                    seen_signatures=page_signatures,
                )
                accepted_paths.extend(path for path, _r, _m in accepted)
    finally:
        gemini_service.verify_tile_only = real_verify
        pipeline.TILE_ONLY_CATALOG = real_flag
        pipeline.emit = real_emit

    for match in ACCOUNTING.finditer(captured.getvalue()):
        accounting.append(tuple(int(value) for value in match.groups()))

    return accounting, accepted_paths, captured.getvalue()


def check(label, ok, detail=""):
    return (label, bool(ok), detail)


def three_tiles_become_three():
    """The reported page, rerun. A rejection must not cost the page."""
    accounting, accepted, _log = run_page(tile_only=True, reject_first=True)

    route1 = accounting[0] if accounting else (0,) * 6
    route2 = accounting[1] if len(accounting) > 1 else (0,) * 6

    return [
        check("the sheet is searched by both routes", len(accounting) == 2,
              f"{len(accounting)} accounting line(s)"),
        check(f"route 1 detects all three products ({route1[0]})",
              route1[0] == 3),
        check(f"route 1 accepts all three ({route1[1]})", route1[1] == 3,
              f"{route1[1]} accepted, {route1[2]} rejected, "
              f"{route1[3]} duplicate"),
        check("a classifier rejection no longer eats its neighbours",
              route1[3] == 0, f"{route1[3]} called duplicate"),
        check(f"route 2 sees the same three tiles again as duplicates "
              f"({route2[3]})", route2[3] == 3,
              f"{route2[1]} accepted, {route2[3]} duplicate"),
        check("route 2 adds nothing new", route2[1] == 0),
        check(f"the page yields exactly three tiles ({len(accepted)})",
              len(accepted) == 3),
        check("all three output files exist and differ",
              len({path.read_bytes() for path in accepted}) == 3),
    ]


def siblings_are_not_duplicates_of_each_other():
    """The signature fix stands on its own, not on the mode flag.

    With every semantic gate restored, three products from one range
    must still be three candidates. If this fails the fix is only
    hiding behind tile-only mode.
    """
    accounting, accepted, _log = run_page(tile_only=False, reject_first=True)
    route1 = accounting[0] if accounting else (0,) * 6

    return [
        check("strict mode still detects three", route1[0] == 3),
        check("strict mode calls none of them a duplicate", route1[3] == 0,
              f"{route1[3]} called duplicate"),
        check("strict mode rejects exactly the one the classifier refused",
              route1[2] == 1, f"{route1[2]} rejected"),
        check("strict mode keeps the other two", len(accepted) == 2,
              f"{len(accepted)} kept"),
    ]


def the_classifier_cannot_delete_a_product():
    """Tile-only mode: every semantic verdict is advisory."""
    verdicts = ["ARCHITECTURE", "ARTWORK", "COUNTERTOP", "WOOD", "OTHER"]
    results = []

    for verdict in verdicts:
        accounting, accepted, _log = run_page(
            tile_only=True, reject_first=False, second_route=False,
            purity_for=lambda _path, v=verdict: purity(v),
        )
        route1 = accounting[0] if accounting else (0,) * 6
        results.append(check(
            f"a verdict of {verdict} costs no products",
            route1[1] == 3 and len(accepted) == 3,
            f"{route1[1]} accepted, {route1[2]} rejected",
        ))

    return results


def a_multi_product_frame_is_still_split():
    """The one verdict tile-only mode still acts on.

    "Several products in this frame" is not a claim that there is no
    tile -- it is a count, and the answer is to cut them apart. A mode
    that ignored it would save one picture of three products as one
    tile, which is the opposite of what this whole change is for.
    """
    # ONE region deliberately spanning TWO products, which is what a
    # detector that merged neighbours would hand over.
    merged = [{
        "surface": "SAMPLE",
        "confidence": 0.9,
        "quad": quad(60, 80, 920, 420),
        "occluders": [],
        "coordinate_space": "unit",
    }]

    accounting, accepted, log = run_page(
        tile_only=True, reject_first=False, second_route=False,
        purity_for=lambda _path: purity(designs=2),
        regions_override=merged,
    )
    route1 = accounting[0] if accounting else (0,) * 6

    # Whether the seam is findable is the splitter's business and is
    # tested elsewhere. What must hold HERE is that tile-only mode does
    # not wave a merged frame through as a single tile -- a picture of
    # two products saved as one product is the failure this rule exists
    # for, and the mode must not have disabled it.
    saved_whole = route1[1] == 1 and "splitting into" not in log

    return [
        check("a merged two-product frame is never saved as one tile",
              not saved_whole,
              "the frame was accepted whole"),
        check("the merged frame is either split or accounted for, "
              "never silently dropped",
              route1[0] == sum(route1[1:]),
              f"{route1[0]} detected, {sum(route1[1:])} accounted"),
        check("if it split, each piece was judged separately",
              ("splitting into" not in log) or len(accepted) >= 2,
              f"{len(accepted)} produced"),
    ]


def a_true_repeat_is_still_one_tile():
    """Duplicate safety must survive the fix.

    The same tile seen by both routes is ONE product. If this passes
    while the first group also passes, the pipeline is distinguishing
    "the same tile again" from "the tile next to it" -- which is the
    whole point.
    """
    accounting, accepted, _log = run_page(tile_only=True, reject_first=False)
    route2 = accounting[1] if len(accounting) > 1 else (0,) * 6

    signatures = set()
    for path in accepted:
        import cv2
        image = cv2.imread(str(path), cv2.IMREAD_COLOR)
        signatures.add(pipeline.crop_signature(image))

    return [
        check("the second route re-finds all three and adds none",
              route2[3] == 3 and route2[1] == 0,
              f"{route2[1]} accepted, {route2[3]} duplicate"),
        check("exactly three tiles survive the whole page",
              len(accepted) == 3, f"{len(accepted)}"),
        check("no two surviving tiles are the same image",
              len(signatures) == 3, f"{len(signatures)} distinct"),
    ]


def every_candidate_is_accounted_for():
    """No silent dropping, in either mode."""
    results = []
    for tile_only in (True, False):
        accounting, _accepted, log = run_page(
            tile_only=tile_only, reject_first=True,
        )
        for route, numbers in enumerate(accounting, start=1):
            detected, *buckets = numbers
            results.append(check(
                f"{'tile-only' if tile_only else 'strict'} route {route}: "
                f"{detected} detected = {sum(buckets)} accounted for",
                detected == sum(buckets),
            ))
        results.append(check(
            f"{'tile-only' if tile_only else 'strict'}: no accounting mismatch",
            "ACCOUNTING MISMATCH" not in log,
        ))
    return results


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)

    groups = [
        ("three tiles on a page become three tiles",
         three_tiles_become_three()),
        ("siblings in one range are not duplicates of each other",
         siblings_are_not_duplicates_of_each_other()),
        ("in tile-only mode the classifier cannot delete a product",
         the_classifier_cannot_delete_a_product()),
        ("a multi-product frame is still split",
         a_multi_product_frame_is_still_split()),
        ("a true cross-route repeat is still one tile",
         a_true_repeat_is_still_one_tile()),
        ("every candidate is accounted for",
         every_candidate_is_accounted_for()),
    ]

    failures = 0
    total = 0
    for title, results in groups:
        print(f"\n{title}")
        print("-" * len(title))
        for label, ok, *rest in results:
            total += 1
            detail = rest[0] if rest else ""
            if ok:
                print(f"  PASS  {label}")
            else:
                failures += 1
                print(f"  FAIL  {label}" + (f"  [{detail}]" if detail else ""))

    print(f"\n{total - failures}/{total} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
