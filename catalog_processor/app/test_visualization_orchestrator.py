"""
test_visualization_orchestrator.py

Offline test for visualization_orchestrator.py.

No Gemini.
No Google Drive.
No Google Sheets.

The downstream services are replaced with fakes so this test
verifies orchestration order and data flow only.
"""

from pathlib import Path
import tempfile

import app.visualization_orchestrator as service


def main():

    print("")
    print("=" * 70)
    print(
        "VISUALIZATION ORCHESTRATOR TEST"
    )
    print("=" * 70)

    with tempfile.TemporaryDirectory() as temp_dir:

        temp = Path(temp_dir)

        scene_image = (
            temp
            / "bathroom.png"
        )

        scene_image.write_bytes(
            b"FAKE_BATHROOM_IMAGE"
        )

        calls = []

        # ----------------------------------------------------
        # Fake Product Visualization
        # ----------------------------------------------------

        original_product_visualization = (
            service.generate_product_visualization
        )

        def fake_product_visualization(
            spreadsheet_id,
            product_id,
            scene_image,
            surface,
            sheet_name,
        ):

            calls.append(
                "PRODUCT_VISUALIZATION"
            )

            return {
                "status": "GENERATED",
                "visualization_id": (
                    "VIZ_TEST_001"
                ),
                "scene_id": (
                    "SCENE_TEST_001"
                ),
                "product_id": product_id,
                "product_name": (
                    "Test Marble Tile"
                ),
                "surface": surface,
                "source_scene": str(
                    scene_image
                ),
                "tile_image": (
                    "output/crops/"
                    "001_TEST-P001.png"
                ),
                "image_path": (
                    "output/tile_visualizations/"
                    "TEST-P001_floor.png"
                ),
                "model": (
                    "gemini-3.1-flash-image"
                ),
            }

        # ----------------------------------------------------
        # Fake Drive
        # ----------------------------------------------------

        original_drive_upload = (
            service.upload_visualization_to_drive
        )

        def fake_drive_upload(
            record,
            update_registry=True,
        ):

            calls.append(
                "DRIVE"
            )

            return {
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
                "metadata": {
                    "file_id": (
                        "DRIVE_METADATA_001"
                    ),
                    "webViewLink": (
                        "https://drive.google.com/"
                        "file/d/DRIVE_METADATA_001"
                    ),
                },
            }

        # ----------------------------------------------------
        # Fake MASTER
        # ----------------------------------------------------

        original_master_persist = (
            service.persist_visualization_to_master
        )

        def fake_master_persist(
            spreadsheet_id,
            visualization_record,
            moodboard_id=None,
            sheet_name="MASTER",
        ):

            calls.append(
                "MASTER"
            )

            return {
                "record_id": (
                    "VIZ_VIZ_TEST_001"
                ),
                "sheet_status": (
                    "UPLOADED"
                ),
            }

        # ----------------------------------------------------
        # Fake Moodboard
        # ----------------------------------------------------

        original_attach_moodboard = (
            service.attach_visualization_to_moodboard
        )

        def fake_attach_moodboard(
            moodboard,
            visualization_record,
        ):

            calls.append(
                "MOODBOARD"
            )

            result = dict(
                moodboard
            )

            result[
                "applied_visualizations"
            ] = [
                visualization_record
            ]

            result[
                "applied_visualization_count"
            ] = 1

            return result

        # ----------------------------------------------------
        # Fake Final Design
        # ----------------------------------------------------

        original_attach_final_design = (
            service.attach_visualization_to_final_design
        )

        def fake_attach_final_design(
            final_design,
            visualization_record,
        ):

            calls.append(
                "FINAL_DESIGN"
            )

            result = dict(
                final_design
            )

            result[
                "applied_visualizations"
            ] = [
                visualization_record
            ]

            result[
                "applied_visualization_count"
            ] = 1

            return result

        try:

            service.generate_product_visualization = (
                fake_product_visualization
            )

            service.upload_visualization_to_drive = (
                fake_drive_upload
            )

            service.persist_visualization_to_master = (
                fake_master_persist
            )

            service.attach_visualization_to_moodboard = (
                fake_attach_moodboard
            )

            service.attach_visualization_to_final_design = (
                fake_attach_final_design
            )

            moodboard = {
                "moodboard_id": (
                    "MOOD_TEST_001"
                ),
                "name": (
                    "Modern Bathroom"
                ),
            }

            final_design = {
                "selected_moodboard": (
                    moodboard
                ),
                "rendering": {},
            }

            # ------------------------------------------------
            # 1. INPUT VALIDATION
            # ------------------------------------------------

            print("")
            print(
                "1. Validating orchestration input..."
            )

            validated = (
                service.validate_orchestration_input(
                    spreadsheet_id=(
                        "TEST_SPREADSHEET"
                    ),
                    product_id="TEST-P001",
                    scene_image=scene_image,
                    surface="FLOOR",
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

            print(
                "[PASS] Input validation."
            )

            # ------------------------------------------------
            # 2. FULL ORCHESTRATION
            # ------------------------------------------------

            print("")
            print(
                "2. Running orchestration..."
            )

            result = (
                service.generate_and_persist_visualization(
                    spreadsheet_id=(
                        "TEST_SPREADSHEET"
                    ),
                    product_id="TEST-P001",
                    scene_image=scene_image,
                    surface="FLOOR",
                    scene_id="SCENE_TEST_001",
                    moodboard=moodboard,
                    final_design=final_design,
                )
            )

            assert (
                result["status"]
                == "COMPLETED"
            )

            assert (
                result["visualization_id"]
                == "VIZ_TEST_001"
            )

            assert (
                result["drive_result"][
                    "status"
                ]
                == "UPLOADED"
            )

            assert (
                result["master_result"][
                    "sheet_status"
                ]
                == "UPLOADED"
            )

            assert (
                result["moodboard_result"][
                    "applied_visualization_count"
                ]
                == 1
            )

            assert (
                result["final_design_result"][
                    "applied_visualization_count"
                ]
                == 1
            )

            print(
                "[PASS] Orchestration completed."
            )

            # ------------------------------------------------
            # 3. ORDER CHECK
            # ------------------------------------------------

            print("")
            print(
                "3. Checking pipeline order..."
            )

            expected = [
                "PRODUCT_VISUALIZATION",
                "DRIVE",
                "MASTER",
                "MOODBOARD",
                "FINAL_DESIGN",
            ]

            assert calls == expected, (
                "Unexpected orchestration order:\n"
                f"Expected: {expected}\n"
                f"Actual:   {calls}"
            )

            print(
                "[PASS] Pipeline order."
            )

            # ------------------------------------------------
            # FINAL
            # ------------------------------------------------

            print("")
            print("=" * 70)
            print(
                "VISUALIZATION ORCHESTRATOR TEST PASSED"
            )
            print("=" * 70)

            print("")
            print(
                "Input Validation : OK"
            )

            print(
                "Product Service  : OK"
            )

            print(
                "Drive Layer      : OK"
            )

            print(
                "MASTER Layer     : OK"
            )

            print(
                "Moodboard Layer  : OK"
            )

            print(
                "Final Design     : OK"
            )

            print(
                "Pipeline Order   : OK"
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

            service.generate_product_visualization = (
                original_product_visualization
            )

            service.upload_visualization_to_drive = (
                original_drive_upload
            )

            service.persist_visualization_to_master = (
                original_master_persist
            )

            service.attach_visualization_to_moodboard = (
                original_attach_moodboard
            )

            service.attach_visualization_to_final_design = (
                original_attach_final_design
            )


if __name__ == "__main__":
    main()
