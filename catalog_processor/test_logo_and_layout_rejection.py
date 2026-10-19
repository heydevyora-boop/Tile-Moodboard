"""Regression: real extraction failures reported from Google Drive --
brand logos, multi-tile layout pages, and thin strip fragments reaching
the catalog as if each were a standalone tile product.

THE FAILURES THIS COVERS
-------------------------
Four reported symptoms, all traced to the SAME live pipeline
(main_step6_complete.py's extract_images_from_pdf):

1. Brand logos (e.g. a company logo) were being saved as products.
2. Multi-tile catalog layout pages (several swatches, each captioned
   with its own product name, often with a page footer) were saved as
   ONE image instead of being split or dropped.
3. Thin vertical strips -- furniture legs, partial graphics, clipping
   fragments -- were being saved.
4. Text / slogan / banner graphics were coming through.

ROOT CAUSES FOUND
------------------
(1) and (2) share one mechanism: on a tile-only catalog, when the
whole-image classifier rejects a candidate and region-mining then finds
nothing recoverable inside it, `keep_whole = TILE_ONLY_CATALOG and not
recovered` saved the ORIGINAL image anyway -- on the theory that "an
embedded image on a prepared page IS a product picture". That theory is
right for an ambiguous OTHER/unclassifiable rejection, but not for a
confident, specific verdict that the frame is a logo or a multi-product
layout: a region search finding nothing inside a logo does not mean the
logo itself is a tile. Fixed by gating `keep_whole` on the rejection's
category (KEEP_WHOLE_BLOCKED_CATEGORIES).

A second, narrower instance of the same shape exists at the per-region
and per-piece level: the "tile-only contract" there turns ANY non-APPROVED
purity verdict into APPROVED unless it is "impure with >1 design" --
including a purity verdict of `physical_surface: false`, i.e. "this is a
printed/drawn graphic, not a photograph of a physical surface", which is
exactly what a logo region crop is. Fixed by excluding that specific,
non-disputable verdict from the rescue (both call sites).

(3) is a plain gap: MIN_IMAGE_WIDTH/MIN_IMAGE_HEIGHT floor each
dimension independently, so a 200x2000px sliver passes both floors
while still being an extreme fragment. Fixed by is_thin_strip_image(),
a new dimension-only early filter.

(4) was already substantially addressed by the earlier SYSTEM_PROMPT
strengthening and is_mostly_text_image(); this file re-confirms both are
intact and adds the layout-page caption/footer wording as a presence
check.

THE RISK THIS FILE GUARDS AGAINST MOST
----------------------------------------
Every one of these fixes gates on CONFIDENT, SPECIFIC evidence (an exact
category, or `physical_surface: false`, or an extreme aspect ratio) --
never on the classifier merely disagreeing about what a real tile is
called. The majority of this file is therefore checks that the existing,
deliberately-protected behaviour is untouched: a verdict of ARCHITECTURE,
ARTWORK, COUNTERTOP, WOOD or OTHER on a real (physical_surface=true)
photographed tile must still cost nothing, exactly as
test_tile_only_mode.py's the_classifier_cannot_delete_a_product requires,
and a genuinely ambiguous whole-image rejection with nothing recoverable
must still be kept whole.

Run:  GEMINI_API_KEY=test python3 test_logo_and_layout_rejection.py
"""

import contextlib
import io
import os
import shutil
import sys
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

OUT = Path(__file__).resolve().parent / "output" / "logo_and_layout_rejection_test"


def check(label, ok, detail=""):
    return (label, bool(ok), detail)


def png_bytes(image):
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


# ----------------------------------------------------------------------
# 1. is_thin_strip_image()
# ----------------------------------------------------------------------

def thin_strip_filter_checks():
    results = []

    extreme_cases = [
        (200, 2000, "a 200x2000 vertical sliver"),
        (2200, 220, "a 2200x220 horizontal strip"),
        (1800, 200, "a 1800x200 fragment at the floor dimension"),
    ]
    for width, height, label in extreme_cases:
        reject, reason = pipeline.is_thin_strip_image(width, height)
        results.append(check(
            f"is_thin_strip_image rejects {label}", reject, reason,
        ))

    safe_cases = [
        (400, 400, "a square swatch"),
        (600, 300, "a 2:1 rectangular swatch"),
        (240, 1200, "a 1:5 plank-style product photo"),
        (1200, 220, "a 1:5.45 strip/listello product at its own proportions"),
        (200, 200, "the smallest size that still clears the floor"),
    ]
    for width, height, label in safe_cases:
        reject, reason = pipeline.is_thin_strip_image(width, height)
        results.append(check(
            f"is_thin_strip_image keeps {label} ({width}x{height}, "
            f"ratio {max(width, height) / min(width, height):.2f})",
            not reject, reason,
        ))

    return results


# ----------------------------------------------------------------------
# 2. The tile-only contract no longer rescues a verdict of
#    physical_surface=false (a logo/printed graphic), at both the
#    region level and the split-piece level -- while the existing,
#    deliberately-protected material-name rescue keeps working.
# ----------------------------------------------------------------------

PAGE_W, PAGE_H = 900, 700


def tile_patch(width, height, colours, cell=28):
    light, dark = colours
    canvas = np.zeros((height, width, 3), dtype=np.uint8)
    for y in range(height):
        for x in range(width):
            if x % cell < 4 or y % cell < 4:
                canvas[y, x] = (118, 110, 98)
            else:
                canvas[y, x] = (
                    light if ((x // cell) + (y // cell)) % 2 == 0 else dark
                )
    return canvas


def build_region_sheet(path):
    page = np.full((PAGE_H, PAGE_W, 3), 246, dtype=np.uint8)
    page[80:480, 60:460] = tile_patch(400, 400, ((201, 190, 173), (183, 173, 157)))
    Image.fromarray(page, "RGB").save(path, "WEBP", quality=92, method=6)


def quad(x1, y1, x2, y2):
    return [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]


def one_region():
    return [{
        "surface": "SAMPLE",
        "confidence": 0.9,
        "quad": quad(60, 80, 460, 480),
        "occluders": [],
        "coordinate_space": "unit",
    }]


class Analysis:
    def __init__(self, image_type="TILE_SAMPLE", is_product=True):
        self.image_type = image_type
        self.is_product_image = is_product
        self.decision = "APPROVED" if is_product else "REJECTED"
        self.confidence = 0.9
        self.product_name = "Range"
        self.product_bbox = None
        self.size_text = ""
        self.reason = ""


def purity(**overrides):
    base = {
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
    base.update(overrides)
    return base


def run_region_candidate(purity_result):
    """Searches one page with ONE region, the way the pipeline does,
    using the real mine_tile_regions/validate_and_correct_tile_image
    machinery. Returns (accepted_paths, log)."""
    directory = OUT / "region_candidate"
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True, exist_ok=True)

    embedded = directory / "sheet_page_1_image_1.webp"
    build_region_sheet(embedded)

    real_verify = gemini_service.verify_tile_only
    real_flag = pipeline.TILE_ONLY_CATALOG
    gemini_service.verify_tile_only = lambda _path: purity_result
    pipeline.TILE_ONLY_CATALOG = True

    captured = io.StringIO()
    real_emit = pipeline.emit
    pipeline.emit = lambda message="": captured.write(f"{message}\n")

    try:
        with contextlib.redirect_stdout(captured):
            accepted, _deferred = pipeline.mine_tile_regions(
                embedded,
                page_number=1,
                image_counter=1,
                text_spans=[],
                image_rect=None,
                semantic_validator=(
                    lambda path, page_text="": Analysis(),
                    validate_product_decision,
                    validate_bbox,
                ),
                region_miner=(
                    lambda path, width, height: [dict(r) for r in one_region()],
                    extract_tile_region,
                ),
                output_directory=directory,
                source_type="embedded-image",
                seen_signatures=[],
            )
    finally:
        gemini_service.verify_tile_only = real_verify
        pipeline.TILE_ONLY_CATALOG = real_flag
        pipeline.emit = real_emit

    return [path for path, _r, _m in accepted], captured.getvalue()


def tile_only_contract_region_level_checks():
    results = []

    # A logo/printed-graphic verdict must NOT be rescued.
    accepted, log = run_region_candidate(purity(physical_surface=False, material="GRAPHIC"))
    results.append(check(
        "a region the purity verifier says is not a physical surface "
        "(a logo/printed graphic) is rejected, not rescued",
        len(accepted) == 0,
        f"{len(accepted)} accepted; log tail: {log.splitlines()[-3:]}",
    ))

    # The explicitly-protected material-name rescue must still work:
    # a real photographed surface the classifier merely misnames must
    # still be saved (this is the_classifier_cannot_delete_a_product's
    # guarantee, re-checked here at point of change).
    for verdict in ("ARCHITECTURE", "WOOD", "OTHER"):
        accepted, _log = run_region_candidate(purity(material=verdict))
        results.append(check(
            f"a real surface merely misnamed {verdict} is still rescued "
            f"by the tile-only contract",
            len(accepted) == 1,
            f"{len(accepted)} accepted",
        ))

    # A real tile that is genuinely contaminated (e.g. a person in
    # frame) but IS a physical surface must still be rescued -- only
    # physical_surface=false is excluded, not every contaminant.
    accepted, _log = run_region_candidate(purity(contains_person=True))
    results.append(check(
        "a real photographed surface contaminated by a person is still "
        "rescued (only physical_surface=false is excluded)",
        len(accepted) == 1,
        f"{len(accepted)} accepted",
    ))

    return results


def build_two_design_sheet(path):
    """Two visibly distinct tile patches side by side -- an actual seam
    for split_tile_designs to find, unlike build_region_sheet's single
    uniform patch."""
    page = np.full((PAGE_H, PAGE_W, 3), 246, dtype=np.uint8)
    page[80:480, 60:460] = tile_patch(400, 400, ((230, 60, 50), (190, 30, 25)))
    page[80:480, 480:880] = tile_patch(400, 400, ((40, 90, 180), (25, 60, 140)))
    Image.fromarray(page, "RGB").save(path, "WEBP", quality=92, method=6)


def a_multi_design_frame_still_splits_with_the_new_guard():
    """The physical_surface guard must not interfere with the existing,
    separately-tested multi-design split path (designs > 1 still goes
    to split_tile_designs, not to this guard)."""
    merged = [{
        "surface": "SAMPLE",
        "confidence": 0.9,
        "quad": quad(60, 80, 880, 480),
        "occluders": [],
        "coordinate_space": "unit",
    }]

    directory = OUT / "multi_design_guard"
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True, exist_ok=True)
    embedded = directory / "sheet_page_1_image_1.webp"
    build_two_design_sheet(embedded)

    real_verify = gemini_service.verify_tile_only
    real_flag = pipeline.TILE_ONLY_CATALOG
    gemini_service.verify_tile_only = lambda _path: purity(distinct_tile_designs=2)
    pipeline.TILE_ONLY_CATALOG = True

    captured = io.StringIO()
    real_emit = pipeline.emit
    pipeline.emit = lambda message="": captured.write(f"{message}\n")

    try:
        with contextlib.redirect_stdout(captured):
            accepted, _deferred = pipeline.mine_tile_regions(
                embedded, page_number=1, image_counter=1, text_spans=[],
                image_rect=None,
                semantic_validator=(
                    lambda path, page_text="": Analysis(),
                    validate_product_decision, validate_bbox,
                ),
                region_miner=(
                    lambda path, width, height: [dict(r) for r in merged],
                    extract_tile_region,
                ),
                output_directory=directory, source_type="embedded-image",
                seen_signatures=[],
            )
    finally:
        gemini_service.verify_tile_only = real_verify
        pipeline.TILE_ONLY_CATALOG = real_flag
        pipeline.emit = real_emit

    log = captured.getvalue()
    # The point of this check is that the physical_surface guard did
    # not change what happens to a multi-product frame. It still does
    # not: the frame is handled by the multi-product path, which now
    # REFUSES rather than cuts (pipeline.SPLIT_MERGED_FRAMES), and the
    # line it prints says so in those words. What would fail this is
    # the guard claiming the frame instead -- a rejection that talks
    # about a printed graphic or a physical surface.
    return [check(
        "designs>1 still goes to the multi-product path, unaffected by "
        "the physical_surface guard",
        "more than one product in this frame" in log
        and "physical" not in log.lower(),
        log.splitlines()[-5:],
    )]


# ----------------------------------------------------------------------
# 3. keep_whole no longer rescues a confident logo / multi-product-
#    layout rejection when region-mining finds nothing -- but still
#    rescues a genuinely ambiguous OTHER rejection, exactly as before.
# ----------------------------------------------------------------------

def build_single_image_pdf(path, image):
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=700, height=900)
    page.insert_image(fitz.Rect(40, 40, 440, 440), stream=png_bytes(image))
    doc.save(str(path))
    doc.close()


def run_whole_image_candidate(image_type, reason, is_product=False):
    directory = OUT / f"whole_image_{image_type.lower()}"
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True, exist_ok=True)

    pdf_path = directory / "page.pdf"
    # Content is irrelevant -- the classifier is stubbed -- but must be
    # large enough to clear MIN_IMAGE_WIDTH/HEIGHT and not trip the
    # OTHER early filters, so a photographed-tile-shaped image is used.
    rng = np.random.default_rng(3)
    arr = (np.full((400, 400, 3), 200, dtype=np.uint8)
           + rng.normal(0, 6, (400, 400, 3))).clip(0, 255).astype("uint8")
    build_single_image_pdf(pdf_path, Image.fromarray(arr))

    real_analyze = gemini_service.analyze_product_image
    real_detect = gemini_service.detect_tile_regions
    real_flag = pipeline.TILE_ONLY_CATALOG

    def fake_analyze(_path, page_text=""):
        return Analysis(image_type=image_type, is_product=is_product)

    class _Stub:
        pass

    analysis = Analysis(image_type=image_type, is_product=is_product)
    analysis.reason = reason

    gemini_service.analyze_product_image = (
        lambda _path, page_text="": analysis
    )
    gemini_service.detect_tile_regions = lambda _path, width, height: []
    pipeline.TILE_ONLY_CATALOG = True

    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured):
            images = pipeline.extract_images_from_pdf(pdf_path, directory)
    finally:
        gemini_service.analyze_product_image = real_analyze
        gemini_service.detect_tile_regions = real_detect
        pipeline.TILE_ONLY_CATALOG = real_flag

    return images, captured.getvalue()


def keep_whole_category_gating_checks():
    results = []

    images, log = run_whole_image_candidate(
        "LOGO", "this is a company logo / brand mark, not a product photo",
    )
    results.append(check(
        "a confident LOGO rejection with nothing recoverable is NOT "
        "kept whole", len(images) == 0,
        f"{len(images)} saved; tail: {log.splitlines()[-4:]}",
    ))

    images, log = run_whole_image_candidate(
        "COLLAGE",
        "multiple products arranged as a catalog page layout, a collage "
        "of several tile swatches",
    )
    results.append(check(
        "a confident multi-product/layout rejection with nothing "
        "recoverable is NOT kept whole", len(images) == 0,
        f"{len(images)} saved; tail: {log.splitlines()[-4:]}",
    ))

    # The protected case: a genuinely ambiguous OTHER rejection with
    # nothing recoverable must still be kept whole, unchanged.
    images, log = run_whole_image_candidate(
        "OTHER", "could not confidently classify this image",
    )
    results.append(check(
        "an ambiguous OTHER rejection with nothing recoverable is still "
        "kept whole (the mechanism this guard must not break)",
        len(images) == 1,
        f"{len(images)} saved; tail: {log.splitlines()[-4:]}",
    ))

    return results


# ----------------------------------------------------------------------
# 4. Cross-check: the layout-page caption/footer wording is present,
#    and the earlier SYSTEM_PROMPT/text-filter work is still intact.
# ----------------------------------------------------------------------

def prompt_reinforcement_checks():
    prompt = gemini_service.SYSTEM_PROMPT
    purity_prompt = gemini_service.TILE_PURITY_PROMPT
    return [
        check(
            "SYSTEM_PROMPT names per-swatch captions/page footers as "
            "layout-page evidence",
            "page number or footer strip" in prompt,
        ),
        check(
            "TILE_PURITY_PROMPT's distinct_tile_designs guidance names "
            "captions/footers too",
            "page number/footer strip" in purity_prompt,
        ),
        check(
            "the earlier logo/banner REJECT section is still present",
            "LOGOS, BRAND MARKS, BANNERS, TEXT GRAPHICS" in prompt,
        ),
        check(
            "is_mostly_text_image is still defined and callable",
            callable(getattr(pipeline, "is_mostly_text_image", None)),
        ),
    ]


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)

    groups = [
        ("is_thin_strip_image()", thin_strip_filter_checks()),
        ("tile-only contract: region/piece level physical_surface guard",
         tile_only_contract_region_level_checks()),
        ("the multi-design split path is unaffected by the new guard",
         a_multi_design_frame_still_splits_with_the_new_guard()),
        ("keep_whole: category-gated rescue", keep_whole_category_gating_checks()),
        ("prompt reinforcement + cross-check", prompt_reinforcement_checks()),
    ]

    total = 0
    passed = 0
    for name, results in groups:
        print(f"\n{name}")
        for label, ok, detail in results:
            total += 1
            passed += int(ok)
            mark = "PASS" if ok else "FAIL"
            print(f"  [{mark}] {label}")
            if not ok and detail:
                print(f"         {detail}")

    print(f"\n{passed}/{total} checks passed")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
