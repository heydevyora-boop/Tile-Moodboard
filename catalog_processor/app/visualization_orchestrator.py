"""
visualization_orchestrator.py

Production orchestration layer for the complete applied-tile
visualization workflow.

Flow:

Bathroom Scene
    +
MASTER Product ID
    +
Surface
    ↓
Product Visualization Service
    ↓
Tile Visualization Pipeline
    ↓
Visualization Registry
    ↓
Google Drive
    ↓
Google MASTER persistence
    ↓
Moodboard / Final Design integration

Important:
- No new authentication system is created.
- Gemini is called only by the downstream visualization engine.
- Drive uses the existing visualization Drive service.
- MASTER uses the existing Google MASTER persistence layer.
- Moodboard integration is performed only after visualization
  persistence succeeds.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional

import hashlib
import re
import urllib.parse

from app.product_visualization_service import (
    generate_product_visualization,
)

from app.scene_image_resolver import resolve_scene_image

from app.visualization_drive_service import (
    upload_visualization_to_drive,
)

from app.google_master_persistence import (
    persist_visualization_to_master,
)

from app.moodboard_visualization_service import (
    attach_visualization_to_moodboard,
    attach_visualization_to_final_design,
)


# ============================================================
# HELPERS
# ============================================================

def _safe_text(value: Any) -> str:
    if value is None:
        return ""

    return str(value).strip()


def _validate_scene_image(
    scene_image: Path,
) -> Path:
    scene_image = Path(
        scene_image
    )

    if not scene_image.exists():
        raise FileNotFoundError(
            f"Scene image not found: {scene_image}"
        )

    if not scene_image.is_file():
        raise ValueError(
            f"Scene image is not a file: {scene_image}"
        )

    return scene_image.resolve()


# ============================================================
# BUILD VISUALIZATION RECORD
# ============================================================

def _build_registry_record(
    visualization_result: Dict[str, Any],
    scene_id: Optional[str],
) -> Dict[str, Any]:
    """
    Convert product visualization output into the normalized
    visualization registry record expected by downstream
    persistence layers.
    """

    if not isinstance(
        visualization_result,
        dict,
    ):
        raise TypeError(
            "visualization_result must be a dictionary."
        )

    visualization_id = _safe_text(
        visualization_result.get(
            "visualization_id",
            "",
        )
    )

    if not visualization_id:
        visualization_id = _safe_text(
            visualization_result.get(
                "registry_record",
                {},
            ).get(
                "visualization_id",
                "",
            )
        )

    if not visualization_id:
        raise RuntimeError(
            "Visualization ID was not produced by "
            "the visualization pipeline."
        )

    registry_record = {
        "visualization_id": visualization_id,
        "scene_id": (
            _safe_text(
                scene_id
            )
            or _safe_text(
                visualization_result.get(
                    "scene_id",
                    "",
                )
            )
        ),
        "product_id": _safe_text(
            visualization_result.get(
                "product_id",
                "",
            )
        ),
        "product_name": _safe_text(
            visualization_result.get(
                "product_name",
                "",
            )
        ),
        "surface": _safe_text(
            visualization_result.get(
                "surface",
                "",
            )
        ).upper(),
        "source_scene_image": _safe_text(
            visualization_result.get(
                "source_scene",
                visualization_result.get(
                    "source_scene_image",
                    "",
                ),
            )
        ),
        "tile_image": _safe_text(
            visualization_result.get(
                "tile_image",
                visualization_result.get(
                    "product_image",
                    "",
                ),
            )
        ),
        "applied_image": _safe_text(
            visualization_result.get(
                "image_path",
                visualization_result.get(
                    "applied_image",
                    "",
                ),
            )
        ),
        "drive_file_id": _safe_text(
            visualization_result.get(
                "drive_file_id",
                "",
            )
        ),
        "drive_url": _safe_text(
            visualization_result.get(
                "drive_url",
                "",
            )
        ),
        "model": _safe_text(
            visualization_result.get(
                "model",
                "",
            )
        ),
        "status": (
            _safe_text(
                visualization_result.get(
                    "status",
                    "GENERATED",
                )
            ).upper()
            or "GENERATED"
        ),
        "metadata_path": _safe_text(
            visualization_result.get(
                "metadata_path",
                "",
            )
        ),
    }

    return registry_record


# ============================================================
# MAIN ORCHESTRATOR
# ============================================================

def generate_and_persist_visualization(
    *,
    spreadsheet_id: str,
    product_id: str,
    scene_image: Path,
    surface: str = "FLOOR",
    scene_id: Optional[str] = None,
    sheet_name: str = "MASTER",
    moodboard: Optional[Dict[str, Any]] = None,
    final_design: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Execute the complete backend visualization workflow.

    Steps:
        1. MASTER Product lookup
        2. Exact tile image resolution
        3. Gemini tile visualization
        4. Visualization registry
        5. Google Drive persistence
        6. Google MASTER persistence
        7. Optional moodboard integration
        8. Optional final-design integration
    """

    if not spreadsheet_id:
        raise ValueError(
            "spreadsheet_id is required."
        )

    product_id = _safe_text(
        product_id
    )

    if not product_id:
        raise ValueError(
            "product_id is required."
        )

    scene_image = resolve_scene_image(
        scene_image
    )

    # --------------------------------------------------------
    # STEP 1-3
    # MASTER -> exact image -> Gemini visualization
    # --------------------------------------------------------

    visualization_result = (
        generate_product_visualization(
            spreadsheet_id=spreadsheet_id,
            product_id=product_id,
            scene_image=scene_image,
            surface=surface,
            sheet_name=sheet_name,
        )
    )

    # --------------------------------------------------------
    # Build normalized persistence record
    # --------------------------------------------------------

    registry_record = _build_registry_record(
        visualization_result,
        scene_id,
    )

    # --------------------------------------------------------
    # STEP 4
    # Visualization Registry
    # --------------------------------------------------------

    # The tile visualization pipeline normally creates the
    # registry record already. Preserve that ID and metadata.
    visualization_result[
        "registry_record"
    ] = registry_record

    visualization_result[
        "visualization_id"
    ] = registry_record[
        "visualization_id"
    ]

    # --------------------------------------------------------
    # STEP 5
    # Google Drive
    # --------------------------------------------------------

    drive_result = (
        upload_visualization_to_drive(
            registry_record,
            update_registry=True,
        )
    )

    visualization_result[
        "drive_result"
    ] = drive_result

    # --------------------------------------------------------
    # Update normalized record with Drive information
    # --------------------------------------------------------

    image_upload = (
        drive_result.get(
            "image",
            {},
        )
    )

    registry_record[
        "drive_file_id"
    ] = _safe_text(
        image_upload.get(
            "file_id",
            "",
        )
    )

    registry_record[
        "drive_url"
    ] = _safe_text(
        image_upload.get(
            "webViewLink",
            "",
        )
    )

    registry_record[
        "status"
    ] = "UPLOADED"

    metadata_upload = (
        drive_result.get(
            "metadata",
            {},
        )
    )

    registry_record[
        "metadata_drive_file_id"
    ] = _safe_text(
        metadata_upload.get(
            "file_id",
            "",
        )
    )

    registry_record[
        "metadata_drive_url"
    ] = _safe_text(
        metadata_upload.get(
            "webViewLink",
            "",
        )
    )

    # --------------------------------------------------------
    # STEP 6
    # Google MASTER persistence
    # --------------------------------------------------------

    master_result = (
        persist_visualization_to_master(
            spreadsheet_id=spreadsheet_id,
            visualization_record=registry_record,
            moodboard_id=(
                _safe_text(
                    (
                        moodboard or {}
                    ).get(
                        "moodboard_id",
                        "",
                    )
                )
            ),
            sheet_name=sheet_name,
        )
    )

    visualization_result[
        "master_result"
    ] = master_result

    # --------------------------------------------------------
    # STEP 7
    # Moodboard integration
    # --------------------------------------------------------

    if moodboard is not None:

        visualization_result[
            "moodboard_result"
        ] = (
            attach_visualization_to_moodboard(
                moodboard,
                registry_record,
            )
        )

    else:

        visualization_result[
            "moodboard_result"
        ] = None

    # --------------------------------------------------------
    # STEP 8
    # Final design integration
    # --------------------------------------------------------

    if final_design is not None:

        visualization_result[
            "final_design_result"
        ] = (
            attach_visualization_to_final_design(
                final_design,
                registry_record,
            )
        )

    else:

        visualization_result[
            "final_design_result"
        ] = None

    # --------------------------------------------------------
    # FINAL STATUS
    # --------------------------------------------------------

    visualization_result[
        "status"
    ] = "COMPLETED"

    visualization_result[
        "pipeline"
    ] = (
        "MASTER_TO_GEMINI_TO_DRIVE_TO_SHEETS_TO_MOODBOARD"
    )

    return visualization_result


# ============================================================
# DRY-RUN VALIDATION
# ============================================================

def validate_orchestration_input(
    *,
    spreadsheet_id: str,
    product_id: str,
    scene_image: Path,
    surface: str,
) -> Dict[str, str]:
    """
    Validate orchestration inputs without calling any external
    service or Gemini.
    """

    if not _safe_text(
        spreadsheet_id
    ):
        raise ValueError(
            "spreadsheet_id is required."
        )

    if not _safe_text(
        product_id
    ):
        raise ValueError(
            "product_id is required."
        )

    scene_image = resolve_scene_image(
        scene_image
    )

    surface = _safe_text(
        surface
    ).upper()

    if not surface:
        raise ValueError(
            "surface is required."
        )

    return {
        "spreadsheet_id": _safe_text(
            spreadsheet_id
        ),
        "product_id": _safe_text(
            product_id
        ),
        "scene_image": str(
            scene_image
        ),
        "surface": surface,
    }
