"""
test_visualization_registry.py

Offline test for the visualization registry.

No Gemini.
No Google Drive.
No Google Sheets.
"""

from pathlib import Path
import tempfile

from app.visualization_registry import (
    build_visualization_record,
    create_and_register_visualization,
    get_visualization,
    list_visualizations,
    update_visualization_status,
)


def main():
    print("=" * 70)
    print("VISUALIZATION REGISTRY TEST")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as temp:
        registry_path = (
            Path(temp)
            / "visualization_registry.json"
        )

        # ----------------------------------------------------
        # BUILD
        # ----------------------------------------------------

        print("")
        print("1. Building visualization record...")

        record = build_visualization_record(
            scene_id="SCENE_TEST_001",
            product_id="TEST-P001",
            product_name="Test Marble Tile",
            surface="FLOOR",
            source_scene_image=(
                "input/bathroom.png"
            ),
            tile_image=(
                "output/crops/001_TEST-P001.png"
            ),
            applied_image=(
                "output/tile_visualizations/"
                "TEST-P001_floor.png"
            ),
            model="gemini-3.1-flash-image",
            status="GENERATED",
        )

        assert record[
            "product_id"
        ] == "TEST-P001"

        assert record[
            "surface"
        ] == "FLOOR"

        assert record[
            "status"
        ] == "GENERATED"

        print(
            "[PASS] Record built."
        )

        print(
            "  Visualization ID:",
            record["visualization_id"],
        )

        # ----------------------------------------------------
        # REGISTER
        # ----------------------------------------------------

        print("")
        print("2. Registering visualization...")

        saved = create_and_register_visualization(
            scene_id=record["scene_id"],
            product_id=record["product_id"],
            product_name=record["product_name"],
            surface=record["surface"],
            source_scene_image=(
                record["source_scene_image"]
            ),
            tile_image=record["tile_image"],
            applied_image=(
                record["applied_image"]
            ),
            model=record["model"],
            status=record["status"],
            registry_path=registry_path,
        )

        assert registry_path.exists()

        print(
            "[PASS] Visualization registered."
        )

        # ----------------------------------------------------
        # GET
        # ----------------------------------------------------

        print("")
        print("3. Reading visualization...")

        loaded = get_visualization(
            saved["visualization_id"],
            registry_path,
        )

        assert loaded is not None

        assert loaded[
            "product_id"
        ] == "TEST-P001"

        print(
            "[PASS] Visualization lookup."
        )

        # ----------------------------------------------------
        # FILTER
        # ----------------------------------------------------

        print("")
        print("4. Filtering by product/surface...")

        results = list_visualizations(
            product_id="TEST-P001",
            surface="FLOOR",
            registry_path=registry_path,
        )

        assert len(results) == 1

        print(
            "[PASS] Visualization filtering."
        )

        # ----------------------------------------------------
        # STATUS UPDATE
        # ----------------------------------------------------

        print("")
        print("5. Updating storage status...")

        updated = update_visualization_status(
            saved["visualization_id"],
            "UPLOADED",
            drive_file_id="DRIVE_TEST_001",
            drive_url=(
                "https://drive.google.com/"
                "file/d/DRIVE_TEST_001"
            ),
            registry_path=registry_path,
        )

        assert updated[
            "status"
        ] == "UPLOADED"

        assert updated[
            "drive_file_id"
        ] == "DRIVE_TEST_001"

        assert updated[
            "drive_url"
        ]

        print(
            "[PASS] Visualization status updated."
        )

        # ----------------------------------------------------
        # FINAL
        # ----------------------------------------------------

        print("")
        print("=" * 70)
        print(
            "VISUALIZATION REGISTRY TEST PASSED"
        )
        print("=" * 70)

        print("")
        print(
            "Registry:",
            registry_path,
        )


if __name__ == "__main__":
    main()