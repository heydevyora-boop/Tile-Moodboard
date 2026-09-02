"""
visualization_registry.py

Persistent registry for generated tile visualizations.

Purpose:
    Store one normalized record for each applied-tile
    visualization.

This module is intentionally independent of:
    - Gemini
    - Google Drive
    - Google Sheets

That makes it safe to test offline.

Registry record example:

{
    "visualization_id": "VIZ_20260824171700_ABC123",
    "scene_id": "SCENE_001",
    "product_id": "TEST-P001",
    "product_name": "Test Marble Tile",
    "surface": "FLOOR",
    "source_scene_image": "input/bathroom.png",
    "tile_image": "output/crops/001_TEST-P001.png",
    "applied_image": "output/tile_visualizations/TEST-P001_floor.png",
    "drive_file_id": "",
    "drive_url": "",
    "model": "gemini-3.1-flash-image",
    "status": "GENERATED",
    "created_at": "2026-08-24T...",
    "metadata_path": ""
}
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
import json
import re
import uuid


# ============================================================
# PROJECT PATHS
# ============================================================

PROJECT_ROOT = (
    Path(__file__)
    .resolve()
    .parent
    .parent
)

OUTPUT_ROOT = (
    PROJECT_ROOT
    / "output"
)

REGISTRY_ROOT = (
    OUTPUT_ROOT
    / "visualizations"
)

REGISTRY_FILE = (
    REGISTRY_ROOT
    / "visualization_registry.json"
)


# ============================================================
# CONSTANTS
# ============================================================

ALLOWED_SURFACES = {
    "FLOOR",
    "WALL",
    "BACK_WALL",
    "SHOWER_WALL",
    # Kept in sync with tile_application_engine.py's ALLOWED_SURFACES --
    # a Gemini generation with surface="BOTH" would otherwise succeed
    # (costing a real generation call) and only fail here, afterward, at
    # registry persistence.
    "BOTH",
}

ALLOWED_STATUSES = {
    "GENERATED",
    "UPLOADED",
    "COMPLETED",
    "FAILED",
    "PENDING",
}


# ============================================================
# GENERAL HELPERS
# ============================================================

def _safe_text(value: Any) -> str:
    """
    Convert any value into a clean string.
    """

    if value is None:
        return ""

    return str(value).strip()


def _safe_component(value: Any) -> str:
    """
    Make a value safe for filenames/IDs.
    """

    value = _safe_text(value)

    if not value:
        return "UNKNOWN"

    value = re.sub(
        r"[^A-Za-z0-9._-]+",
        "_",
        value,
    )

    return value[:120]


def _utc_now() -> str:
    """
    Current UTC timestamp in ISO format.
    """

    return datetime.now(
        timezone.utc
    ).isoformat()


def _new_visualization_id() -> str:
    """
    Generate a unique visualization ID.
    """

    timestamp = datetime.now(
        timezone.utc
    ).strftime(
        "%Y%m%d%H%M%S"
    )

    short_uuid = (
        uuid.uuid4()
        .hex[:10]
        .upper()
    )

    return (
        f"VIZ_{timestamp}_{short_uuid}"
    )


def _normalize_surface(
    surface: Any,
) -> str:
    """
    Validate and normalize visualization surface.
    """

    surface = _safe_text(
        surface
    ).upper()

    if surface not in ALLOWED_SURFACES:

        raise ValueError(
            "Unsupported surface: "
            f"{surface}. "
            f"Allowed surfaces: "
            f"{sorted(ALLOWED_SURFACES)}"
        )

    return surface


def _normalize_status(
    status: Any,
) -> str:
    """
    Validate and normalize visualization status.
    """

    status = _safe_text(
        status
    ).upper()

    if not status:
        status = "PENDING"

    if status not in ALLOWED_STATUSES:

        raise ValueError(
            "Unsupported visualization status: "
            f"{status}. "
            f"Allowed statuses: "
            f"{sorted(ALLOWED_STATUSES)}"
        )

    return status


# ============================================================
# EMPTY REGISTRY
# ============================================================

def _empty_registry() -> Dict[str, Any]:
    """
    Create a new empty registry object.
    """

    return {
        "version": 1,
        "updated_at": _utc_now(),
        "visualizations": [],
    }


# ============================================================
# LOAD REGISTRY
# ============================================================

def load_visualization_registry(
    registry_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """
    Load visualization registry from JSON.

    Behavior:
        - Missing file -> empty registry
        - Invalid JSON -> RuntimeError
        - Invalid structure -> RuntimeError
    """

    path = Path(
        registry_path
        or REGISTRY_FILE
    )

    if not path.exists():
        return _empty_registry()

    try:

        data = json.loads(
            path.read_text(
                encoding="utf-8"
            )
        )

    except json.JSONDecodeError as error:

        raise RuntimeError(
            "Visualization registry contains "
            f"invalid JSON: {path}"
        ) from error

    if not isinstance(
        data,
        dict,
    ):

        raise RuntimeError(
            "Visualization registry root "
            "must be a JSON object."
        )

    if (
        "visualizations"
        not in data
    ):

        data[
            "visualizations"
        ] = []

    if not isinstance(
        data["visualizations"],
        list,
    ):

        raise RuntimeError(
            "Registry 'visualizations' "
            "must be a list."
        )

    data.setdefault(
        "version",
        1,
    )

    data.setdefault(
        "updated_at",
        _utc_now(),
    )

    return data


# ============================================================
# SAVE REGISTRY
# ============================================================

def save_visualization_registry(
    registry: Dict[str, Any],
    registry_path: Optional[Path] = None,
) -> Path:
    """
    Save registry atomically.
    """

    if not isinstance(
        registry,
        dict,
    ):

        raise TypeError(
            "registry must be a dictionary."
        )

    visualizations = (
        registry.get(
            "visualizations"
        )
    )

    if not isinstance(
        visualizations,
        list,
    ):

        raise ValueError(
            "registry.visualizations "
            "must be a list."
        )

    path = Path(
        registry_path
        or REGISTRY_FILE
    )

    path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    registry["version"] = int(
        registry.get(
            "version",
            1,
        )
    )

    registry[
        "updated_at"
    ] = _utc_now()

    temporary_path = (
        path.with_suffix(
            ".tmp"
        )
    )

    temporary_path.write_text(
        json.dumps(
            registry,
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    temporary_path.replace(
        path
    )

    return path


# ============================================================
# BUILD RECORD
# ============================================================

def build_visualization_record(
    *,
    scene_id: Optional[str],
    product_id: str,
    product_name: str,
    surface: str,
    source_scene_image: str,
    tile_image: str,
    applied_image: str,
    model: str = "",
    status: str = "GENERATED",
    visualization_id: Optional[str] = None,
    drive_file_id: str = "",
    drive_url: str = "",
    metadata_path: str = "",
    extra: Optional[
        Dict[str, Any]
    ] = None,
) -> Dict[str, Any]:
    """
    Build a normalized visualization record.
    """

    product_id = _safe_text(
        product_id
    )

    if not product_id:

        raise ValueError(
            "product_id is required."
        )

    product_name = _safe_text(
        product_name
    )

    surface = _normalize_surface(
        surface
    )

    status = _normalize_status(
        status
    )

    record = {
        "visualization_id": (
            _safe_text(
                visualization_id
            )
            or _new_visualization_id()
        ),

        "scene_id": _safe_text(
            scene_id
        ),

        "product_id": (
            product_id
        ),

        "product_name": (
            product_name
        ),

        "surface": surface,

        "source_scene_image": (
            _safe_text(
                source_scene_image
            )
        ),

        "tile_image": (
            _safe_text(
                tile_image
            )
        ),

        "applied_image": (
            _safe_text(
                applied_image
            )
        ),

        "drive_file_id": (
            _safe_text(
                drive_file_id
            )
        ),

        "drive_url": (
            _safe_text(
                drive_url
            )
        ),

        "model": _safe_text(
            model
        ),

        "status": status,

        "created_at": _utc_now(),

        "metadata_path": (
            _safe_text(
                metadata_path
            )
        ),
    }

    if extra is not None:

        if not isinstance(
            extra,
            dict,
        ):

            raise TypeError(
                "extra must be a dictionary."
            )

        record["extra"] = extra

    return record


# ============================================================
# REGISTER NEW VISUALIZATION
# ============================================================

def register_visualization(
    record: Dict[str, Any],
    registry_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """
    Add a new visualization record.

    Duplicate visualization IDs are rejected.
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

    if not visualization_id:

        raise ValueError(
            "record.visualization_id "
            "is required."
        )

    registry = (
        load_visualization_registry(
            registry_path
        )
    )

    for existing in (
        registry["visualizations"]
    ):

        if not isinstance(
            existing,
            dict,
        ):
            continue

        existing_id = _safe_text(
            existing.get(
                "visualization_id"
            )
        )

        if (
            existing_id
            == visualization_id
        ):

            raise ValueError(
                "Visualization already exists: "
                f"{visualization_id}"
            )

    registry[
        "visualizations"
    ].append(
        record
    )

    save_visualization_registry(
        registry,
        registry_path,
    )

    return record


# ============================================================
# UPSERT
# ============================================================

def upsert_visualization(
    record: Dict[str, Any],
    registry_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """
    Insert or update a visualization by ID.
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

    if not visualization_id:

        raise ValueError(
            "record.visualization_id "
            "is required."
        )

    registry = (
        load_visualization_registry(
            registry_path
        )
    )

    for index, existing in enumerate(
        registry["visualizations"]
    ):

        if not isinstance(
            existing,
            dict,
        ):
            continue

        existing_id = _safe_text(
            existing.get(
                "visualization_id"
            )
        )

        if (
            existing_id
            == visualization_id
        ):

            merged = dict(
                existing
            )

            merged.update(
                record
            )

            registry[
                "visualizations"
            ][index] = merged

            save_visualization_registry(
                registry,
                registry_path,
            )

            return merged

    registry[
        "visualizations"
    ].append(
        record
    )

    save_visualization_registry(
        registry,
        registry_path,
    )

    return record


# ============================================================
# GET VISUALIZATION
# ============================================================

def get_visualization(
    visualization_id: str,
    registry_path: Optional[Path] = None,
) -> Optional[Dict[str, Any]]:
    """
    Get one visualization by ID.
    """

    visualization_id = _safe_text(
        visualization_id
    )

    registry = (
        load_visualization_registry(
            registry_path
        )
    )

    for record in (
        registry[
            "visualizations"
        ]
    ):

        if not isinstance(
            record,
            dict,
        ):
            continue

        if (
            _safe_text(
                record.get(
                    "visualization_id"
                )
            )
            == visualization_id
        ):

            return record

    return None


# ============================================================
# LIST / FILTER
# ============================================================

def list_visualizations(
    *,
    product_id: Optional[str] = None,
    scene_id: Optional[str] = None,
    surface: Optional[str] = None,
    status: Optional[str] = None,
    registry_path: Optional[Path] = None,
) -> List[Dict[str, Any]]:
    """
    Filter visualization records.
    """

    registry = (
        load_visualization_registry(
            registry_path
        )
    )

    product_id = (
        _safe_text(
            product_id
        )
        if product_id is not None
        else None
    )

    scene_id = (
        _safe_text(
            scene_id
        )
        if scene_id is not None
        else None
    )

    normalized_surface = (
        _normalize_surface(
            surface
        )
        if surface is not None
        else None
    )

    normalized_status = (
        _normalize_status(
            status
        )
        if status is not None
        else None
    )

    results = []

    for record in (
        registry[
            "visualizations"
        ]
    ):

        if not isinstance(
            record,
            dict,
        ):
            continue

        if (
            product_id is not None
            and _safe_text(
                record.get(
                    "product_id"
                )
            )
            != product_id
        ):
            continue

        if (
            scene_id is not None
            and _safe_text(
                record.get(
                    "scene_id"
                )
            )
            != scene_id
        ):
            continue

        if (
            normalized_surface
            is not None
            and _safe_text(
                record.get(
                    "surface"
                )
            ).upper()
            != normalized_surface
        ):
            continue

        if (
            normalized_status
            is not None
            and _safe_text(
                record.get(
                    "status"
                )
            ).upper()
            != normalized_status
        ):
            continue

        results.append(
            record
        )

    return results


# ============================================================
# UPDATE STATUS
# ============================================================

def update_visualization_status(
    visualization_id: str,
    status: str,
    *,
    drive_file_id: Optional[str] = None,
    drive_url: Optional[str] = None,
    metadata_path: Optional[str] = None,
    registry_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """
    Update visualization status and optional Drive metadata.
    """

    normalized_status = (
        _normalize_status(
            status
        )
    )

    registry = (
        load_visualization_registry(
            registry_path
        )
    )

    visualization_id = _safe_text(
        visualization_id
    )

    for index, record in enumerate(
        registry[
            "visualizations"
        ]
    ):

        if not isinstance(
            record,
            dict,
        ):
            continue

        current_id = _safe_text(
            record.get(
                "visualization_id"
            )
        )

        if (
            current_id
            != visualization_id
        ):
            continue

        updated = dict(
            record
        )

        updated[
            "status"
        ] = normalized_status

        if drive_file_id is not None:

            updated[
                "drive_file_id"
            ] = _safe_text(
                drive_file_id
            )

        if drive_url is not None:

            updated[
                "drive_url"
            ] = _safe_text(
                drive_url
            )

        if metadata_path is not None:

            updated[
                "metadata_path"
            ] = _safe_text(
                metadata_path
            )

        registry[
            "visualizations"
        ][index] = updated

        save_visualization_registry(
            registry,
            registry_path,
        )

        return updated

    raise KeyError(
        "Visualization not found: "
        f"{visualization_id}"
    )


# ============================================================
# CREATE + REGISTER
# ============================================================

def create_and_register_visualization(
    *,
    scene_id: Optional[str],
    product_id: str,
    product_name: str,
    surface: str,
    source_scene_image: str,
    tile_image: str,
    applied_image: str,
    model: str = "",
    status: str = "GENERATED",
    drive_file_id: str = "",
    drive_url: str = "",
    metadata_path: str = "",
    extra: Optional[
        Dict[str, Any]
    ] = None,
    registry_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """
    Build and persist one visualization record.
    """

    record = build_visualization_record(
        scene_id=scene_id,
        product_id=product_id,
        product_name=product_name,
        surface=surface,
        source_scene_image=(
            source_scene_image
        ),
        tile_image=tile_image,
        applied_image=applied_image,
        model=model,
        status=status,
        drive_file_id=drive_file_id,
        drive_url=drive_url,
        metadata_path=metadata_path,
        extra=extra,
    )

    return upsert_visualization(
        record,
        registry_path,
    )


# ============================================================
# OPTIONAL DELETE
# ============================================================

def delete_visualization(
    visualization_id: str,
    registry_path: Optional[Path] = None,
) -> bool:
    """
    Delete a visualization record by ID.

    Returns:
        True  -> deleted
        False -> not found
    """

    visualization_id = _safe_text(
        visualization_id
    )

    registry = (
        load_visualization_registry(
            registry_path
        )
    )

    original_count = len(
        registry[
            "visualizations"
        ]
    )

    registry[
        "visualizations"
    ] = [
        record
        for record in registry[
            "visualizations"
        ]
        if not (
            isinstance(
                record,
                dict,
            )
            and _safe_text(
                record.get(
                    "visualization_id"
                )
            )
            == visualization_id
        )
    ]

    if (
        len(
            registry[
                "visualizations"
            ]
        )
        == original_count
    ):

        return False

    save_visualization_registry(
        registry,
        registry_path,
    )

    return True