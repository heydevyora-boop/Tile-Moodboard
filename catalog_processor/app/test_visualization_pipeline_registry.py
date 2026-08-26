"""
test_visualization_pipeline_registry.py

Offline integration test for:

Tile Visualization Pipeline
        ↓
Visualization Registry

No Gemini API.
No Google Drive.
No Google Sheets.
"""

from pathlib import Path
import tempfile

from app.tile_visualization_pipeline import (
    find_cropped_tile,
    build_output_path,
)

from app.visualization_registry import (
    create_and_register_visualization,
    get_visualization,
    list_visualizations,
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
# MAIN
# ============================================================

def main():

    print("")
    print("=" * 70)
    print(
        "VISUALIZATION PIPELINE -> REGISTRY TEST"
    )
    print("=" * 70)

    product_id = "TEST-P001"
    surface = "FLOOR"

    # --------------------------------------------------------
    # 1. FIND TILE
    # --------------------------------------------------------

    print("")
    print(
        "1. Finding cropped tile..."
    )

    tile_image = find_cropped_tile(
        product_id
    )

    if not tile_image.exists():
        raise RuntimeError(
            f"Tile image does not exist:\n"
            f"{tile_image}"
        )

    print(
        "[PASS] Tile found:"
    )

    print(
        tile_image
    )

    # --------------------------------------------------------
    # 2. BUILD OUTPUT PATH
    # --------------------------------------------------------

    print("")
    print(
        "2. Building visualization output path..."
    )

    output_path = build_output_path(
        product_id=product_id,
        surface=surface,
    )

    print(
        "[PASS] Output path:"
    )

    print(
        output_path
    )

    # --------------------------------------------------------
    # 3. TEMPORARY REGISTRY
    # --------------------------------------------------------

    with tempfile.TemporaryDirectory() as temp_dir:

        registry_path = (
            Path(temp_dir)
            / "visualization_registry.json"
        )

        # ----------------------------------------------------
        # 4. REGISTER
        # ----------------------------------------------------

        print("")
        print(
            "3. Registering visualization..."
        )

        record = (
            create_and_register_visualization(
                scene_id="SCENE_TEST_001",

                product_id=product_id,

                product_name=(
                    "Test Marble Tile"
                ),

                surface=surface,

                source_scene_image=(
                    "input/bathroom.png"
                ),

                tile_image=str(
                    tile_image
                ),

                applied_image=str(
                    output_path
                ),

                model=(
                    "gemini-3.1-flash-image"
                ),

                status="GENERATED",

                registry_path=registry_path,
            )
        )

        if not record.get(
            "visualization_id"
        ):
            raise RuntimeError(
                "Visualization ID was not created."
            )

        print(
            "[PASS] Visualization registered."
        )

        print(
            "Visualization ID:",
            record[
                "visualization_id"
            ],
        )

        # ----------------------------------------------------
        # 5. READ
        # ----------------------------------------------------

        print("")
        print(
            "4. Reading registry record..."
        )

        loaded = get_visualization(
            record[
                "visualization_id"
            ],
            registry_path,
        )

        if loaded is None:
            raise RuntimeError(
                "Registered visualization "
                "could not be loaded."
            )

        if loaded.get(
            "product_id"
        ) != product_id:
            raise RuntimeError(
                "Product ID mismatch."
            )

        if loaded.get(
            "surface"
        ) != surface:
            raise RuntimeError(
                "Surface mismatch."
            )

        print(
            "[PASS] Registry record verified."
        )

        # ----------------------------------------------------
        # 6. FILTER
        # ----------------------------------------------------

        print("")
        print(
            "5. Filtering registry..."
        )

        results = list_visualizations(
            product_id=product_id,
            surface=surface,
            registry_path=registry_path,
        )

        if len(results) != 1:
            raise RuntimeError(
                "Expected exactly one "
                "visualization record."
            )

        print(
            "[PASS] Registry filtering."
        )

        # ----------------------------------------------------
        # FINAL
        # ----------------------------------------------------

        print("")
        print("=" * 70)
        print(
            "VISUALIZATION PIPELINE -> REGISTRY "
            "TEST PASSED"
        )
        print("=" * 70)

        print("")
        print(
            "Tile Lookup      : OK"
        )

        print(
            "Output Path      : OK"
        )

        print(
            "Registry Write   : OK"
        )

        print(
            "Registry Read    : OK"
        )

        print(
            "Registry Filter  : OK"
        )

        print("")
        print(
            "No Gemini API was used."
        )

        print(
            "No Google Drive was used."
        )

        print(
            "No Google Sheets was used."
        )

        print("")


# ============================================================
# ENTRY POINT
# ============================================================

if __name__ == "__main__":
    main()