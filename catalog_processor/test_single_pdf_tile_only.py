"""End-to-end: one tile-only PDF, through process_pdf, twice.

This is the single-PDF workflow the extraction change has to satisfy,
run against the REAL process_pdf -- the same function the CLI calls --
with Drive, Sheets, the backend and the processed-files table replaced
by recording stubs. Extraction, region mining, geometry, dedup and
persist_tile are all the shipping code.

Three properties, and the second and third are the ones a change to
duplicate handling can quietly break:

  RUN 1   a page showing three tiles produces three tiles, three Drive
          files, three MASTER rows -- and no two Drive files hold the
          same image.

  RUN 2   the same PDF again produces no new Drive files at all. Every
          tile is recognised as already processed.

  RETRY   when one tile's upload fails, the other tiles are still
          recorded, and the next run retries ONLY the failed one. A
          page is not marked done because part of it succeeded.

Why a stubbed Drive is enough: the property under test is how many
distinct images the pipeline HANDS to Drive and which ones it hands
twice. That is entirely decided here; the real Drive client adds
nothing to it but latency.

Run:  GEMINI_API_KEY=test python3 test_single_pdf_tile_only.py
"""

import hashlib
import os
import shutil
import sys
from pathlib import Path

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-used")

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fitz  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import app.gemini_service as gemini_service  # noqa: E402
import main_step6_complete as pipeline  # noqa: E402
from app.image_validator import (  # noqa: E402
    validate_bbox,
    validate_product_decision,
)
from app.tile_region_extractor import extract_tile_region  # noqa: E402

OUT = Path(__file__).resolve().parent / "output" / "single_pdf_tile_only_test"

PAGES = 2
SHEET_W, SHEET_H = 1200, 900

# Where the sheet is placed on each PDF page, in points.
SHEET_RECT = (50.0, 100.0, 545.0, 472.0)
PAGE_W_PT, PAGE_H_PT = 595.0, 842.0

GROUT = (118, 110, 98)

# Three products per sheet, from one range -- one palette, one texture.
# Deliberately alike: siblings that look like each other are what the
# old appearance-based dedup was collapsing into a single "duplicate".
FAMILY = [
    ((201, 190, 173), (183, 173, 157)),
    ((205, 193, 170), (186, 175, 154)),
    ((198, 188, 176), (180, 170, 160)),
]

# Each product's box within the sheet, as fractions of it.
SLOTS = [
    (60 / SHEET_W, 80 / SHEET_H, 460 / SHEET_W, 420 / SHEET_H),
    (520 / SHEET_W, 80 / SHEET_H, 920 / SHEET_W, 420 / SHEET_H),
    (60 / SHEET_W, 470 / SHEET_H, 460 / SHEET_W, 810 / SHEET_H),
]

TILES_PER_PAGE = len(SLOTS)
EXPECTED_TILES = PAGES * TILES_PER_PAGE


def tile_patch(width, height, colours, cell):
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


def build_sheet(path, page_index):
    """One catalog sheet: three products of one range, side by side."""
    sheet = np.full((SHEET_H, SHEET_W, 3), 246, dtype=np.uint8)
    for slot, colours in zip(SLOTS, FAMILY):
        x1 = int(slot[0] * SHEET_W)
        y1 = int(slot[1] * SHEET_H)
        x2 = int(slot[2] * SHEET_W)
        y2 = int(slot[3] * SHEET_H)
        # Page 2 uses a different cell size so its three products are
        # genuinely different products from page 1's, not reprints.
        sheet[y1:y2, x1:x2] = tile_patch(
            x2 - x1, y2 - y1, colours, cell=26 + page_index * 12,
        )
    Image.fromarray(sheet, "RGB").save(path)


def build_pdf(path):
    document = fitz.open()
    for index in range(PAGES):
        page = document.new_page(width=PAGE_W_PT, height=PAGE_H_PT)
        source = OUT / f"_sheet_{index}.png"
        build_sheet(source, index)
        page.insert_image(fitz.Rect(*SHEET_RECT), filename=str(source))
    document.save(str(path))
    document.close()


def fake_detect(image_path, width, height):
    """Reports the three products, in whichever image it is shown.

    A rendered page carries the sheet inset in it, so the slots are
    mapped through the sheet's placement; an embedded image IS the
    sheet. Both routes therefore report the SAME three physical tiles,
    which is the condition that produced duplicate Drive files.
    """
    if "_render" in Path(image_path).name:
        x0 = SHEET_RECT[0] / PAGE_W_PT
        y0 = SHEET_RECT[1] / PAGE_H_PT
        span_x = (SHEET_RECT[2] - SHEET_RECT[0]) / PAGE_W_PT
        span_y = (SHEET_RECT[3] - SHEET_RECT[1]) / PAGE_H_PT
    else:
        x0, y0, span_x, span_y = 0.0, 0.0, 1.0, 1.0

    regions = []
    for slot in SLOTS:
        left = int((x0 + slot[0] * span_x) * width)
        top = int((y0 + slot[1] * span_y) * height)
        right = int((x0 + slot[2] * span_x) * width)
        bottom = int((y0 + slot[3] * span_y) * height)
        regions.append({
            "surface": "SAMPLE",
            "confidence": 0.9,
            "quad": [(left, top), (right, top), (right, bottom), (left, bottom)],
            "occluders": [],
            "coordinate_space": "pixel",
        })
    return regions


class Analysis:
    def __init__(self):
        # Deliberately unhelpful, the way the classifier actually
        # answers a bare swatch with no context in it.
        self.image_type = "OTHER"
        self.is_product_image = False
        self.decision = "REJECTED"
        self.confidence = 0.88
        self.product_name = ""
        self.product_bbox = None
        self.size_text = ""
        self.reason = "not a standalone product shot"


def fake_purity(image_path):
    # Also unhelpful: the verdict that was deleting real products.
    return {
        "tile_fraction": 1.0,
        "material": "ARTWORK",
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


class Harness:
    """Drive, Sheets, the backend and processed_files, all recording."""

    def __init__(self, fail_upload_on=None):
        self.uploads = []            # (filename, sha256 of the bytes)
        self.master_rows = []
        self.processed = set()
        self.attempts = 0
        self.fail_upload_on = fail_upload_on

    # -- Drive ------------------------------------------------------
    def upload_file(self, _service, path, _folder_id):
        self.attempts += 1
        if self.fail_upload_on is not None and self.attempts == self.fail_upload_on:
            raise RuntimeError("drive is down")
        digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        self.uploads.append((Path(path).name, digest))
        return {"id": f"drive-{len(self.uploads)}", "webViewLink": "http://d/x"}

    # -- processed_files --------------------------------------------
    def already_processed(self, file_hash):
        return file_hash in self.processed

    def mark_processed(self, file_hash, filename):
        self.processed.add(file_hash)

    # -- Sheets / backend -------------------------------------------
    def append_product(self, **kwargs):
        self.master_rows.append(kwargs["image_filename"])

    @property
    def unique_uploads(self):
        return {digest for _name, digest in self.uploads}


def install(harness):
    pipeline.load_semantic_tile_validator = lambda: (
        lambda path, page_text="": Analysis(),
        validate_product_decision,
        validate_bbox,
    )
    pipeline.load_tile_region_miner = lambda: (fake_detect, extract_tile_region)
    gemini_service.verify_tile_only = fake_purity
    pipeline.load_tile_purity_verifier = lambda: (
        fake_purity,
        __import__("app.image_validator", fromlist=["x"]).assess_tile_purity,
    )

    pipeline.upload_file = harness.upload_file
    pipeline.already_processed = harness.already_processed
    pipeline.mark_processed = harness.mark_processed
    pipeline.append_product = harness.append_product
    pipeline.get_or_create_folder = lambda *a, **k: "folder-id"
    pipeline.append_brand = lambda **k: None
    pipeline.append_catalog = lambda **k: None
    pipeline.sync_master_product_to_backend = lambda **k: {"ok": True}


def run(pdf_path, harness, label):
    install(harness)
    directory = OUT / label
    if directory.exists():
        shutil.rmtree(directory)
    return pipeline.process_pdf(pdf_path, directory, "drive", "sheets")


def check(label, ok, detail=""):
    return (label, bool(ok), detail)


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)

    pdf_path = OUT / "range_collection.pdf"
    build_pdf(pdf_path)

    results = []

    # ---------------- RUN 1 ----------------
    print("=" * 72)
    print("RUN 1 -- every tile on every page must come out")
    print("=" * 72)
    first = Harness()
    run(pdf_path, first, "run1")

    results.append(check(
        f"every tile on every page was extracted and uploaded "
        f"({len(first.uploads)}/{EXPECTED_TILES})",
        len(first.uploads) == EXPECTED_TILES,
        f"{len(first.uploads)} uploaded",
    ))
    results.append(check(
        "no two Drive files hold the same image",
        len(first.unique_uploads) == len(first.uploads),
        f"{len(first.uploads)} uploads, {len(first.unique_uploads)} distinct",
    ))
    results.append(check(
        f"one MASTER row per Drive file ({len(first.master_rows)})",
        len(first.master_rows) == len(first.uploads),
    ))

    # ---------------- RUN 2 ----------------
    print("")
    print("=" * 72)
    print("RUN 2 -- the same PDF again must upload nothing")
    print("=" * 72)
    second = Harness()
    second.processed = set(first.processed)
    run(pdf_path, second, "run2")

    results.append(check(
        f"a re-run uploads nothing ({len(second.uploads)})",
        len(second.uploads) == 0,
        f"{len(second.uploads)} duplicate upload(s)",
    ))
    results.append(check(
        "a re-run writes no MASTER rows",
        len(second.master_rows) == 0,
    ))

    # ---------------- RETRY ----------------
    print("")
    print("=" * 72)
    print("RETRY -- one failed tile must be the only one retried")
    print("=" * 72)
    broken = Harness(fail_upload_on=2)
    run(pdf_path, broken, "run3")

    results.append(check(
        f"the surviving tiles still uploaded "
        f"({len(broken.uploads)}/{EXPECTED_TILES - 1})",
        len(broken.uploads) == EXPECTED_TILES - 1,
        f"{len(broken.uploads)} uploaded",
    ))

    retry = Harness()
    retry.processed = set(broken.processed)
    run(pdf_path, retry, "run4")

    results.append(check(
        f"the retry uploads exactly the one that failed "
        f"({len(retry.uploads)})",
        len(retry.uploads) == 1,
        f"{len(retry.uploads)} uploaded",
    ))
    results.append(check(
        "the retry does not re-upload anything that succeeded",
        not (retry.unique_uploads & broken.unique_uploads),
        "a tile was uploaded twice across the two runs",
    ))

    combined = broken.unique_uploads | retry.unique_uploads
    results.append(check(
        f"after the retry every tile exists in Drive exactly once "
        f"({len(combined)}/{EXPECTED_TILES})",
        len(combined) == EXPECTED_TILES,
    ))

    print("")
    failures = 0
    for label, ok, *rest in results:
        detail = rest[0] if rest else ""
        if ok:
            print(f"  PASS  {label}")
        else:
            failures += 1
            print(f"  FAIL  {label}" + (f"  [{detail}]" if detail else ""))

    print(f"\n{len(results) - failures}/{len(results)} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
