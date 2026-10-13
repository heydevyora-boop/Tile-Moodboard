"""Regression: a base tile and its highlighter, embedded as two separate
PDF images on one page, must not collapse into one product.

THE FAILURE THIS COVERS
------------------------
test_tile_only_mode.py already proved that three products DETECTED AS
REGIONS WITHIN ONE SOURCE IMAGE survive -- source_key makes candidates
from the same source skip appearance comparison entirely, and
deduplicate_regions/geometry separate them within that one image.

That is not the only way a base tile and its highlighter reach the
pipeline. A catalog PDF routinely embeds them as two SEPARATE image
resources on the same page -- two different xrefs, two different
output files, two different source_key values -- each going through
its own call to mine_tile_regions. source_key equality cannot help
there; the two sources are never equal.

The pipeline's own fallback for that case is page geometry
(page_box_for_region / signature_already_seen's box_iou check): two
sightings describing the same AREA of the page are the same tile,
regardless of how they look. But page.get_image_rects(xref) does not
always return a placement for an embedded image -- inline images and
some content-stream constructs give PyMuPDF nothing to report -- and
when that happens for either side, image_rect is None, page_box is
None, and the only signal signature_already_seen had left was
content_signature() appearance matching.

That is exactly the signal the pipeline's own measurements (see
signature_already_seen's docstring and tile_region_extractor.py's
PAGE_BOX_OVERLAP_LIMIT comment) say cannot tell a base tile from its
own highlighter: same-range siblings measured 0.0108 apart on a real
catalog, INSIDE the 0.03 threshold that means "same tile". So without
geometry, two separate embedded images from the same close-palette
range fell back to the one comparison already documented as unsafe for
them, and the highlighter was dropped as a "duplicate" of the base.

WHAT THIS FILE CHECKS
----------------------
1. signature_already_seen() directly, against every combination of
   source type and geometry availability -- including that a true
   cross-route repeat (embedded image vs. the page render of the same
   page) still resolves as a duplicate, so this fix does not just
   disable the safety net the "true repeat" test already covers.

2. The real mine_tile_regions, called twice -- once for a base tile,
   once for its highlighter, as two separate embedded-image sources
   sharing one page's signature list, both without a placement rect --
   proving the fix holds through the actual call shape
   extract_images_from_pdf uses, not just the helper function alone.

Run:  GEMINI_API_KEY=test python3 test_same_page_sibling_variants.py
"""

import os
import shutil
import sys
from pathlib import Path

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-used")

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import main_step6_complete as pipeline  # noqa: E402
from app.image_validator import (  # noqa: E402
    validate_bbox,
    validate_product_decision,
)
from app.tile_region_extractor import (  # noqa: E402
    content_signature,
    extract_tile_region,
)

OUT = Path(__file__).resolve().parent / "output" / "same_page_sibling_test"

PAGE_W, PAGE_H = 1200, 900

# The same measured pair the pipeline's own comments cite: two
# same-range products close enough that appearance alone cannot
# separate them from a true repeat.
GROUT = (118, 110, 98)
BASE_COLOURS = ((201, 190, 173), (183, 173, 157))
HIGHLIGHTER_COLOURS = ((205, 193, 170), (186, 175, 154))


def check(label, ok, detail=""):
    return (label, bool(ok), detail)


# ----------------------------------------------------------------------
# signature_already_seen(): direct, function-level checks
# ----------------------------------------------------------------------

def tile_patch(width, height, colours, cell=28):
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


def _signature_for(colours):
    import cv2
    patch = tile_patch(200, 200, colours)
    bgr = cv2.cvtColor(patch, cv2.COLOR_RGB2BGR)
    return content_signature(bgr)


def unit_level_checks():
    base_signature = _signature_for(BASE_COLOURS)
    highlighter_signature = _signature_for(HIGHLIGHTER_COLOURS)

    results = []

    # The exact pairing this bug produced: two embedded-image sources,
    # neither with a placement rect, close enough in appearance that the
    # old code called them the same tile.
    seen = [("embedded-image:base.webp", base_signature, None)]
    results.append(check(
        "two embedded-image sources with no geometry are NOT merged by "
        "appearance, however close they look",
        not pipeline.signature_already_seen(
            seen, highlighter_signature,
            source_key="embedded-image:highlighter.webp", page_box=None,
        ),
    ))

    # Geometry, when available on both sides, still decides -- this must
    # not have been disabled by the fix.
    seen_with_boxes = [
        ("embedded-image:base.webp", base_signature, (0.0, 0.0, 10.0, 10.0)),
    ]
    results.append(check(
        "with non-overlapping page boxes on both sides, two embedded "
        "images still are not duplicates",
        not pipeline.signature_already_seen(
            seen_with_boxes, highlighter_signature,
            source_key="embedded-image:highlighter.webp",
            page_box=(50.0, 50.0, 60.0, 60.0),
        ),
    ))
    results.append(check(
        "with OVERLAPPING page boxes, two embedded images ARE still "
        "called the same tile -- geometry still wins when it is there",
        pipeline.signature_already_seen(
            seen_with_boxes, highlighter_signature,
            source_key="embedded-image:highlighter.webp",
            page_box=(0.5, 0.5, 10.5, 10.5),
        ),
    ))

    # The case this fix must NOT touch: an embedded image compared
    # against the PAGE RENDER of the same page is a legitimate
    # cross-route re-sighting, and appearance is still how that is
    # caught when geometry is not available for the embedded side. This
    # fix only withholds the appearance fallback between two separate
    # EMBEDDED sources -- it does not, and is not meant to, make
    # embedded-vs-render appearance matching any more (or less) precise
    # than it already was; that pairing's own close-sibling-vs-repeat
    # ambiguity is the pre-existing, documented tradeoff described in
    # this function's docstring, not something this change touches.
    seen_render = [("rendered-page:sheet_page_1_render.webp", base_signature, None)]
    results.append(check(
        "an embedded image vs. a page render (true cross-route repeat) "
        "still matches by appearance when neither side has geometry",
        pipeline.signature_already_seen(
            seen_render, base_signature,
            source_key="embedded-image:base.webp", page_box=None,
        ),
    ))

    # source_key equality still short-circuits everything else, exactly
    # as before this fix.
    seen_same_source = [("embedded-image:base.webp", base_signature, None)]
    results.append(check(
        "the same source_key is still never compared by appearance at "
        "all (region-level separation owns that question)",
        not pipeline.signature_already_seen(
            seen_same_source, base_signature,
            source_key="embedded-image:base.webp", page_box=None,
        ),
    ))

    return results


# ----------------------------------------------------------------------
# mine_tile_regions(): the real call shape extract_images_from_pdf uses
# ----------------------------------------------------------------------

def build_single_tile_image(path, colours):
    page = np.full((PAGE_H, PAGE_W, 3), 246, dtype=np.uint8)
    patch = tile_patch(PAGE_W - 120, PAGE_H - 160, colours)
    page[80:80 + patch.shape[0], 60:60 + patch.shape[1]] = patch
    Image.fromarray(page, "RGB").save(path, "WEBP", quality=92, method=6)


def quad(x1, y1, x2, y2):
    return [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]


def whole_image_region(width, height):
    return [{
        "surface": "SAMPLE",
        "confidence": 0.9,
        "quad": quad(0, 0, width, height),
        "occluders": [],
        "coordinate_space": "pixel",
    }]


class Analysis:
    def __init__(self):
        self.image_type = "TILE_SAMPLE"
        self.is_product_image = True
        self.decision = "APPROVED"
        self.confidence = 0.9
        self.product_name = "Range"
        self.product_bbox = None
        self.size_text = ""
        self.reason = ""


def purity():
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
        "physical_surface": True,
        "distinct_tile_designs": 1,
        "reason": "synthetic",
    }


def integration_two_separate_embedded_sources():
    """Base and highlighter as two xref'd images, neither with a rect --
    the exact shape of the loop in extract_images_from_pdf."""
    directory = OUT / "two_sources"
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True, exist_ok=True)

    base_path = directory / "catalog_page_1_image_1.webp"
    highlighter_path = directory / "catalog_page_1_image_2.webp"
    build_single_tile_image(base_path, BASE_COLOURS)
    build_single_tile_image(highlighter_path, HIGHLIGHTER_COLOURS)

    import app.gemini_service as gemini_service
    real_verify = gemini_service.verify_tile_only
    gemini_service.verify_tile_only = lambda _path: purity()

    page_signatures = []  # shared across both sources, as the real loop does
    accepted_paths = []

    try:
        for image_counter, path in ((1, base_path), (2, highlighter_path)):
            accepted, _deferred = pipeline.mine_tile_regions(
                path,
                page_number=1,
                image_counter=image_counter,
                text_spans=[],
                image_rect=None,  # the missing-placement-rect case
                semantic_validator=(
                    lambda p, page_text="": Analysis(),
                    validate_product_decision,
                    validate_bbox,
                ),
                region_miner=(
                    lambda p, width, height: whole_image_region(width, height),
                    extract_tile_region,
                ),
                output_directory=directory,
                source_type="embedded-image",
                seen_signatures=page_signatures,
            )
            accepted_paths.extend(p for p, _r, _m in accepted)
    finally:
        gemini_service.verify_tile_only = real_verify

    return [
        check(
            f"both the base tile and its highlighter survive as separate "
            f"products ({len(accepted_paths)})",
            len(accepted_paths) == 2,
            f"got {len(accepted_paths)}: {[p.name for p in accepted_paths]}",
        ),
        check(
            "the two surviving files hold different pixels",
            len(accepted_paths) == 2
            and accepted_paths[0].read_bytes() != accepted_paths[1].read_bytes(),
        ),
    ]


def integration_true_repeat_across_routes_still_caught():
    """The same page, searched by embedded-image then by its own
    rendered-page fallback -- still exactly one tile, not two. Confirms
    the fix did not also open the door to re-uploading the same tile."""
    directory = OUT / "true_repeat"
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True, exist_ok=True)

    embedded_path = directory / "catalog_page_1_image_1.webp"
    rendered_path = directory / "catalog_page_1_render.webp"
    build_single_tile_image(embedded_path, BASE_COLOURS)
    build_single_tile_image(rendered_path, BASE_COLOURS)

    import app.gemini_service as gemini_service
    real_verify = gemini_service.verify_tile_only
    gemini_service.verify_tile_only = lambda _path: purity()

    page_signatures = []
    accepted_paths = []

    try:
        for path, source_type, counter in (
            (embedded_path, "embedded-image", 1),
            (rendered_path, "rendered-page", 0),
        ):
            accepted, _deferred = pipeline.mine_tile_regions(
                path,
                page_number=1,
                image_counter=counter,
                text_spans=[],
                image_rect=None,
                semantic_validator=(
                    lambda p, page_text="": Analysis(),
                    validate_product_decision,
                    validate_bbox,
                ),
                region_miner=(
                    lambda p, width, height: whole_image_region(width, height),
                    extract_tile_region,
                ),
                output_directory=directory,
                source_type=source_type,
                seen_signatures=page_signatures,
            )
            accepted_paths.extend(p for p, _r, _m in accepted)
    finally:
        gemini_service.verify_tile_only = real_verify

    return [
        check(
            f"the same tile, re-found via the page render, is still one "
            f"product ({len(accepted_paths)})",
            len(accepted_paths) == 1,
            f"got {len(accepted_paths)}",
        ),
    ]


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)

    groups = [
        ("signature_already_seen: unit-level checks", unit_level_checks()),
        ("mine_tile_regions: two separate embedded sources, no geometry",
         integration_two_separate_embedded_sources()),
        ("mine_tile_regions: a true cross-route repeat is still caught",
         integration_true_repeat_across_routes_still_caught()),
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
