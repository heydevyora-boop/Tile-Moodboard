"""
test_visualization_api.py

Offline test for visualization_api.py.

The orchestration layer is replaced with a fake function so
no Gemini, Google Drive, or Google Sheets call is made.
"""

from pathlib import Path
import tempfile

import app.visualization_api as api


def main():

    print("")
    print("=" * 70)
    print(
        "VISUALIZATION API TEST"
    )
    print("=" * 70)

    with tempfile.TemporaryDirectory() as temp_dir:

        temp = Path(temp_dir)

        scene_image = (
            temp
            / "bathroom.png"
        )

        scene_image.write_bytes(
            b"FAKE_BATHROOM"
        )

        original_orchestrator = (
            api.generate_and_persist_visualization
        )

        def fake_orchestrator(
            *,
            spreadsheet_id,
            product_id,
            scene_image,
            surface,
            scene_id=None,
            sheet_name="MASTER",
            moodboard=None,
            final_design=None,
        ):

            return {
                "status": "COMPLETED",
                "pipeline": (
                    "MASTER_TO_GEMINI_TO_DRIVE"
                    "_TO_SHEETS_TO_MOODBOARD"
                ),
                "visualization_id": (
                    "VIZ_TEST_001"
                ),
                "product_id": product_id,
                "product_name": (
                    "Test Marble Tile"
                ),
                "surface": surface,
                "image_path": (
                    "output/tile_visualizations/"
                    "TEST-P001_floor.png"
                ),
                "drive_result": {
                    "status": "UPLOADED",
                    "image": {
                        "file_id": (
                            "DRIVE_IMAGE_001"
                        ),
                        "webViewLink": (
                            "https://drive.google.com/"
                            "file/d/DRIVE_IMAGE_001"
                        ),
                    },
                },
                "master_result": {
                    "record_id": (
                        "VIZ_VIZ_TEST_001"
                    ),
                    "sheet_status": (
                        "UPLOADED"
                    ),
                },
                "moodboard_result": {
                    "applied_visualization_count": 1
                },
                "final_design_result": {
                    "applied_visualization_count": 1
                },
            }

        try:

            api.generate_and_persist_visualization = (
                fake_orchestrator
            )

            # ------------------------------------------------
            # 1. REQUEST VALIDATION
            # ------------------------------------------------

            print("")
            print(
                "1. Validating request..."
            )

            request = {
                "spreadsheet_id": (
                    "TEST_SPREADSHEET"
                ),
                "product_id": (
                    "TEST-P001"
                ),
                "scene_image": str(
                    scene_image
                ),
                "surface": "floor",
                "scene_id": (
                    "SCENE_TEST_001"
                ),
            }

            validated = (
                api.validate_visualization_request(
                    request
                )
            )

            assert (
                validated["product_id"]
                == "TEST-P001"
            )

            assert (
                validated["surface"]
                == "FLOOR"
            )

            assert (
                validated["scene_id"]
                == "SCENE_TEST_001"
            )

            print(
                "[PASS] Request validation."
            )

            # ------------------------------------------------
            # 2. API SUCCESS
            # ------------------------------------------------

            print("")
            print(
                "2. Running visualization API..."
            )

            response = (
                api.create_visualization(
                    request
                )
            )

            assert (
                response["success"]
                is True
            )

            assert (
                response["status"]
                == "COMPLETED"
            )

            assert (
                response[
                    "visualization"
                ][
                    "visualization_id"
                ]
                == "VIZ_TEST_001"
            )

            assert (
                response[
                    "visualization"
                ][
                    "product_id"
                ]
                == "TEST-P001"
            )

            assert (
                response[
                    "drive"
                ][
                    "status"
                ]
                == "UPLOADED"
            )

            assert (
                response[
                    "master"
                ][
                    "sheet_status"
                ]
                == "UPLOADED"
            )

            print(
                "[PASS] Success response."
            )

            # ------------------------------------------------
            # 3. ERROR RESPONSE
            # ------------------------------------------------

            print("")
            print(
                "3. Testing API error handling..."
            )

            error_response = (
                api.create_visualization(
                    {
                        "spreadsheet_id": "",
                        "product_id": "",
                        "scene_image": "",
                        "surface": "",
                    }
                )
            )

            assert (
                error_response["success"]
                is False
            )

            assert (
                error_response["status"]
                == "FAILED"
            )

            assert (
                "error"
                in error_response
            )

            print(
                "[PASS] Error response."
            )

            # ------------------------------------------------
            # 4. STRICT API
            # ------------------------------------------------

            print("")
            print(
                "4. Testing strict API..."
            )

            strict_response = (
                api.create_visualization_strict(
                    request
                )
            )

            assert (
                strict_response["success"]
                is True
            )

            assert (
                strict_response[
                    "visualization"
                ][
                    "visualization_id"
                ]
                == "VIZ_TEST_001"
            )

            print(
                "[PASS] Strict API."
            )

            # ------------------------------------------------
            # 5. FILE CONVENIENCE API
            # ------------------------------------------------

            print("")
            print(
                "5. Testing file convenience API..."
            )

            file_response = (
                api.create_visualization_from_file(
                    spreadsheet_id=(
                        "TEST_SPREADSHEET"
                    ),
                    product_id=(
                        "TEST-P001"
                    ),
                    scene_image=scene_image,
                    surface="WALL",
                    scene_id=(
                        "SCENE_TEST_002"
                    ),
                )
            )

            assert (
                file_response["success"]
                is True
            )

            assert (
                file_response[
                    "visualization"
                ][
                    "product_id"
                ]
                == "TEST-P001"
            )

            print(
                "[PASS] File convenience API."
            )

            # ------------------------------------------------
            # FINAL
            # ------------------------------------------------

            print("")
            print("=" * 70)
            print(
                "VISUALIZATION API TEST PASSED"
            )
            print("=" * 70)

            print("")
            print(
                "Request Validation : OK"
            )

            print(
                "Success Response   : OK"
            )

            print(
                "Error Handling     : OK"
            )

            print(
                "Strict API         : OK"
            )

            print(
                "File API           : OK"
            )

            print("")
            print(
                "No Gemini API was used."
            )

            print(
                "No real Google Drive request was made."
            )

            print(
                "No real Google Sheets request was made."
            )

        finally:

            api.generate_and_persist_visualization = (
                original_orchestrator
            )


if __name__ == "__main__":
    main()
