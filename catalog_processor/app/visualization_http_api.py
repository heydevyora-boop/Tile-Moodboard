"""
visualization_http_api.py

HTTP API adapter for the existing visualization business API.

This module exposes the already-tested business function from
app.visualization_api through FastAPI.

It does NOT contain business logic. The workflow remains:

HTTP request
    ↓
visualization_http_api.py
    ↓
visualization_api.py
    ↓
visualization_orchestrator.py
    ↓
Product → Gemini → Registry → Drive → MASTER → Moodboard

The endpoint expects a JSON request containing:
    spreadsheet_id
    product_id
    scene_image
    surface
    optional scene_id
    optional sheet_name
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from app.visualization_api import (
    create_visualization,
)


# ============================================================
# APP
# ============================================================

app = FastAPI(
    title="Tile Visualization API",
    version="1.0.0",
)


# ============================================================
# REQUEST MODEL
# ============================================================

class VisualizationRequest(BaseModel):
    spreadsheet_id: str = Field(
        min_length=1
    )

    product_id: str = Field(
        min_length=1
    )

    scene_image: str = Field(
        min_length=1
    )

    surface: str = Field(
        min_length=1
    )

    scene_id: Optional[str] = None

    sheet_name: str = "MASTER"


# ============================================================
# HEALTH
# ============================================================

@app.get("/health")
def health() -> Dict[str, Any]:
    """
    Lightweight health endpoint.

    Does not call Gemini, Drive, or Sheets.
    """

    return {
        "success": True,
        "status": "OK",
        "service": "tile-visualization-api",
        "version": "1.0.0",
    }


# ============================================================
# CREATE VISUALIZATION
# ============================================================

@app.post("/api/visualizations")
def create_visualization_endpoint(
    request: VisualizationRequest,
) -> Dict[str, Any]:
    """
    Generate and persist a tile visualization.
    """

    try:

        response = create_visualization(
            request.model_dump()
        )

        if not response.get(
            "success",
            False,
        ):
            error = response.get(
                "error",
                {},
            )

            raise HTTPException(
                status_code=400,
                detail=error,
            )

        return response

    except HTTPException:
        raise

    except Exception as error:

        raise HTTPException(
            status_code=500,
            detail={
                "type": type(
                    error
                ).__name__,
                "message": str(
                    error
                ),
            },
        )


# ============================================================
# END
# ============================================================
