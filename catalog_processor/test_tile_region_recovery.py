"""End-to-end regression for tile recovery out of a real catalog PDF.

This is the test the production failure needed and did not have. It builds
an actual multi-page PDF whose pages reproduce, page by page, each way the
old pipeline lost a tile, then runs the real extraction over it:

  page 1  a tile swatch drawn as VECTOR artwork -- page.get_images()
          returns nothing for it, so nothing ever looked at the page
  page 2  an embedded room photo with a tiled wall behind a toilet --
          detected correctly, then destroyed by the coordinate-space bug
  page 3  a logo and marketing text -- must stay rejected
  page 4  a four-product collage -- must stay rejected as a whole

Gemini is faked at the transport boundary (_generate_content_safe) rather
than at the parsing boundary, so the REAL detect_tile_regions parser, the
REAL geometry, and the REAL validator decisions all execute. The faked
detector answers in Gemini's native 0-1000 coordinate convention, which is
what production actually receives and what the old parser collapsed into a
single point.

Run:  GEMINI_API_KEY=test python3 test_tile_region_recovery.py
"""

import json
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


OUT = Path(__file__).resolve().parent / "output" / "region_recovery_test"

# Colours used to build the synthetic room photo, so the assertions can
# count pixels by origin: did any toilet survive into the tile swatch?
TILE_A = (196, 186, 170)
TILE_B = (176, 166, 150)
GROUT = (120, 112, 100)
TOILET = (250, 250, 252)
FLOOR = (92, 78, 64)


def build_room_photo(width=1000, height=760):
    """A tiled wall, a toilet standing in front of it, a wooden floor."""
    canvas = np.zeros((height, width, 3), dtype=np.uint8)
    canvas[:, :] = FLOOR

    # Tiled wall occupying the upper two-thirds, drawn in perspective so
    # rectification has something real to correct.
    for y in range(0, 520):
        for x in range(0, width):
            skew = int((y / 520.0) * 40)
            tx, ty = x + skew, y
            cell_x, cell_y = (tx // 90), (ty // 90)
            if tx % 90 < 6 or ty % 90 < 6:
                canvas[y, x] = GROUT
            else:
                canvas[y, x] = TILE_A if (cell_x + cell_y) % 2 == 0 else TILE_B

    # The toilet: a solid block sitting against the lower-left of the wall.
    canvas[330:520, 120:430] = TOILET

    return Image.fromarray(canvas, "RGB")


def build_collage(width=900, height=700):
    """Four different products in one frame."""
    canvas = np.zeros((height, width, 3), dtype=np.uint8)
    for index, (y0, x0) in enumerate([(0, 0), (0, 450), (350, 0), (350, 450)]):
        shade = 70 + index * 45
        canvas[y0:y0 + 350, x0:x0 + 450] = (shade, shade - 12, shade - 25)
    return Image.fromarray(canvas, "RGB")


def build_catalog_pdf(path):
    """Writes the four-page test catalog."""
    document = fitz.open()

    # -- page 1: vector-only tile swatch -------------------------------
    page = document.new_page(width=595, height=842)
    page.insert_text((60, 70), "TERRA COLLECTION", fontsize=20)
    page.insert_text((60, 96), "Terra Grey  600x600mm", fontsize=11)
    for row in range(6):
        for column in range(6):
            x = 60 + column * 78
            y = 130 + row * 78
            rect = fitz.Rect(x, y, x + 74, y + 74)
            tone = 0.74 if (row + column) % 2 == 0 else 0.66
            page.draw_rect(rect, color=(0.42, 0.40, 0.36),
                           fill=(tone, tone - 0.04, tone - 0.09), width=0.8)
    page.insert_text((60, 640), "Vector artwork -- no embedded raster.", fontsize=9)

    # -- page 2: embedded room photo -----------------------------------
    page = document.new_page(width=595, height=842)
    page.insert_text((60, 70), "TERRA IN SITU", fontsize=20)
    page.insert_text((60, 96), "Terra Grey  600x600mm", fontsize=11)
    photo = OUT / "_source_room.png"
    build_room_photo().save(photo)
    page.insert_image(fitz.Rect(60, 120, 535, 481), filename=str(photo))

    # -- page 3: logo / marketing --------------------------------------
    page = document.new_page(width=595, height=842)
    page.insert_text((60, 300), "TERRA", fontsize=64)
    page.insert_text((60, 350), "since 1974", fontsize=14)
    page.draw_rect(fitz.Rect(60, 380, 400, 386), fill=(0.8, 0.2, 0.2))

    # -- page 4: collage -----------------------------------------------
    page = document.new_page(width=595, height=842)
    page.insert_text((60, 70), "MIX & MATCH", fontsize=20)
    collage = OUT / "_source_collage.png"
    build_collage().save(collage)
    page.insert_image(fitz.Rect(60, 110, 535, 480), filename=str(collage))

    document.save(str(path))
    document.close()


# ----------------------------------------------------------------------
# Faked Gemini transport.
#
# Region coordinates are emitted in the 0-1000 grid, NOT the 0.0-1.0 the
# prompt asks for -- that mismatch is the production bug, and a test that
# fed clean 0-1 values would pass against the broken parser too.
# ----------------------------------------------------------------------

WALL_REGION = {
    "regions": [{
        "surface": "WALL",
        "confidence": 0.91,
        "quad": [{"x": 20, "y": 30}, {"x": 975, "y": 30},
                 {"x": 975, "y": 660}, {"x": 20, "y": 660}],
        "occluders": [{"x1": 100, "y1": 400, "x2": 450, "y2": 700}],
    }]
}

VECTOR_TILE_REGION = {
    "regions": [{
        "surface": "SAMPLE",
        "confidence": 0.88,
        "quad": [{"x": 95, "y": 148}, {"x": 890, "y": 148},
                 {"x": 890, "y": 700}, {"x": 95, "y": 700}],
        "occluders": [],
    }]
}

NO_REGION = {"regions": []}


class FakeResponse:
    def __init__(self, payload):
        self.text = json.dumps(payload)


class FakeClassification:
    def __init__(self, image_type, is_product, name="", confidence=0.9):
        self.image_type = image_type
        self.is_product_image = is_product
        self.confidence = confidence
        self.product_name = name
        self.product_bbox = None
        self.reason = f"classified as {image_type}"


calls = {"detect": 0, "classify": 0}


def install_fakes():
    """Routes the two Gemini entry points at canned answers."""

    def fake_generate(**kwargs):
        # Only detect_tile_regions passes a response_schema.
        schema = (kwargs.get("config") or {}).get("response_schema")
        if schema is not gemini_service.TILE_REGION_SCHEMA:
            return None

        calls["detect"] += 1
        path = fake_generate.current_image or ""

        if "_page_1_" in path:      # vector swatch page, rendered
            return FakeResponse(VECTOR_TILE_REGION)
        if "_page_2_" in path:      # embedded room photo
            return FakeResponse(WALL_REGION)
        if "_page_4_" in path:
            # The collage DOES read as a tiled surface to the detector --
            # four grids side by side. Whether that survives is the region
            # validator's call, not the detector's, and page 4 exists to
            # prove that gate still bites.
            return FakeResponse(WALL_REGION)

        # A logo has no tiled surface. The detector says so.
        return FakeResponse(NO_REGION)

    fake_generate.current_image = None
    gemini_service._generate_content_safe = fake_generate

    real_detect = gemini_service.detect_tile_regions

    def tracking_detect(image_path, width, height):
        fake_generate.current_image = str(image_path)
        return real_detect(image_path, width, height)

    def fake_analyze(image_path, page_text=""):
        calls["classify"] += 1
        name = Path(image_path).name

        # Page 4 is judged by what it IS, whether it arrives as the whole
        # collage or as a crop out of it -- a slice of a four-product
        # layout is still not one tile. Checked before the _region_ rule
        # so the region validator is genuinely exercised rather than
        # rubber-stamping anything the detector cut out.
        if "page_4" in name:
            return FakeClassification("COLLAGE", False, confidence=0.88)
        if "page_3" in name:
            return FakeClassification("LOGO", False, confidence=0.95)
        if "_region_" in name:
            return FakeClassification("TILE_SAMPLE", True, "Terra Grey", 0.93)
        return FakeClassification("ROOM_SCENE", False, confidence=0.9)

    gemini_service.analyze_product_image = fake_analyze

    from app.image_validator import validate_bbox, validate_product_decision

    pipeline.load_semantic_tile_validator = lambda: (
        fake_analyze, validate_product_decision, validate_bbox,
    )
    from app.tile_region_extractor import extract_tile_region

    pipeline.load_tile_region_miner = lambda: (tracking_detect, extract_tile_region)

    # The crops this test cuts are synthetic tile grids with nothing laid
    # on top of them, so frame purity is not what it is exercising --
    # report a clean tile and leave the deciding to the region rules
    # above. test_tile_only_output.py is where purity itself is tested.
    from app.image_validator import assess_tile_purity

    def fake_purity(image_path):
        name = Path(image_path).name
        return {
            "tile_fraction": 1.0,
            "material": "TILE",
            "contains_person": False,
            "contains_text": False,
            "contains_logo": False,
            "contains_furniture": False,
            "contains_fixture": False,
            "contains_object": False,
            "is_scene": False,
            # Page 4 lays four different products out together, so a crop
            # spanning them shows four designs. That is what stops it
            # being saved as one tile -- the source being "a collage" no
            # longer rejects anything by itself.
            "distinct_tile_designs": 4 if "page_4" in name else 1,
            "reason": "synthetic tile grid",
        }

    pipeline.load_tile_purity_verifier = lambda: (fake_purity, assess_tile_purity)


def assert_true(label, condition, detail=""):
    mark = "PASS" if condition else "FAIL"
    print(f"  [{mark}] {label}" + (f" -- {detail}" if detail else ""))
    return bool(condition)


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)

    pdf_path = OUT / "terra_catalog.pdf"
    build_catalog_pdf(pdf_path)
    install_fakes()

    print("=" * 72)
    print("EXTRACTION RUN")
    print("=" * 72)

    images = pipeline.extract_images_from_pdf(pdf_path, OUT)

    print("")
    print("=" * 72)
    print("ACCEPTANCE CHECKS")
    print("=" * 72)

    results = []

    results.append(assert_true(
        "at least one tile recovered where the old pipeline recovered zero",
        len(images) >= 1, f"{len(images)} accepted",
    ))

    pages = {record["page"] for record in images}

    results.append(assert_true(
        "vector-only page 1 recovered via page render",
        1 in pages, f"accepted pages: {sorted(pages)}",
    ))
    results.append(assert_true(
        "room photo on page 2 yielded a wall swatch",
        2 in pages, f"accepted pages: {sorted(pages)}",
    ))
    results.append(assert_true(
        "logo page 3 stayed rejected", 3 not in pages,
    ))
    results.append(assert_true(
        "collage page 4 rejected -- region validator overruled the detector",
        4 not in pages,
    ))
    results.append(assert_true(
        "no rejected region left a file behind",
        not list(OUT.glob("*page_4*region*.webp")),
    ))

    # The real question: is the saved image actually tile, and only tile?
    wall = [r for r in images if r["page"] == 2]
    if wall:
        with Image.open(wall[0]["path"]) as opened:
            pixels = np.asarray(opened.convert("RGB")).reshape(-1, 3)

        toilet_hits = int(np.sum(
            np.all(np.abs(pixels.astype(int) - np.array(TOILET)) <= 12, axis=1)
        ))
        tile_hits = int(np.sum(
            np.all(np.abs(pixels.astype(int) - np.array(TILE_A)) <= 26, axis=1)
            | np.all(np.abs(pixels.astype(int) - np.array(TILE_B)) <= 26, axis=1)
        ))
        share = tile_hits / len(pixels)

        results.append(assert_true(
            "recovered swatch contains no toilet pixels",
            toilet_hits == 0, f"{toilet_hits} found",
        ))
        results.append(assert_true(
            "recovered swatch is predominantly tile",
            share > 0.50, f"{share:.0%} tile pixels",
        ))
    else:
        results.append(assert_true("wall swatch present for pixel audit", False))

    results.append(assert_true(
        "no full-page render survived as a product image",
        not list(OUT.glob("*_render.webp")),
    ))
    results.append(assert_true(
        "every accepted record points at a file that exists",
        all(Path(record["path"]).is_file() for record in images),
    ))
    results.append(assert_true(
        "product name carried through to the record",
        all(record["product_name"] == "Terra Grey" for record in images),
    ))

    print("")
    print("Accepted images:")
    for record in images:
        print(f"  page {record['page']}  {record['width']}x{record['height']}  "
              f"{record['filename']}  name={record['product_name']!r}")

    print("")
    print(f"Gemini calls -- region detection: {calls['detect']}, "
          f"classification: {calls['classify']}")
    print(f"Debug crops written to: {OUT}")

    passed = sum(1 for r in results if r)
    print("")
    print(f"{passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
