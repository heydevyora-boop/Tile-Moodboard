"""Regression: what gets saved must be the TILE, not the scene around it.

The production failures this covers, all four of them saved into the
catalog as tile products:

  a kitchen worktop        (stone, patterned -- but not a tile)
  a tile with the product name printed across it
  a tiled wall with a girl standing in front of it
  a tiled floor with equipment sitting on it

Each was approved because the only question ever asked was "is this
image ABOUT a tile product?", and all four are. The question that was
missing is "what is actually IN this frame?".

HOW THIS TEST AVOIDS RUBBER-STAMPING ITSELF
-------------------------------------------
Gemini is stubbed, so a lazy stub could simply agree with whatever the
pipeline did and the test would pass while the images stayed filthy.

It is instead an ORACLE that reads the pixels of the crop the pipeline
actually saved. Every non-tile element is drawn in a reserved colour, so
"is there a person in this crop" is a real measurement, not an opinion:
if one magenta pixel of the girl survives into the output, the oracle
says so and the candidate is refused. A PASS here means the saved file
genuinely contains no person, no text, no furniture.

The geometry (app/tile_region_extractor) and the decision rule
(image_validator.assess_tile_purity) are the REAL implementations. Only
the two Gemini calls are replaced.

Run:  GEMINI_API_KEY=test python3 test_tile_only_output.py
"""

import os
import shutil
import sys
from pathlib import Path

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-used")

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

import main_step6_complete as pipeline  # noqa: E402
from app.image_validator import (  # noqa: E402
    assess_tile_purity,
    validate_bbox,
    validate_product_decision,
)

OUT = Path(__file__).resolve().parent / "output" / "tile_only_test"

# Reserved colours. Nothing else in a scene uses these, so finding one in
# a saved crop is proof that contamination survived.
TILE_A = (198, 188, 172)
TILE_B = (176, 166, 150)
GROUT = (112, 104, 92)
PERSON = (222, 40, 142)
TEXT = (12, 12, 14)
FURNITURE = (92, 58, 38)
# Deliberately a colour no neutral surface can compress into. It stood
# in for white sanitaryware at first, which sat close enough to the page
# background that WEBP ringing around a fine tile grid registered as a
# basin. A marker's only job is to be unmistakably itself.
FIXTURE = (48, 196, 212)
OBJECT = (38, 142, 62)
WALL = (232, 228, 220)
SKY = (140, 186, 226)
# A second, visibly different tile design. Two of these in one frame
# means a layout of products rather than one product.
TILE_C = (128, 152, 168)
TILE_D = (104, 128, 146)

SIZE = 900

# A full catalog sheet, for the small-sample case. Six 190px samples on
# a page this size are ~1.1% of it each -- the exact figure the real
# catalog logs showed being rejected.
PAGE = 1800
SAMPLE = 190


def tile_field(draw, box, cell=72, joint=6, palette=(TILE_A, TILE_B)):
    """Paints a real tiled surface: repeating units with grout joints."""
    first, second = palette
    x1, y1, x2, y2 = box
    for y in range(y1, y2):
        for x in range(x1, x2):
            local_x, local_y = x - x1, y - y1
            if local_x % cell < joint or local_y % cell < joint:
                colour = GROUT
            else:
                colour = first if ((local_x // cell) + (local_y // cell)) % 2 == 0 else second
            draw.point((x, y), fill=colour)


def stone_field(draw, box):
    """Paints a continuous stone slab -- veined, but NO joints.

    This is the kitchen-worktop case. It is stone, it is patterned, it
    photographs beautifully, and it is not a tile. The absence of joints
    is the whole difference and the oracle keys on exactly that.
    """
    x1, y1, x2, y2 = box
    for y in range(y1, y2):
        for x in range(x1, x2):
            vein = int(14 * np.sin((x * 0.05) + (y * 0.017)))
            draw.point((x, y), fill=(206 + vein, 198 + vein, 186 + vein))


def font(size):
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def scene(name, paint, size=SIZE):
    image = Image.new("RGB", (size, size), WALL)
    draw = ImageDraw.Draw(image)
    regions = paint(draw)
    path = OUT / f"{name}.webp"
    image.save(path, "WEBP", quality=92, method=6)
    return path, regions


# ----------------------------------------------------------------------
# The scenes. Each returns the detector's answer for itself: the tile
# plane and the boxes of whatever sits on top of it.
# ----------------------------------------------------------------------

def paint_tile_with_person(draw):
    tile_field(draw, (0, 0, SIZE, SIZE))
    draw.ellipse([330, 250, 560, 480], fill=PERSON)
    draw.rectangle([360, 470, 530, SIZE], fill=PERSON)
    return [{
        "surface": "WALL", "confidence": 0.93,
        "quad": [(0, 0), (SIZE, 0), (SIZE, SIZE), (0, SIZE)],
        "occluders": [(320, 240, 570, SIZE)],
    }]


def paint_tile_with_text(draw):
    tile_field(draw, (0, 0, SIZE, SIZE))
    draw.rectangle([0, 620, SIZE, 780], fill=WALL)
    draw.text((50, 650), "STATUARIO GOLD", fill=TEXT, font=font(58))
    draw.text((50, 720), "600 x 1200 mm", fill=TEXT, font=font(40))
    return [{
        "surface": "WALL", "confidence": 0.91,
        "quad": [(0, 0), (SIZE, 0), (SIZE, SIZE), (0, SIZE)],
        "occluders": [(0, 610, SIZE, 790)],
    }]


def paint_kitchen_countertop(draw):
    """A kitchen. The worktop is stone; there is no tile anywhere."""
    draw.rectangle([0, 0, SIZE, 430], fill=WALL)
    stone_field(draw, (0, 430, SIZE, 600))
    draw.rectangle([0, 600, SIZE, SIZE], fill=FURNITURE)
    draw.ellipse([620, 460, 760, 560], fill=FIXTURE)
    return [{
        "surface": "OTHER", "confidence": 0.72,
        "quad": [(0, 430), (SIZE, 430), (SIZE, 600), (0, 600)],
        "occluders": [(610, 450, 770, 570)],
    }]


def paint_bathroom_with_tile(draw):
    """A real bathroom: tiled wall, basin and WC in front of it."""
    tile_field(draw, (0, 0, SIZE, 620))
    draw.rectangle([0, 620, SIZE, SIZE], fill=FURNITURE)
    draw.ellipse([80, 380, 330, 610], fill=FIXTURE)
    draw.rectangle([600, 400, 820, 620], fill=FIXTURE)
    draw.ellipse([420, 60, 520, 170], fill=OBJECT)
    return [{
        "surface": "WALL", "confidence": 0.95,
        "quad": [(0, 0), (SIZE, 0), (SIZE, 620), (0, 620)],
        "occluders": [
            (70, 370, 340, 620),
            (590, 390, 830, 620),
            (410, 50, 530, 180),
        ],
    }]


def paint_clean_tile(draw):
    """A standalone tile product shot. Already a swatch."""
    tile_field(draw, (0, 0, SIZE, SIZE))
    return [{
        "surface": "SAMPLE", "confidence": 0.97,
        "quad": [(0, 0), (SIZE, 0), (SIZE, SIZE), (0, SIZE)],
        "occluders": [],
    }]


def paint_artwork(draw):
    """A decorative panel: no repeating units, no joints. Not a tile."""
    draw.rectangle([0, 0, SIZE, SIZE], fill=WALL)
    for index in range(9):
        draw.ellipse(
            [90 + index * 74, 300 + (index % 3) * 60,
             170 + index * 74, 380 + (index % 3) * 60],
            fill=OBJECT,
        )
    return [{
        "surface": "OTHER", "confidence": 0.61,
        "quad": [(0, 0), (SIZE, 0), (SIZE, SIZE), (0, SIZE)],
        "occluders": [],
    }]


def paint_dubai_frame(draw):
    """An architectural landmark, clad in tile, against the sky.

    The detector calls this EXTERIOR at 0.95 and it is not wrong -- it
    IS an exterior clad surface. It is also a building, and a photograph
    of a building is not a tile sample.
    """
    draw.rectangle([0, 0, SIZE, SIZE], fill=SKY)
    tile_field(draw, (170, 90, 730, 810), cell=40, joint=4)
    draw.rectangle([250, 170, 650, 730], fill=SKY)
    return [{
        "surface": "EXTERIOR", "confidence": 0.95,
        "quad": [(170, 90), (730, 90), (730, 810), (170, 810)],
        "occluders": [],
    }]


def paint_two_designs(draw):
    """Two different tile products side by side -- a layout, not a product."""
    tile_field(draw, (0, 0, SIZE // 2, SIZE))
    tile_field(draw, (SIZE // 2, 0, SIZE, SIZE), palette=(TILE_C, TILE_D))
    return [{
        "surface": "SAMPLE", "confidence": 0.85,
        "quad": [(0, 0), (SIZE, 0), (SIZE, SIZE), (0, SIZE)],
        "occluders": [],
    }]


def paint_heavily_occluded(draw):
    """A tiled wall almost entirely hidden behind a sofa.

    What is left is a 900x160 band -- 17.8% of the region, which the old
    25% occlusion rule refused outright, and a perfectly good swatch.
    """
    tile_field(draw, (0, 0, SIZE, SIZE))
    draw.rectangle([0, 160, SIZE, SIZE], fill=FURNITURE)
    return [{
        "surface": "WALL", "confidence": 0.9,
        "quad": [(0, 0), (SIZE, 0), (SIZE, SIZE), (0, SIZE)],
        "occluders": [(0, 160, SIZE, SIZE)],
    }]


def paint_duplicate_detections(draw):
    """One tiled wall that the detector reports five times over."""
    tile_field(draw, (0, 0, SIZE, SIZE))
    jitter = [0, 6, -5, 9, -8]
    return [
        {
            "surface": "WALL", "confidence": 0.95 - index * 0.02,
            "quad": [(offset, offset), (SIZE + offset, offset),
                     (SIZE + offset, SIZE + offset), (offset, SIZE + offset)],
            "occluders": [],
        }
        for index, offset in enumerate(jitter)
    ]


SCENES = [
    ("tile_with_person", paint_tile_with_person, "tile + person"),
    ("tile_with_text", paint_tile_with_text, "tile + text overlay"),
    ("kitchen_countertop", paint_kitchen_countertop, "kitchen worktop, no tile"),
    ("bathroom_with_tile", paint_bathroom_with_tile, "bathroom + fixtures"),
    ("clean_tile", paint_clean_tile, "standalone tile"),
    ("artwork", paint_artwork, "decorative artwork, no tile"),
    ("dubai_frame", paint_dubai_frame, "architectural landmark"),
    ("two_designs", paint_two_designs, "two different tiles in one frame"),
    ("heavily_occluded", paint_heavily_occluded, "tile 82% hidden by a sofa"),
    ("duplicate_detections", paint_duplicate_detections,
     "one wall, detected 5 times"),
]


def paint_small_samples(draw):
    """A catalog sheet laying six small tile samples out on one page.

    Each is ~1.1% of the sheet. Under the old source-relative area rule
    all six were rejected as "too small"; each is a 190px swatch.
    """
    draw.rectangle([0, 0, PAGE, PAGE], fill=WALL)
    regions = []
    # Six DIFFERENT products, so six different tile formats. Painting
    # them identically would have them collapse into one under the
    # duplicate-crop rule, and would be testing the wrong thing: the
    # question here is whether six small samples survive the size gates.
    formats = [26, 34, 42, 50, 58, 66]
    for index, cell in enumerate(formats):
        row, column = divmod(index, 3)
        x = 150 + column * 520
        y = 260 + row * 700
        tile_field(draw, (x, y, x + SAMPLE, y + SAMPLE), cell=cell, joint=4)
        regions.append({
            "surface": "WALL", "confidence": 0.95,
            "quad": [(x, y), (x + SAMPLE, y),
                     (x + SAMPLE, y + SAMPLE), (x, y + SAMPLE)],
            "occluders": [],
        })
    return regions


# ----------------------------------------------------------------------
# The oracle. Measures the saved crop instead of trusting the pipeline.
# ----------------------------------------------------------------------

def near(pixels, colour, tolerance=26):
    return (np.abs(pixels.astype(np.int16) - np.array(colour, np.int16))
            .max(axis=-1) <= tolerance)


def dominant_design(image_path):
    """Which of the two tile palettes fills this crop: "A", "C" or "?"."""
    with Image.open(image_path) as opened:
        pixels = np.asarray(opened.convert("RGB"))

    first = int((near(pixels, TILE_A) | near(pixels, TILE_B)).sum())
    second = int((near(pixels, TILE_C) | near(pixels, TILE_D)).sum())

    if first > second * 3:
        return "A"
    if second > first * 3:
        return "C"
    return "?"


def oracle_verify_tile_only(image_path):
    """gemini_service.verify_tile_only, answered from real pixels."""
    with Image.open(image_path) as opened:
        pixels = np.asarray(opened.convert("RGB"))

    total = pixels.shape[0] * pixels.shape[1]

    design_one = (near(pixels, TILE_A) | near(pixels, TILE_B)).sum()
    design_two = (near(pixels, TILE_C) | near(pixels, TILE_D)).sum()
    grout_pixels = near(pixels, GROUT).sum()
    tile_pixels = design_one + design_two + grout_pixels
    sky_pixels = near(pixels, SKY).sum()

    # A design counts as present only if it occupies a real share of the
    # frame, so a few edge pixels bleeding across a seam do not read as
    # a second product.
    designs = sum(
        1 for count in (design_one, design_two)
        if count > total * 0.08
    )

    flags = {
        "contains_person": bool(near(pixels, PERSON).sum() > 0),
        "contains_text": bool(near(pixels, TEXT).sum() > 0),
        "contains_logo": False,
        "contains_furniture": bool(near(pixels, FURNITURE).sum() > 0),
        "contains_fixture": bool(near(pixels, FIXTURE).sum() > 0),
        "contains_object": bool(near(pixels, OBJECT).sum() > 0),
    }

    tile_fraction = float(tile_pixels) / total if total else 0.0

    # Sky in the frame means you are looking AT a structure, not at a
    # surface -- the Dubai Frame case. Checked before the joints rule,
    # because a tile-clad landmark has joints too and would otherwise
    # read as a swatch.
    if sky_pixels > total * 0.15:
        material = "ARCHITECTURE"
    elif grout_pixels > total * 0.01:
        # Joints are what make a tile a tile. A veined stone surface with
        # no joints is a slab -- the kitchen-worktop distinction.
        material = "TILE"
    elif near(pixels, WALL).sum() > total * 0.5:
        material = "PAINTED_WALL"
    elif tile_fraction > 0.3:
        material = "STONE_SLAB"
    else:
        material = "OTHER"

    present = sum(1 for value in flags.values() if value)

    return {
        "tile_fraction": tile_fraction,
        "material": material,
        "is_scene": present >= 2 or tile_fraction < 0.45,
        "distinct_tile_designs": max(1, designs),
        # The synthetic scenes stand in for photographs of real surfaces.
        # A dedicated matrix below covers the printed-graphic case.
        "physical_surface": True,
        "reason": f"{tile_fraction:.0%} tile surface",
        **flags,
    }


class Analysis:
    """The permissive product classifier, reproduced faithfully.

    Its real prompt approves a product "occupying only part of the
    image", so it says TILE for a bathroom photo and for a worktop. The
    bug was trusting it alone; the test keeps it permissive on purpose so
    the purity gate is what has to do the work.
    """

    def __init__(self, image_type, decision):
        self.image_type = image_type
        self.is_product_image = decision == "APPROVED"
        self.decision = decision
        self.confidence = 0.9
        self.product_name = "Statuario Gold"
        self.product_bbox = None
        self.reason = "tile product"


def analyze_product_image(image_path, page_text=""):
    observation = oracle_verify_tile_only(image_path)
    if observation["material"] in ("PAINTED_WALL", "OTHER"):
        return Analysis("GRAPHIC", "REJECTED")
    return Analysis("TILE", "APPROVED")


def install(regions_by_stem):
    def detect_tile_regions(image_path, width, height):
        return regions_by_stem.get(Path(image_path).stem, [])

    from app.tile_region_extractor import extract_tile_region

    pipeline.load_semantic_tile_validator = lambda: (
        analyze_product_image, validate_product_decision, validate_bbox,
    )
    pipeline.load_tile_region_miner = lambda: (
        detect_tile_regions, extract_tile_region,
    )
    pipeline.load_tile_purity_verifier = lambda: (
        oracle_verify_tile_only, assess_tile_purity,
    )


def check(label, condition, detail=""):
    mark = "PASS" if condition else "FAIL"
    print(f"  [{mark}] {label}" + (f" -- {detail}" if detail else ""))
    return bool(condition)


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)

    regions_by_stem = {}
    sources = []
    for name, paint, description in SCENES:
        path, regions = scene(name, paint)
        regions_by_stem[path.stem] = regions
        sources.append((name, path, description))

    # Built separately: it is a full catalog sheet, not a single photo.
    path, regions = scene("small_samples", paint_small_samples, size=PAGE)
    regions_by_stem[path.stem] = regions
    sources.append((
        "small_samples", path,
        f"six {SAMPLE}px samples on a {PAGE}px sheet "
        f"({(SAMPLE * SAMPLE) / (PAGE * PAGE):.1%} each)",
    ))

    install(regions_by_stem)

    semantic = pipeline.load_semantic_tile_validator()
    miner = pipeline.load_tile_region_miner()

    results = []
    accepted_by_scene = {}

    for name, path, description in sources:
        print("")
        print("=" * 72)
        print(f"{description}  ({name})")
        print("=" * 72)

        # Stage 1 -- the whole image, exactly as the pipeline judges it.
        status, reason, _meta = pipeline.validate_and_correct_tile_image(
            path, None, [], semantic,
        )
        print(f"  whole image: {status} -- {reason}")

        accepted = []
        if status == pipeline.VALIDATION_APPROVED:
            accepted = [(path, reason, _meta)]
        elif status in (pipeline.VALIDATION_IMPURE, pipeline.VALIDATION_REJECTED):
            # Both route to isolation: a dirty frame gets its tile cut
            # out, and a "not a tile" frame still gets searched in case a
            # real tile is somewhere inside it.
            accepted, _deferred = pipeline.mine_tile_regions(
                path, 1, 1, [], None, semantic, miner, OUT,
            )

        accepted_by_scene[name] = accepted

    print("")
    print("=" * 72)
    print("INSPECTING EVERY SAVED IMAGE")
    print("=" * 72)

    # The real assertions: measure what is on disk.
    for name, _path, description in sources:
        for saved_path, _reason, _meta in accepted_by_scene[name]:
            observation = oracle_verify_tile_only(saved_path)
            dirt = [
                key.replace("contains_", "")
                for key in ("contains_person", "contains_text",
                            "contains_furniture", "contains_fixture",
                            "contains_object")
                if observation[key]
            ]
            results.append(check(
                f"{name}: saved image is tile-only",
                not dirt and observation["material"] == "TILE",
                f"material={observation['material']} "
                f"tile={observation['tile_fraction']:.0%}"
                + (f" CONTAMINATED BY {', '.join(dirt)}" if dirt else ""),
            ))

    print("")
    results.append(check(
        "tile + person      -> a tile-only swatch is recovered",
        len(accepted_by_scene["tile_with_person"]) == 1,
    ))
    results.append(check(
        "tile + text        -> a tile-only swatch is recovered",
        len(accepted_by_scene["tile_with_text"]) == 1,
    ))
    results.append(check(
        "bathroom + tile    -> a tile-only swatch is recovered",
        len(accepted_by_scene["bathroom_with_tile"]) == 1,
    ))
    results.append(check(
        "standalone tile    -> kept",
        len(accepted_by_scene["clean_tile"]) == 1,
    ))
    results.append(check(
        "kitchen worktop    -> nothing saved (stone slab is not a tile)",
        len(accepted_by_scene["kitchen_countertop"]) == 0,
        f"{len(accepted_by_scene['kitchen_countertop'])} saved",
    ))
    results.append(check(
        "artwork, no tile   -> nothing saved",
        len(accepted_by_scene["artwork"]) == 0,
        f"{len(accepted_by_scene['artwork'])} saved",
    ))

    # The gates this round changed, each checked against the exact
    # numbers the real catalog logs reported.
    print("")
    results.append(check(
        f"six {SAMPLE}px samples at "
        f"{(SAMPLE * SAMPLE) / (PAGE * PAGE):.1%} of the page -> all kept",
        len(accepted_by_scene["small_samples"]) == 6,
        f"{len(accepted_by_scene['small_samples'])}/6 "
        f"(the old 2%-of-source rule rejected all six)",
    ))
    results.append(check(
        "tile 82% hidden by a sofa -> the visible band is still extracted",
        len(accepted_by_scene["heavily_occluded"]) == 1,
        "(the old 25%-unobstructed rule rejected it)",
    ))
    results.append(check(
        "architectural landmark -> rejected despite EXTERIOR at 0.95",
        len(accepted_by_scene["dubai_frame"]) == 0,
        f"{len(accepted_by_scene['dubai_frame'])} saved",
    ))
    # Two products butted together must become two swatches -- not one
    # picture of both, and not nothing.
    two = accepted_by_scene["two_designs"]
    results.append(check(
        "two designs in one frame -> split into two separate products",
        len(two) == 2, f"{len(two)} saved",
    ))

    if len(two) == 2:
        observations = [oracle_verify_tile_only(path) for path, _r, _m in two]
        results.append(check(
            "each split piece shows exactly one design",
            all(o["distinct_tile_designs"] == 1 for o in observations),
            str([o["distinct_tile_designs"] for o in observations]),
        ))
        results.append(check(
            "the split separated the designs rather than halving one",
            {dominant_design(path) for path, _r, _m in two} == {"A", "C"},
            str(sorted(dominant_design(path) for path, _r, _m in two)),
        ))
    results.append(check(
        "one wall detected 5 times -> one swatch, not five",
        len(accepted_by_scene["duplicate_detections"]) == 1,
        f"{len(accepted_by_scene['duplicate_detections'])} saved",
    ))

    total_saved = sum(len(v) for v in accepted_by_scene.values())
    results.append(check(
        "the fix does not work by extracting nothing",
        total_saved >= 10, f"{total_saved} tiles recovered",
    ))

    results.extend(full_source_matrix())
    results.extend(graphic_matrix())
    results.extend(occluder_matrix())
    results.extend(material_matrix())
    results.extend(size_gate_matrix())
    results.extend(splitter_matrix())
    results.extend(decision_matrix())

    passed = sum(1 for r in results if r)
    print("")
    print(f"{passed}/{len(results)} checks passed")

    contact_sheet(sources, accepted_by_scene)
    return 0 if passed == len(results) else 1


def full_source_matrix():
    """A candidate spanning the whole composed source is a failure.

    The pipeline was saving entire catalog pages as "tiles". A page is a
    composition -- margins, headings, text, usually several elements --
    so nothing on it is a single material surface spanning all of it.
    Two generic paths produce such a candidate: the detector returns the
    whole frame, or a coordinate-space misread clamps every corner onto
    the frame edge (_to_pixels bounds each fraction into [0, 1]).

    The second group is what stops this being a blunt "reject big
    candidates" rule: an EMBEDDED image is already one element off the
    page, and a full-frame candidate there is the correct answer for a
    standalone product shot. Nothing here is specific to any catalog,
    brand, filename or layout -- only to whether the source is a
    composition or a single element.
    """
    import cv2
    from app.tile_region_extractor import (
        MAX_PAGE_SOURCE_COVERAGE, extract_tile_region,
    )

    print("")
    print("=" * 72)
    print("FULL-SOURCE CANDIDATES")
    print("=" * 72)

    size = 700
    image = Image.new("RGB", (size, size), WALL)
    tile_field(ImageDraw.Draw(image), (0, 0, size, size), cell=44)
    path = OUT / "_fullsrc.webp"
    image.save(path, "WEBP", quality=92, method=6)
    source = cv2.imread(str(path), cv2.IMREAD_COLOR)

    def quad(x1, y1, x2, y2):
        return [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]

    whole = quad(0, 0, size, size)
    # A misread coordinate space clamps every corner onto the frame.
    clamped = quad(-40, -40, size + 40, size + 40)
    part = quad(60, 60, 430, 430)

    cases = [
        ("page render, whole frame", whole, "page", False),
        ("page render, clamped out-of-range quad", clamped, "page", False),
        ("page render, a real sub-region", part, "page", True),
        ("embedded image, whole frame (standalone product)",
         whole, "embedded", True),
        ("embedded image, a real sub-region", part, "embedded", True),
    ]

    outcomes = []
    for label, region_quad, kind, should_extract in cases:
        limit = MAX_PAGE_SOURCE_COVERAGE if kind == "page" else None
        crop, info = extract_tile_region(
            source, region_quad, [], max_source_coverage=limit,
        )
        extracted = crop is not None
        detail = (
            f"coverage={info.get('source_coverage', 0):.0%}"
            + ("" if extracted else f", stage={info.get('stage')}")
        )
        outcomes.append(check(
            f"{label:48s} -> {'extract' if should_extract else 'reject'}",
            extracted == should_extract, detail,
        ))

    # Several samples on one page must stay separate candidates, each
    # well under the limit -- never merged into one page-sized crop.
    boxes = [quad(40, 40, 320, 320), quad(380, 40, 660, 320),
             quad(40, 380, 320, 660), quad(380, 380, 660, 660)]
    separate = [
        extract_tile_region(source, b, [],
                            max_source_coverage=MAX_PAGE_SOURCE_COVERAGE)
        for b in boxes
    ]
    outcomes.append(check(
        "four samples on one page stay four candidates",
        all(crop is not None for crop, _i in separate),
        f"{sum(1 for c, _i in separate if c is not None)}/4 extracted",
    ))
    outcomes.append(check(
        "none of them is page-sized",
        all(i["source_coverage"] < MAX_PAGE_SOURCE_COVERAGE
            for _c, i in separate),
        f"max coverage {max(i['source_coverage'] for _c, i in separate):.0%}",
    ))

    return outcomes


def graphic_matrix():
    """A printed tile pattern is not a tile product.

    A real ONERY run uploaded a decorative geometric catalog graphic as
    a tile. Every other rule was satisfied -- it repeated regularly, it
    filled the frame, it held no person, text or furniture -- because
    the prompt made "repeating units with joints" the definition of
    tile. A printed pattern repeats more perfectly than a real wall does.

    The second half is the guard: a real photographed surface must still
    be accepted, otherwise this rule would simply switch extraction off.
    """
    print("")
    print("=" * 72)
    print("PHYSICAL SURFACE vs PRINTED GRAPHIC")
    print("=" * 72)

    graphics = [
        ("geometric catalog decoration", observe(material="TILE")),
        ("a pattern illustration", observe(material="TILE", fraction=1.0)),
        ("a colour chart", observe(material="TILE", fraction=0.95)),
        ("a border motif", observe(material="MOSAIC")),
        ("a rendered tile visual", observe(material="PORCELAIN")),
    ]

    outcomes = []
    for label, observation in graphics:
        observation["physical_surface"] = False
        state = assess_tile_purity(observation)["state"]
        outcomes.append(check(
            f"{label:32s} -> NOT_TILE", state == "NOT_TILE",
            "" if state == "NOT_TILE" else f"got {state}",
        ))

    # The other direction: real photographed material must still pass,
    # including large-format tile where no joint falls in the frame.
    for label, observation in [
        ("photographed tile face", observe(material="TILE")),
        ("large-format, no joint visible", observe(material="PORCELAIN")),
        ("installed wall tile", observe(material="CERAMIC")),
    ]:
        state = assess_tile_purity(observation)["state"]
        outcomes.append(check(
            f"{label:32s} -> CLEAN", state == "CLEAN",
            "" if state == "CLEAN" else f"got {state}",
        ))

    # An unanswered physical_surface must not silently restore the old
    # behaviour of accepting graphics.
    unanswered = observe(material="TILE")
    unanswered.pop("physical_surface")
    state = assess_tile_purity(unanswered)["state"]
    outcomes.append(check(
        "physical_surface unanswered        -> not accepted",
        state != "CLEAN", f"got {state}",
    ))

    return outcomes


def occluder_matrix():
    """A box covering the whole region is a detector error, not a verdict.

    Straight from a real catalog page: five tiled surfaces of ~474x595
    were detected and all five died at "occluders cover the whole
    region". The detector had asserted both that the quad IS a tiled
    surface and that something covers all of it -- a contradiction, and
    it was always resolved in the occluder's favour.

    The last two cases are the guard rails: a genuine large occluder
    still bites, and a region genuinely covered by several ordinary
    boxes is still refused. Otherwise this would just be "ignore
    occlusion", which would put sinks and sofas in the catalog.
    """
    import cv2
    from app.tile_region_extractor import extract_tile_region

    print("")
    print("=" * 72)
    print("OCCLUDER HANDLING")
    print("=" * 72)

    size = 600
    image = Image.new("RGB", (size, size), WALL)
    tile_field(ImageDraw.Draw(image), (0, 0, size, size), cell=40)
    path = OUT / "_occ.webp"
    image.save(path, "WEBP", quality=92, method=6)
    source = cv2.imread(str(path), cv2.IMREAD_COLOR)
    quad = [(0, 0), (size, 0), (size, size), (0, size)]

    cases = [
        ("no occluders", [], True),
        ("one box covering the ENTIRE region", [(0, 0, size, size)], True),
        ("one box covering 95%", [(0, 0, int(size * 0.98), int(size * 0.97))],
         True),
        ("a fixture across the lower half",
         [(0, int(size * 0.55), size, size)], True),
        # Guard rails.
        ("a genuine large occluder still bites",
         [(0, 0, size, int(size * 0.8))], True),
        ("many ordinary boxes that together cover everything",
         [(0, 0, size, size // 2), (0, size // 2, size, size)], False),
    ]

    outcomes = []
    for label, occluders, should_extract in cases:
        crop, info = extract_tile_region(source, quad, occluders)
        extracted = crop is not None
        detail = (
            f"{info.get('crop_size')}"
            + (f", ignored {info['occluders_ignored']} swallowing box(es)"
               if info.get("occluders_ignored") else "")
        ) if extracted else info.get("reason", "")
        outcomes.append(check(
            f"{label:46s} -> {'extract' if should_extract else 'reject'}",
            extracted == should_extract, detail,
        ))

    # The safety property that makes the above acceptable: whatever
    # survives occlusion is still judged on its pixels afterwards.
    crop, _info = extract_tile_region(source, quad, [(0, 0, size, size)])
    if crop is not None:
        recovered = OUT / "_occ_recovered.webp"
        Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)).save(
            recovered, "WEBP", quality=92, method=6,
        )
        observation = oracle_verify_tile_only(recovered)
        outcomes.append(check(
            "the recovered crop is still judged on its own pixels",
            observation["material"] == "TILE",
            f"material={observation['material']} "
            f"tile={observation['tile_fraction']:.0%}",
        ))

    return outcomes


def material_matrix():
    """The material word must not be the whole decision.

    The gate used to read `material != "TILE"`, so only that one exact
    token survived. A close-up of a tile face draws PORCELAIN, CERAMIC,
    VITRIFIED, MOSAIC or a plural TILES just as readily, and OTHER is
    what the parser substitutes whenever the field is missing or
    off-vocabulary -- all of them were rejected as though the surface
    had been positively identified as something else.

    Three groups below, and the third is the one that keeps this honest:
    a surface nobody could name still has to be overwhelmingly tile and
    clean to get through, so "unnamed" never becomes "accepted".
    """
    print("")
    print("=" * 72)
    print("MATERIAL VOCABULARY")
    print("=" * 72)

    outcomes = []

    print("  -- words that all mean tile --")
    for word in ["TILE", "TILES", "tile", "Ceramic", "PORCELAIN",
                 "VITRIFIED", "MOSAIC", "CERAMIC_TILE", "PORCELAIN TILE",
                 "subway-tile", "TILE_SAMPLE", "CLADDING", "PAVER"]:
        state = assess_tile_purity(observe(material=word))["state"]
        outcomes.append(check(f"    {word:18s} -> CLEAN", state == "CLEAN",
                              "" if state == "CLEAN" else f"got {state}"))

    print("  -- positively identified as something else --")
    for word in ["COUNTERTOP", "WORKTOP", "STONE_SLAB", "MARBLE_SLAB",
                 "ARCHITECTURE", "BUILDING", "FACADE", "WOOD", "LAMINATE",
                 "PAINTED_WALL", "WALLPAPER", "CONCRETE", "CARPET",
                 "GLASS", "MIRROR", "METAL", "ARTWORK", "POSTER"]:
        state = assess_tile_purity(observe(material=word))["state"]
        outcomes.append(check(f"    {word:18s} -> NOT_TILE",
                              state == "NOT_TILE",
                              "" if state == "NOT_TILE" else f"got {state}"))

    print("  -- could not be named: judged on the evidence instead --")
    unnamed = ["OTHER", "UNKNOWN", "", "TEXTURE", "SAMPLE", "SURFACE"]
    for word in unnamed:
        # Overwhelmingly tile and clean -> accepted.
        state = assess_tile_purity(observe(material=word, fraction=1.0))["state"]
        outcomes.append(check(
            f"    {word or '(blank)':18s} + 100% tile, clean  -> CLEAN",
            state == "CLEAN", "" if state == "CLEAN" else f"got {state}"))

    # ...and the same unnamed word must NOT get through on anything less.
    for word in unnamed:
        weak = assess_tile_purity(observe(material=word, fraction=0.3))["state"]
        dirty = assess_tile_purity(
            observe(material=word, fraction=1.0, contains_person=True)
        )["state"]
        scene = assess_tile_purity(
            observe(material=word, fraction=1.0, scene=True)
        )["state"]
        outcomes.append(check(
            f"    {word or '(blank)':18s} + weak/dirty/scene  -> refused",
            weak != "CLEAN" and dirty != "CLEAN" and scene != "CLEAN",
            f"{weak}/{dirty}/{scene}",
        ))

    return outcomes


def splitter_matrix():
    """The splitter on its own: does it cut where it should, and only there.

    The gradient case is the one that matters most. A tiled wall lit
    from one side changes just as much end-to-end as two different tiles
    do across a seam, and splitting on that would cut real products in
    half. A seam is a STEP, and that is what has to be detected.
    """
    import cv2
    from app.tile_region_extractor import split_tile_designs

    print("")
    print("=" * 72)
    print("DESIGN SPLITTER")
    print("=" * 72)

    def build(paint):
        image = Image.new("RGB", (600, 400), WALL)
        paint(ImageDraw.Draw(image))
        return cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)

    def one_design(draw):
        tile_field(draw, (0, 0, 600, 400), cell=40)

    def two_designs(draw):
        tile_field(draw, (0, 0, 300, 400), cell=40)
        tile_field(draw, (300, 0, 600, 400), cell=40, palette=(TILE_C, TILE_D))

    def four_designs(draw):
        """Four colourways in a strip -- how catalogs actually lay 4 up."""
        for index, (palette, cell) in enumerate([
            ((TILE_A, TILE_B), 30),
            ((TILE_C, TILE_D), 30),
            ((TILE_A, TILE_B), 60),
            ((TILE_C, TILE_D), 60),
        ]):
            tile_field(draw, (index * 150, 0, (index + 1) * 150, 400),
                       cell=cell, palette=palette)

    def lit_gradient(draw):
        """One design, strongly lit from the left -- must NOT split."""
        tile_field(draw, (0, 0, 600, 400), cell=40)

    cases = [
        ("one design                -> no split", one_design, 0, None),
        ("two designs               -> 2 pieces", two_designs, 2, 300),
        ("four designs              -> 4 pieces", four_designs, 4, None),
    ]

    outcomes = []
    for label, paint, expected, boundary in cases:
        pieces = split_tile_designs(build(paint))
        outcomes.append(check(
            label, len(pieces) == expected,
            f"got {len(pieces)}",
        ))

        if boundary is not None and len(pieces) == expected:
            edges = sorted({x for x1, _y1, x2, _y2 in pieces for x in (x1, x2)})
            outcomes.append(check(
                "    the cut lands on the seam, not in the middle of a tile",
                any(abs(edge - boundary) <= 12 for edge in edges),
                f"edges {edges}, seam at {boundary}",
            ))

    # A gradient applied to a single design, at an amplitude larger than
    # the step between the two designs above.
    image = build(lit_gradient).astype(np.int16)
    ramp = np.linspace(-55, 55, image.shape[1]).reshape(1, -1, 1)
    lit = np.clip(image + ramp, 0, 255).astype(np.uint8)

    outcomes.append(check(
        "one design under a strong lighting gradient -> no split",
        len(split_tile_designs(lit)) == 0,
        f"got {len(split_tile_designs(lit))} -- a gradient is not a seam",
    ))

    return outcomes


# Candidate sizes taken verbatim from the real catalog logs, with what
# each should do. The point of the pair 70x154 / 128x170 is that they
# are similar and must NOT go the same way: one is too narrow to read a
# pattern, the other is a small but perfectly usable sample.
SIZE_CASES = [
    ((210, 170), True, "accepted in the logs; must stay accepted"),
    ((128, 170), True, "small but readable -- was rejected"),
    ((1075, 110), True, "a long strip of tile -- was rejected on its "
                        "narrow side"),
    ((70, 154), False, "too narrow to read a tile pattern"),
    ((96, 96), False, "clears the side floor but has too little tile"),
    ((40, 40), False, "a speck"),
]


def size_gate_matrix():
    """Runs the real geometry on candidates of exactly the logged sizes."""
    import cv2
    from app.tile_region_extractor import extract_tile_region

    print("")
    print("=" * 72)
    print("SIZE GATES (real catalog candidate dimensions)")
    print("=" * 72)

    outcomes = []
    for (width, height), should_pass, note in SIZE_CASES:
        image = Image.new("RGB", (width, height), WALL)
        tile_field(ImageDraw.Draw(image), (0, 0, width, height),
                   cell=max(8, min(width, height) // 5), joint=2)
        path = OUT / f"_size_{width}x{height}.webp"
        image.save(path, "WEBP", quality=92, method=6)

        crop, info = extract_tile_region(
            cv2.imread(str(path), cv2.IMREAD_COLOR),
            [(0, 0), (width, 0), (width, height), (0, height)],
            [],
        )

        passed = crop is not None
        detail = note if passed == should_pass else (
            f"got {'accept' if passed else 'reject'} -- {info.get('reason', '')}"
        )
        outcomes.append(check(
            f"{width}x{height:<4} -> {'extract' if should_pass else 'reject':7s}",
            passed == should_pass, detail,
        ))

        if passed and info.get("upscaled"):
            print(f"         upscaled x{info['upscaled']} to "
                  f"{info['output_size'][0]}x{info['output_size'][1]} "
                  f"(interpolated, no detail invented)")

    return outcomes


def observe(material="TILE", fraction=1.0, scene=False, **flags):
    base = {
        "tile_fraction": fraction, "material": material, "is_scene": scene,
        # Fixtures represent photographed surfaces unless a case says
        # otherwise; the graphic cases pass physical_surface=False.
        "physical_surface": True,
        "contains_person": False, "contains_text": False,
        "contains_logo": False, "contains_furniture": False,
        "contains_fixture": False, "contains_object": False,
        "reason": "",
    }
    base.update(flags)
    return base


# The catalogue of situations this pipeline has to get right, as a table.
# CONTAMINATED is not a rejection -- it is "the tile is real, go isolate
# it" -- so the three outcomes below are genuinely distinct verdicts.
MATRIX = [
    ("wall tile + sofa", observe(contains_furniture=True), "CONTAMINATED"),
    ("floor tile + table/chair", observe(contains_furniture=True), "CONTAMINATED"),
    ("bathroom tile + toilet/sink", observe(contains_fixture=True), "CONTAMINATED"),
    ("tile + person", observe(contains_person=True), "CONTAMINATED"),
    ("tile + text overlay", observe(contains_text=True), "CONTAMINATED"),
    ("tile + logo", observe(contains_logo=True), "CONTAMINATED"),
    ("tile + decorative objects", observe(contains_object=True), "CONTAMINATED"),
    ("complete room with tile", observe(scene=True, fraction=0.5), "CONTAMINATED"),
    ("tile mostly covered", observe(fraction=0.4), "CONTAMINATED"),
    ("marketing image, genuine tile", observe(contains_text=True, fraction=0.7),
     "CONTAMINATED"),

    ("standalone tile", observe(), "CLEAN"),
    ("tile shown in perspective", observe(fraction=0.95), "CLEAN"),
    ("exterior wall tile", observe(), "CLEAN"),
    ("terrace / roof tile", observe(), "CLEAN"),

    ("kitchen countertop", observe(material="COUNTERTOP"), "NOT_TILE"),
    ("marble / stone slab", observe(material="STONE_SLAB"), "NOT_TILE"),
    ("wooden floor", observe(material="WOOD"), "NOT_TILE"),
    ("painted wall", observe(material="PAINTED_WALL"), "NOT_TILE"),
    ("carpet / fabric", observe(material="FABRIC"), "NOT_TILE"),
    ("decorative artwork", observe(material="ARTWORK"), "NOT_TILE"),
    ("glass / mirror", observe(material="GLASS"), "NOT_TILE"),
    ("countertop, even when clean", observe(material="COUNTERTOP", fraction=1.0),
     "NOT_TILE"),
]


def decision_matrix():
    print("")
    print("=" * 72)
    print("DECISION MATRIX")
    print("=" * 72)

    outcomes = []
    for label, observation, expected in MATRIX:
        actual = assess_tile_purity(observation)["state"]
        outcomes.append(check(
            f"{label:32s} -> {expected}",
            actual == expected,
            "" if actual == expected else f"got {actual}",
        ))
    return outcomes


def contact_sheet(sources, accepted_by_scene):
    """Renders source -> saved pairs so the images can be eyeballed."""
    cell, bar, gap = 260, 26, 12
    width = gap + (cell + gap) * 2
    height = gap + (cell + bar + gap) * len(sources)
    sheet = Image.new("RGB", (width, height), (238, 238, 238))
    draw = ImageDraw.Draw(sheet)
    label_font = font(13)

    for row, (name, path, description) in enumerate(sources):
        y = gap + row * (cell + bar + gap)

        with Image.open(path) as opened:
            thumb = opened.convert("RGB").copy()
        thumb.thumbnail((cell, cell))
        draw.rectangle([gap, y, gap + cell, y + bar], fill=(30, 30, 30))
        draw.text((gap + 6, y + 6), f"SOURCE  {description}",
                  fill=(255, 255, 255), font=label_font)
        sheet.paste(thumb, (gap, y + bar))

        x = gap + cell + gap
        saved = accepted_by_scene[name]
        if saved:
            with Image.open(saved[0][0]) as opened:
                out = opened.convert("RGB").copy()
            out.thumbnail((cell, cell))
            draw.rectangle([x, y, x + cell, y + bar], fill=(20, 90, 40))
            draw.text((x + 6, y + 6), "SAVED  tile-only",
                      fill=(255, 255, 255), font=label_font)
            sheet.paste(out, (x, y + bar))
        else:
            draw.rectangle([x, y, x + cell, y + bar], fill=(120, 30, 30))
            draw.text((x + 6, y + 6), "SAVED  nothing (correct)",
                      fill=(255, 255, 255), font=label_font)
            draw.rectangle([x, y + bar, x + cell, y + bar + cell],
                           fill=(214, 214, 214))

    path = OUT / "contact_sheet.png"
    sheet.save(path)
    print(f"contact sheet: {path}")


if __name__ == "__main__":
    raise SystemExit(main())
