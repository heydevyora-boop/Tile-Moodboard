"""Diagnostic harness: capture stages A-G for real catalog candidates.

Drives the REAL pipeline functions (render_image_crop, extract_tile_region,
crop_image_to_validated_bbox, crop_image_to_aspect_ratio, split_tile_designs,
fit_to_output_canvas) over the REAL source PDF pixels.

LIMITATION, stated plainly: no GEMINI_API_KEY is configured in this
environment, so detect_tile_regions cannot be called and the REAL quads from
the failing production run cannot be captured. Stage B quads here are derived
geometrically from the page's own ink (tight bounding boxes of the non-white
product blocks), i.e. they represent a CORRECT detector. That makes everything
downstream of B a fair test of the processing chain: if a correct region still
produces a bad final image, the fault is in the processing, not the detector.

Run: python3 diagnostics/stage_harness.py
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
from app.image_processor import OUTPUT_CANVAS_SIZE, fit_to_output_canvas  # noqa: E402
from app.tile_region_extractor import extract_tile_region, split_tile_designs  # noqa: E402

PDF = HERE.parent / "single_catalog" / "18_mozart_frame_collection.pdf (1).pdf"
OUT = HERE / "stages"


def product_boxes(bgr, min_side=120):
    """Tight bounding boxes of the distinct product blocks on a page render."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    ink = (gray < 246).astype(np.uint8) * 255
    ink = cv2.morphologyEx(
        ink, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (25, 25)),
    )
    n, _lab, stats, _c = cv2.connectedComponentsWithStats(ink, connectivity=8)
    boxes = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if w >= min_side and h >= min_side and area > 0.2 * w * h:
            boxes.append((x, y, x + w, y + h))
    boxes.sort(key=lambda b: b[0])
    return boxes


def save(img_bgr, name):
    OUT.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(OUT / name), img_bgr)
    h, w = img_bgr.shape[:2]
    return w, h


def main():
    doc = fitz.open(str(PDF))
    rows = []

    for page_number in (1, 2, 3):
        page = doc[page_number - 1]
        page_bytes, pw, ph = pipeline.render_image_crop(
            page, page.rect, dpi=pipeline.PAGE_RENDER_DPI,
        )
        page_bgr = cv2.imdecode(
            np.frombuffer(page_bytes, np.uint8), cv2.IMREAD_COLOR,
        )
        save(page_bgr, f"p{page_number}_A_page_render.png")

        boxes = product_boxes(page_bgr)
        overlay = page_bgr.copy()
        for i, (x1, y1, x2, y2) in enumerate(boxes, start=1):
            cv2.rectangle(overlay, (x1, y1), (x2, y2), (0, 0, 255), 6)
            cv2.putText(overlay, str(i), (x1 + 10, y1 + 70),
                        cv2.FONT_HERSHEY_SIMPLEX, 2.0, (0, 0, 255), 5)
        save(overlay, f"p{page_number}_B_quads.png")

        for index, (x1, y1, x2, y2) in enumerate(boxes, start=1):
            tag = f"p{page_number}_c{index}"
            quad = [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]

            # Stage C -- the real region extractor, with the real
            # rendered-page coverage limit the pipeline applies.
            crop, info = extract_tile_region(
                page_bgr, quad, [],
                max_source_coverage=pipeline.MAX_PAGE_SOURCE_COVERAGE
                if hasattr(pipeline, "MAX_PAGE_SOURCE_COVERAGE") else 0.92,
            )
            if crop is None:
                rows.append((tag, "C", "REJECTED by extract_tile_region",
                             info.get("reason", "")))
                continue
            cw, ch = save(crop, f"{tag}_C_raw_crop.png")

            # Stage D -- bbox correction (full-frame bbox = no-op here, which
            # is what a region candidate with no classifier bbox receives).
            pil = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
            d = pipeline.crop_image_to_validated_bbox(
                pil, {"x1": 0, "y1": 0, "x2": pil.width, "y2": pil.height},
            )
            dw, dh = d.size

            # Stage E -- the aspect-ratio correction, driven by a size label.
            # This catalog has NO page text, so in production nothing fires
            # here. Both are shown: as-shipped (no label) and the
            # cross-contamination case (a neighbouring "600x600" label).
            e_none = pipeline.crop_image_to_aspect_ratio(d, None)
            e_600 = pipeline.crop_image_to_aspect_ratio(
                d, pipeline.parse_product_aspect_ratio("600x600"),
            )
            e_none.save(OUT / f"{tag}_E_noLabel.png")
            e_600.save(OUT / f"{tag}_E_label600x600.png")

            # Stage F -- splitter, asked for 2 pieces, to see whether one
            # continuous moulded panel gets cut apart.
            pieces = split_tile_designs(crop, max_pieces=2)

            # Stage G -- final presentation canvas.
            g = fit_to_output_canvas(
                cv2.cvtColor(np.asarray(e_none.convert("RGB")), cv2.COLOR_RGB2BGR),
            )
            gw, gh = save(g, f"{tag}_G_canvas.png")
            ink = (cv2.cvtColor(g, cv2.COLOR_BGR2GRAY) < 243)
            ys, xs = np.nonzero(ink)
            prod_w = xs.max() - xs.min() + 1 if xs.size else 0
            prod_h = ys.max() - ys.min() + 1 if ys.size else 0

            rows.append((
                tag,
                f"C {cw}x{ch} r={cw/ch:.2f}",
                f"E_none {e_none.width}x{e_none.height} r={e_none.width/e_none.height:.2f}"
                f" | E_600 {e_600.width}x{e_600.height} r={e_600.width/e_600.height:.2f}"
                f" | lost {100*(1-(e_600.width*e_600.height)/(dw*dh)):.0f}%",
                f"F pieces={len(pieces)} | G {gw}x{gh} product {prod_w}x{prod_h}"
                f" fills {100*max(prod_w,prod_h)/gw:.0f}% of canvas",
            ))

    print(f"canvas size = {OUTPUT_CANVAS_SIZE}")
    print("=" * 110)
    for r in rows:
        print(f"{r[0]:8} {r[1]}")
        print(f"         {r[2]}")
        print(f"         {r[3]}")
    print("=" * 110)
    print(f"artifacts in {OUT}")


if __name__ == "__main__":
    main()
