"""Regression: conservative pre-Gemini hard filters, and a cross-check
that Chunks 1-3 are still intact.

THE FAILURE THIS COVERS
------------------------
Every embedded image extract_images_from_pdf examines used to go
straight to classify_image_content() and then, almost always, to a
Gemini call -- even a pure solid-colour highlighter-style bar with no
tile anywhere in it, or a scanned/rendered block of printed text. Both
cost a Gemini call for a verdict that is already decidable from pixels
alone, and both can only ever end in REJECT, so paying for that verdict
is pure waste on a catalog of any size.

THE RISK THIS TEST GUARDS AGAINST MOST
---------------------------------------
A hard filter that fires before Gemini ever sees the image can also
silently delete a real product, with no model and no human in the loop
to catch it -- a worse failure than the one being fixed. So the
overwhelming majority of this file is NOT testing that the two filters
catch bad content; it is testing that they do NOT catch a long list of
genuine, if plain, photographed tiles: a flatly-lit solid colour tile,
one with grout lines, marble/stone with natural veining, a two-tone
GEOMETRIC MOSAIC tile (the closest real product to "looks like a solid
colour swatch"), and a fine small-repeat pattern tile (the closest real
product to "looks like printed text" once sensor noise is factored in
-- see classify_hard_reject's own comments for the measurements behind
every threshold).

WHAT THIS FILE CHECKS
----------------------
1. is_flat_graphic_image() / is_mostly_text_image() against every case
   above, run through the REAL functions (not reimplemented here).
2. classify_hard_reject() combining both.
3. That the filters are wired into extract_images_from_pdf's own loop
   (not just defined and never called) and that a page mixing a real
   tile with a pure colour bar and a text block keeps only the tile.
4. A short cross-check that Chunks 1-3 are still present and working:
   page filtering (should_skip_page), the strengthened SYSTEM_PROMPT
   (Section 8A plus the four REJECT sub-sections), and the same-page
   sibling dedup fix (signature_already_seen's embedded-vs-embedded
   guard) -- run from THIS file so one command confirms all four
   chunks together, the way a final-chunk sanity pass should.

Run:  GEMINI_API_KEY=test python3 test_early_hard_filters.py
"""

import io
import os
import shutil
import sys
from pathlib import Path

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-used")

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
import cv2  # noqa: E402
from PIL import Image, ImageDraw, ImageFilter  # noqa: E402

import main_step6_complete as pipeline  # noqa: E402
from app.image_extractor import should_skip_page  # noqa: E402
from app.devyora_system_prompt import DEVYORA_SYSTEM_PROMPT  # noqa: E402

OUT = Path(__file__).resolve().parent / "output" / "early_hard_filters_test"


def check(label, ok, detail=""):
    return (label, bool(ok), detail)


def png_bytes(image):
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


# ----------------------------------------------------------------------
# Synthetic content -- same shapes used to calibrate the thresholds,
# rebuilt here independently rather than imported, so this test does not
# silently pass if the calibration script's helpers ever drift.
# ----------------------------------------------------------------------

def photographic_tile(rgb, size=400, seed=1, noise=6, vignette=0.35):
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:size, 0:size]
    cx, cy = size * 0.5, size * 0.45
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / (size * 0.9)
    field = np.array(rgb, dtype=np.float32)[None, None, :] * (
        1 - vignette * np.clip(dist, 0, 1)
    )[:, :, None]
    field += rng.normal(0, noise, (size, size, 3))
    return Image.fromarray(np.clip(field, 0, 255).astype("uint8")).filter(
        ImageFilter.GaussianBlur(0.6)
    )


def tile_with_grout(rgb, size=400, cell=90, seed=2):
    base = photographic_tile(rgb, size=size, seed=seed)
    arr = np.array(base)
    for x in range(0, size, cell):
        arr[:, max(0, x - 1):x + 1] = (120, 112, 100)
    for y in range(0, size, cell):
        arr[max(0, y - 1):y + 1, :] = (120, 112, 100)
    return Image.fromarray(arr)


def marble_like(size=400, seed=4):
    rng = np.random.default_rng(seed)
    noise = rng.normal(0, 1, (size, size))
    for _ in range(3):
        noise = cv2.GaussianBlur(noise.astype(np.float32), (0, 0), sigmaX=8)
    noise = (noise - noise.min()) / (noise.max() - noise.min())
    base = np.array([230, 225, 215], dtype=np.float32)
    vein = np.array([120, 110, 100], dtype=np.float32)
    arr = base[None, None, :] * (1 - noise[:, :, None]) + vein[None, None, :] * noise[:, :, None]
    arr += rng.normal(0, 5, arr.shape)
    return Image.fromarray(np.clip(arr, 0, 255).astype("uint8"))


def geometric_mosaic(size=400, cell=40, seed=3):
    """The closest real product to 'looks like a solid colour swatch':
    a sharp two-tone tile pattern, still a genuine catalog item."""
    arr = np.zeros((size, size, 3), dtype=np.uint8)
    for y in range(size):
        for x in range(size):
            arr[y, x] = (245, 245, 240) if ((x // cell) + (y // cell)) % 2 == 0 else (25, 25, 28)
    img = Image.fromarray(arr)
    rng = np.random.default_rng(seed)
    a = np.array(img).astype(np.float32)
    a += rng.normal(0, 4, a.shape)
    return Image.fromarray(np.clip(a, 0, 255).astype("uint8"))


def busy_small_motif_tile(size=400, cell=14, seed=30):
    """The closest real product to 'looks like printed text': a fine,
    small-repeat decorative pattern."""
    rng = np.random.default_rng(seed)
    arr = np.zeros((size, size, 3), dtype=np.uint8)
    for y in range(0, size, cell):
        for x in range(0, size, cell):
            colour = rng.integers(90, 220, size=3)
            arr[y:y + cell, x:x + cell] = colour
    img = Image.fromarray(arr)
    a = np.array(img).astype(np.float32)
    a += rng.normal(0, 4, a.shape)
    return Image.fromarray(np.clip(a, 0, 255).astype("uint8"))


def text_paragraph(size=(600, 800)):
    img = Image.new("RGB", size, (250, 248, 244))
    draw = ImageDraw.Draw(img)
    words = (
        "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod "
        "tempor incididunt ut labore et dolore magna aliqua Ut enim ad minim "
        "veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex "
        "ea commodo consequat "
    ).split()
    x, y, i = 20, 20, 0
    while y < size[1] - 30:
        line = ""
        while x < size[0] - 100:
            line += words[i % len(words)] + " "
            i += 1
            if len(line) > 55:
                break
        draw.text((20, y), line, fill=(20, 20, 20))
        y += 18
    return img


def spec_table(size=(700, 500)):
    img = Image.new("RGB", size, (252, 250, 247))
    draw = ImageDraw.Draw(img)
    cols = [20, 220, 380, 540]
    for y in range(40, 460, 40):
        draw.line([(20, y), (680, y)], fill=(180, 178, 174), width=1)
    for x, header in zip(cols, ("PRODUCT", "SIZE", "FINISH", "PRICE")):
        draw.text((x, 15), header, fill=(20, 20, 20))
    for row in range(10):
        y = 48 + row * 40
        draw.text((cols[0], y), f"Terra {row}", fill=(30, 30, 30))
        draw.text((cols[1], y), "600x600mm", fill=(30, 30, 30))
        draw.text((cols[2], y), "Matte", fill=(30, 30, 30))
        draw.text((cols[3], y), f"$4.{row:02d}", fill=(30, 30, 30))
    return img


def flat_bar(colour=(255, 230, 90), size=(400, 100)):
    return Image.new("RGB", size, colour)


# ----------------------------------------------------------------------
# 1. is_flat_graphic_image()
# ----------------------------------------------------------------------

def flat_graphic_filter_checks():
    results = []

    for colour in ((255, 230, 90), (10, 10, 10), (250, 250, 250), (90, 160, 210)):
        reject, reason = pipeline.is_flat_graphic_image(png_bytes(flat_bar(colour)))
        results.append(check(
            f"a solid {colour} colour bar is rejected", reject, reason,
        ))

    # JPEG recompression noise must not be enough to save it.
    buffer = io.BytesIO()
    flat_bar().save(buffer, "JPEG", quality=90)
    reject, _reason = pipeline.is_flat_graphic_image(buffer.getvalue())
    results.append(check(
        "a JPEG-recompressed colour bar is still rejected", reject,
    ))

    real_tiles = {
        "plain flatly-lit tile": photographic_tile((210, 195, 175)),
        "plain tile, low noise": photographic_tile((210, 195, 175), noise=1, vignette=0.05, seed=99),
        "tile with grout lines": tile_with_grout((210, 195, 175)),
        "marble/stone": marble_like(),
        "two-tone geometric mosaic": geometric_mosaic(),
        "fine small-repeat pattern": busy_small_motif_tile(),
    }
    for name, image in real_tiles.items():
        reject, reason = pipeline.is_flat_graphic_image(png_bytes(image))
        results.append(check(
            f"a real tile ({name}) is NOT rejected as a flat graphic",
            not reject, reason or "kept",
        ))

    return results


# ----------------------------------------------------------------------
# 2. is_mostly_text_image()
# ----------------------------------------------------------------------

def text_filter_checks():
    results = []

    text_cases = {
        "dense paragraph": text_paragraph(),
        "sparse price list": spec_table(),  # ruled table exercises grid lines too
    }
    for name, image in text_cases.items():
        reject, reason = pipeline.is_mostly_text_image(png_bytes(image))
        results.append(check(f"a {name} is rejected as mostly text", reject, reason))

    real_tiles = {
        "plain flatly-lit tile": photographic_tile((210, 195, 175)),
        "tile with grout lines": tile_with_grout((210, 195, 175)),
        "marble/stone": marble_like(),
        "two-tone geometric mosaic": geometric_mosaic(),
        "fine small-repeat pattern": busy_small_motif_tile(),
        "darker plain tile": photographic_tile((90, 85, 80), seed=12),
    }
    for name, image in real_tiles.items():
        reject, reason = pipeline.is_mostly_text_image(png_bytes(image))
        results.append(check(
            f"a real tile ({name}) is NOT rejected as mostly text",
            not reject, reason or "kept",
        ))

    # A flat colour bar has no text structure either -- must not be
    # caught by this filter (it is caught, correctly, by the other one).
    reject, _reason = pipeline.is_mostly_text_image(png_bytes(flat_bar()))
    results.append(check(
        "a flat colour bar is not independently flagged as text", not reject,
    ))

    return results


# ----------------------------------------------------------------------
# 3. classify_hard_reject() and real pipeline wiring
# ----------------------------------------------------------------------

def combined_filter_checks():
    results = []
    reject, reason = pipeline.classify_hard_reject(png_bytes(flat_bar()))
    results.append(check("classify_hard_reject rejects a colour bar", reject, reason))

    reject, reason = pipeline.classify_hard_reject(png_bytes(text_paragraph()))
    results.append(check("classify_hard_reject rejects a text block", reject, reason))

    reject, reason = pipeline.classify_hard_reject(png_bytes(geometric_mosaic()))
    results.append(check(
        "classify_hard_reject keeps a real two-tone mosaic tile",
        not reject, reason or "kept",
    ))
    reject, reason = pipeline.classify_hard_reject(png_bytes(busy_small_motif_tile()))
    results.append(check(
        "classify_hard_reject keeps a real fine-pattern tile",
        not reject, reason or "kept",
    ))

    return results


def build_mixed_page_pdf(path):
    """One PDF page embedding three images: a real tile, a pure colour
    bar, and a text block -- the exact mix extract_images_from_pdf must
    reduce to one accepted product."""
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=700, height=900)

    tile_png = png_bytes(photographic_tile((200, 190, 170), seed=7))
    bar_png = png_bytes(flat_bar(size=(500, 80)))
    text_png = png_bytes(text_paragraph(size=(500, 300)))

    page.insert_image(fitz.Rect(40, 40, 440, 440), stream=tile_png)
    page.insert_image(fitz.Rect(40, 460, 540, 540), stream=bar_png)
    page.insert_image(fitz.Rect(40, 560, 540, 860), stream=text_png)

    doc.save(str(path))
    doc.close()


def integration_mixed_page_through_real_pipeline():
    directory = OUT / "mixed_page"
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True, exist_ok=True)

    pdf_path = directory / "mixed.pdf"
    build_mixed_page_pdf(pdf_path)

    import app.gemini_service as gemini_service
    real_verify = gemini_service.verify_tile_only

    def fake_purity(_path):
        return {
            "tile_fraction": 1.0, "material": "TILE",
            "contains_person": False, "contains_text": False,
            "contains_logo": False, "contains_furniture": False,
            "contains_fixture": False, "contains_object": False,
            "is_scene": False, "physical_surface": True,
            "distinct_tile_designs": 1, "reason": "synthetic",
        }

    gemini_service.verify_tile_only = fake_purity
    real_tile_only = pipeline.TILE_ONLY_CATALOG
    pipeline.TILE_ONLY_CATALOG = True

    captured = io.StringIO()
    import contextlib
    try:
        with contextlib.redirect_stdout(captured):
            images = pipeline.extract_images_from_pdf(pdf_path, directory)
    finally:
        gemini_service.verify_tile_only = real_verify
        pipeline.TILE_ONLY_CATALOG = real_tile_only

    log = captured.getvalue()

    return [
        check(
            f"exactly one product survives the mixed page ({len(images)})",
            len(images) == 1, f"got {len(images)}",
        ),
        check(
            "the hard filter actually fired on this page",
            "HARD FILTER" in log,
        ),
        check(
            "the hard-filtered count in the log is 2 (the bar and the text block)",
            "Hard-filtered (graphic/text): 2" in log,
            [line for line in log.splitlines() if "Hard-filtered" in line],
        ),
    ]


# ----------------------------------------------------------------------
# 4. Cross-check: Chunks 1-3 are still intact
# ----------------------------------------------------------------------

def chunk_1_page_filtering_intact():
    """should_skip_page: page 1 always skipped; a keyword page skipped;
    a normal product page kept. Full coverage lives in
    test_page_filtering.py; this is a short presence/sanity check."""
    return [
        check("page 1 is still always skipped",
              should_skip_page(1, "anything", [(900, 900)])),
        check("an index page is still skipped",
              should_skip_page(2, "TABLE OF CONTENTS", [])),
        check("a normal product page with a large image is still kept",
              not should_skip_page(2, "Terra Grey 600x600mm", [(900, 900)])),
    ]


def chunk_2_system_prompt_intact():
    """The four strengthened REJECT sections and the 8A bathroom section
    are still present in SYSTEM_PROMPT. Full coverage lives in
    gemini_service.py's own prompt; this is a presence check."""
    markers = [
        "LOGOS, BRAND MARKS, BANNERS, TEXT GRAPHICS",
        "COVER / INSTRUCTION-STYLE IMAGES",
        "COLOR BARS / HIGHLIGHTER-STYLE ANNOTATION MARKS",
        "LIFESTYLE, ROOM SCENES, COLLAGES",
        "When uncertain between APPROVE and REJECT",
    ]
    import app.gemini_service as gemini_service
    prompt = gemini_service.SYSTEM_PROMPT
    results = [
        check(f'SYSTEM_PROMPT still contains "{marker[:40]}..."', marker in prompt)
        for marker in markers
    ]
    results.append(check(
        "8A. BATHROOM FUNCTIONAL COMPLETENESS is still in the doctrine",
        "8A. BATHROOM FUNCTIONAL COMPLETENESS" in DEVYORA_SYSTEM_PROMPT,
    ))
    return results


def chunk_3_highlighter_dedup_intact():
    """signature_already_seen: two separate embedded-image sources with
    no geometry are still not merged by appearance, and a true
    cross-route repeat is still caught. Full coverage lives in
    test_same_page_sibling_variants.py; this is a presence/sanity check."""
    from app.tile_region_extractor import content_signature

    base = cv2.cvtColor(
        np.full((40, 40, 3), (200, 190, 170), dtype=np.uint8), cv2.COLOR_RGB2BGR,
    )
    highlighter = cv2.cvtColor(
        np.full((40, 40, 3), (204, 193, 169), dtype=np.uint8), cv2.COLOR_RGB2BGR,
    )
    base_sig = content_signature(base)
    hl_sig = content_signature(highlighter)

    seen = [("embedded-image:base.webp", base_sig, None)]
    not_merged = not pipeline.signature_already_seen(
        seen, hl_sig, source_key="embedded-image:highlighter.webp", page_box=None,
    )

    seen_render = [("rendered-page:page_1_render.webp", base_sig, None)]
    true_repeat_caught = pipeline.signature_already_seen(
        seen_render, base_sig, source_key="embedded-image:base.webp", page_box=None,
    )

    return [
        check("same-page sibling sources are still not merged by appearance",
              not_merged),
        check("a true cross-route repeat is still caught",
              true_repeat_caught),
    ]


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)

    groups = [
        ("is_flat_graphic_image()", flat_graphic_filter_checks()),
        ("is_mostly_text_image()", text_filter_checks()),
        ("classify_hard_reject()", combined_filter_checks()),
        ("integration: a mixed page through the real pipeline",
         integration_mixed_page_through_real_pipeline()),
        ("cross-check: Chunk 1 (page filtering) is intact",
         chunk_1_page_filtering_intact()),
        ("cross-check: Chunk 2 (SYSTEM_PROMPT) is intact",
         chunk_2_system_prompt_intact()),
        ("cross-check: Chunk 3 (highlighter/sibling dedup) is intact",
         chunk_3_highlighter_dedup_intact()),
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
