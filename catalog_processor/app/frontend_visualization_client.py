"""
frontend_visualization_client.py

Small frontend/backend client for the Tile Visualization API.

Purpose:
    Keep HTTP communication separate from the UI.

Flow:
    Frontend code
        ↓
    this client
        ↓
    POST /api/visualizations
        ↓
    visualization_http_api.py

This module does not call Gemini, Google Drive, or Google Sheets
directly.

For the current API contract, scene_image is a server-accessible
file path. A real browser file-upload endpoint can be added later
without changing the business API structure.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional

import requests


# ============================================================
# DEFAULT CONFIGURATION
# ============================================================

DEFAULT_API_BASE_URL = (
    "http://127.0.0.1:8000"
)

DEFAULT_TIMEOUT_SECONDS = 300


# ============================================================
# CLIENT
# ============================================================

class VisualizationAPIClient:
    """
    HTTP client for the tile visualization API.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_API_BASE_URL,
        timeout: int = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:

        base_url = str(
            base_url
        ).strip().rstrip("/")

        if not base_url:
            raise ValueError(
                "base_url is required."
            )

        if timeout <= 0:
            raise ValueError(
                "timeout must be greater than zero."
            )

        self.base_url = base_url
        self.timeout = timeout

    # --------------------------------------------------------
    # HEALTH
    # --------------------------------------------------------

    def health(
        self,
    ) -> Dict[str, Any]:
        """
        Check whether the HTTP API is reachable.
        """

        url = (
            f"{self.base_url}"
            "/health"
        )

        response = requests.get(
            url,
            timeout=self.timeout,
        )

        response.raise_for_status()

        data = response.json()

        if not isinstance(
            data,
            dict,
        ):
            raise RuntimeError(
                "Health endpoint returned "
                "an invalid JSON object."
            )

        return data

    # --------------------------------------------------------
    # CREATE VISUALIZATION
    # --------------------------------------------------------

    def create_visualization(
        self,
        *,
        spreadsheet_id: str,
        product_id: str,
        scene_image: str | Path,
        surface: str,
        scene_id: Optional[str] = None,
        sheet_name: str = "MASTER",
        moodboard: Optional[
            Dict[str, Any]
        ] = None,
        final_design: Optional[
            Dict[str, Any]
        ] = None,
    ) -> Dict[str, Any]:
        """
        Send one visualization request to the API.
        """

        spreadsheet_id = str(
            spreadsheet_id
        ).strip()

        product_id = str(
            product_id
        ).strip()

        surface = str(
            surface
        ).strip().upper()

        scene_image = Path(
            scene_image
        )

        if not spreadsheet_id:
            raise ValueError(
                "spreadsheet_id is required."
            )

        if not product_id:
            raise ValueError(
                "product_id is required."
            )

        if not scene_image.exists():
            raise FileNotFoundError(
                f"Scene image not found: "
                f"{scene_image}"
            )

        if not scene_image.is_file():
            raise ValueError(
                f"Scene image is not a file: "
                f"{scene_image}"
            )

        if not surface:
            raise ValueError(
                "surface is required."
            )

        payload = {
            "spreadsheet_id": spreadsheet_id,
            "product_id": product_id,
            "scene_image": str(
                scene_image.resolve()
            ),
            "surface": surface,
            "scene_id": scene_id,
            "sheet_name": sheet_name,
        }

        if moodboard is not None:
            payload["moodboard"] = moodboard

        if final_design is not None:
            payload["final_design"] = final_design

        url = (
            f"{self.base_url}"
            "/api/visualizations"
        )

        try:

            response = requests.post(
                url,
                json=payload,
                timeout=self.timeout,
            )

        except requests.RequestException as error:

            raise RuntimeError(
                "Could not reach visualization API: "
                f"{error}"
            ) from error

        try:
            data = response.json()
        except ValueError as error:

            raise RuntimeError(
                "Visualization API returned "
                "non-JSON response."
            ) from error

        if response.status_code >= 400:

            message = (
                data.get(
                    "detail",
                    data,
                )
                if isinstance(
                    data,
                    dict,
                )
                else data
            )

            raise RuntimeError(
                "Visualization API request failed "
                f"(HTTP {response.status_code}): "
                f"{message}"
            )

        if not isinstance(
            data,
            dict,
        ):
            raise RuntimeError(
                "Visualization API returned "
                "an invalid response object."
            )

        if not data.get(
            "success",
            False,
        ):

            error = data.get(
                "error",
                {},
            )

            raise RuntimeError(
                "Visualization generation failed: "
                f"{error}"
            )

        return data


# ============================================================
# SIMPLE FUNCTION API
# ============================================================

def check_api_health(
    base_url: str = DEFAULT_API_BASE_URL,
) -> Dict[str, Any]:
    """
    Convenience function for health checks.
    """

    client = VisualizationAPIClient(
        base_url=base_url
    )

    return client.health()


def request_visualization(
    *,
    spreadsheet_id: str,
    product_id: str,
    scene_image: str | Path,
    surface: str,
    base_url: str = DEFAULT_API_BASE_URL,
    scene_id: Optional[str] = None,
    sheet_name: str = "MASTER",
) -> Dict[str, Any]:
    """
    Convenience function for one visualization request.
    """

    client = VisualizationAPIClient(
        base_url=base_url
    )

    return client.create_visualization(
        spreadsheet_id=spreadsheet_id,
        product_id=product_id,
        scene_image=scene_image,
        surface=surface,
        scene_id=scene_id,
        sheet_name=sheet_name,
    )
