"""
test_visualization_http_api.py

Offline HTTP-level test for visualization_http_api.py.

The business API is replaced by a fake function.

No Gemini.
No Google Drive.
No Google Sheets.
"""

from pathlib import Path
import tempfile

from fastapi.testclient import TestClient

import app.visualization_http_api as server


def main():

    print("")
    print("=" * 70)
    print(
        "VISUALIZATION HTTP API TEST"
    )
    print("=" * 70)

    original_create_visualization = (
        server.create_visualization
    )

    with tempfile.TemporaryDirectory() as temp_dir:

        scene = (
            Path(temp_dir)
            / "bathroom.png"
        )

        scene.write_bytes(
            b"FAKE_IMAGE"
        )

        # ----------------------------------------------------
        # Fake business API
        # ----------------------------------------------------

        def fake_create_visualization(
            request,
        ):

            return {
                "success": True,
                "status": "COMPLETED",
                "pipeline": (
                    "MASTER_TO_GEMINI_TO_DRIVE"
                    "_TO_SHEETS_TO_MOODBOARD"
                ),
                "visualization": {
                    "visualization_id": (
                        "VIZ_TEST_001"
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
                        ].upper()
                    ),
                    "image_path": (
                        "output/tile_visualizations/"
                        "TEST-P001_floor.png"
                    ),
                },
                "drive": {
                    "status": "UPLOADED"
                },
                "master": {
                    "sheet_status": "UPLOADED"
                },
            }

        server.create_visualization = (
            fake_create_visualization
        )

        try:

            client = TestClient(
                server.app
            )

            # ------------------------------------------------
            # 1. HEALTH
            # ------------------------------------------------

            print("")
            print(
                "1. Testing health endpoint..."
            )

            response = client.get(
                "/health"
            )

            assert (
                response.status_code
                == 200
            )

            health = response.json()

            assert (
                health["success"]
                is True
            )

            assert (
                health["status"]
                == "OK"
            )

            print(
                "[PASS] Health endpoint."
            )

            # ------------------------------------------------
            # 2. VALID CREATE
            # ------------------------------------------------

            print("")
            print(
                "2. Testing visualization endpoint..."
            )

            response = client.post(
                "/api/visualizations",
                json={
                    "spreadsheet_id": (
                        "TEST_SPREADSHEET"
                    ),
                    "product_id": (
                        "TEST-P001"
                    ),
                    "scene_image": str(
                        scene
                    ),
                    "surface": "FLOOR",
                    "scene_id": (
                        "SCENE_TEST_001"
                    ),
                    "sheet_name": "MASTER",
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
                payload[
                    "visualization"
                ][
                    "visualization_id"
                ]
                == "VIZ_TEST_001"
            )

            assert (
                payload[
                    "visualization"
                ][
                    "product_id"
                ]
                == "TEST-P001"
            )

            print(
                "[PASS] Visualization endpoint."
            )

            # ------------------------------------------------
            # 3. VALIDATION FAILURE
            # ------------------------------------------------

            print("")
            print(
                "3. Testing request validation..."
            )

            response = client.post(
                "/api/visualizations",
                json={
                    "spreadsheet_id": "",
                    "product_id": "",
                    "scene_image": "",
                    "surface": "",
                },
            )

            assert (
                response.status_code
                == 422
            )

            print(
                "[PASS] Request validation."
            )

            # ------------------------------------------------
            # FINAL
            # ------------------------------------------------

            print("")
            print("=" * 70)
            print(
                "VISUALIZATION HTTP API TEST PASSED"
            )
            print("=" * 70)

            print("")
            print(
                "Health Endpoint : OK"
            )

            print(
                "POST Endpoint   : OK"
            )

            print(
                "Validation      : OK"
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

            server.create_visualization = (
                original_create_visualization
            )


if __name__ == "__main__":
    main()
