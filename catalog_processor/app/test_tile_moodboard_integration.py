"""
test_tile_moodboard_integration.py

Integration test for:

Bathroom Scene
    +
Selected Tile Product
    ↓
Tile Visualization Pipeline
    ↓
Applied Tile Image
    ↓
Moodboard JSON

The test automatically handles missing test scene images by
creating a synthetic bathroom scene.

For production use, provide a real bathroom image at:

    input/bathroom.png
"""

from pathlib import Path
from typing import Optional

from PIL import Image, ImageDraw

from app.tile_moodboard_integration import (
    create_tile_moodboard,
)


# ============================================================
# PROJECT ROOT
# ============================================================

PROJECT_ROOT = (
    Path(__file__)
    .resolve()
    .parent
    .parent
)


# ============================================================
# TEST ASSETS
# ============================================================

INPUT_ROOT = (
    PROJECT_ROOT
    / "input"
)

SYNTHETIC_SCENE = (
    INPUT_ROOT
    / "synthetic_bathroom_test.png"
)

REAL_SCENE = (
    INPUT_ROOT
    / "bathroom.png"
)

TEST_PRODUCT_ID = "TEST-P001"

TEST_TILE_NAME = (
    "Selected Test Tile"
)

TEST_SURFACE = "FLOOR"


# ============================================================
# CREATE SYNTHETIC BATHROOM
# ============================================================

def create_synthetic_bathroom(
    output_path: Path,
) -> Path:
    """
    Create a simple bathroom-style test image.

    This is ONLY a development/test fallback.

    It is not intended to replace a real user bathroom image.
    """

    output_path = Path(
        output_path
    )

    output_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    width = 1200
    height = 900

    image = Image.new(
        "RGB",
        (width, height),
        "#E7E1D8",
    )

    draw = ImageDraw.Draw(
        image
    )

    # --------------------------------------------------------
    # WALL
    # --------------------------------------------------------

    wall_top = 0
    wall_bottom = 620

    draw.rectangle(
        [
            0,
            wall_top,
            width,
            wall_bottom,
        ],
        fill="#E7E1D8",
    )

    # --------------------------------------------------------
    # FLOOR
    # --------------------------------------------------------

    draw.polygon(
        [
            (0, 620),
            (width, 620),
            (width, height),
            (0, height),
        ],
        fill="#C7C0B5",
    )

    # --------------------------------------------------------
    # FLOOR LINES
    # --------------------------------------------------------

    for y in range(
        660,
        height,
        70,
    ):

        draw.line(
            [
                (0, y),
                (width, y),
            ],
            fill="#A9A197",
            width=2,
        )

    for x in range(
        0,
        width,
        90,
    ):

        draw.line(
            [
                (x, 620),
                (x, height),
            ],
            fill="#A9A197",
            width=2,
        )

    # --------------------------------------------------------
    # BACK WALL FEATURE
    # --------------------------------------------------------

    draw.rectangle(
        [
            360,
            130,
            840,
            500,
        ],
        fill="#D8D0C6",
        outline="#B8AEA4",
        width=3,
    )

    # --------------------------------------------------------
    # MIRROR
    # --------------------------------------------------------

    draw.rounded_rectangle(
        [
            470,
            160,
            730,
            340,
        ],
        radius=20,
        fill="#9EA8AB",
        outline="#6D7476",
        width=6,
    )

    # --------------------------------------------------------
    # VANITY
    # --------------------------------------------------------

    draw.rectangle(
        [
            390,
            400,
            810,
            500,
        ],
        fill="#8A7667",
        outline="#5E5147",
        width=3,
    )

    # Vanity top
    draw.rectangle(
        [
            370,
            380,
            830,
            410,
        ],
        fill="#D9D2C9",
        outline="#A9A198",
        width=2,
    )

    # --------------------------------------------------------
    # BASIN
    # --------------------------------------------------------

    draw.ellipse(
        [
            500,
            375,
            700,
            425,
        ],
        fill="#F4F3F0",
        outline="#9E9B95",
        width=3,
    )

    # --------------------------------------------------------
    # FAUCET
    # --------------------------------------------------------

    draw.line(
        [
            (600, 365),
            (600, 340),
            (630, 340),
            (630, 365),
        ],
        fill="#777777",
        width=7,
    )

    # --------------------------------------------------------
    # SHOWER PANEL
    # --------------------------------------------------------

    draw.rectangle(
        [
            870,
            120,
            1080,
            520,
        ],
        fill="#D1D8D8",
        outline="#858D8D",
        width=5,
    )

    draw.line(
        [
            (975, 120),
            (975, 520),
        ],
        fill="#9BA2A2",
        width=3,
    )

    # Shower fitting
    draw.ellipse(
        [
            945,
            185,
            1005,
            245,
        ],
        outline="#717777",
        width=6,
    )

    # --------------------------------------------------------
    # WC
    # --------------------------------------------------------

    draw.rounded_rectangle(
        [
            90,
            435,
            260,
            550,
        ],
        radius=30,
        fill="#F4F3F0",
        outline="#A7A49F",
        width=4,
    )

    draw.rectangle(
        [
            110,
            395,
            240,
            455,
        ],
        fill="#F4F3F0",
        outline="#A7A49F",
        width=4,
    )

    # --------------------------------------------------------
    # LIGHT
    # --------------------------------------------------------

    draw.ellipse(
        [
            515,
            40,
            685,
            90,
        ],
        fill="#FFF5D6",
        outline="#B7AD98",
        width=3,
    )

    # --------------------------------------------------------
    # IMAGE LABEL
    # --------------------------------------------------------

    draw.text(
        (30, 25),
        "SYNTHETIC BATHROOM TEST SCENE",
        fill="#555555",
    )

    # --------------------------------------------------------
    # SAVE
    # --------------------------------------------------------

    image.save(
        output_path,
        format="PNG",
    )

    return output_path


# ============================================================
# FIND EXISTING SCENE
# ============================================================

def find_existing_scene() -> Optional[Path]:
    """
    Search the project for an existing image that can be used
    as a test scene.

    Preferred location:
        input/bathroom.png
    """

    # --------------------------------------------------------
    # Preferred real image
    # --------------------------------------------------------

    if REAL_SCENE.exists():
        return REAL_SCENE

    # --------------------------------------------------------
    # Search common folders
    # --------------------------------------------------------

    search_roots = [
        PROJECT_ROOT / "input",
        PROJECT_ROOT / "output",
        PROJECT_ROOT / "config",
    ]

    valid_extensions = {
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
    }

    excluded_names = {
        "synthetic_bathroom_test.png",
        "real_applied_tile.png",
    }

    candidates = []

    for root in search_roots:

        if not root.exists():
            continue

        for path in root.rglob("*"):

            if not path.is_file():
                continue

            if path.suffix.lower() not in valid_extensions:
                continue

            if path.name.lower() in {
                name.lower()
                for name in excluded_names
            }:
                continue

            candidates.append(
                path
            )

    # --------------------------------------------------------
    # Prefer files whose names suggest a scene/bathroom
    # --------------------------------------------------------

    preferred_words = [
        "bathroom",
        "scene",
        "room",
        "interior",
        "reference",
    ]

    for candidate in candidates:

        name = candidate.name.lower()

        if any(
            word in name
            for word in preferred_words
        ):
            return candidate

    # --------------------------------------------------------
    # Otherwise return first valid candidate
    # --------------------------------------------------------

    if candidates:
        return candidates[0]

    return None


# ============================================================
# RESOLVE SCENE
# ============================================================

def resolve_test_scene() -> Path:
    """
    Return a real scene when available; otherwise create a
    synthetic bathroom scene.
    """

    existing_scene = (
        find_existing_scene()
    )

    if existing_scene is not None:

        print("")
        print(
            "[PASS] Existing scene found:"
        )

        print(
            existing_scene
        )

        return existing_scene

    print("")
    print(
        "[INFO] No bathroom scene found."
    )

    print(
        "[INFO] Creating synthetic bathroom test scene..."
    )

    synthetic_scene = (
        create_synthetic_bathroom(
            SYNTHETIC_SCENE
        )
    )

    print(
        "[PASS] Synthetic scene created:"
    )

    print(
        synthetic_scene
    )

    return synthetic_scene


# ============================================================
# MAIN TEST
# ============================================================

def main():

    print("=" * 70)
    print("TILE -> MOODBOARD INTEGRATION TEST")
    print("=" * 70)

    # --------------------------------------------------------
    # Resolve scene
    # --------------------------------------------------------

    scene_image = (
        resolve_test_scene()
    )

    # --------------------------------------------------------
    # Tile crop check
    # --------------------------------------------------------

    expected_tile = (
        PROJECT_ROOT
        / "output"
        / "crops"
        / "001_TEST-P001.png"
    )

    print("")
    print(
        "Expected test tile:"
    )

    print(
        expected_tile
    )

    if not expected_tile.exists():

        raise FileNotFoundError(
            "Expected TEST-P001 crop was not found:\n"
            f"{expected_tile}\n\n"
            "Run the cropper first:\n"
            "python -m app.test_scene_product_cropper"
        )

    print(
        "[PASS] Test tile exists."
    )

    # --------------------------------------------------------
    # Create moodboard
    # --------------------------------------------------------

    print("")
    print("=" * 70)
    print("GENERATING APPLIED TILE MOODBOARD")
    print("=" * 70)

    result = create_tile_moodboard(
        scene_image=scene_image,
        product_id=TEST_PRODUCT_ID,
        tile_name=TEST_TILE_NAME,
        surface=TEST_SURFACE,
    )

    # --------------------------------------------------------
    # Result
    # --------------------------------------------------------

    print("")
    print("=" * 70)
    print("RESULT")
    print("=" * 70)

    print("")
    print(
        "Status:",
        result.get(
            "status",
            "",
        ),
    )

    print(
        "Product ID:",
        result.get(
            "product_id",
            "",
        ),
    )

    print(
        "Tile name:",
        result.get(
            "tile_name",
            "",
        ),
    )

    print(
        "Surface:",
        result.get(
            "surface",
            "",
        ),
    )

    print(
        "Source scene:",
        result.get(
            "source_scene",
            "",
        ),
    )

    print(
        "Tile reference:",
        result.get(
            "tile_reference",
            "",
        ),
    )

    print(
        "Applied image:",
        result.get(
            "applied_image",
            "",
        ),
    )

    print(
        "Moodboard JSON:",
        result.get(
            "moodboard_path",
            "",
        ),
    )

    # --------------------------------------------------------
    # Validate result
    # --------------------------------------------------------

    applied_image = Path(
        result.get(
            "applied_image",
            "",
        )
    )

    if not applied_image.exists():

        raise RuntimeError(
            "Applied tile image was not created:\n"
            f"{applied_image}"
        )

    if applied_image.stat().st_size == 0:

        raise RuntimeError(
            "Applied tile image is empty:\n"
            f"{applied_image}"
        )

    moodboard_path = Path(
        result.get(
            "moodboard_path",
            "",
        )
    )

    if not moodboard_path.exists():

        raise RuntimeError(
            "Moodboard JSON was not created:\n"
            f"{moodboard_path}"
        )

    print("")
    print(
        "[PASS] Applied tile image exists."
    )

    print(
        "[PASS] Applied tile image is not empty."
    )

    print(
        "[PASS] Moodboard JSON exists."
    )

    # --------------------------------------------------------
    # Final
    # --------------------------------------------------------

    print("")
    print("=" * 70)
    print(
        "TILE -> MOODBOARD INTEGRATION TEST PASSED"
    )
    print("=" * 70)

    print("")
    print(
        "Bathroom Scene : OK"
    )

    print(
        "Tile Product   : OK"
    )

    print(
        "Tile Lookup    : OK"
    )

    print(
        "Tile Apply     : OK"
    )

    print(
        "Applied Image  : OK"
    )

    print(
        "Moodboard      : OK"
    )

    print("")
    print(
        "Generated image:"
    )

    print(
        applied_image
    )

    print("")
    print("=" * 70)


# ============================================================
# ENTRY POINT
# ============================================================

if __name__ == "__main__":
    main()