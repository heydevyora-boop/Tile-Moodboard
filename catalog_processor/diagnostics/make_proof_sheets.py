"""Build viewable proof sheets from the real catalog extraction.

Produces:
  1. extracted_products.png   -- all 9 products from the real 3-page
                                 catalog, as the 1024x1024 files that
                                 would be uploaded.
  2. before_after_highlighter.png -- the same product through the OLD
                                 code path (size-label centre crop +
                                 no-upscale canvas) and the NEW one.
  3. before_after_small.png   -- a small valid crop, old vs new canvas.
"""

import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import fitz  # noqa: E402

import main_step6_complete as pipeline  # noqa: E402
from app.image_processor import NEUTRAL_BACKGROUND_BGR, fit_to_output_canvas  # noqa: E402
from app.tile_region_extractor import (  # noqa: E402
    MAX_PAGE_SOURCE_COVERAGE,
    extract_tile_region,
)

PDF = HERE.parent / "single_catalog" / "18_mozart_frame_collection.pdf (1).pdf"
OUT = HERE / "proof"


def old_canvas(image_bgr, canvas_size=1024):
    """The pre-fix presentation: never enlarge."""
    h, w = image_bgr.shape[:2]
    scale = min(canvas_size / w, canvas_size / h, 1.0)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    resized = (cv2.resize(image_bgr, (nw, nh), interpolation=cv2.INTER_AREA)
               if scale < 0.999 else image_bgr)
    canvas = np.full((canvas_size, canvas_size, 3), NEUTRAL_BACKGROUND_BGR, np.uint8)
    x0, y0 = (canvas_size - nw) // 2, (canvas_size - nh) // 2
    canvas[y0:y0 + nh, x0:x0 + nw] = resized
    return canvas


def label_strip(width, text, height=64, bg=(255, 255, 255)):
    strip = np.full((height, width, 3), bg, np.uint8)
    cv2.putText(strip, text, (16, 44), cv2.FONT_HERSHEY_SIMPLEX, 1.1,
                (20, 20, 20), 2, cv2.LINE_AA)
    return strip


def product_crops():
    doc = fitz.open(str(PDF))
    out = []
    for page_number in (1, 2, 3):
        page = doc[page_number - 1]
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
            [tuple(int(v) for v in stats[i][:4]) for i in range(1, n)
             if stats[i][2] >= 120 and stats[i][3] >= 120],
            key=lambda b: b[0],
        )
        for idx, (x, y, w, h) in enumerate(boxes, start=1):
            quad = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
            crop, _info = extract_tile_region(
                page_bgr, quad, [], max_source_coverage=MAX_PAGE_SOURCE_COVERAGE,
            )
            if crop is not None:
                out.append((f"page {page_number} - product {idx}", crop))
    doc.close()
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    crops = product_crops()
    print(f"{len(crops)} products extracted from the real catalog")

    # ---- 1. contact sheet of every final upload image -----------------
    cells = []
    for name, crop in crops:
        canvas = fit_to_output_canvas(crop)
        thumb = cv2.resize(canvas, (420, 420), interpolation=cv2.INTER_AREA)
        cells.append(np.vstack([label_strip(420, name, 48), thumb]))

    rows = []
    for i in range(0, len(cells), 3):
        row = cells[i:i + 3]
        while len(row) < 3:
            row.append(np.full_like(cells[0], 255))
        rows.append(np.hstack(row))
    sheet = np.vstack(rows)
    header = label_strip(sheet.shape[1],
                         "EXTRACTED PRODUCTS - 18_mozart_frame_collection "
                         "(each 1024x1024, as uploaded)", 70)
    cv2.imwrite(str(OUT / "extracted_products.png"), np.vstack([header, sheet]))

    # ---- 2. before / after on the floral highlighter panel -----------
    name, hero = crops[1]  # page 1, product 2 -- the floral decor panel
    ratio = pipeline.parse_product_aspect_ratio("600x600")
    damaged = pipeline.crop_image_to_aspect_ratio(
        Image.fromarray(cv2.cvtColor(hero, cv2.COLOR_BGR2RGB)), ratio,
    )
    damaged_bgr = cv2.cvtColor(np.asarray(damaged), cv2.COLOR_RGB2BGR)

    before = old_canvas(damaged_bgr)
    after = fit_to_output_canvas(hero)
    def titled(img, text, bg):
        return np.vstack([label_strip(img.shape[1], text, 70, bg), img])

    def side_by_side(left, right):
        h = max(left.shape[0], right.shape[0])
        out = []
        for img in (left, right):
            pad = np.full((h - img.shape[0], img.shape[1], 3), 255, np.uint8)
            out.append(np.vstack([img, pad]) if pad.size else img)
        return np.hstack(out)

    pair = side_by_side(
        titled(before, "BEFORE - 600x600 label centre-crop", (235, 235, 255)),
        titled(after, "AFTER - complete product, no padding", (235, 255, 235)),
    )
    cv2.imwrite(str(OUT / "before_after_highlighter.png"), pair)
    print(f"hero: source {hero.shape[1]}x{hero.shape[0]} -> "
          f"damaged {damaged_bgr.shape[1]}x{damaged_bgr.shape[0]}")

    # ---- 3. before / after for a small valid crop --------------------
    small = cv2.resize(hero, (300, 600), interpolation=cv2.INTER_AREA)
    pair2 = side_by_side(
        titled(old_canvas(small), "BEFORE - padded square, tile small",
               (235, 235, 255)),
        titled(fit_to_output_canvas(small), "AFTER - tile alone, full size",
               (235, 255, 235)),
    )
    cv2.imwrite(str(OUT / "before_after_small.png"), pair2)

    for f in sorted(OUT.iterdir()):
        print(" ", f.name, f"{f.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
