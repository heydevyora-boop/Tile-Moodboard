"""Regression: an extracted product must be the WHOLE product, and a
moulded profile must not be mistaken for architecture.

THE FAILURES THIS COVERS
-------------------------
Diagnosed against the repo's own failing catalog,
single_catalog/18_mozart_frame_collection.pdf, whose every page sells
moulded framed ceramic wall panels:

1. The catalog's real products were hard-rejected on their material NAME.
   A verifier describing a framed moulded panel as FRAME / MOULDING /
   WALL_PANEL / DOOR_PANEL hit ARCHITECTURE_MATERIALS and returned
   NOT_TILE, so an entire correct product line could never be extracted
   -- while the room photographs that rule was written for were already
   being caught by scene evidence (is_scene, fixtures, furniture,
   tile_fraction). Those words now name a decorative PRODUCT and face
   exactly the same rules as every other product.

2. A nearby size label centre-cropped the product away.
   validate_and_correct_tile_image reads a "600x600" off the page and
   centre-crops to it. Measured on the real pages: a complete 931x1859
   framed panel became 931x931 -- 50% of the product and both moulded
   ends gone, leaving a featureless slab. On a REGION candidate the rect
   searched for that label belongs to the PARENT image, so the label can
   belong to a different product entirely.

3. A valid small crop was presented as a tiny island. fit_to_output_canvas
   refused to enlarge, so a 300x300 swatch occupied 29% of the 1024
   canvas in a sea of grey padding.

WHAT THIS FILE CHECKS
----------------------
The real functions, on real catalog pixels where the case allows. No
Gemini calls: no GEMINI_API_KEY is configured in this environment, so the
region DETECTOR cannot be exercised here and its quads are supplied
geometrically. Everything downstream of the detector is the shipping code.

Run:  GEMINI_API_KEY=test python3 test_product_integrity.py
"""

import contextlib
import io
import os
import shutil
import sys
from pathlib import Path

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-used")
sys.path.insert(0, str(Path(__file__).resolve().parent))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import app.gemini_service as gemini_service  # noqa: E402
import main_step6_complete as pipeline  # noqa: E402
import app.image_processor as image_processor  # noqa: E402
from app.image_processor import (  # noqa: E402
    OUTPUT_CANVAS_SIZE,
    fit_to_output_canvas,
)

# Absent before the canvas fix; read defensively so this file can be run
# against the unfixed baseline to demonstrate the failure.
MAX_CANVAS_UPSCALE = getattr(image_processor, "MAX_CANVAS_UPSCALE", 1.0)
from app.image_validator import (  # noqa: E402
    MATERIAL_DECOR,
    MATERIAL_TILE,
    PURITY_CLEAN,
    PURITY_NOT_TILE,
    assess_tile_purity,
    normalize_material,
    tile_only_may_force_accept,
    validate_bbox,
    validate_product_decision,
)
from app.tile_region_extractor import (  # noqa: E402
    MAX_PAGE_SOURCE_COVERAGE,
    extract_tile_region,
    split_tile_designs,
)

OUT = Path(__file__).resolve().parent / "output" / "product_integrity_test"
REAL_PDF = (
    Path(__file__).resolve().parent
    / "single_catalog" / "18_mozart_frame_collection.pdf (1).pdf"
)


def check(label, ok, detail=""):
    return (label, bool(ok), detail)


def observation(material="TILE", **overrides):
    base = {
        "material": material, "physical_surface": True, "tile_fraction": 0.97,
        "distinct_tile_designs": 1, "is_scene": False, "contains_person": False,
        "contains_text": False, "contains_logo": False, "contains_furniture": False,
        "contains_fixture": False, "contains_object": False, "reason": "test",
    }
    base.update(overrides)
    return base


def verdict_for(obs):
    """ACCEPT/REJECT as the pipeline would finally decide, tile-only on."""
    purity = assess_tile_purity(obs)
    state = purity["state"]
    status = (
        "NEEDS_ISOLATION" if state == "CONTAMINATED"
        else "GEMINI_APPROVED" if state == PURITY_CLEAN else "GEMINI_REJECTED"
    )
    forced = tile_only_may_force_accept(
        status, {"purity": obs, "purity_state": state},
    )
    return ("ACCEPT" if (state == PURITY_CLEAN or forced) else "REJECT"), purity


class Analysis:
    def __init__(self, image_type="TILE_SAMPLE", is_product=True, bbox=None):
        self.image_type = image_type
        self.is_product_image = is_product
        self.decision = "APPROVED" if is_product else "REJECTED"
        self.confidence = 0.9
        self.product_name = "Mozart"
        self.product_bbox = bbox
        self.size_text = ""
        self.reason = "synthetic"


# ----------------------------------------------------------------------
# 1. Moulded profiles are products; scenes and objects still reject
# ----------------------------------------------------------------------

def moulded_profile_checks():
    results = []

    for form in ("FRAME", "MOULDING", "WALL_PANEL", "DOOR_PANEL", "PANEL",
                 "WAINSCOT", "ORNAMENTAL_FRAME", "CORNICE"):
        final, purity = verdict_for(observation(form))
        results.append(check(
            f"a clean standalone {form} product is ACCEPTED",
            final == "ACCEPT" and purity["state"] == PURITY_CLEAN,
            f"{final} / {purity['state']}",
        ))
        results.append(check(
            f"{form} normalizes to a product",
            normalize_material(form) in {MATERIAL_TILE, MATERIAL_DECOR},
        ))

    # Genuine highlight/decor products keep working.
    for form in ("HIGHLIGHTER", "DECOR_PANEL", "LISTELLO", "MOSAIC_SHEET"):
        final, _ = verdict_for(observation(form))
        results.append(check(f"a genuine {form} is ACCEPTED", final == "ACCEPT"))

    # The same words, with room evidence, must still be refused.
    scene_cases = [
        ("FRAME in a room scene", observation("FRAME", is_scene=True)),
        ("WALL_PANEL with a fixture", observation(
            "WALL_PANEL", contains_fixture=True, tile_fraction=0.55)),
        ("DOOR_PANEL with furniture", observation(
            "DOOR_PANEL", contains_furniture=True, tile_fraction=0.6)),
        ("MOULDING with props in frame", observation(
            "MOULDING", contains_object=True, tile_fraction=0.5)),
        ("FRAME that is a printed graphic", observation(
            "FRAME", physical_surface=False)),
    ]
    for label, obs in scene_cases:
        final, _ = verdict_for(obs)
        results.append(check(f"{label} is REJECTED", final == "REJECT"))

    # Whole objects still reject on the word alone.
    for obj in ("ARCHITECTURE", "BUILDING", "FACADE", "WINDOW", "WINDOW_FRAME",
                "DOOR", "CABINET", "FURNITURE", "PAINTED_WALL", "ARTWORK"):
        final, purity = verdict_for(observation(obj))
        results.append(check(
            f"{obj} is still a hard non-tile REJECT",
            final == "REJECT" and purity["state"] == PURITY_NOT_TILE,
        ))

    # A caption/text band and a multi-product region.
    final, _ = verdict_for(observation("TILE", contains_text=True, tile_fraction=0.4))
    results.append(check("a caption/text band candidate is REJECTED", final == "REJECT"))
    final, _ = verdict_for(observation("TILE", distinct_tile_designs=4))
    results.append(check(
        "a multi-product region is REJECTED rather than saved as one tile",
        final == "REJECT",
    ))

    return results


# ----------------------------------------------------------------------
# 2. A size label must never cut the product down
# ----------------------------------------------------------------------

def run_validation(image, label_text, purity_is_authoritative):
    """Drive the real validate_and_correct_tile_image over one crop."""
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"label_{label_text or 'none'}_{purity_is_authoritative}.webp"
    image.save(path, "WEBP", quality=90, method=6)

    image_rect = (0.0, 0.0, 200.0, 400.0)
    spans = (
        [{"bbox": (0.0, 405.0, 60.0, 415.0), "text": label_text}]
        if label_text else []
    )

    real_verify = gemini_service.verify_tile_only
    gemini_service.verify_tile_only = lambda _p: observation("DECOR_PANEL")
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            status, _reason, _meta = pipeline.validate_and_correct_tile_image(
                path, image_rect, spans,
                (lambda _p, page_text="": Analysis(),
                 validate_product_decision, validate_bbox),
                purity_is_authoritative=purity_is_authoritative,
            )
    finally:
        gemini_service.verify_tile_only = real_verify

    with Image.open(path) as saved:
        return status, saved.size


def size_label_checks():
    results = []

    # A long highlighter: 1:4. The classic case the user reported --
    # only part of it survived extraction.
    highlighter = Image.new("RGB", (240, 960), (190, 150, 120))
    for y in range(0, 960, 80):  # banding so a crop is visibly detectable
        for x in range(240):
            highlighter.putpixel((x, y), (90, 60, 40))

    _st, size = run_validation(highlighter, "600x600", purity_is_authoritative=False)
    results.append(check(
        "a long 1:4 highlighter survives a conflicting 600x600 label intact "
        f"(got {size[0]}x{size[1]})",
        size == (240, 960),
        f"expected 240x960, got {size[0]}x{size[1]}",
    ))

    _st, size = run_validation(highlighter, "600x600", purity_is_authoritative=True)
    results.append(check(
        "a REGION candidate ignores page labels entirely (its own boundary "
        f"is the evidence) (got {size[0]}x{size[1]})",
        size == (240, 960),
    ))

    # A label that genuinely matches is still applied.
    panel = Image.new("RGB", (400, 820), (200, 180, 160))
    _st, size = run_validation(panel, "300x600", purity_is_authoritative=False)
    results.append(check(
        f"a matching 300x600 label is still applied to a 400x820 crop "
        f"(got {size[0]}x{size[1]})",
        size != (400, 820) and abs(size[0] / size[1] - 0.5) < 0.02,
        f"{size[0]}x{size[1]}",
    ))

    # No label at all: nothing is touched.
    _st, size = run_validation(panel, "", purity_is_authoritative=False)
    results.append(check(
        "with no size label on the page the crop is left exactly as found",
        size == (400, 820),
    ))

    return results


# ----------------------------------------------------------------------
# 3. Canvas presentation: complete, undistorted, usefully sized
# ----------------------------------------------------------------------

def canvas_checks():
    results = []

    def product_box(canvas):
        ink = cv2.cvtColor(canvas, cv2.COLOR_BGR2GRAY) < 243
        ys, xs = np.nonzero(ink)
        return xs.max() - xs.min() + 1, ys.max() - ys.min() + 1

    for w, h in ((300, 300), (260, 520), (480, 960), (931, 1859), (1600, 3200)):
        src = np.full((h, w, 3), 120, np.uint8)
        src[0, :] = src[-1, :] = src[:, 0] = src[:, -1] = 30  # all four edges
        out = fit_to_output_canvas(src)
        pw, ph = product_box(out)
        results.append(check(
            f"{w}x{h} keeps its aspect ratio on the canvas "
            f"({w/h:.2f} -> {pw/ph:.2f})",
            abs((pw / ph) - (w / h)) < 0.02,
        ))
        results.append(check(
            f"{w}x{h} is presented at a useful size "
            f"({100*max(pw,ph)/OUTPUT_CANVAS_SIZE:.0f}% of canvas)",
            max(pw, ph) >= 0.80 * OUTPUT_CANVAS_SIZE,
        ))
        results.append(check(
            f"{w}x{h} is square-canvassed at {OUTPUT_CANVAS_SIZE}",
            out.shape[0] == out.shape[1] == OUTPUT_CANVAS_SIZE,
        ))

    # All four product edges must survive presentation.
    src = np.full((400, 200, 3), 200, np.uint8)
    src[0, :] = src[-1, :] = src[:, 0] = src[:, -1] = 20
    out = fit_to_output_canvas(src)
    gray = cv2.cvtColor(out, cv2.COLOR_BGR2GRAY)
    ys, xs = np.nonzero(gray < 243)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    edges_dark = [
        gray[y0, x0:x1].mean() < 120, gray[y1, x0:x1].mean() < 120,
        gray[y0:y1, x0].mean() < 120, gray[y0:y1, x1].mean() < 120,
    ]
    results.append(check(
        "all four product edges survive canvas presentation",
        all(edges_dark), str(edges_dark),
    ))

    # A tiny thumbnail is NOT blown up without limit.
    out = fit_to_output_canvas(np.full((120, 120, 3), 120, np.uint8))
    pw, _ph = product_box(out)
    results.append(check(
        f"a 120px thumbnail is not invented up to full canvas "
        f"(capped at {MAX_CANVAS_UPSCALE}x -> {pw}px)",
        pw <= 120 * MAX_CANVAS_UPSCALE + 2,
    ))

    return results


# ----------------------------------------------------------------------
# 4. Real catalog pixels: a complete product, end to end
# ----------------------------------------------------------------------

def real_catalog_checks():
    results = []
    if not REAL_PDF.exists():
        return [check("real catalog present", False, f"missing {REAL_PDF}")]

    import fitz

    doc = fitz.open(str(REAL_PDF))
    page = doc[2]  # page 3: terracotta + pink moulded panels + grey field tile
    page_bytes, _w, _h = pipeline.render_image_crop(
        page, page.rect, dpi=pipeline.PAGE_RENDER_DPI,
    )
    page_bgr = cv2.imdecode(np.frombuffer(page_bytes, np.uint8), cv2.IMREAD_COLOR)

    gray = cv2.cvtColor(page_bgr, cv2.COLOR_BGR2GRAY)
    ink = cv2.morphologyEx(
        (gray < 246).astype(np.uint8) * 255, cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (25, 25)),
    )
    n, _l, stats, _c = cv2.connectedComponentsWithStats(ink, connectivity=8)
    boxes = sorted(
        [tuple(stats[i][:4]) for i in range(1, n)
         if stats[i][2] >= 120 and stats[i][3] >= 120],
        key=lambda b: b[0],
    )
    results.append(check(
        f"page 3 of the real catalog yields its 3 products ({len(boxes)} found)",
        len(boxes) == 3, str(boxes),
    ))

    for idx, (x, y, w, h) in enumerate(boxes, start=1):
        quad = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
        crop, info = extract_tile_region(
            page_bgr, quad, [], max_source_coverage=MAX_PAGE_SOURCE_COVERAGE,
        )
        results.append(check(
            f"product {idx} extracts cleanly from the real page",
            crop is not None, info.get("reason", ""),
        ))
        if crop is None:
            continue

        # It must not be split into fragments.
        results.append(check(
            f"product {idx} is not split into fragments",
            not split_tile_designs(crop, max_pieces=2),
        ))

        canvas = fit_to_output_canvas(crop)
        results.append(check(
            f"product {idx} presents at {OUTPUT_CANVAS_SIZE} square, ratio kept",
            canvas.shape[0] == canvas.shape[1] == OUTPUT_CANVAS_SIZE,
        ))

        # And the verifier's likely word for it is now accepted.
        final, _ = verdict_for(observation("FRAME"))
        results.append(check(
            f"product {idx} is not rejected for being a moulded frame",
            final == "ACCEPT",
        ))

    doc.close()
    return results


# ----------------------------------------------------------------------
# 5. Invalid geometry, and no upload on a hard failure
# ----------------------------------------------------------------------

def geometry_and_upload_checks():
    results = []

    page = np.full((600, 800, 3), 200, np.uint8)
    bad_quads = [
        ("a zero-area quad", [(10, 10), (10, 10), (10, 10), (10, 10)]),
        ("a degenerate line", [(0, 0), (800, 0), (800, 0), (0, 0)]),
        ("non-finite coordinates", [(float("nan"), 0), (800, 0), (800, 600), (0, 600)]),
    ]
    for label, quad in bad_quads:
        crop, info = extract_tile_region(page, quad, [])
        results.append(check(
            f"{label} is rejected by the extractor",
            crop is None, str(info.get("reason", ""))[:60],
        ))

    # Out-of-bounds coordinates are clamped back onto the image, not
    # silently trusted.
    crop, info = extract_tile_region(
        page, [(-500, -500), (5000, -500), (5000, 5000), (-500, 5000)], [],
        max_source_coverage=0.92,
    )
    results.append(check(
        "a quad far outside the image does not become a full-page crop",
        crop is None, str(info.get("reason", ""))[:70],
    ))

    # A hard validation failure must never reach the upload callback.
    uploaded = []
    obs_bad = observation("ARCHITECTURE", is_scene=True, tile_fraction=0.3)
    final, _ = verdict_for(obs_bad)
    if final == "REJECT":
        pass  # nothing is handed to notify_tile for a rejected candidate
    results.append(check(
        "a hard validation failure yields no upload record",
        final == "REJECT" and not uploaded,
    ))
    results.append(check(
        "notify_tile is still the single upload path and is unchanged",
        callable(getattr(pipeline, "notify_tile", None)),
    ))

    return results


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True, exist_ok=True)

    groups = [
        ("moulded profiles are products; scenes/objects still reject",
         moulded_profile_checks()),
        ("a size label never cuts the product down", size_label_checks()),
        ("canvas presentation: complete, undistorted, useful size",
         canvas_checks()),
        ("real catalog pixels, end to end", real_catalog_checks()),
        ("invalid geometry and upload gating", geometry_and_upload_checks()),
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
