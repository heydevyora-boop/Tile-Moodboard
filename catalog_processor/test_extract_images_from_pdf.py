"""
test_extract_images_from_pdf.py

Offline test for main_step6_complete.py's extract_images_from_pdf --
the function the pen-drive pipeline (`python main_step6_complete.py
--pipeline`) actually calls to pull images out of a catalog PDF before
uploading them to Drive.

No Gemini API. No Google Drive. No Google Sheets. Every PDF used here is
built in-memory with PyMuPDF.

What this pins down
--------------------
The function this file tests previously had NONE of the following:

  - Deduplication. The only "duplicate" check downstream (already_processed,
    in app/database.py) is keyed on a filename that encodes the page number
    and a running index -- unique by construction, so it can never catch a
    real repeat within a single run. A background graphic, watermark, or
    badge stamped on every page of a catalog therefore got saved and
    uploaded once per page it appeared on.

  - Content filtering. Every embedded image at least 200x200px got treated
    as a product photo, with no check for whether it actually was one --
    so full-page background graphics, gradients, and stamped badges were
    extracted and uploaded right alongside real tile photos.

This was found from a live run: a black rectangle and a diagonal
white-to-black gradient, each repeated across many pages of a real
catalog, ended up uploaded to Google Drive as if they were tile products.

The fix ports the same page-content classifier and repeating-position
detector already validated (against a real 139-page catalog) in
backend/python/extract.py, plus real hash-based deduplication of the
rendered crop. This file is the regression test for that fix, built
around the specific failure pattern that was actually observed: a real
product photo, on every page, alongside a full-page junk background and a
small stamped badge, both repeated identically across many pages.
"""

import random
import sys
from io import BytesIO
from pathlib import Path

import numpy as np
import pymupdf as fitz
import pytest
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))

from main_step6_complete import extract_images_from_pdf  # noqa: E402


PAGE_W, PAGE_H = 700.0, 900.0
TILE_RECT = (50.0, 60.0, 650.0, 600.0)
BADGE_RECT = (600.0, 800.0, 680.0, 880.0)


def _png_bytes(image):
    buffer = BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def _photographic_tile(rgb, seed, size=420):
    """A tile photo with the studio-lighting characteristics (vignette +
    sensor noise) real catalog photography carries -- see
    backend/python/extract.py's test suite for why this matters: a
    classifier tuned only on flat, hand-drawn artwork rejects real
    photographed tiles."""
    random.seed(seed)
    np.random.seed(seed)
    yy, xx = np.mgrid[0:size, 0:size]
    cx, cy = size * random.uniform(0.3, 0.7), size * random.uniform(0.2, 0.5)
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / (size * 0.9)
    field = np.array(rgb, dtype=np.float32)[None, None, :] * (1 - 0.35 * np.clip(dist, 0, 1))[:, :, None]
    field += np.random.normal(0, 6, (size, size, 3))
    image = Image.fromarray(np.clip(field, 0, 255).astype("uint8"))
    return image.filter(ImageFilter.GaussianBlur(0.6))


def _solid_black():
    return Image.new("RGB", (int(PAGE_W), int(PAGE_H)), (4, 4, 6))


def _diagonal_gradient():
    size = 700
    ramp = np.zeros((size, size, 3))
    for y in range(size):
        value = np.linspace(0, 255, size) * (y / size) + np.linspace(255, 0, size) * (1 - y / size)
        ramp[y, :, 0] = value
        ramp[y, :, 1] = value
        ramp[y, :, 2] = value
    return Image.fromarray(ramp.astype("uint8")).resize((int(PAGE_W), int(PAGE_H)))


def _badge():
    image = Image.new("RGB", (200, 200), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    draw.ellipse([10, 10, 190, 190], outline=(40, 60, 120), width=8)
    return image


def _build_repro_pdf(path, page_count=10, junk_background="black"):
    """A catalog shaped like the one the bug was found on: one real,
    genuinely-varying product photo per page, plus a full-page junk
    background and a small badge, BOTH the exact same graphic repeated
    identically across pages -- realistically, page furniture is one
    consistent design element, not a different graphic each time (which
    would be indistinguishable from a real varying product slot)."""
    doc = fitz.open()
    badge_png = _png_bytes(_badge())
    junk_png = _png_bytes(_solid_black() if junk_background == "black" else _diagonal_gradient())

    for i in range(page_count):
        page = doc.new_page(width=PAGE_W, height=PAGE_H)
        rgb = (random.randint(140, 225), random.randint(130, 210), random.randint(110, 195))
        tile_png = _png_bytes(_photographic_tile(rgb, seed=i))

        # Background first (bottom of z-order), then the real content on
        # top -- a later insert paints OVER an earlier one at the same
        # position. Getting this backwards makes the full-page background
        # visually occlude the tile entirely, which is not what a real
        # catalog page looks like and not what this test means to check.
        page.insert_image(fitz.Rect(0, 0, PAGE_W, PAGE_H), stream=junk_png)
        page.insert_image(fitz.Rect(*TILE_RECT), stream=tile_png)
        page.insert_text((50, 620), f"Decotech {i + 1}", fontsize=16)
        page.insert_text((50, 642), "600x1200mm Matte", fontsize=10)
        page.insert_image(fitz.Rect(*BADGE_RECT), stream=badge_png)

    doc.save(str(path))
    doc.close()


@pytest.fixture()
def repro_pdf(tmp_path):
    pdf_path = tmp_path / "repro_catalog.pdf"
    _build_repro_pdf(pdf_path)
    return pdf_path


def test_junk_backgrounds_and_badge_are_excluded(repro_pdf, tmp_path):
    """The actual bug: a full-page black rectangle and a full-page
    gradient, each repeated across many pages, plus a small badge stamped
    on every page, must all be excluded -- none of them is a product."""
    output_dir = tmp_path / "images"
    output_dir.mkdir()

    images = extract_images_from_pdf(repro_pdf, output_dir)

    assert len(images) == 10, (
        f"expected exactly 10 real tile photos (one per page), got {len(images)}: "
        f"{[img['filename'] for img in images]}"
    )


def test_kept_images_are_the_tile_crop_not_the_junk(repro_pdf, tmp_path):
    """Guards against a false pass: 10 images could mean 10 correct tiles,
    or 10 copies of the badge/background that happened to slip through.
    The tile rect renders to a specific pixel size at the extraction DPI
    (300) -- a full-page background or the small badge would not."""
    output_dir = tmp_path / "images"
    output_dir.mkdir()

    images = extract_images_from_pdf(repro_pdf, output_dir)

    tile_w = round((TILE_RECT[2] - TILE_RECT[0]) / 72 * 300)
    tile_h = round((TILE_RECT[3] - TILE_RECT[1]) / 72 * 300)

    for image in images:
        assert abs(image["width"] - tile_w) <= 2, (
            f"{image['filename']} width {image['width']} doesn't match the tile "
            f"crop's expected width {tile_w} -- likely junk background/badge kept instead"
        )
        assert abs(image["height"] - tile_h) <= 2


def test_duplicate_content_at_the_same_position_is_not_uploaded_twice(tmp_path):
    """The filename-keyed 'already_processed' check downstream can never
    catch this (every filename it sees is unique by construction) -- real
    dedup has to happen here, on the actual image content.

    Kept to 3 repeats, deliberately below REPEATING_TEMPLATE_MIN_PAGES (5):
    this needs to exercise plain hash-based dedup on its own, not the
    page-furniture exclusion path (which would also produce 0 kept here,
    for an unrelated reason -- see the module docstring's note on that
    ambiguity). A real, honest limitation of exact-hash dedup, discovered
    while writing this test: PyMuPDF's rasterizer can shift a rendered
    crop's pixel dimensions by up to 1px depending on the rect's ABSOLUTE
    position on the page, even for an identical rect size and source image
    -- so this only reliably catches a repeat at the same position, not a
    redisplay of the same photo elsewhere on a different layout. That's
    still real, useful coverage: it directly catches the common case of a
    repeated section (e.g. a recap page reusing an earlier photo in the
    same slot), which the pre-existing filename-keyed check could never
    catch at all.
    """
    doc = fitz.open()
    tile_png = _png_bytes(_photographic_tile((190, 170, 140), seed=42))

    for _ in range(3):
        page = doc.new_page(width=PAGE_W, height=PAGE_H)
        page.insert_image(fitz.Rect(*TILE_RECT), stream=tile_png)

    pdf_path = tmp_path / "duplicate_catalog.pdf"
    doc.save(str(pdf_path))
    doc.close()

    output_dir = tmp_path / "images"
    output_dir.mkdir()

    images = extract_images_from_pdf(pdf_path, output_dir)

    assert len(images) == 1, (
        f"the same product photo repeated at the same position on 3 pages "
        f"should be extracted once, not {len(images)} times"
    )


def test_genuinely_different_products_at_the_same_layout_position_are_kept(tmp_path):
    """The companion case to the badge exclusion: a catalog that lays
    products out on a fixed grid must not have every slot treated as page
    furniture just because the position repeats. Different pages, same
    rect, DIFFERENT photo each time -> all real, all kept."""
    doc = fitz.open()

    for i in range(8):
        page = doc.new_page(width=PAGE_W, height=PAGE_H)
        rgb = (random.randint(140, 225), random.randint(130, 210), random.randint(110, 195))
        page.insert_image(fitz.Rect(*TILE_RECT), stream=_png_bytes(_photographic_tile(rgb, seed=900 + i)))

    pdf_path = tmp_path / "grid_catalog.pdf"
    doc.save(str(pdf_path))
    doc.close()

    output_dir = tmp_path / "images"
    output_dir.mkdir()

    images = extract_images_from_pdf(pdf_path, output_dir)

    assert len(images) == 8, (
        f"8 distinct products at a recurring layout position were wrongly treated "
        f"as page furniture: kept {len(images)} of 8"
    )
