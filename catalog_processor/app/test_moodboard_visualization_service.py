"""
test_moodboard_visualization_service.py

Offline test.

No Gemini.
No Google Drive.
No Google Sheets.
"""

from pathlib import Path
import tempfile

from app.moodboard_visualization_service import (
    attach_visualization_to_moodboard,
    attach_visualization_to_final_design,
    build_moodboard_visualization_package,
    save_moodboard_visualization_package,
)


def main():

    print("")
    print("=" * 70)
    print(
        "MOODBOARD VISUALIZATION SERVICE TEST"
    )
    print("=" * 70)

    moodboard = {
        "moodboard_id": (
            "MOOD_TEST_001"
        ),
        "name": (
            "Modern Marble Bathroom"
        ),
        "description": (
            "Modern bathroom moodboard"
        ),
        "products": [
            {
                "product_id": "TEST-P001",
                "product_name": (
                    "Test Marble Tile"
                ),
            }
        ],
    }

    visualization = {
        "visualization_id": (
            "VIZ_TEST_001"
        ),
        "scene_id": (
            "SCENE_TEST_001"
        ),
        "product_id": (
            "TEST-P001"
        ),
        "product_name": (
            "Test Marble Tile"
        ),
        "surface": "FLOOR",
        "source_scene_image": (
            "input/bathroom.png"
        ),
        "tile_image": (
            "output/crops/"
            "001_TEST-P001.png"
        ),
        "applied_image": (
            "output/tile_visualizations/"
            "TEST-P001_floor.png"
        ),
        "drive_file_id": (
            "DRIVE_TEST_001"
        ),
        "drive_url": (
            "https://drive.google.com/"
            "file/d/DRIVE_TEST_001"
        ),
        "model": (
            "gemini-3.1-flash-image"
        ),
        "status": "UPLOADED",
        "metadata_path": (
            "output/visualizations/"
            "VIZ_TEST_001_metadata.json"
        ),
    }

    # --------------------------------------------------------
    # 1. MOODBOARD ATTACHMENT
    # --------------------------------------------------------

    print("")
    print(
        "1. Attaching visualization to moodboard..."
    )

    updated_moodboard = (
        attach_visualization_to_moodboard(
            moodboard,
            visualization,
        )
    )

    assert (
        updated_moodboard[
            "applied_visualization_count"
        ]
        == 1
    )

    assert (
        updated_moodboard[
            "applied_visualizations"
        ][0]["product_id"]
        == "TEST-P001"
    )

    print(
        "[PASS] Visualization attached to moodboard."
    )

    # --------------------------------------------------------
    # 2. DUPLICATE UPDATE
    # --------------------------------------------------------

    print("")
    print(
        "2. Testing duplicate visualization update..."
    )

    updated_visualization = dict(
        visualization
    )

    updated_visualization[
        "status"
    ] = "COMPLETED"

    updated_again = (
        attach_visualization_to_moodboard(
            updated_moodboard,
            updated_visualization,
        )
    )

    assert (
        updated_again[
            "applied_visualization_count"
        ]
        == 1
    )

    assert (
        updated_again[
            "applied_visualizations"
        ][0]["status"]
        == "COMPLETED"
    )

    print(
        "[PASS] Duplicate visualization updated."
    )

    # --------------------------------------------------------
    # 3. FINAL DESIGN
    # --------------------------------------------------------

    print("")
    print(
        "3. Attaching visualization to final design..."
    )

    final_design = {
        "engine": {
            "name": (
                "Final Bathroom "
                "Composition Engine"
            ),
            "version": "1.0",
        },
        "selected_moodboard": moodboard,
        "surface_products": [],
        "fixtures": {},
        "rendering": {
            "status": "READY"
        },
    }

    updated_design = (
        attach_visualization_to_final_design(
            final_design,
            visualization,
        )
    )

    assert (
        updated_design[
            "applied_visualization_count"
        ]
        == 1
    )

    assert (
        updated_design[
            "selected_moodboard"
        ][
            "applied_visualization_count"
        ]
        == 1
    )

    assert (
        updated_design[
            "rendering"
        ][
            "applied_visualization_image"
        ]
        == (
            "output/tile_visualizations/"
            "TEST-P001_floor.png"
        )
    )

    print(
        "[PASS] Visualization attached to final design."
    )

    # --------------------------------------------------------
    # 4. PACKAGE
    # --------------------------------------------------------

    print("")
    print(
        "4. Building moodboard visualization package..."
    )

    package = (
        build_moodboard_visualization_package(
            moodboard=moodboard,
            visualization_records=[
                visualization
            ],
            scene_id="SCENE_TEST_001",
        )
    )

    assert (
        package[
            "visualization_count"
        ]
        == 1
    )

    assert (
        package[
            "moodboard_id"
        ]
        == "MOOD_TEST_001"
    )

    print(
        "[PASS] Package built."
    )

    # --------------------------------------------------------
    # 5. SAVE JSON
    # --------------------------------------------------------

    print("")
    print(
        "5. Saving package..."
    )

    with tempfile.TemporaryDirectory() as temp:

        package_path = (
            Path(temp)
            / "moodboard_package.json"
        )

        saved_path = (
            save_moodboard_visualization_package(
                package,
                package_path,
            )
        )

        assert saved_path.exists()

        content = (
            saved_path.read_text(
                encoding="utf-8"
            )
        )

        assert (
            "VIZ_TEST_001"
            in content
        )

        assert (
            "TEST-P001"
            in content
        )

    print(
        "[PASS] Package saved."
    )

    # --------------------------------------------------------
    # FINAL
    # --------------------------------------------------------

    print("")
    print("=" * 70)
    print(
        "MOODBOARD VISUALIZATION SERVICE TEST PASSED"
    )
    print("=" * 70)

    print("")
    print(
        "Moodboard Attachment : OK"
    )

    print(
        "Duplicate Handling   : OK"
    )

    print(
        "Final Design         : OK"
    )

    print(
        "Package Generation   : OK"
    )

    print(
        "JSON Persistence     : OK"
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


if __name__ == "__main__":
    main()
