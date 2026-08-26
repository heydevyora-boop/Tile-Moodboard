"""
test_visualization_upload_api.py

Offline test for visualization_upload_api.py.

The business visualization function is replaced with a fake.

No Gemini.
No Google Drive.
No Google Sheets.
"""

from pathlib import Path
import tempfile

from fastapi.testclient import TestClient

import app.visualization_upload_api as api


def main():

    print("")
    print("=" * 70)
    print(
        "VISUALIZATION UPLOAD API TEST"
    )
    print("=" * 70)

    original_create_visualization = (
        api.create_visualization
    )

    with tempfile.TemporaryDirectory() as temp_dir:

        upload_dir = (
            Path(temp_dir)
            / "incoming_scenes"
        )

        original_upload_root = (
            api.UPLOAD_ROOT
        )

        api.UPLOAD_ROOT = upload_dir

        def fake_create_visualization(
            request,
        ):

            scene_path = Path(
                request["scene_image"]
            )

            assert scene_path.exists()
            assert scene_path.is_file()

            return {
                "success": True,
                "status": "COMPLETED",
                "pipeline": (
                    "MASTER_TO_GEMINI_TO_DRIVE"
                    "_TO_SHEETS_TO_MOODBOARD"
                ),
                "visualization": {
                    "visualization_id": (
                        "VIZ_UPLOAD_TEST_001"
                    ),
                    "product_id": (
                        request[
                            "product_id"
                        ]
                    ),
                    "product_name": (
                        "Test Marble Tile"
                    ),
                    "surface": (
                        request[
                            "surface"
                        ]
                    ),
                    "image_path": (
                        "output/tile_visualizations/"
                        "TEST-P001_floor.png"
                    ),
                },
            }

        api.create_visualization = (
            fake_create_visualization
        )

        try:

            client = TestClient(
                api.app
            )

            # ------------------------------------------------
            # 1. HEALTH
            # ------------------------------------------------

            print("")
            print(
                "1. Testing health..."
            )

            response = client.get(
                "/health"
            )

            assert (
                response.status_code
                == 200
            )

            assert (
                response.json()[
                    "status"
                ]
                == "OK"
            )

            print(
                "[PASS] Health."
            )

            # ------------------------------------------------
            # 2. VALID UPLOAD
            # ------------------------------------------------

            print("")
            print(
                "2. Testing real multipart image upload..."
            )

            image_bytes = (
                b"\x89PNG\r\n\x1a\n"
                b"FAKE_IMAGE_DATA"
            )

            response = client.post(
                "/api/visualizations/upload",
                data={
                    "spreadsheet_id": (
                        "TEST_SPREADSHEET"
                    ),
                    "product_id": (
                        "TEST-P001"
                    ),
                    "surface": "floor",
                    "scene_id": (
                        "SCENE_UPLOAD_001"
                    ),
                    "sheet_name": "MASTER",
                },
                files={
                    "image": (
                        "bathroom.png",
                        image_bytes,
                        "image/png",
                    )
                },
            )

            assert (
                response.status_code
                == 200
            )

            payload = (
                response.json()
            )

            assert (
                payload["success"]
                is True
            )

            assert (
                payload["status"]
                == "COMPLETED"
            )

            assert (
                payload[
                    "visualization"
                ][
                    "product_id"
                ]
                == "TEST-P001"
            )

            assert (
                payload[
                    "visualization"
                ][
                    "surface"
                ]
                == "FLOOR"
            )

            assert (
                payload[
                    "upload"
                ][
                    "filename"
                ]
                == "bathroom.png"
            )

            assert (
                payload[
                    "upload"
                ][
                    "size_bytes"
                ] > 0
            )

            uploaded_path = Path(
                payload[
                    "upload"
                ][
                    "image_path"
                ]
            )

            assert uploaded_path.exists()
            assert uploaded_path.is_file()

            print(
                "[PASS] Multipart upload."
            )

            # ------------------------------------------------
            # 3. INVALID TYPE
            # ------------------------------------------------

            print("")
            print(
                "3. Testing invalid image type..."
            )

            response = client.post(
                "/api/visualizations/upload",
                data={
                    "spreadsheet_id": (
                        "TEST_SPREADSHEET"
                    ),
                    "product_id": (
                        "TEST-P001"
                    ),
                    "surface": "FLOOR",
                },
                files={
                    "image": (
                        "bathroom.txt",
                        b"NOT_AN_IMAGE",
                        "text/plain",
                    )
                },
            )

            assert (
                response.status_code
                == 400
            )

            print(
                "[PASS] Invalid image type."
            )

            # ------------------------------------------------
            # 4. INVALID SURFACE
            # ------------------------------------------------

            print("")
            print(
                "4. Testing invalid surface..."
            )

            response = client.post(
                "/api/visualizations/upload",
                data={
                    "spreadsheet_id": (
                        "TEST_SPREADSHEET"
                    ),
                    "product_id": (
                        "TEST-P001"
                    ),
                    "surface": "CEILING",
                },
                files={
                    "image": (
                        "bathroom.png",
                        image_bytes,
                        "image/png",
                    )
                },
            )

            assert (
                response.status_code
                == 400
            )

            print(
                "[PASS] Invalid surface."
            )

            # ------------------------------------------------
            # FINAL
            # ------------------------------------------------

            print("")
            print("=" * 70)
            print(
                "VISUALIZATION UPLOAD API TEST PASSED"
            )
            print("=" * 70)

            print("")
            print(
                "Health Endpoint   : OK"
            )

            print(
                "Multipart Upload  : OK"
            )

            print(
                "Image Persistence : OK"
            )

            print(
                "Invalid Type      : OK"
            )

            print(
                "Invalid Surface   : OK"
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

            api.create_visualization = (
                original_create_visualization
            )

            api.UPLOAD_ROOT = (
                original_upload_root
            )


if __name__ == "__main__":
    main()
