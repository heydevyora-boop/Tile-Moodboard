"""
visualization_upload_api.py

Real browser-upload endpoint for bathroom scene images.

This adapter accepts multipart/form-data:

    spreadsheet_id
    product_id
    surface
    scene_id (optional)
    sheet_name (optional)
    image

The uploaded image is stored temporarily on disk and then passed
to the existing business API:

    app.visualization_api.create_visualization()

This keeps image-upload/HTTP concerns separate from the existing
visualization business logic.

Endpoint:

    POST /api/visualizations/upload
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from app.visualization_api import (
    create_visualization,
)


# ============================================================
# CONFIGURATION
# ============================================================

PROJECT_ROOT = (
    Path(__file__).resolve().parent.parent
)

UPLOAD_ROOT = (
    PROJECT_ROOT
    / "output"
    / "incoming_scenes"
)

ALLOWED_IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}

MAX_UPLOAD_BYTES = 15 * 1024 * 1024


# ============================================================
# APP
# ============================================================

app = FastAPI(
    title="Tile Visualization Upload API",
    version="1.0.0",
)


# ============================================================
# HELPERS
# ============================================================

def _safe_text(value: Any) -> str:
    if value is None:
        return ""

    return str(value).strip()


def _validate_surface(
    surface: str,
) -> str:
    surface = _safe_text(
        surface
    ).upper()

    allowed = {
        "FLOOR",
        "WALL",
        "BACK_WALL",
        "SHOWER_WALL",
    }

    if surface not in allowed:
        raise ValueError(
            "Unsupported surface: "
            f"{surface}. "
            f"Allowed: {sorted(allowed)}"
        )

    return surface


def _build_upload_path(
    filename: str,
    content_type: str,
) -> Path:
    """
    Create a unique safe local path.
    """

    suffix = ALLOWED_IMAGE_TYPES[
        content_type
    ]

    safe_stem = (
        Path(
            filename or "bathroom"
        ).stem
        or "bathroom"
    )

    safe_stem = "".join(
        char
        if (
            char.isalnum()
            or char in (
                "_",
                "-",
            )
        )
        else "_"
        for char in safe_stem
    )

    unique_id = (
        uuid4()
        .hex[:12]
        .upper()
    )

    return (
        UPLOAD_ROOT
        / (
            f"{safe_stem}_"
            f"{unique_id}"
            f"{suffix}"
        )
    )


# ============================================================
# HEALTH
# ============================================================

@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "success": True,
        "status": "OK",
        "service": "tile-visualization-upload-api",
        "version": "1.0.0",
    }


# ============================================================
# BROWSER IMAGE UPLOAD
# ============================================================

@app.post(
    "/api/visualizations/upload"
)
async def upload_visualization_image(
    spreadsheet_id: str = Form(...),
    product_id: str = Form(...),
    surface: str = Form(...),
    scene_id: Optional[str] = Form(
        default=None
    ),
    sheet_name: str = Form(
        default="MASTER"
    ),
    image: UploadFile = File(...),
) -> Dict[str, Any]:

    try:

        spreadsheet_id = _safe_text(
            spreadsheet_id
        )

        product_id = _safe_text(
            product_id
        )

        scene_id = _safe_text(
            scene_id
        )

        sheet_name = (
            _safe_text(
                sheet_name
            )
            or "MASTER"
        )

        if not spreadsheet_id:
            raise HTTPException(
                status_code=400,
                detail="spreadsheet_id is required.",
            )

        if not product_id:
            raise HTTPException(
                status_code=400,
                detail="product_id is required.",
            )

        surface = _validate_surface(
            surface
        )

        if image is None:
            raise HTTPException(
                status_code=400,
                detail="image is required.",
            )

        content_type = (
            _safe_text(
                image.content_type
            ).lower()
        )

        if content_type not in ALLOWED_IMAGE_TYPES:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Unsupported image type. "
                    "Allowed: PNG, JPEG, WEBP."
                ),
            )

        UPLOAD_ROOT.mkdir(
            parents=True,
            exist_ok=True,
        )

        output_path = _build_upload_path(
            image.filename or "bathroom",
            content_type,
        )

        total_bytes = 0

        try:

            with output_path.open(
                "wb"
            ) as output_file:

                while True:

                    chunk = await image.read(
                        1024 * 1024
                    )

                    if not chunk:
                        break

                    total_bytes += len(
                        chunk
                    )

                    if (
                        total_bytes
                        > MAX_UPLOAD_BYTES
                    ):

                        output_file.close()

                        if output_path.exists():
                            output_path.unlink()

                        raise HTTPException(
                            status_code=413,
                            detail=(
                                "Image is too large. "
                                f"Maximum size is "
                                f"{MAX_UPLOAD_BYTES // (1024 * 1024)} MB."
                            ),
                        )

                    output_file.write(
                        chunk
                    )

        finally:
            await image.close()

        if (
            not output_path.exists()
            or output_path.stat().st_size == 0
        ):
            raise HTTPException(
                status_code=400,
                detail=(
                    "Uploaded image is empty."
                ),
            )

        request = {
            "spreadsheet_id": spreadsheet_id,
            "product_id": product_id,
            "scene_image": str(
                output_path.resolve()
            ),
            "surface": surface,
            "scene_id": scene_id or None,
            "sheet_name": sheet_name,
        }

        response = create_visualization(
            request
        )

        if not response.get(
            "success",
            False,
        ):
            return JSONResponse(
                status_code=400,
                content={
                    **response,
                    "upload": {
                        "image_path": str(
                            output_path
                        ),
                        "filename": (
                            image.filename
                        ),
                        "content_type": (
                            content_type
                        ),
                        "size_bytes": (
                            total_bytes
                        ),
                    },
                },
            )

        response["upload"] = {
            "image_path": str(
                output_path
            ),
            "filename": image.filename,
            "content_type": content_type,
            "size_bytes": total_bytes,
        }

        return response

    except HTTPException:
        raise

    except ValueError as error:

        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error

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
        ) from error


# ============================================================
# END
# ============================================================
