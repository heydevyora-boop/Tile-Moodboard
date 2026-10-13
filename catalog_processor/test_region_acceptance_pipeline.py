"""Regression: what the REAL pipeline loop does with each candidate kind.

test_frame_scene_rejection.py checks the validator rules in isolation.
This file runs the same kinds of candidate through the actual pipeline
code (mine_tile_regions for the page-render route that produced the bad
Drive outputs, extract_images_from_pdf for the embedded-image route), so
the decision that reaches Drive is what is asserted -- not just a helper's
return value. Two holes were only visible at this level:

  * an UNJUDGED region crop (purity verifier did not run: quota, rate
    limit, API error) was force-approved by the tile-only contract,
    because every check passed on its defaults -- the DEFERRED branch
    right after it was unreachable in tile-only mode;
  * an embedded frame the verifier had JUDGED contaminated (room scene,
    fixtures) or NOT_TILE was saved whole by the tile-only keep_whole
    fallback whenever region mining recovered nothing from it.

Gemini is stubbed; no network, no Drive. The attached Drive screenshots
were used only for visual diagnosis -- the observations below are
hand-written to match what each screenshot shows, not read from them.

Run:  GEMINI_API_KEY=test python3 test_region_acceptance_pipeline.py
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
from app.image_processor import OUTPUT_CANVAS_SIZE  # noqa: E402
from app.image_validator import validate_bbox, validate_product_decision  # noqa: E402
from app.tile_region_extractor import extract_tile_region  # noqa: E402

OUT = Path(__file__).resolve().parent / "output" / "region_acceptance_pipeline_test"
PAGE_W, PAGE_H = 1000, 800


def check(label, ok, detail=""):
    return (label, bool(ok), detail)


def tile_patch(width, height, colours, cell=30):
    light, dark = colours
    yy, xx = np.mgrid[0:height, 0:width]
    checker = ((xx // cell) + (yy // cell)) % 2 == 0
    canvas = np.where(checker[..., None], light, dark).astype(np.uint8)
    canvas[(xx % cell < 4) | (yy % cell < 4)] = (118, 110, 98)
    return canvas


def observation(material="TILE", **overrides):
    base = {
        "tile_fraction": 0.97, "material": material,
        "contains_person": False, "contains_text": False,
        "contains_logo": False, "contains_furniture": False,
        "contains_fixture": False, "contains_object": False,
        "is_scene": False, "physical_surface": True,
        "distinct_tile_designs": 1, "reason": "synthetic",
    }
    base.update(overrides)
    return base


class Analysis:
    def __init__(self, image_type="TILE_SAMPLE", is_product=True):
        self.image_type = image_type
        self.is_product_image = is_product
        self.decision = "APPROVED" if is_product else "REJECTED"
        self.confidence = 0.9
        self.product_name = "Range"
        self.product_bbox = None
        self.size_text = ""
        self.reason = "synthetic classifier verdict"


# ----------------------------------------------------------------------
# Page-render route: one detected region, judged by a stubbed verifier.
# ----------------------------------------------------------------------

REGION = (100, 200, 520, 410)  # 420x210 -- deliberately not square


def run_render_region(name, purity_result, classifier_type="TILE_SAMPLE"):
    directory = OUT / name
    shutil.rmtree(directory, ignore_errors=True)
    directory.mkdir(parents=True, exist_ok=True)

    page = np.full((PAGE_H, PAGE_W, 3), 246, dtype=np.uint8)
    x1, y1, x2, y2 = REGION
    page[y1:y2, x1:x2] = tile_patch(x2 - x1, y2 - y1, ((201, 190, 173), (183, 173, 157)))
    source = directory / "catalog_page_1_render.webp"
    Image.fromarray(page).save(source, "WEBP", quality=92, method=6)

    def fake_verify(_path):
        if isinstance(purity_result, Exception):
            raise purity_result
        return purity_result

    real_verify, real_flag, real_emit = (
        gemini_service.verify_tile_only, pipeline.TILE_ONLY_CATALOG, pipeline.emit,
    )
    gemini_service.verify_tile_only = fake_verify
    pipeline.TILE_ONLY_CATALOG = True
    captured = io.StringIO()
    pipeline.emit = lambda message="": captured.write(f"{message}\n")
    try:
        with contextlib.redirect_stdout(captured):
            accepted, deferred = pipeline.mine_tile_regions(
                source, page_number=1, image_counter=0, text_spans=[],
                image_rect=None,
                semantic_validator=(
                    lambda _p, page_text="": Analysis(
                        classifier_type, classifier_type == "TILE_SAMPLE",
                    ),
                    validate_product_decision, validate_bbox,
                ),
                region_miner=(
                    lambda _p, w, h: [{
                        "surface": "SAMPLE", "confidence": 0.9,
                        "quad": [(x1, y1), (x2, y1), (x2, y2), (x1, y2)],
                        "occluders": [], "coordinate_space": "pixel",
                    }],
                    extract_tile_region,
                ),
                output_directory=directory, source_type="rendered-page",
                seen_signatures=[],
            )
    finally:
        gemini_service.verify_tile_only = real_verify
        pipeline.TILE_ONLY_CATALOG = real_flag
        pipeline.emit = real_emit

    return accepted, deferred, captured.getvalue()


def product_box(path):
    """Bounding box of the non-canvas pixels in a saved output."""
    with Image.open(path) as opened:
        arr = np.asarray(opened.convert("RGB")).astype(int)
    mask = np.abs(arr - 245).max(axis=2) > 12
    ys, xs = np.nonzero(mask)
    return arr.shape[1], arr.shape[0], xs.max() - xs.min() + 1, ys.max() - ys.min() + 1


def render_route_checks():
    results = []

    accepted, _d, log = run_render_region(
        "standalone_tile", observation("TILE"), classifier_type="GRAPHIC",
    )
    results.append(check(
        "genuine standalone tile is accepted (a broad GRAPHIC label on the "
        "crop does not veto a clean purity verdict)",
        len(accepted) == 1, log.splitlines()[-3:],
    ))
    if accepted:
        records = []
        with contextlib.redirect_stdout(io.StringIO()):
            pipeline.append_recovered_regions(accepted, records, 1, 0)
        canvas_w, canvas_h, box_w, box_h = product_box(records[0]["path"])
        results.append(check(
            f"accepted tile sits on the {OUTPUT_CANVAS_SIZE}x{OUTPUT_CANVAS_SIZE} "
            f"canvas without stretching (product {box_w}x{box_h}, "
            f"ratio {box_w / box_h:.2f}, source ratio 2.00)",
            canvas_w == canvas_h == OUTPUT_CANVAS_SIZE
            and abs(box_w / box_h - 2.0) < 0.1,
        ))

    accepted, _d, _log = run_render_region("highlighter", observation("HIGHLIGHTER"))
    results.append(check(
        "genuine highlight/decorative tile is accepted", len(accepted) == 1,
    ))

    invalid = [
        ("architectural frame on sky (Dubai-frame screenshot)",
         observation("ARCHITECTURE", tile_fraction=0.45, is_scene=True)),
        ("door panel with hardware (page 4 region 7)",
         observation("DOOR_PANEL", contains_fixture=True, tile_fraction=0.7)),
        ("decorative-named panel + window + background (page 4 region 5)",
         observation("RELIEF_PANEL", contains_fixture=True, tile_fraction=0.6)),
        ("partial curved panel with props (page 4 region 3)",
         observation("PAINTED_WALL", contains_object=True, tile_fraction=0.55)),
        ("multi-product catalog region with no findable seam",
         observation("TILE", distinct_tile_designs=3)),
    ]
    for label, obs in invalid:
        accepted, deferred, log = run_render_region(
            label.split(" ")[0] + str(len(label)), obs,
        )
        results.append(check(
            f"{label} is rejected, not uploaded",
            not accepted and not deferred,
            log.splitlines()[-3:],
        ))

    accepted, deferred, log = run_render_region(
        "unjudged", RuntimeError("429 quota exhausted"),
    )
    results.append(check(
        "a crop no verifier judged is NOT force-approved by the tile-only "
        "contract",
        not accepted, log.splitlines()[-3:],
    ))
    results.append(check(
        "...it is held back as DEFERRED instead (preserved, not published)",
        len(deferred) == 1,
    ))

    return results


# ----------------------------------------------------------------------
# Embedded-image route: the keep_whole fallback after region mining
# recovers nothing.
# ----------------------------------------------------------------------

def run_embedded(name, analysis, purity_result):
    import fitz

    directory = OUT / name
    shutil.rmtree(directory, ignore_errors=True)
    directory.mkdir(parents=True, exist_ok=True)

    buffer = io.BytesIO()
    rng = np.random.default_rng(5)
    arr = tile_patch(480, 360, ((205, 196, 180), (180, 170, 155))).astype(np.float32)
    arr += rng.normal(0, 4, arr.shape)
    Image.fromarray(arr.clip(0, 255).astype(np.uint8)).save(buffer, "PNG")

    doc = fitz.open()
    page = doc.new_page(width=700, height=900)
    page.insert_image(fitz.Rect(60, 60, 540, 420), stream=buffer.getvalue())
    pdf_path = directory / "catalog.pdf"
    doc.save(str(pdf_path))
    doc.close()

    patched = {
        "analyze_product_image": lambda _p, page_text="": analysis,
        "verify_tile_only": lambda _p: purity_result,
        "detect_tile_regions": lambda _p, w, h: [],
    }
    real = {key: getattr(gemini_service, key) for key in patched}
    real_flag = pipeline.TILE_ONLY_CATALOG
    for key, value in patched.items():
        setattr(gemini_service, key, value)
    pipeline.TILE_ONLY_CATALOG = True
    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured):
            images = pipeline.extract_images_from_pdf(pdf_path, directory)
    finally:
        for key, value in real.items():
            setattr(gemini_service, key, value)
        pipeline.TILE_ONLY_CATALOG = real_flag

    return images, captured.getvalue()


def embedded_route_checks():
    results = []

    images, log = run_embedded(
        "embedded_room_scene", Analysis("TILE_SAMPLE", True),
        observation("TILE", is_scene=True, contains_fixture=True, tile_fraction=0.5),
    )
    results.append(check(
        "an embedded frame judged a room scene is not saved whole when "
        "isolation finds nothing", not images,
        [line for line in log.splitlines() if "tile-only" in line or "REJECT" in line][-3:],
    ))

    images, _log = run_embedded(
        "embedded_architecture", Analysis("TILE_SAMPLE", True),
        observation("ARCHITECTURE", tile_fraction=0.9),
    )
    results.append(check(
        "an embedded frame judged architecture is not saved whole", not images,
    ))

    images, _log = run_embedded(
        "embedded_lifestyle_type", Analysis("ROOM_INTERIOR", False), observation(),
    )
    results.append(check(
        "an embedded frame the classifier typed ROOM_INTERIOR is not saved "
        "whole", not images,
    ))

    images, log = run_embedded(
        "embedded_soft_other", Analysis("OTHER", False), observation(),
    )
    results.append(check(
        "an embedded frame the classifier merely could not name (OTHER) is "
        "still kept whole -- the tile-only safety net is preserved",
        len(images) == 1, log.splitlines()[-4:],
    ))

    return results


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True, exist_ok=True)

    groups = [
        ("page-render route (mine_tile_regions)", render_route_checks()),
        ("embedded route (keep_whole fallback)", embedded_route_checks()),
    ]

    total = passed = 0
    for name, results in groups:
        print(f"\n{name}")
        for label, ok, detail in results:
            total += 1
            passed += int(ok)
            print(f"  {'PASS' if ok else 'FAIL'}  {label}")
            if not ok and detail:
                print(f"        {detail}")

    print(f"\n{passed}/{total} checks passed")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
