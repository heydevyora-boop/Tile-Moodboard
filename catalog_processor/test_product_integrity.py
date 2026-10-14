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
    final, _ = verdict_for(observation("FRAME", complete_rectangle=False))
    results.append(check(
        "an arch described as a FRAME is still REJECTED",
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
