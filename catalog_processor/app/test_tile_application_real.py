"""
test_tile_application_real.py

REAL integration test for the tile application engine.

Usage:

python -m app.test_tile_application_real ^
    --scene "C:\\path\\to\\bathroom.png" ^
    --tile "C:\\path\\to\\tile.png"

Example:

python -m app.test_tile_application_real ^
    --scene ".\\input\\bathroom.png" ^
    --tile ".\\output\\crops\\001_TEST-P001.png"
"""

from pathlib import Path
import argparse
import sys

from app.tile_application_engine import (
    apply_tile_to_scene,
    validate_image,
    validate_surface,
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
# DEFAULT OUTPUT
# ============================================================

DEFAULT_OUTPUT = (
    PROJECT_ROOT
    / "output"
    / "tile_applications"
    / "REAL_APPLIED_TILE.png"
)


# ============================================================
# ARGUMENT PARSER
# ============================================================

def parse_args():
    parser = argparse.ArgumentParser(
        description=(
            "Generate a real bathroom image with "
            "the selected tile applied."
        )
    )

    parser.add_argument(
        "--scene",
        required=True,
        help=(
            "Path to the original bathroom/interior image."
        ),
    )

    parser.add_argument(
        "--tile",
        required=True,
        help=(
            "Path to the selected/cropped tile image."
        ),
    )

    parser.add_argument(
        "--surface",
        default="FLOOR",
        choices=[
            "FLOOR",
            "WALL",
            "BACK_WALL",
            "SHOWER_WALL",
        ],
        help="Surface where the tile should be applied.",
    )

    parser.add_argument(
        "--product-id",
        default="REAL-TILE-001",
        help="Tile product ID.",
    )

    parser.add_argument(
        "--tile-name",
        default="Selected Tile",
        help="Tile product name.",
    )

    parser.add_argument(
        "--output",
        default=str(DEFAULT_OUTPUT),
        help="Output path for generated image.",
    )

    return parser.parse_args()


# ============================================================
# RESOLVE PATH
# ============================================================

def resolve_path(
    value: str,
) -> Path:
    """
    Resolve an absolute or project-relative path.
    """

    path = Path(value)

    if not path.is_absolute():
        path = (
            PROJECT_ROOT
            / path
        )

    return path.resolve()


# ============================================================
# MAIN
# ============================================================

def main():

    args = parse_args()

    scene_image = resolve_path(
        args.scene
    )

    tile_image = resolve_path(
        args.tile
    )

    output_image = resolve_path(
        args.output
    )

    # --------------------------------------------------------
    # HEADER
    # --------------------------------------------------------

    print("")
    print("=" * 70)
    print("REAL TILE APPLICATION TEST")
    print("=" * 70)

    print("")
    print("Project root:")
    print(PROJECT_ROOT)

    print("")
    print("Bathroom image:")
    print(scene_image)

    print("")
    print("Tile image:")
    print(tile_image)

    print("")
    print("Surface:")
    print(args.surface)

    print("")
    print("Output image:")
    print(output_image)

    # --------------------------------------------------------
    # INPUT CHECK
    # --------------------------------------------------------

    print("")
    print("=" * 70)
    print("CHECKING INPUTS")
    print("=" * 70)

    if not scene_image.exists():

        raise FileNotFoundError(
            "Bathroom image not found:\n"
            f"{scene_image}"
        )

    if not tile_image.exists():

        raise FileNotFoundError(
            "Tile image not found:\n"
            f"{tile_image}"
        )

    if not scene_image.is_file():

        raise ValueError(
            "Bathroom path is not a file:\n"
            f"{scene_image}"
        )

    if not tile_image.is_file():

        raise ValueError(
            "Tile path is not a file:\n"
            f"{tile_image}"
        )

    print(
        "[PASS] Bathroom image exists."
    )

    print(
        "[PASS] Tile image exists."
    )

    # --------------------------------------------------------
    # IMAGE VALIDATION
    # --------------------------------------------------------

    validate_image(
        scene_image,
        "Bathroom image",
    )

    validate_image(
        tile_image,
        "Tile image",
    )

    print(
        "[PASS] Bathroom image is valid."
    )

    print(
        "[PASS] Tile image is valid."
    )

    # --------------------------------------------------------
    # SURFACE VALIDATION
    # --------------------------------------------------------

    surface = validate_surface(
        args.surface
    )

    print(
        f"[PASS] Surface validated: {surface}"
    )

    # --------------------------------------------------------
    # CREATE OUTPUT DIRECTORY
    # --------------------------------------------------------

    output_image.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    # --------------------------------------------------------
    # REAL GEMINI GENERATION
    # --------------------------------------------------------

    print("")
    print("=" * 70)
    print("GENERATING APPLIED TILE IMAGE")
    print("=" * 70)

    print("")
    print(
        "This call uses the real Gemini image-generation API."
    )

    print("")
    print(
        "Please wait..."
    )

    result = apply_tile_to_scene(
        scene_image=scene_image,
        tile_image=tile_image,
        surface=surface,
        output_path=output_image,
        tile_product_id=args.product_id,
        tile_name=args.tile_name,
    )

    # --------------------------------------------------------
    # RESULT
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
        "Surface:",
        result.get(
            "surface",
            "",
        ),
    )

    print(
        "Tile Product ID:",
        result.get(
            "tile_product_id",
            "",
        ),
    )

    print(
        "Tile Name:",
        result.get(
            "tile_name",
            "",
        ),
    )

    generated_path = Path(
        result.get(
            "image_path",
            output_image,
        )
    )

    print("")
    print(
        "Generated image:"
    )

    print(
        generated_path
    )

    # --------------------------------------------------------
    # OUTPUT CHECK
    # --------------------------------------------------------

    print("")
    print("=" * 70)
    print("CHECKING GENERATED IMAGE")
    print("=" * 70)

    if not generated_path.exists():

        raise RuntimeError(
            "Gemini generation returned successfully, "
            "but the output image was not found:\n"
            f"{generated_path}"
        )

    if generated_path.stat().st_size == 0:

        raise RuntimeError(
            "Generated image is empty:\n"
            f"{generated_path}"
        )

    print(
        "[PASS] Generated image exists."
    )

    print(
        "[PASS] Generated image is not empty."
    )

    # --------------------------------------------------------
    # FINAL
    # --------------------------------------------------------

    print("")
    print("=" * 70)
    print("REAL TILE APPLICATION TEST PASSED")
    print("=" * 70)

    print("")
    print(
        "Bathroom image  : OK"
    )

    print(
        "Tile image      : OK"
    )

    print(
        "Surface         : OK"
    )

    print(
        "Gemini          : OK"
    )

    print(
        "Applied image   : OK"
    )

    print("")
    print(
        "OUTPUT:"
    )

    print(
        generated_path
    )

    print("")
    print("=" * 70)


# ============================================================
# ENTRY POINT
# ============================================================

if __name__ == "__main__":

    try:
        main()

    except Exception as error:

        print("")
        print("=" * 70)
        print("REAL TILE APPLICATION TEST FAILED")
        print("=" * 70)

        print("")
        print(
            f"{type(error).__name__}: {error}"
        )

        print("")

        sys.exit(1)