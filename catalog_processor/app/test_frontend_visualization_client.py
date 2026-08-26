"""
test_frontend_visualization_client.py

Offline test for frontend_visualization_client.py.

The requests library is replaced with a fake implementation.

No running API server is required.
No Gemini.
No Google Drive.
No Google Sheets.
"""

from pathlib import Path
import tempfile

import app.frontend_visualization_client as client_module


# ============================================================
# FAKE RESPONSE
# ============================================================

class FakeResponse:

    def __init__(
        self,
        status_code,
        payload,
    ):
        self.status_code = status_code
        self._payload = payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(
                f"HTTP {self.status_code}"
            )

    def json(self):
        return self._payload


# ============================================================
# FAKE REQUESTS
# ============================================================

class FakeRequests:

    def __init__(self):
        self.last_url = ""
        self.last_payload = {}

    def get(
        self,
        url,
        timeout,
    ):
        self.last_url = url

        return FakeResponse(
            200,
            {
                "success": True,
                "status": "OK",
                "service": (
                    "tile-visualization-api"
                ),
            },
        )

    def post(
        self,
        url,
        json,
        timeout,
    ):
        self.last_url = url
        self.last_payload = json

        return FakeResponse(
            200,
            {
                "success": True,
                "status": "COMPLETED",
                "visualization": {
                    "visualization_id": (
                        "VIZ_TEST_001"
                    ),
                    "product_id": (
                        json["product_id"]
                    ),
                    "product_name": (
                        "Test Marble Tile"
                    ),
                    "surface": (
                        json["surface"]
                    ),
                    "image_path": (
                        "output/"
                        "tile_visualizations/"
                        "TEST-P001_floor.png"
                    ),
                },
                "drive": {
                    "status": "UPLOADED"
                },
                "master": {
                    "sheet_status": "UPLOADED"
                },
            },
        )


# ============================================================
# MAIN
# ============================================================

def main():

    print("")
    print("=" * 70)
    print(
        "FRONTEND VISUALIZATION CLIENT TEST"
    )
    print("=" * 70)

    fake_requests = FakeRequests()

    original_requests = (
        client_module.requests
    )

    with tempfile.TemporaryDirectory() as temp_dir:

        scene_image = (
            Path(temp_dir)
            / "bathroom.png"
        )

        scene_image.write_bytes(
            b"FAKE_BATHROOM_IMAGE"
        )

        try:

            client_module.requests = (
                fake_requests
            )

            client = (
                client_module.VisualizationAPIClient(
                    base_url=(
                        "http://127.0.0.1:8000"
                    )
                )
            )

            # ------------------------------------------------
            # 1. HEALTH
            # ------------------------------------------------

            print("")
            print(
                "1. Checking API health..."
            )

            health = (
                client.health()
            )

            assert (
                health["success"]
                is True
            )

            assert (
                health["status"]
                == "OK"
            )

            assert (
                fake_requests.last_url
                == (
                    "http://127.0.0.1:8000"
                    "/health"
                )
            )

            print(
                "[PASS] API health."
            )

            # ------------------------------------------------
            # 2. CREATE VISUALIZATION
            # ------------------------------------------------

            print("")
            print(
                "2. Sending visualization request..."
            )

            response = (
                client.create_visualization(
                    spreadsheet_id=(
                        "TEST_SPREADSHEET"
                    ),
                    product_id=(
                        "TEST-P001"
                    ),
                    scene_image=scene_image,
                    surface="floor",
                    scene_id=(
                        "SCENE_TEST_001"
                    ),
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
                    "surface"
                ]
                == "FLOOR"
            )

            print(
                "[PASS] Visualization request."
            )

            # ------------------------------------------------
            # 3. PAYLOAD
            # ------------------------------------------------

            print("")
            print(
                "3. Checking request payload..."
            )

            payload = (
                fake_requests.last_payload
            )

            assert (
                payload[
                    "spreadsheet_id"
                ]
                == "TEST_SPREADSHEET"
            )

            assert (
                payload[
                    "product_id"
                ]
                == "TEST-P001"
            )

            assert (
                payload[
                    "surface"
                ]
                == "FLOOR"
            )

            assert (
                payload[
                    "scene_id"
                ]
                == "SCENE_TEST_001"
            )

            assert (
                payload[
                    "sheet_name"
                ]
                == "MASTER"
            )

            assert (
                payload[
                    "scene_image"
                ]
            )

            print(
                "[PASS] Request payload."
            )

            # ------------------------------------------------
            # 4. SIMPLE FUNCTION
            # ------------------------------------------------

            print("")
            print(
                "4. Testing convenience function..."
            )

            response2 = (
                client_module.request_visualization(
                    spreadsheet_id=(
                        "TEST_SPREADSHEET"
                    ),
                    product_id=(
                        "TEST-P001"
                    ),
                    scene_image=scene_image,
                    surface="WALL",
                    base_url=(
                        "http://127.0.0.1:8000"
                    ),
                )
            )

            assert (
                response2["success"]
                is True
            )

            assert (
                response2[
                    "visualization"
                ][
                    "surface"
                ]
                == "WALL"
            )

            print(
                "[PASS] Convenience function."
            )

            # ------------------------------------------------
            # FINAL
            # ------------------------------------------------

            print("")
            print("=" * 70)
            print(
                "FRONTEND VISUALIZATION CLIENT TEST PASSED"
            )
            print("=" * 70)

            print("")
            print(
                "Health Request    : OK"
            )

            print(
                "POST Request      : OK"
            )

            print(
                "Payload           : OK"
            )

            print(
                "Response Parsing  : OK"
            )

            print(
                "Convenience API   : OK"
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

            client_module.requests = (
                original_requests
            )


if __name__ == "__main__":
    main()
