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

    results.extend(inheritance_matrix())
    results.extend(size_gate_matrix())
    results.extend(splitter_matrix())
    results.extend(decision_matrix())

    passed = sum(1 for r in results if r)
    print("")
    print(f"{passed}/{len(results)} checks passed")

    contact_sheet(sources, accepted_by_scene)
    return 0 if passed == len(results) else 1


def inheritance_matrix():
    """A split piece that cannot identify itself inherits the parent's material.

    Straight from the catalog log: a candidate reading material=TILE at
    100% tile fraction was split because it held two designs, and BOTH
    pieces came back OTHER and were thrown away. Two halves of a surface
    just called tile do not stop being tile by being looked at
    separately -- the verifier simply has less to go on once the piece
    is smaller and stripped of context.

    The inheritance is narrow on purpose. It applies only where the
    piece said "I cannot tell", and only from a parent that was
    confidently tile. A piece that positively identifies a countertop,
    a slab, architecture, a painted wall or artwork keeps its own answer
    -- next to a tiled wall, that piece really might be the worktop.
    """
    print("")
    print("=" * 72)
    print("PARENT EVIDENCE (split pieces)")
    print("=" * 72)

    confident_parent = observe(material="TILE", fraction=1.0)
    weak_parent = observe(material="TILE", fraction=0.5)

    cases = [
        ("piece OTHER        + parent TILE 100%  -> CLEAN",
         observe(material="OTHER"), confident_parent, "CLEAN"),
        ("piece UNKNOWN      + parent TILE 100%  -> CLEAN",
         observe(material="UNKNOWN"), confident_parent, "CLEAN"),
        ("piece OTHER        + no parent         -> NOT_TILE",
         observe(material="OTHER"), None, "NOT_TILE"),
        ("piece OTHER        + weak parent       -> NOT_TILE",
         observe(material="OTHER"), weak_parent, "NOT_TILE"),

        # The guards: a positive identification is never overridden.
        ("piece COUNTERTOP   + parent TILE 100%  -> NOT_TILE",
         observe(material="COUNTERTOP"), confident_parent, "NOT_TILE"),
        ("piece STONE_SLAB   + parent TILE 100%  -> NOT_TILE",
         observe(material="STONE_SLAB"), confident_parent, "NOT_TILE"),
        ("piece ARCHITECTURE + parent TILE 100%  -> NOT_TILE",
         observe(material="ARCHITECTURE"), confident_parent, "NOT_TILE"),
        ("piece PAINTED_WALL + parent TILE 100%  -> NOT_TILE",
         observe(material="PAINTED_WALL"), confident_parent, "NOT_TILE"),
        ("piece ARTWORK      + parent TILE 100%  -> NOT_TILE",
         observe(material="ARTWORK"), confident_parent, "NOT_TILE"),

        # Inheriting material does not excuse anything else.
        ("inherited piece with a person          -> CONTAMINATED",
         observe(material="OTHER", contains_person=True), confident_parent,
         "CONTAMINATED"),
        ("inherited piece with text              -> CONTAMINATED",
         observe(material="OTHER", contains_text=True), confident_parent,
         "CONTAMINATED"),
        ("inherited piece still holding 2 designs -> CONTAMINATED",
         observe(material="OTHER", distinct_tile_designs=2), confident_parent,
         "CONTAMINATED"),
    ]

    outcomes = []
    for label, piece, parent, expected in cases:
        actual = assess_tile_purity(piece, parent=parent)["state"]
        outcomes.append(check(
            label, actual == expected,
            "" if actual == expected else f"got {actual}",
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
