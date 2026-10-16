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
import inspect
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
import app.image_validator as image_validator_module  # noqa: E402
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
    PURITY_CONTAMINATED,
    PURITY_NOT_TILE,
    assess_tile_purity,
    normalize_material,
    tile_only_may_force_accept,
    validate_bbox,
    validate_product_decision,
)
import app.tile_region_extractor as region_extractor  # noqa: E402
from app.tile_region_extractor import (  # noqa: E402
    MAX_PAGE_SOURCE_COVERAGE,
    extract_tile_region,
    split_tile_designs,
)

# Absent until the page-trim exists; the check below reports that as a
# failure rather than taking the whole file down with an ImportError.
trim_to_product = getattr(region_extractor, "trim_to_product", None)
grow_to_whole_product = getattr(region_extractor, "grow_to_whole_product", None)
crop_is_one_product = getattr(region_extractor, "crop_is_one_product", None)
region_runs_off_the_page = getattr(
    region_extractor, "region_runs_off_the_page", None)

OUT = Path(__file__).resolve().parent / "output" / "product_integrity_test"
REAL_PDF = (
    Path(__file__).resolve().parent
    / "single_catalog" / "18_mozart_frame_collection.pdf (1).pdf"
)


def check(label, ok, detail=""):
    return (label, bool(ok), detail)


def tile_patch(width, height, colours, cell=28):
    """A checkerboard tile face with grout, like a real sheet."""
    light, dark = colours
    yy, xx = np.mgrid[0:height, 0:width]
    checker = ((xx // cell) + (yy // cell)) % 2 == 0
    canvas = np.where(checker[..., None], light, dark).astype(np.uint8)
    canvas[(xx % cell < 4) | (yy % cell < 4)] = (118, 110, 98)
    return canvas


def observation(material="TILE", **overrides):
    base = {
        "material": material, "physical_surface": True, "tile_fraction": 0.97,
        "distinct_tile_designs": 1, "is_scene": False, "contains_person": False,
        "complete_rectangle": True,
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

    for form in ("MOULDING", "WALL_PANEL", "DOOR_PANEL", "PANEL",
                 "WAINSCOT", "CORNICE", "FRAMED_PANEL", "MOULDED_PANEL"):
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
        ("PANEL in a room scene", observation("PANEL", is_scene=True)),
        ("WALL_PANEL with a fixture", observation(
            "WALL_PANEL", contains_fixture=True, tile_fraction=0.55)),
        ("DOOR_PANEL with furniture", observation(
            "DOOR_PANEL", contains_furniture=True, tile_fraction=0.6)),
        ("MOULDING with props in frame", observation(
            "MOULDING", contains_object=True, tile_fraction=0.5)),
        ("PANEL that is a printed graphic", observation(
            "PANEL", physical_surface=False)),
    ]
    for label, obs in scene_cases:
        final, _ = verdict_for(obs)
        results.append(check(f"{label} is REJECTED", final == "REJECT"))

    # Whole objects still reject on the word alone.
    # A bare FRAME names a STRUCTURE as readily as a tile profile, and a
    # photograph of the Dubai Frame reached Drive as a tile while it was
    # treated as a product. The catalog's own pieces are PANELs, checked
    # above, so the structure words all reject here.
    for obj in ("ARCHITECTURE", "BUILDING", "FACADE", "WINDOW", "WINDOW_FRAME",
                "DOOR", "CABINET", "FURNITURE", "PAINTED_WALL", "ARTWORK",
                "FRAME", "ORNAMENTAL_FRAME", "MONUMENT", "LANDMARK",
                "STRUCTURE", "TOWER", "BRIDGE", "ARCHWAY", "EXTERIOR"):
        final, purity = verdict_for(observation(obj))
        results.append(check(
            f"{obj} is still a hard non-tile REJECT",
            final == "REJECT" and purity["state"] == PURITY_NOT_TILE,
        ))

    # A TILE IS A RECTANGLE -- arches and part-shapes are refused.
    for label in ("an arched niche", "a domed/curved top",
                  "a semicircular fragment", "a part-shape with no edges"):
        final, purity = verdict_for(observation("TILE", complete_rectangle=False))
        results.append(check(
            f"{label} is REJECTED even though its surface is real tile",
            final == "REJECT" and purity["state"] == PURITY_NOT_TILE,
            f"{final} / {purity['state']}",
        ))
    # ...including when the material name is a moulded profile.
    final, _ = verdict_for(observation("PANEL", complete_rectangle=False))
    results.append(check(
        "an arch described as a PANEL is still REJECTED",
        final == "REJECT",
    ))
    # The reported failure: a frame-shaped BUILDING against open sky.
    for extra in ({}, {"is_scene": True}, {"tile_fraction": 0.95}):
        final, _ = verdict_for(observation("FRAME", **extra))
        results.append(check(
            f"a frame-shaped building is REJECTED (extra={extra or 'none'})",
            final == "REJECT",
        ))
    # A tile whose ARTWORK is curved is still a rectangle.
    final, _ = verdict_for(observation("DECOR_PANEL", complete_rectangle=True))
    results.append(check(
        "a decorative tile with curved artwork is still ACCEPTED",
        final == "ACCEPT",
    ))
    # An older verifier that never answers the question must not reject.
    legacy = observation("TILE")
    legacy.pop("complete_rectangle", None)
    final, _ = verdict_for(legacy)
    results.append(check(
        "a verifier that does not report the shape does not reject",
        final == "ACCEPT",
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
            f"{w}x{h} comes out as the tile alone, no padding "
            f"({out.shape[1]}x{out.shape[0]})",
            (pw, ph) == (out.shape[1], out.shape[0]),
            f"product {pw}x{ph} vs image {out.shape[1]}x{out.shape[0]}",
        ))
        # The long side reaches the target, unless the upscale cap stops
        # it first -- a small crop is presented larger, never invented.
        expected_long = min(OUTPUT_CANVAS_SIZE,
                            round(max(w, h) * MAX_CANVAS_UPSCALE))
        results.append(check(
            f"{w}x{h} has its longest side at {expected_long}",
            abs(max(out.shape[:2]) - expected_long) <= 1,
            f"got {out.shape[1]}x{out.shape[0]}",
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
        src_ratio = crop.shape[1] / crop.shape[0]
        out_ratio = canvas.shape[1] / canvas.shape[0]
        results.append(check(
            f"product {idx} presents at {OUTPUT_CANVAS_SIZE} long side, "
            f"ratio kept, no padding",
            max(canvas.shape[:2]) == OUTPUT_CANVAS_SIZE
            and abs(src_ratio - out_ratio) < 0.02,
            f"{canvas.shape[1]}x{canvas.shape[0]}",
        ))

        # And the words a verifier reaches for on a flat moulded ceramic
        # panel are accepted -- while the bare FRAME that names a
        # building is not.
        for word in ("PANEL", "MOULDED_PANEL", "DECOR_PANEL"):
            final, _ = verdict_for(observation(word))
            results.append(check(
                f"product {idx} is not rejected when called {word}",
                final == "ACCEPT",
            ))
        results.append(check(
            f"product {idx}: a bare FRAME is still refused (it names a "
            f"structure, not this flat piece)",
            verdict_for(observation("FRAME"))[0] == "REJECT",
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


def catalog_duplicate_checks():
    """The same product found again on a LATER page must not be saved
    twice, while two different products never merge."""
    from app.tile_region_extractor import content_signature, signatures_match

    results = []
    # Absent before the dedup fix; read defensively so this file runs
    # against the unfixed baseline to demonstrate the failure.
    threshold = getattr(pipeline, 'CATALOG_DUPLICATE_MAX_DIFFERENCE', 0.03)

    base = tile_patch(300, 600, ((201, 190, 173), (183, 173, 157)))
    # The SAME tile re-rasterized the way the two routes do it.
    ok, buf = cv2.imencode(".webp", base, [int(cv2.IMWRITE_WEBP_QUALITY), 85])
    requantized = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    # A SIBLING of the same range: same pattern, slightly different tone.
    sibling = tile_patch(300, 600, ((205, 193, 170), (186, 175, 154)))
    # A different product entirely.
    other = tile_patch(300, 600, ((120, 140, 190), (90, 110, 160)))

    sig_base = content_signature(base)
    pairs = [
        ("the same tile seen again later IS a duplicate",
         content_signature(requantized), True),
        ("a sibling of the same range is NOT a duplicate",
         content_signature(sibling), False),
        ("a different product is NOT a duplicate",
         content_signature(other), False),
    ]
    for label, sig, expected in pairs:
        got = signatures_match(sig_base, sig, max_difference_fraction=threshold)
        diff = sum(abs(a - b) for a, b in zip(sig_base, sig)) / len(sig_base) / 255.0
        results.append(check(f"{label} (measured {diff:.4f}, "
                             f"threshold {threshold})", got == expected,
                             f"got match={got}"))

    results.append(check(
        "the catalog-duplicate threshold is tighter than the within-page one",
        threshold < 0.03,
    ))
    results.append(check(
        "mine_tile_regions accepts a catalog_signatures list",
        "catalog_signatures" in
        pipeline.mine_tile_regions.__code__.co_varnames,
    ))
    return results


def real_product_crop():
    """The pink moulded panel from page 3 of the real catalog, in BGR.

    A product whose own moulded border runs right around its edge --
    exactly the kind of border a crop must not quietly remove.
    """
    import fitz

    doc = fitz.open(str(REAL_PDF))
    page = doc[2]
    page_bytes, _w, _h = pipeline.render_image_crop(
        page, page.rect, dpi=pipeline.PAGE_RENDER_DPI,
    )
    page_bgr = cv2.imdecode(np.frombuffer(page_bytes, np.uint8), cv2.IMREAD_COLOR)
    gray = cv2.cvtColor(page_bgr, cv2.COLOR_BGR2GRAY)
    n, _l, stats, _c = cv2.connectedComponentsWithStats(
        (gray < 248).astype(np.uint8), connectivity=8,
    )
    boxes = [tuple(stats[i][:4]) for i in range(1, n) if stats[i][4] > 20000]
    boxes.sort(key=lambda b: -b[2] * b[3])
    x, y, w, h = boxes[0]
    return page_bgr[y:y + h, x:x + w].copy()


def synthetic_highlighter(width=900, height=260):
    """A highlighter strip: decorative bands top and bottom, motif between.

    The bands are the product. A box drawn around the motif alone is
    the failure this covers.
    """
    strip = np.full((height, width, 3), (196, 206, 214), np.uint8)
    band = int(height * 0.22)
    strip[:band] = (150, 162, 176)
    strip[-band:] = (150, 162, 176)
    for x in range(0, width, 46):
        cv2.circle(strip, (x + 23, height // 2), 26, (120, 140, 190), -1)
    for y in (band - 5, height - band + 5):
        cv2.line(strip, (0, y), (width, y), (96, 110, 128), 4)
    return strip


def as_pil(image_bgr):
    return Image.fromarray(cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB))


def on_page(product_bgr, margin=0.18, background=250):
    """The product laid on a catalog page, and the box tight around it."""
    height, width = product_bgr.shape[:2]
    mx, my = int(width * margin), int(height * margin)
    page = np.full((height + 2 * my, width + 2 * mx, 3), background, np.uint8)
    page[my:my + height, mx:mx + width] = product_bgr
    return page, {"x1": mx, "y1": my, "x2": mx + width, "y2": my + height}


def bbox_trim_checks():
    """A product box may remove background. It may not cut the product.

    crop_image_to_validated_bbox cut to whatever box the classifier
    returned, guarded only by MIN_BBOX_FRACTION = 0.10, which asks no
    more than that the box not be a sliver. A box keeping the middle
    70% of a highlighter clears that -- and a highlighter's decorative
    top and bottom bands ARE the product, so both ends were lost. This
    is the "upper border and lower border are being removed" report.
    """
    results = []
    if not REAL_PDF.exists():
        return [check("real catalog present", False, f"missing {REAL_PDF}")]
    if not hasattr(pipeline, "bbox_trim_only_removes_background"):
        return [check(
            "a product box is checked before it cuts the product", False,
            "bbox_trim_only_removes_background does not exist -- nothing "
            "stops the classifier's box removing a product's own border",
        )]

    panel = real_product_crop()
    strip = synthetic_highlighter()
    guard = pipeline.bbox_trim_only_removes_background

    # Legitimate trims: the box is tight on the product, the page around
    # it is what goes.
    for label, product, background in (
        ("a moulded panel on a pale page", panel, 250),
        ("a highlighter on a pale page", strip, 250),
        ("a product on a dark page", panel, 28),
    ):
        page, box = on_page(product, background=background)
        allowed, why = guard(as_pil(page), box)
        results.append(check(
            f"trimming background around {label} is allowed",
            allowed, why,
        ))

    # Cuts into the product itself.
    for label, product in (("moulded panel", panel), ("highlighter", strip)):
        height, width = product.shape[:2]
        for name, inset in (("70%", 0.15), ("85%", 0.075), ("92%", 0.04)):
            box = {"x1": 0, "y1": int(height * inset),
                   "x2": width, "y2": int(height * (1 - inset))}
            allowed, why = guard(as_pil(product), box)
            results.append(check(
                f"a box keeping only the centre {name} of a {label} is refused",
                not allowed, "allowed it" if allowed else why[:60],
            ))
        box = {"x1": int(width * 0.1), "y1": int(height * 0.05),
               "x2": int(width * 0.9), "y2": int(height * 0.95)}
        allowed, _why = guard(as_pil(product), box)
        results.append(check(
            f"a box inset on all four sides of a {label} is refused",
            not allowed,
        ))

    # A box that trims nothing cannot be a cut, and an unmeasurable one
    # must not become a new way to lose an image.
    height, width = panel.shape[:2]
    results.append(check(
        "a full-frame box is allowed without measuring anything",
        guard(as_pil(panel), {"x1": 0, "y1": 0, "x2": width, "y2": height})[0],
    ))
    results.append(check(
        "a degenerate box is allowed rather than failing the save",
        guard(as_pil(panel), {"x1": 10, "y1": 10, "x2": 11, "y2": 11})[0],
    ))

    # The highlighter case, stated as the thing the user reported: the
    # decorative bands survive.
    height, width = strip.shape[:2]
    motif_box = {"x1": 0, "y1": int(height * 0.22),
                 "x2": width, "y2": int(height * 0.78)}
    allowed, _ = guard(as_pil(strip), motif_box)
    results.append(check(
        "a box around a highlighter's motif alone does not strip its borders",
        not allowed,
    ))

    source = inspect.getsource(pipeline.validate_and_prepare_tile_image) \
        if hasattr(pipeline, "validate_and_prepare_tile_image") else ""
    if not source:
        source = inspect.getsource(pipeline)
    results.append(check(
        "the guard is actually consulted before the product box is applied",
        "bbox_trim_only_removes_background" in source
        and source.index("bbox_trim_only_removes_background")
        < source.rindex("crop_image_to_validated_bbox"),
    ))
    return results


def split_laundering_checks():
    """Cutting something up must not launder a verdict of "not a tile".

    Splitting exists for several products butted together in one frame,
    but it ran on whatever reached it -- including a hard non-tile
    verdict. A photographed building, a view of a room or a printed
    graphic was cut apart and its pieces judged one by one, and a piece
    of a flat facade reads as a clean surface. The refusal on the whole
    image was undone by the act of dividing it.
    """
    if not hasattr(image_validator_module, "purity_is_hard_non_tile"):
        return [check(
            "a hard non-tile verdict survives being cut up", False,
            "purity_is_hard_non_tile does not exist -- a building, a room "
            "or a graphic is split and its pieces judged as tiles",
        )]
    hard = image_validator_module.purity_is_hard_non_tile

    cases = [
        # (label, observation, purity state, is this beyond repair?)
        ("three products in one frame",
         observation("TILE", distinct_tile_designs=3), PURITY_CONTAMINATED, False),
        ("a tile with a towel lying on it",
         observation("TILE", contains_object=True), PURITY_CONTAMINATED, False),
        ("a tile photographed with a person in shot",
         observation("TILE", contains_person=True), PURITY_CONTAMINATED, False),
        ("a view of a room",
         observation("TILE", is_scene=True), PURITY_CONTAMINATED, True),
        ("a photographed building",
         observation("ARCHITECTURE"), PURITY_NOT_TILE, True),
        ("a frame-shaped structure",
         observation("FRAME"), PURITY_NOT_TILE, True),
        ("a printed graphic, no physical surface",
         observation("TILE", physical_surface=False), PURITY_NOT_TILE, True),
        ("an arch",
         observation("TILE", complete_rectangle=False), PURITY_NOT_TILE, True),
        ("a clean tile", observation("TILE"), PURITY_CLEAN, False),
        ("a clean decorative panel", observation("DECOR_PANEL"), PURITY_CLEAN, False),
    ]

    results = []
    for label, obs, state, beyond_repair in cases:
        results.append(check(
            f"{label}: {'cutting it up cannot help' if beyond_repair else 'splitting still allowed'}",
            hard(obs, state) is beyond_repair,
            f"got hard={hard(obs, state)}",
        ))

    results.append(check(
        "no purity verdict at all is not evidence of anything",
        hard(None, None) is False,
    ))
    results.append(check(
        "an empty observation is not evidence of anything",
        hard({}, None) is False,
    ))

    source = inspect.getsource(pipeline.mine_tile_regions)
    split_at = source.index("split_at_background_gutters(crop)")
    results.append(check(
        "the splitter consults it before cutting anything up",
        "purity_is_hard_non_tile" in source
        and source.index("purity_is_hard_non_tile") > split_at,
    ))
    return results


def structure_word_checks():
    """A product is never a skyline, a gateway or a dome.

    The frame-shaped building reached Drive once already on the word
    FRAME, which was then moved back to the architecture set. These are
    the neighbouring words that still fell through to UNDECIDED and
    were judged on everything else -- which, for a flat graphic
    photograph of a structure, is not much.
    """
    added = ("SKYSCRAPER", "SKYLINE", "CITYSCAPE", "GATE", "GATEWAY",
             "PORTAL", "ARCH", "ARCADE", "DOME", "MINARET", "MOSQUE",
             "TEMPLE", "PALACE", "CASTLE")
    results = [
        check(f"{word} is refused as a product",
              assess_tile_purity(observation(word))["state"] == PURITY_NOT_TILE)
        for word in added
    ]

    # And nothing a real catalog calls its own products is caught by it.
    for word in ("TILE", "CERAMIC", "PORCELAIN", "MARBLE", "TERRACOTTA",
                 "MOSAIC", "HIGHLIGHTER", "DECOR_PANEL", "WALL_PANEL",
                 "MOULDED_PANEL", "GLAZED", "VITRIFIED", "BORDER",
                 "LISTELLO", "OTHER"):
        results.append(check(
            f"{word} is still kept",
            assess_tile_purity(observation(word))["state"] != PURITY_NOT_TILE,
        ))

    # Words that name where a tile is LAID are deliberately not here: a
    # model reaching for one of them about a correct tile shot must not
    # have the image deleted for it.
    for word in ("TERRACE", "BALCONY", "ROOFTOP", "COURTYARD"):
        results.append(check(
            f"{word} names a place a tile is laid, so it does not reject",
            assess_tile_purity(observation(word))["state"] != PURITY_NOT_TILE,
        ))
    return results


FIXTURES = Path(__file__).resolve().parent / "single_catalog" / "fixtures"


def catalog_fixture(name):
    """A page of the real 41-page Mozart catalog, rendered at 72 DPI."""
    path = FIXTURES / f"{name}.png"
    if not path.exists():
        return None
    return cv2.imread(str(path))


def page_regions_of(page):
    """Every product region on a page, as boxes in the page's own pixels."""
    count, _labels, stats, scale = region_extractor._page_regions(page)
    inverse = 1.0 / scale
    boxes = []
    for index in range(1, count):
        x, y, width, height, area = (int(v) for v in stats[index][:5])
        if area < 800 or width < 15 or height < 15:
            continue
        boxes.append((
            int(x * inverse), int(y * inverse),
            int(width * inverse), int(height * inverse),
        ))
    return boxes


def page_bleed_checks():
    """A hero that bleeds off the page is not a product shot.

    The real catalog finally explained two complaints that had survived
    several rounds. Its COVER is a photograph of the Dubai Frame -- an
    actual building -- running off the bottom of the page, and page 2
    carries three moulded frames overlapping and cropped by the page
    edge. Regions mined from those arrive as a frame-shaped structure
    and as narrow strips of moulding: exactly what kept reaching Drive.

    Over all 41 pages, 215 product regions, only three touch a page
    edge: those two, and one full-bleed page. A catalog puts page
    around its products and bleeds its artwork off the margin.
    """
    if region_runs_off_the_page is None:
        return [check(
            "hero artwork bled off the page is refused", False,
            "region_runs_off_the_page does not exist -- the cover's Dubai "
            "Frame and page 2's cropped mouldings are still mined as tiles",
        )]

    results = []
    for name, should_bleed, what in (
        ("mozart_cover_dubai_frame", True,
         "the cover's Dubai Frame photograph"),
        ("mozart_page2_bled_mouldings", True,
         "page 2's three cropped mouldings"),
        ("mozart_page7_products", False,
         "page 7's catalogued panels"),
    ):
        page = catalog_fixture(name)
        if page is None:
            results.append(check(f"{what}: fixture present", False, name))
            continue

        bled = []
        for x, y, width, height in page_regions_of(page):
            runs_off, note = region_runs_off_the_page(
                page, (x, y, x + width, y + height),
            )
            if runs_off:
                bled.append((f"{width}x{height}", note))

        if should_bleed:
            results.append(check(
                f"{what} is refused as page bleed",
                len(bled) >= 1, f"{len(bled)} refused",
            ))
            if bled:
                results.append(check(
                    f"{what}: the reason says it runs off the page",
                    "runs off" in bled[0][1] and "not a product shot"
                    in bled[0][1],
                    bled[0][1][:60],
                ))
        else:
            results.append(check(
                f"{what} are NOT refused -- they sit inside the page",
                not bled, f"{len(bled)} wrongly refused: {bled[:2]}",
            ))

    # A product photographed edge to edge is not a bleed: that is simply
    # how an embedded product image arrives, and it is four edges, not
    # one to three.
    panel = real_product_crop()
    runs_off, note = region_runs_off_the_page(
        panel, (0, 0, panel.shape[1], panel.shape[0]),
    )
    results.append(check(
        "a product filling its own image is not called a bleed",
        not runs_off, note[:60],
    ))

    source = inspect.getsource(extract_tile_region)
    results.append(check(
        "region extraction refuses a bleed before it rectifies or crops",
        source.index("region_runs_off_the_page") < source.index("rectify_quad"),
    ))
    return results


def one_product_split_checks():
    """One product is never cut up, whatever seams its pattern shows.

    split_tile_designs looks for seams, and a framed panel with a vine
    up it has plenty. The page knows better than the pattern does: a
    product is one connected region on it.
    """
    if crop_is_one_product is None:
        return [check(
            "a single product is not carved into pieces", False,
            "crop_is_one_product does not exist -- the seam splitter "
            "still quarters a framed panel",
        )]

    page = catalog_fixture("mozart_page7_products")
    if page is None:
        return [check("page 7 fixture present", False, "missing")]

    results = []
    # The three largest regions on page 7 are its products: two framed
    # panels and a mix-and-match tile. Everything smaller is page
    # furniture -- the index tab, the caption boxes -- which correctly
    # reads as "more than one product" because it is text.
    boxes = sorted(page_regions_of(page), key=lambda b: -(b[2] * b[3]))
    panels = boxes[:3]
    results.append(check(
        f"page 7 yields catalogued panels to test ({len(panels)})",
        len(panels) >= 2, str(panels[:3]),
    ))

    carved_before = carved_after = 0
    for x, y, width, height in panels:
        crop = page[y:y + height, x:x + width]
        seams = split_tile_designs(crop, max_pieces=4)
        single, note = crop_is_one_product(page, (x, y, x + width, y + height))
        if seams:
            carved_before += 1
            if not single:
                carved_after += 1
        results.append(check(
            f"a {width}x{height} panel reads as one product on the page",
            single, note[:60],
        ))

    results.append(check(
        "every panel the seam splitter would have carved is now spared",
        carved_after == 0, f"{carved_after} still carved of {carved_before}",
    ))

    # A box drawn across two products must NOT read as one.
    if len(panels) >= 2:
        first, second = sorted(panels[:2], key=lambda b: b[0])
        across = (
            first[0], min(first[1], second[1]),
            second[0] + second[2], max(first[1] + first[3],
                                       second[1] + second[3]),
        )
        single, note = crop_is_one_product(page, across)
        results.append(check(
            "a box across two panels does not read as one product",
            not single, note[:60],
        ))

    results.append(check(
        "the splitter consults it before the seam splitter runs",
        "crop_is_one_product" in inspect.getsource(pipeline.mine_tile_regions)
        and "not single_product" in inspect.getsource(
            pipeline.mine_tile_regions),
    ))
    return results


def real_page_and_products(page_index=2, dpi=110):
    """A real catalog page, with the true extent of each product on it."""
    import fitz

    doc = fitz.open(str(REAL_PDF))
    pix = doc[page_index].get_pixmap(dpi=dpi)
    page = cv2.imdecode(
        np.frombuffer(pix.tobytes("png"), np.uint8), cv2.IMREAD_COLOR,
    )
    gray = cv2.cvtColor(page, cv2.COLOR_BGR2GRAY)
    count, _l, stats, _c = cv2.connectedComponentsWithStats(
        (gray < 244).astype(np.uint8), 8,
    )
    products = sorted(
        [tuple(int(v) for v in stats[i][:4]) for i in range(1, count)
         if stats[i][4] > 40000],
        key=lambda b: b[0],
    )
    return page, products


def as_quad(x, y, width, height):
    return [(x, y), (x + width, y), (x + width, y + height), (x, y + height)]


def grow_checks():
    """Half a product is not a product -- so finish it, do not refuse it.

    Mozart came back with half panels: a quad bounding part of a
    product, so the crop, and any piece the splitter cut from it, held
    a fragment. What is needed to see that is not in the crop at all --
    it is in the parent, where the product continues past the quad.

    Six crop-only statistics were measured against this and every one
    put a real, tightly cropped patterned tile inside the refusing
    band, so nothing is refused: the quad is grown to the product it
    sits in.
    """
    if not REAL_PDF.exists():
        return [check("real catalog present", False, f"missing {REAL_PDF}")]
    if grow_to_whole_product is None:
        return [check(
            "a quad that cuts a product is finished before use", False,
            "grow_to_whole_product does not exist -- half a panel is "
            "cropped, and the splitter then cuts a fragment of a fragment",
        )]

    results = []
    page, products = real_page_and_products()
    results.append(check(
        f"the real page yields its products ({len(products)} found)",
        len(products) >= 3, str(products),
    ))

    for index, (x, y, width, height) in enumerate(products):
        whole = as_quad(x, y, width, height)
        reference, _note = grow_to_whole_product(page, whole)
        reference_bounds = region_extractor.quad_bounds(reference)

        # TO WITHIN A FEW PIXELS, AND THAT IS THE RIGHT ASSERTION.
        #
        # The parent is labelled on a reduced copy -- one labelling per
        # page instead of one per candidate, which at 200 DPI is 0.09s
        # against 16.2s. The boundary then lands a pixel or two
        # differently, measured at worst 2px, or 0.29% of a product's
        # longest side, and identically for every cut fraction of the
        # same product. What matters is that a half quad recovers the
        # SAME product, not that it agrees to the pixel with a full
        # one, so the tolerance is 4px: twice the worst seen.
        for label, fraction, axis in (
            ("55% of its width", 0.55, "x"),
            ("30% of its width", 0.30, "x"),
            ("40% of its height", 0.40, "y"),
            ("60% of its height", 0.60, "y"),
        ):
            cut = (as_quad(x, y, int(width * fraction), height) if axis == "x"
                   else as_quad(x, y, width, int(height * fraction)))
            grown, note = grow_to_whole_product(page, cut)
            bounds = region_extractor.quad_bounds(grown)
            results.append(check(
                f"product {index}: a quad holding {label} recovers all of it",
                all(abs(a - b) <= 4 for a, b in zip(bounds, reference_bounds)),
                f"{bounds} vs {reference_bounds}",
            ))

        # A quad already on the whole product is left where it is.
        _same, note = grow_to_whole_product(page, whole)
        results.append(check(
            f"product {index}: a correct quad is not moved",
            "already holds the whole product" in note, note[:60],
        ))

    # A SCENE HAS NO PAGE TO FIND, AND MUST NOT BE GROWN TO ITS WHOLE SELF.
    scene = np.zeros((900, 1400, 3), np.uint8)
    for row in range(900):
        scene[row, :] = (150 + int(40 * row / 900),
                         150 + int(35 * row / 900),
                         145 + int(30 * row / 900))
    cv2.rectangle(scene, (0, 648), (1400, 900), (96, 104, 112), -1)
    cv2.rectangle(scene, (840, 360), (1260, 720), (220, 220, 225), -1)
    for label, quad in (
        ("a wall region in a room photo", as_quad(60, 60, 500, 500)),
        ("a floor region in a room photo", as_quad(100, 675, 600, 180)),
    ):
        grown, note = grow_to_whole_product(scene, quad)
        results.append(check(
            f"{label} is left alone",
            region_extractor.quad_bounds(grown)
            == region_extractor.quad_bounds(quad),
            note[:60],
        ))
        # The reason now comes from the earlier, cleaner test: a room
        # photograph has no page margin at all, so none of the page
        # rules apply to it. The behaviour asserted above -- the region
        # is left exactly as it was -- is unchanged.
        results.append(check(
            f"{label}: the reason says a photograph has no page",
            "photograph" in note, note[:60],
        ))

    # A quad spanning two products belongs to the splitter, not here.
    (x0, y0, w0, h0), (x1, y1, w1, h1) = products[0], products[1]
    across = as_quad(x0, min(y0, y1), (x1 + w1) - x0,
                     max(y0 + h0, y1 + h1) - min(y0, y1))
    grown, note = grow_to_whole_product(page, across)
    results.append(check(
        "a quad spanning two products is left for the splitter",
        region_extractor.quad_bounds(grown)
        == region_extractor.quad_bounds(across)
        and "more than one product" in note,
        note[:60],
    ))

    # End to end: the crop that comes out is the whole product.
    x, y, width, height = products[0]
    full_crop, _info = extract_tile_region(page, as_quad(x, y, width, height))
    for label, fraction in (("55%", 0.55), ("30%", 0.30)):
        crop, info = extract_tile_region(
            page, as_quad(x, y, int(width * fraction), height),
        )
        results.append(check(
            f"a quad holding {label} of a product still crops the whole tile",
            crop is not None and full_crop is not None
            and abs(crop.shape[0] - full_crop.shape[0]) <= 4
            and abs(crop.shape[1] - full_crop.shape[1]) <= 4,
            f"{None if crop is None else crop.shape} vs "
            f"{None if full_crop is None else full_crop.shape}",
        ))

    results.append(check(
        "the quad is grown before it is normalised or cropped",
        inspect.getsource(extract_tile_region).index("grow_to_whole_product")
        < inspect.getsource(extract_tile_region).index("normalize_quad("),
    ))

    # The superseded header for the first, refusing version of the trim
    # was left in the file when that version was replaced, so the module
    # carried two headers and the first described behaviour that is not
    # there. It describes "four outcomes" and a touch rule that refuses.
    source = inspect.getsource(region_extractor)
    results.append(check(
        "the module does not describe a refusing trim it no longer has",
        source.count("ONLY THE TILE. NOT THE PAGE IT WAS PRINTED ON.") == 1
        and "Four outcomes" not in source,
    ))
    return results


def checkerboard_tile(width=400, height=340, cell=26):
    """A strongly patterned tile: the case that broke the first trim."""
    grout = (118, 110, 98)
    face = np.zeros((height, width, 3), np.uint8)
    for y in range(height):
        for x in range(width):
            if x % cell < 5 or y % cell < 5:
                face[y, x] = grout
            else:
                face[y, x] = ((201, 190, 173)
                              if ((x // cell) + (y // cell)) % 2 == 0
                              else (183, 173, 157))
    return face


def on_catalog_page(product_bgr, angle=0.0, pad=0.45, background=(250, 250, 250),
                    caption=False, clip=0.0, noise=2.0):
    """The product printed on a page, optionally at an angle."""
    rng = np.random.default_rng(5)
    height, width = product_bgr.shape[:2]
    side = int(max(height, width) * (1 + pad))
    page = np.full((side, side, 3), background, np.uint8)
    oy, ox = (side - height) // 2, (side - width) // 2
    page[oy:oy + height, ox:ox + width] = product_bgr
    if caption:
        cv2.putText(page, "EXOTICA 600X1200",
                    (ox, min(side - 12, oy + height + 46)),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.1, (70, 70, 70), 3)
    if angle:
        rotation = cv2.getRotationMatrix2D((side / 2, side / 2), angle, 1.0)
        page = cv2.warpAffine(page, rotation, (side, side),
                              flags=cv2.INTER_LINEAR,
                              borderMode=cv2.BORDER_CONSTANT,
                              borderValue=background)
    if clip:
        page = page[:, :int(side * clip)]
    return np.clip(page.astype(np.float32)
                   + rng.normal(0, noise, page.shape), 0, 255).astype(np.uint8)


def page_trim_checks():
    """Only the tile. Not the page it was printed on.

    Five images came back from a real Exotica run and three were mostly
    paper: the catalog prints its products at an angle, and an
    axis-aligned box around a tilted tile is two white triangles with a
    band of product between them. One was a tile so far out of frame
    that only a dark diagonal sliver was left.

    trim_to_product cuts the page away and straightens what is left --
    but only when the frame holds one whole rectangular product. Every
    ambiguous frame is handed on untouched, because every statistic
    that would have refused one also refused a real patterned tile.
    """
    results = []
    if not REAL_PDF.exists():
        return [check("real catalog present", False, f"missing {REAL_PDF}")]
    if trim_to_product is None:
        return [check(
            "the page around a product is cut away", False,
            "trim_to_product does not exist -- a tilted product arrives as "
            "two triangles of paper with a band of tile between them",
        )]

    panel = real_product_crop()
    strip = synthetic_highlighter()
    checker = checkerboard_tile()

    # The Exotica layout: a product printed at an angle, with page --
    # and sometimes a caption -- around it.
    for label, product, angle, background in (
        ("a panel at 5 degrees", panel, 5, (250, 250, 250)),
        ("a panel at 20 degrees", panel, 20, (250, 250, 250)),
        ("a panel at 45 degrees", panel, 45, (250, 250, 250)),
        ("a highlighter at 15 degrees", strip, 15, (250, 250, 250)),
        ("a patterned tile at 15 degrees", checker, 15, (250, 250, 250)),
        ("a panel on a DARK page", panel, 12, (30, 30, 30)),
    ):
        crop, info = trim_to_product(
            on_catalog_page(product, angle=angle, background=background),
        )
        results.append(check(
            f"{label} is cut out of the page and straightened",
            info["action"] == "trimmed", info["reason"][:60],
        ))
        if info["action"] == "trimmed":
            tall = max(product.shape[:2]), min(product.shape[:2])
            got = max(crop.shape[:2]), min(crop.shape[:2])
            results.append(check(
                f"{label} comes back at the product's own size",
                abs(got[0] - tall[0]) <= 3 and abs(got[1] - tall[1]) <= 3,
                f"{got} vs {tall}",
            ))

    # A caption beside the product goes with the page.
    crop, info = trim_to_product(on_catalog_page(panel, angle=20, caption=True))
    results.append(check(
        "a caption printed beside the product is left behind with the page",
        info["action"] == "trimmed"
        and abs(max(crop.shape[:2]) - max(panel.shape[:2])) <= 3,
    ))

    # THE CASES THAT MUST BE LEFT EXACTLY AS THEY WERE.
    #
    # The first version of this refused the ambiguous ones, and a
    # checkerboard tile's own pattern read as the page: 6 tiles became
    # 2 in test_single_pdf_tile_only.
    sliver = np.full((900, 700, 3), 250, np.uint8)
    cv2.fillPoly(sliver, [np.array([[0, 0], [105, 0], [700, 795], [595, 900]],
                                   np.int32)], (38, 36, 34))
    two_up = np.full((panel.shape[0] + 80, panel.shape[1] * 2 + 160, 3),
                     250, np.uint8)
    two_up[40:40 + panel.shape[0], 40:40 + panel.shape[1]] = panel
    two_up[40:40 + panel.shape[0],
           40 + panel.shape[1] + 80:40 + panel.shape[1] * 2 + 80] = panel

    for label, image in (
        ("a crop already tight to its panel", panel),
        ("a patterned tile filling the frame", checker),
        ("the same tile with bigger cells", checkerboard_tile(cell=52)),
        ("the same tile with tiny cells", checkerboard_tile(cell=12)),
        ("a highlighter filling the frame", strip),
        ("a product running out of the frame",
         on_catalog_page(panel, angle=20, clip=0.55)),
        ("a thin diagonal sliver", sliver),
        ("two products in one frame", two_up),
    ):
        before = image.shape
        crop, info = trim_to_product(image)
        results.append(check(
            f"{label} is handed on untouched",
            info["action"] == "unchanged" and crop.shape == before,
            info["reason"][:60],
        ))

    results.append(check(
        "the trim never refuses an image outright",
        "rejected" not in inspect.getsource(trim_to_product),
    ))
    results.append(check(
        "region extraction trims before it upscales or reports",
        inspect.getsource(region_extractor.extract_tile_region).index(
            "trim_to_product")
        < inspect.getsource(region_extractor.extract_tile_region).index(
            "UPSCALE_TARGET_SIDE_PX"),
    ))
    results.append(check(
        "the whole-image route trims too, and only on a clean verdict",
        'trim_note.get("action") == "trimmed"' in inspect.getsource(
            pipeline.extract_images_from_pdf),
    ))
    return results


def flat(text):
    """One-line view of a hand-wrapped prompt, for substring checks.

    The prompts are wrapped to column 72, so a phrase being checked can
    have a newline and indent dropped into the middle of it by an edit
    that did not change a word of it. Collapsing whitespace first keeps
    these checks about the wording.
    """
    return " ".join(str(text).split())


def printed_graphic_checks():
    """RULE 0 was deleting the catalog, because of how it was asked.

    A real run of 18_mozart_frame_collection refused about forty
    candidates across nine pages and kept six. The single commonest
    reason, by a wide margin, was "this is a printed or drawn graphic,
    not a photograph of a physical surface".

    The wording made that answer almost inevitable. It said FALSE for
    "ink or pixels DEPICTING a pattern ... a border ... a rendering or
    any other catalog artwork", and every frame in this pipeline is
    pixels cut out of a catalog PDF. It also called a BORDER a graphic
    while the material list two lines below calls a border a product.
    So the question is now about what the image SHOWS, the medium is
    named as evidence of nothing, and an unsure answer is TRUE.
    """
    prompt = flat(gemini_service.TILE_PURITY_PROMPT)
    results = [
        check("the question is about what the image shows, not its medium",
              "It does not ask how the image reached you" in prompt),
        check("coming off a catalog page is named as evidence of nothing",
              "is evidence about none of them" in prompt),
        check("a flat evenly lit catalog swatch is the normal TRUE case",
              "shadowless swatch is exactly what a real product looks like"
              in prompt),
        check("a product render counts as a real piece",
              "A product render is TRUE as well" in prompt),
        check("FALSE is reserved for things that were never material",
              "never a piece of material at all" in prompt),
        check("an unsure answer is TRUE",
              "If you are unsure, answer TRUE. A wrong FALSE deletes the "
              "product outright" in prompt),
        check("the no-appeal consequence is spelled out",
              "nothing downstream can reconsider it" in prompt),
        check("a border is no longer called a graphic",
              "a colour chart, a border, an icon" not in prompt),
        check("the material list still calls a border a product, as it did",
              "DECOR_PANEL the face of a PHYSICAL decorative product -- a "
              "highlighter, border, listello" in prompt),
        check("so the two answers no longer contradict each other",
              "a border, a listello, a highlighter" in prompt),
    ]

    # The rule itself, and what an unanswered question now does.
    plain = observation("TILE")
    no_answer = {k: v for k, v in plain.items() if k != "physical_surface"}
    results.extend([
        check("a frame the model calls a graphic is still refused",
              assess_tile_purity(observation("TILE", physical_surface=False))
              ["state"] == PURITY_NOT_TILE),
        check("a photographed tile is still kept",
              assess_tile_purity(plain)["state"] == PURITY_CLEAN),
        check("a hand-built observation still cannot accept by omission",
              assess_tile_purity(no_answer)["state"] == PURITY_NOT_TILE),
        check("the model is required to answer it at all",
              "physical_surface" in gemini_service.TILE_PURITY_SCHEMA["required"]),
        # And where it actually bites -- a real reply that left the
        # field out -- the omission must not reject by itself, and must
        # not silence the other rules either.
        check("a reply that omits it is not read as 'a graphic'",
              (verify_with_model(
                  purity={k: v for k, v in observation("TILE").items()
                          if k != "physical_surface"},
                  reask="PRODUCT") or {}).get("physical_surface") is True),
        check("a genuine rejection in such a reply still rejects",
              assess_tile_purity(verify_with_model(
                  purity={k: v for k, v in observation("ARCHITECTURE").items()
                          if k != "physical_surface"},
                  reask="ARTWORK"))["state"] == PURITY_NOT_TILE),
        check("and a scene in such a reply is still not clean",
              assess_tile_purity(verify_with_model(
                  purity={k: v for k, v in observation("TILE", is_scene=True).items()
                          if k != "physical_surface"},
                  reask="ARTWORK"))["state"] != PURITY_CLEAN),
        check("a reply that answers it is still read normally",
              (verify_with_model(purity=observation("TILE"), reask="PRODUCT")
               or {}).get("physical_surface") is True),
        # A PRODUCT MATERIAL WITH NO PHYSICAL SURFACE CONTRADICTS ITSELF.
        #
        # The file already re-asks the mirror case (ARTWORK reported for
        # something physical). This pairing is the costlier one: RULE 0
        # deletes on it and the tile-only contract may not override it,
        # so nothing could look again. It is resolved the same way, and
        # fails the same safe way.
        check("a product material with no physical surface is re-asked",
              (verify_with_model(
                  purity=observation("TILE", physical_surface=False),
                  reask="PRODUCT") or {}).get("physical_surface") is True),
        check("and the rescue is recorded, not silent",
              (verify_with_model(
                  purity=observation("TILE", physical_surface=False),
                  reask="PRODUCT") or {}).get("reinterpreted_from") == "GRAPHIC"),
        check("an ARTWORK second opinion leaves the refusal standing",
              (verify_with_model(
                  purity=observation("TILE", physical_surface=False),
                  reask="ARTWORK") or {}).get("physical_surface") is False),
        check("an UNSURE second opinion leaves the refusal standing",
              (verify_with_model(
                  purity=observation("TILE", physical_surface=False),
                  reask="UNSURE") or {}).get("physical_surface") is False),
        check("a genuine graphic -- no product material -- is not re-asked",
              (verify_with_model(
                  purity=observation("GRAPHIC", physical_surface=False),
                  reask="PRODUCT") or {}).get("physical_surface") is False),
        check("a refused graphic still reaches RULE 0 as a rejection",
              assess_tile_purity(verify_with_model(
                  purity=observation("GRAPHIC", physical_surface=False),
                  reask="PRODUCT"))["state"] == PURITY_NOT_TILE),
    ])
    return results


def landmark_and_wall_checks():
    """Two more verdicts from that same run, at opposite extremes.

    Nine candidates were refused as "a photograph of a structure ... a
    landmark clad in tile is still a landmark" -- in a catalog whose
    entire range is moulded framed panels, where the only thing
    frame-shaped about them is the moulding. Meanwhile the one crop
    that WAS accepted off page 6 is a wall of three identical panels
    with the ceiling line across the top: a room, reported as not a
    scene, because tile filled the frame and every tile matched.

    So ARCHITECTURE now needs the evidence of a place rather than a
    shape, and a visible junction is named as what makes a frame a
    space.
    """
    prompt = flat(gemini_service.TILE_PURITY_PROMPT)
    return [
        check("architecture requires evidence of a place, not a shape",
              "ARCHITECTURE NEEDS THE EVIDENCE OF A PLACE, NOT JUST A SHAPE"
              in prompt),
        check("sky, ground, distance and surroundings are the evidence named",
              "sky, ground, open air, distance, a perspective view" in prompt),
        check("a flat piece shot square on is never a landmark",
              "is NEVER a landmark, however grand its moulding" in prompt),
        check("being frame-shaped is explicitly not enough",
              "its frame resembles a doorway or an arch" in prompt),
        check("ornate or frame-shaped resolves to DECOR_PANEL",
              "the answer is DECOR_PANEL" in prompt),

        check("a junction is named as the giveaway for a space",
              "THE GIVEAWAY IS A JUNCTION OR A SECOND PLANE" in prompt),
        check("wall-to-ceiling and wall-to-floor are spelled out",
              "where the wall meets the ceiling, the floor, a skirting"
              in prompt),
        check("tile filling the frame does not make a wall a sample",
              "even when tile fills nearly the whole frame" in prompt),
        check("identical tiles throughout do not make a wall a sample",
              "every tile in it is the same product" in prompt),
        check("an empty room with no props is still a room",
              "no furniture, fitting or person appears anywhere in it"
              in prompt),

        # The rules behind both, unchanged.
        check("a scene is still refused whatever its material",
              assess_tile_purity(observation("TILE", is_scene=True))["state"]
              != PURITY_CLEAN),
        check("an architecture verdict is still refused",
              assess_tile_purity(observation("ARCHITECTURE"))["state"]
              == PURITY_NOT_TILE),
        check("a moulded framed panel is still a product",
              assess_tile_purity(observation("MOULDED_PANEL"))["state"]
              == PURITY_CLEAN),
    ]


def report_accounting_checks():
    """The report must say what happened to every candidate it counted.

    An Exotica run came back with two images out of a ten-page catalog,
    and its report read "candidates: 12, accepted: 2" with
    rejected_by_validation, duplicates_skipped, hard_filtered and
    too_small_skipped ALL zero -- because those counters only track the
    whole-image route, and every one of the twelve was a mined region.
    Ten candidates were unaccounted for in the one file written to
    explain the run, so the reason the catalog came out empty could not
    be read off it at all.
    """
    trace = [
        {"final": "ACCEPTED"},
        {"final": "ACCEPTED"},
        {"final": "REJECTED", "validation_reason": "the surface is artwork, not tile"},
        {"final": "REJECTED", "validation_reason": "the surface is artwork, not tile"},
        {"final": "REJECTED", "validation_reason": "the surface is artwork, not tile"},
        {"final": "REJECTED", "purity_state": PURITY_NOT_TILE},
        {"final": "DUPLICATE"},
        {},  # a candidate that reached the report with no outcome at all
    ]
    outcomes, reasons = pipeline.summarise_candidate_outcomes(trace)

    top_reason, top_count = next(iter(reasons.items()))
    return [
        check("every candidate in the trace is accounted for",
              sum(outcomes.values()) == len(trace),
              f"{sum(outcomes.values())} of {len(trace)}"),
        check("an outcome-less candidate is UNRECORDED, not missing",
              outcomes.get("UNRECORDED") == 1, str(outcomes)),
        check("accepted, rejected and duplicate are counted separately",
              outcomes.get("ACCEPTED") == 2
              and outcomes.get("REJECTED") == 4
              and outcomes.get("DUPLICATE") == 1,
              str(outcomes)),
        check("the commonest rejection reason is reported first",
              top_reason == "the surface is artwork, not tile" and top_count == 3,
              f"{top_reason!r} x{top_count}"),
        check("a rejection with no reason text still carries its purity state",
              PURITY_NOT_TILE in reasons, str(reasons)),
        check("accepted candidates contribute no rejection reason",
              sum(reasons.values()) == len(trace) - outcomes["ACCEPTED"],
              str(reasons)),
        check("the report carries both tallies",
              all(key in inspect.getsource(pipeline.extract_images_from_pdf)
                  for key in ("candidate_outcomes",
                              "candidate_reject_reasons",
                              "summarise_candidate_outcomes"))),
    ]


def verify_with_model(purity, reask):
    """Runs the REAL verify_tile_only against scripted model answers.

    Both of its questions go through _generate_content_safe, and the
    response_schema it passes says which one is being asked, so one
    stub can script the purity observation and the product-or-picture
    re-ask separately. Nothing here is a reimplementation: the prompt,
    the schema, the parser and the contradiction branch are the
    shipping ones.
    """
    import json as _json

    class Reply:
        def __init__(self, payload):
            self.text = _json.dumps(payload)

    def model(**kwargs):
        schema = (kwargs.get("config") or {}).get("response_schema")
        if schema is gemini_service.PRODUCT_OR_ARTWORK_SCHEMA:
            return Reply({"verdict": reask, "reason": "scripted"})
        return Reply(purity)

    OUT.mkdir(parents=True, exist_ok=True)
    swatch = OUT / "_contradiction_probe.webp"
    Image.fromarray(tile_patch(240, 240, ((198, 186, 170), (178, 166, 150)))
                    ).save(swatch)

    original = gemini_service._generate_content_safe
    gemini_service._generate_content_safe = model
    try:
        return gemini_service.verify_tile_only(str(swatch))
    finally:
        gemini_service._generate_content_safe = original


def observation_plumbing_checks():
    """Every field the purity PROMPT asks for must survive the PARSER.

    The first complete_rectangle attempt added the question to the prompt
    and the schema and wrote the validator rule -- but verify_tile_only
    builds its result from an explicit key list, so the model's answer
    was dropped before the validator ever saw it, and arched crops kept
    arriving. This walks prompt -> schema -> parser so a field can never
    again be half-wired.
    """
    import inspect

    results = []
    prompt = gemini_service.TILE_PURITY_PROMPT
    schema = gemini_service.TILE_PURITY_SCHEMA["properties"]
    parser_src = inspect.getsource(gemini_service.verify_tile_only)

    for field in sorted(schema):
        results.append(check(
            f"'{field}' asked in the prompt is also read by the parser",
            f'"{field}"' in parser_src,
            "schema field never reaches the observation dict",
        ))

    for field in ("complete_rectangle", "physical_surface", "is_scene"):
        results.append(check(
            f"'{field}' is described in TILE_PURITY_PROMPT",
            field in prompt,
        ))
        results.append(check(
            f"'{field}' is declared in TILE_PURITY_SCHEMA",
            field in schema,
        ))

    # And the parsed observation really carries it through.
    sample = {
        "material": "TILE", "tile_fraction": 0.95,
        "complete_rectangle": False, "physical_surface": True,
        "is_scene": False, "distinct_tile_designs": 1, "reason": "arch",
    }
    results.append(check(
        "a payload saying complete_rectangle=false reaches the validator "
        "as a rejection",
        assess_tile_purity(observation("TILE", complete_rectangle=False))[
            "state"] == PURITY_NOT_TILE,
    ))
    results.append(check(
        "the parser defaults a missing complete_rectangle to True "
        "(an unanswered question must not empty the catalog)",
        'payload.get("complete_rectangle", True)' in parser_src,
    ))
    return results


def gutter_split_checks():
    """Two tiles with bare page between them must come apart, and a
    single product must never be cut."""
    # Absent before the gutter fix; read defensively so this file can be
    # run against the unfixed baseline to demonstrate the failure.
    import app.tile_region_extractor as tre
    split_at_background_gutters = getattr(
        tre, "split_at_background_gutters", lambda _img: [],
    )

    results = []
    gap = lambda h, w=60: np.full((h, w, 3), 252, np.uint8)

    # THE CASE THAT KEPT REACHING DRIVE: two PLAIN cream tiles with a
    # white stripe between them. The first version of the splitter looked
    # for flat columns, but a plain tile's own columns are flat too, so
    # nothing separated and the pair was saved as one image.
    def plain(base=238, noise=0.6, seed=1, w=400, h=800):
        rng = np.random.default_rng(seed)
        return (np.full((h, w, 3), base, np.float32)
                + rng.normal(0, noise, (h, w, 3))).clip(0, 255).astype(np.uint8)

    for noise in (0.3, 0.6, 1.0, 2.0, 4.0):
        pair = np.hstack([plain(noise=noise), gap(800),
                          plain(noise=noise, seed=2)])
        results.append(check(
            f"two PLAIN tiles (texture {noise}) with page between them are cut",
            len(split_at_background_gutters(pair)) == 2,
            str(split_at_background_gutters(pair)),
        ))
        results.append(check(
            f"a single PLAIN tile (texture {noise}) is NOT cut",
            split_at_background_gutters(plain(noise=noise)) == [],
        ))

    results.append(check(
        "two tiles of DIFFERENT colours are still cut apart",
        len(split_at_background_gutters(
            np.hstack([plain(base=238), gap(800), plain(base=214, seed=9)])
        )) == 2,
    ))

    single = tile_patch(400, 800, ((201, 190, 173), (183, 173, 157)))
    results.append(check(
        "a single patterned tile is NOT cut",
        split_at_background_gutters(single) == [],
        str(split_at_background_gutters(single)),
    ))

    rng = np.random.default_rng(3)
    plain = (np.full((800, 400, 3), 200, np.uint8)
             + rng.normal(0, 4, (800, 400, 3))).clip(0, 255).astype(np.uint8)
    results.append(check(
        "a plain noisy tile is NOT cut (sensor noise is not a gutter)",
        split_at_background_gutters(plain) == [],
    ))

    two = np.hstack([single, gap(800), single])
    pieces = split_at_background_gutters(two)
    results.append(check(
        f"two tiles with page between them are cut apart ({len(pieces)} pieces)",
        len(pieces) == 2, str(pieces),
    ))
    if len(pieces) == 2:
        widths = [x2 - x1 for x1, _y1, x2, _y2 in pieces]
        results.append(check(
            f"each piece is one tile, the white band belongs to neither "
            f"(widths {widths})",
            all(abs(w - 400) <= 8 for w in widths),
        ))

    stacked = np.vstack([single, gap(60, 400), single])
    results.append(check(
        "a horizontal gutter is found too",
        len(split_at_background_gutters(stacked)) == 2,
    ))

    three = np.hstack([single, gap(800), single, gap(800), single])
    results.append(check(
        "three tiles become three pieces",
        len(split_at_background_gutters(three)) == 3,
    ))

    results.append(check(
        "the splitter is wired into mine_tile_regions",
        "split_at_background_gutters" in
        inspect.getsource(pipeline.mine_tile_regions),
    ))
    return results


def size_floor_checks():
    """A narrow product must not be dropped for being narrow."""
    results = []
    too_small = getattr(
        pipeline, "is_too_small_for_a_product",
        lambda w, h: w < 200 or h < 200,   # the old flat floor
    )

    keep = [
        (150, 900, "a 75x300mm subway tile, narrow but large"),
        (200, 200, "a small square swatch at the floor"),
        (240, 1200, "a long plank"),
        (900, 900, "an ordinary tile"),
    ]
    for w, h, label in keep:
        results.append(check(f"{label} ({w}x{h}) is KEPT", not too_small(w, h)))

    drop = [
        (64, 64, "an icon"),
        (180, 180, "a small logo"),
        (32, 400, "a hairline rule"),
        (0, 0, "a degenerate size"),
    ]
    for w, h, label in drop:
        results.append(check(f"{label} ({w}x{h}) is dropped", too_small(w, h)))

    results.append(check(
        "candidates dropped for size are counted, not silently discarded",
        "too_small_skipped" in inspect.getsource(pipeline.extract_images_from_pdf),
    ))
    return results


def shape_question_is_narrow_checks():
    """complete_rectangle must reject curves -- and nothing else.

    The first wording also told the verifier to answer FALSE when "the
    frame shows only a PART of a product, with its real edges nowhere to
    be seen". A region crop is cut TIGHT to the tile, so its edges are
    exactly that, and the whole Exotica catalog came back with two
    images. The question now asks only about a visibly curved outline,
    and says to answer TRUE when unsure.
    """
    prompt = flat(gemini_service.TILE_PURITY_PROMPT)
    results = []

    results.append(check(
        "a tight full-frame crop is explicitly called a complete rectangle",
        "crop cut tight to a tile" in prompt and "edge to edge" in prompt,
    ))
    results.append(check(
        "not seeing a border is stated to mean the crop was CORRECT",
        "extraction was CORRECT" in prompt,
    ))
    results.append(check(
        "the old 'edges nowhere to be seen' rejection is gone",
        "real edges nowhere to be seen" not in prompt,
    ))
    results.append(check(
        "the verifier is told to answer TRUE when unsure",
        "If you are unsure, answer TRUE" in prompt,
    ))
    results.append(check(
        "a wrong FALSE is named as the costly error",
        "deletes a real product" in prompt,
    ))
    for shape in ("an arch", "domed", "semicircle", "oval"):
        results.append(check(
            f"a curved outline ({shape}) is still a FALSE",
            shape in prompt,
        ))

    # The rule itself is unchanged: a curved outline still rejects, a
    # straight one still passes.
    results.append(check(
        "a curved outline is still REJECTED by the rule",
        verdict_for(observation("TILE", complete_rectangle=False))[0] == "REJECT",
    ))
    results.append(check(
        "a straight-edged tile is still ACCEPTED",
        verdict_for(observation("TILE", complete_rectangle=True))[0] == "ACCEPT",
    ))
    return results


def mosaic_picture_checks():
    """A mosaic sheet is a product; a mosaic PICTURE is artwork.

    Two images that did survive the Exotica run were mosaic murals -- a
    face and flowers. MOSAIC normalizes to a tile material, so a picture
    laid up in tesserae walked through as a product.
    """
    prompt = flat(gemini_service.TILE_PURITY_PROMPT)
    results = [
        check("the prompt separates a mosaic SHEET from a mosaic PICTURE",
              "composes into an image" in prompt),
        check("a depicted face/figure/flowers is named as ARTWORK",
              "is ARTWORK, and must be reported as ARTWORK" in prompt),
        check("a tile face still counts for contains_person",
              "even one made entirely of tile" in prompt),
        check("an ornament with no subject in it stays a pattern",
              "An ornament with no subject in it is NOT a picture" in prompt
              and "a medallion, a" in prompt),
        check("the re-ask also keeps a subjectless medallion a product",
              "ornamental medallion or rosette with no subject in it"
              in flat(gemini_service.PRODUCT_OR_ARTWORK_PROMPT)),
        check("a plain mosaic SHEET is still a product",
              verdict_for(observation("MOSAIC"))[0] == "ACCEPT"),
        check("a mosaic reported as ARTWORK is REJECTED",
              verdict_for(observation("ARTWORK"))[0] == "REJECT"),
        check("a mosaic picture with a face is REJECTED",
              verdict_for(observation("MOSAIC", contains_person=True))[0] == "REJECT"),
    ]

    # THE SECOND QUESTION HAD TO AGREE, OR THE FIRST ONE DOES NOTHING.
    #
    # "ARTWORK for a physical surface" is a contradiction, and
    # verify_tile_only re-asks it as product-or-picture. That re-ask
    # prompt argued the rescuing side only: "Being ornate, floral,
    # framed, colourful or unlike a plain square tile does not stop it
    # being a product". A mosaic mural of flowers has every PRODUCT cue
    # it lists -- real light, real shadow, real tesserae -- so it came
    # back PRODUCT and the purity verdict was overwritten. Teaching the
    # first question about murals changed nothing on its own.
    reask = flat(gemini_service.PRODUCT_OR_ARTWORK_PROMPT)
    results.extend([
        check("the re-ask asks whether the surface DEPICTS a subject",
              "does this DEPICT a subject" in reask),
        check("the depiction test is stated to outrank the material cues",
              "EVEN WHEN EVERY PRODUCT CUE" in reask),
        check("an all-over design is still a product in the re-ask",
              "ALL-OVER DESIGN is a product" in reask),
        check("a single composed picture is artwork in the re-ask",
              "SINGLE PICTURE, composed to be looked at, is ARTWORK" in reask),
        check("real tesserae do not make a mural a product",
              "A mosaic mural is still a mural." in reask),
    ])

    # And the rule end to end, through the real verifier: the re-ask
    # decides, and either answer is honoured.
    for verdict, material, expect in (
        ("PRODUCT", MATERIAL_DECOR, "ACCEPT"),
        ("ARTWORK", None, "REJECT"),
    ):
        obs = verify_with_model(
            purity={**observation("ARTWORK"), "physical_surface": True},
            reask=verdict,
        )
        got = verdict_for(obs)[0] if obs else "NO VERDICT"
        results.append(check(
            f"a contradictory ARTWORK verdict re-asked as {verdict} -> {expect}",
            got == expect,
            f"got {got} with material={obs and obs.get('material')}",
        ))
        if material is not None:
            results.append(check(
                f"a {verdict} second opinion normalizes as a product",
                normalize_material(obs["material"]) == material,
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
        ("the same product is not extracted twice in one catalog",
         catalog_duplicate_checks()),
        ("every prompt field survives the parser", observation_plumbing_checks()),
        ("the shape question rejects curves and nothing else",
         shape_question_is_narrow_checks()),
        ("a mosaic picture is artwork, a mosaic sheet is a product",
         mosaic_picture_checks()),
        ("the report accounts for every candidate",
         report_accounting_checks()),
        ("a product box may trim background, never the product",
         bbox_trim_checks()),
        ("cutting something up cannot launder a non-tile verdict",
         split_laundering_checks()),
        ("a product is never a building", structure_word_checks()),
        ("a catalog reproduction is not a printed graphic",
         printed_graphic_checks()),
        ("a panel is not a landmark, a wall is not a sample",
         landmark_and_wall_checks()),
        ("only the tile, not the page it was printed on",
         page_trim_checks()),
        ("half a product is finished, not refused", grow_checks()),
        ("a hero bled off the page is not a product",
         page_bleed_checks()),
        ("one product is never carved into pieces",
         one_product_split_checks()),
        ("two tiles in one crop are cut apart", gutter_split_checks()),
        ("a narrow product is not dropped for being narrow", size_floor_checks()),
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
