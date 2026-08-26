from pathlib import Path
import tempfile

from PIL import Image

from app.tile_application_engine import (
    build_tile_application_prompt,
    validate_surface,
    validate_image,
)


def create_test_image(path: Path):
    image = Image.new(
        "RGB",
        (512, 512),
        "white",
    )

    image.save(
        path,
        format="PNG",
    )


def test_tile_application_offline():

    print("")
    print("=" * 70)
    print("TILE APPLICATION ENGINE OFFLINE TEST")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as temp:

        temp_dir = Path(temp)

        scene_path = (
            temp_dir
            / "bathroom.png"
        )

        tile_path = (
            temp_dir
            / "tile.png"
        )

        create_test_image(
            scene_path
        )

        create_test_image(
            tile_path
        )

        # ----------------------------------------------------
        # VALIDATE IMAGES
        # ----------------------------------------------------

        validate_image(
            scene_path,
            "Scene image",
        )

        validate_image(
            tile_path,
            "Tile image",
        )

        print(
            "[PASS] Scene image validated."
        )

        print(
            "[PASS] Tile image validated."
        )

        # ----------------------------------------------------
        # SURFACE
        # ----------------------------------------------------

        assert (
            validate_surface("FLOOR")
            == "FLOOR"
        )

        print(
            "[PASS] FLOOR surface validated."
        )

        # ----------------------------------------------------
        # PROMPT
        # ----------------------------------------------------

        prompt = build_tile_application_prompt(
            surface="FLOOR",
            tile_product_id="TEST-TILE-001",
            tile_name="Test Marble Tile",
        )

        assert (
            "EXACT tile" in prompt
        )

        assert (
            "FLOOR" in prompt
        )

        print(
            "[PASS] Tile application prompt created."
        )

    print("")
    print("=" * 70)
    print("TILE APPLICATION ENGINE OFFLINE TEST PASSED")
    print("=" * 70)


if __name__ == "__main__":
    test_tile_application_offline()