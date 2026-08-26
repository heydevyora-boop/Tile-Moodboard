"""
visualization_drive_service.py

Google Drive persistence for generated tile visualizations.

Existing Drive infrastructure is reused from app.drive_folders.

Folder hierarchy:

ROOT
└── GENERATED_VISUALIZATIONS
    └── <scene_id>
        └── <product_id>
            └── <surface>
                ├── applied visualization image
                └── visualization metadata JSON

No duplicate Google authentication system is created here.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional
import json
import mimetypes

from app import drive_folders

from app.visualization_registry import (
    update_visualization_status,
)


# ============================================================
# PROJECT PATHS
# ============================================================

PROJECT_ROOT = (
    Path(__file__)
    .resolve()
    .parent
    .parent
)


# ============================================================
# DRIVE CONFIGURATION
# ============================================================

VISUALIZATION_ROOT_FOLDER_NAME = (
    "GENERATED_VISUALIZATIONS"
)


# ============================================================
# HELPERS
# ============================================================

def _safe_text(value: Any) -> str:
    if value is None:
        return ""

    return str(value).strip()


def _safe_folder_name(
    value: Any,
    fallback: str = "UNKNOWN",
) -> str:
    """
    Normalize a value for Google Drive folder naming.
    """

    value = _safe_text(value)

    if not value:
        return fallback

    invalid_chars = (
        "\\",
        "/",
        ":",
        "*",
        "?",
        '"',
        "<",
        ">",
        "|",
    )

    for char in invalid_chars:
        value = value.replace(
            char,
            "_",
        )

    return value[:150]


def _resolve_root_folder_id() -> str:
    """
    Reuse the root folder configured by the existing Drive
    folder manager.
    """

    root_id = _safe_text(
        getattr(
            drive_folders,
            "ROOT_FOLDER_ID",
            "",
        )
    )

    if not root_id:
        raise RuntimeError(
            "drive_folders.ROOT_FOLDER_ID is not configured."
        )

    return root_id


def _ensure_visualization_folder(
    drive_service,
    folder_name: str,
    parent_id: str,
) -> str:
    """
    Find or create a Drive folder.
    """

    folder_name = _safe_folder_name(
        folder_name
    )

    folder_id = (
        drive_folders.get_or_create_folder(
            drive_service,
            folder_name,
            parent_id,
        )
    )

    if not folder_id:
        raise RuntimeError(
            "Google Drive folder could not be resolved: "
            f"{folder_name}"
        )

    return folder_id


# ============================================================
# VISUALIZATION DRIVE FOLDER
# ============================================================

def ensure_visualization_drive_folder(
    scene_id: str,
    product_id: str,
    surface: str,
) -> Dict[str, str]:
    """
    Create/reuse:

        ROOT/
            GENERATED_VISUALIZATIONS/
                scene_id/
                    product_id/
                        surface/
    """

    scene_id = _safe_folder_name(
        scene_id,
        fallback="UNASSIGNED_SCENE",
    )

    product_id = _safe_folder_name(
        product_id,
        fallback="UNKNOWN_PRODUCT",
    )

    surface = _safe_folder_name(
        surface,
        fallback="UNKNOWN_SURFACE",
    ).upper()

    drive = (
        drive_folders.get_drive_service()
    )

    root_id = _resolve_root_folder_id()

    generated_root_id = (
        _ensure_visualization_folder(
            drive,
            VISUALIZATION_ROOT_FOLDER_NAME,
            root_id,
        )
    )

    scene_folder_id = (
        _ensure_visualization_folder(
            drive,
            scene_id,
            generated_root_id,
        )
    )

    product_folder_id = (
        _ensure_visualization_folder(
            drive,
            product_id,
            scene_folder_id,
        )
    )

    surface_folder_id = (
        _ensure_visualization_folder(
            drive,
            surface,
            product_folder_id,
        )
    )

    return {
        "root_folder_id": root_id,
        "generated_root_folder_id": (
            generated_root_id
        ),
        "scene_folder_id": (
            scene_folder_id
        ),
        "product_folder_id": (
            product_folder_id
        ),
        "surface_folder_id": (
            surface_folder_id
        ),
        "scene_id": scene_id,
        "product_id": product_id,
        "surface": surface,
    }


# ============================================================
# UPLOAD ONE FILE
# ============================================================

def upload_visualization_file(
    file_path: Path,
    folder_id: str,
    filename: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Upload one local file using the existing Drive manager.
    """

    file_path = Path(
        file_path
    )

    if not file_path.exists():
        raise FileNotFoundError(
            f"Visualization file not found: "
            f"{file_path}"
        )

    if not file_path.is_file():
        raise ValueError(
            f"Visualization path is not a file: "
            f"{file_path}"
        )

    if not folder_id:
        raise ValueError(
            "folder_id is required for Drive upload."
        )

    uploaded = (
        drive_folders.upload_file_to_folder(
            file_path=file_path,
            folder_id=folder_id,
            filename=(
                filename
                or file_path.name
            ),
        )
    )

    if not isinstance(
        uploaded,
        dict,
    ):
        raise RuntimeError(
            "Google Drive upload returned an invalid result."
        )

    file_id = _safe_text(
        uploaded.get("id")
    )

    if not file_id:
        raise RuntimeError(
            "Google Drive upload returned no file ID."
        )

    return {
        "file_id": file_id,
        "name": _safe_text(
            uploaded.get(
                "name",
                file_path.name,
            )
        ),
        "webViewLink": _safe_text(
            uploaded.get(
                "webViewLink",
                "",
            )
        ),
        "parents": uploaded.get(
            "parents",
            [],
        ),
        "mime_type": (
            mimetypes.guess_type(
                str(file_path)
            )[0]
            or "application/octet-stream"
        ),
    }


# ============================================================
# WRITE LOCAL METADATA
# ============================================================

def write_visualization_metadata(
    record: Dict[str, Any],
    output_dir: Optional[Path] = None,
) -> Path:
    """
    Save a local metadata JSON which can also be uploaded to
    Google Drive.

    The metadata contains no API key or credential data.
    """

    if not isinstance(
        record,
        dict,
    ):
        raise TypeError(
            "record must be a dictionary."
        )

    output_dir = Path(
        output_dir
        or (
            PROJECT_ROOT
            / "output"
            / "visualizations"
            / "metadata"
        )
    )

    output_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    visualization_id = _safe_text(
        record.get(
            "visualization_id",
            "UNKNOWN",
        )
    )

    metadata_path = (
        output_dir
        / (
            f"{visualization_id}"
            "_metadata.json"
        )
    )

    metadata_path.write_text(
        json.dumps(
            record,
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    return metadata_path


# ============================================================
# MAIN UPLOAD
# ============================================================

def upload_visualization_to_drive(
    record: Dict[str, Any],
    update_registry: bool = True,
) -> Dict[str, Any]:
    """
    Upload a generated visualization and its metadata.

    Required record fields:

        visualization_id
        scene_id
        product_id
        product_name
        surface
        applied_image

    Returns a Drive result plus registry status information.
    """

    if not isinstance(
        record,
        dict,
    ):
        raise TypeError(
            "record must be a dictionary."
        )

    visualization_id = _safe_text(
        record.get(
            "visualization_id"
        )
    )

    scene_id = _safe_text(
        record.get(
            "scene_id"
        )
    )

    product_id = _safe_text(
        record.get(
            "product_id"
        )
    )

    surface = _safe_text(
        record.get(
            "surface"
        )
    ).upper()

    applied_image = Path(
        _safe_text(
            record.get(
                "applied_image"
            )
        )
    )

    if not visualization_id:
        raise ValueError(
            "record.visualization_id is required."
        )

    if not scene_id:
        raise ValueError(
            "record.scene_id is required."
        )

    if not product_id:
        raise ValueError(
            "record.product_id is required."
        )

    if not surface:
        raise ValueError(
            "record.surface is required."
        )

    if (
        not applied_image.exists()
        or not applied_image.is_file()
    ):
        raise FileNotFoundError(
            "Applied visualization image not found: "
            f"{applied_image}"
        )

    # --------------------------------------------------------
    # DRIVE FOLDER
    # --------------------------------------------------------

    folders = (
        ensure_visualization_drive_folder(
            scene_id=scene_id,
            product_id=product_id,
            surface=surface,
        )
    )

    surface_folder_id = (
        folders[
            "surface_folder_id"
        ]
    )

    # --------------------------------------------------------
    # IMAGE UPLOAD
    # --------------------------------------------------------

    uploaded_image = (
        upload_visualization_file(
            file_path=applied_image,
            folder_id=surface_folder_id,
            filename=applied_image.name,
        )
    )

    # --------------------------------------------------------
    # METADATA JSON
    # --------------------------------------------------------

    metadata_record = dict(
        record
    )

    metadata_record[
        "drive_file_id"
    ] = uploaded_image[
        "file_id"
    ]

    metadata_record[
        "drive_url"
    ] = uploaded_image[
        "webViewLink"
    ]

    metadata_path = (
        write_visualization_metadata(
            metadata_record
        )
    )

    uploaded_metadata = (
        upload_visualization_file(
            file_path=metadata_path,
            folder_id=surface_folder_id,
            filename=metadata_path.name,
        )
    )

    # --------------------------------------------------------
    # REGISTRY UPDATE
    # --------------------------------------------------------

    registry_result = None

    if update_registry:

        registry_result = (
            update_visualization_status(
                visualization_id=(
                    visualization_id
                ),
                status="UPLOADED",
                drive_file_id=(
                    uploaded_image[
                        "file_id"
                    ]
                ),
                drive_url=(
                    uploaded_image[
                        "webViewLink"
                    ]
                ),
                metadata_path=str(
                    metadata_path
                ),
            )
        )

    # --------------------------------------------------------
    # RESULT
    # --------------------------------------------------------

    return {
        "status": "UPLOADED",

        "visualization_id": (
            visualization_id
        ),

        "scene_id": scene_id,

        "product_id": product_id,

        "surface": surface,

        "image": uploaded_image,

        "metadata": uploaded_metadata,

        "drive_folder": folders,

        "registry": registry_result,
    }


# ============================================================
# END
# ================