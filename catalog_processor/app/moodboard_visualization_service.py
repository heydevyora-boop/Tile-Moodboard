"""
moodboard_visualization_service.py

Connects an applied-tile visualization record to the existing
moodboard/final-design data structure.

This module does NOT regenerate the moodboard. It enriches the
existing moodboard/final design with the generated applied image
and persistent visualization metadata.

Pipeline:

Existing Moodboard / Final Design
        +
Visualization Registry Record
        ↓
Moodboard Visualization Integration
        ↓
Final design with applied_visualizations
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional
import json
from datetime import datetime, timezone


# ============================================================
# PROJECT PATHS
# ============================================================

PROJECT_ROOT = (
    Path(__file__).resolve().parent.parent
)

OUTPUT_ROOT = (
    PROJECT_ROOT / "output"
)

MOODBOARD_VISUALIZATION_ROOT = (
    OUTPUT_ROOT / "moodboard_visualizations"
)


# ============================================================
# HELPERS
# ============================================================

def _safe_text(value: Any) -> str:
    if value is None:
        return ""

    return str(value).strip()


def _utc_now() -> str:
    return datetime.now(
        timezone.utc
    ).isoformat()


def _visualization_key(
    record: Dict[str, Any],
) -> str:
    """
    Stable key for de-duplicating a visualization
    inside a moodboard.
    """

    visualization_id = _safe_text(
        record.get(
            "visualization_id",
            "",
        )
    )

    if visualization_id:
        return visualization_id

    return "|".join(
        [
            _safe_text(
                record.get(
                    "product_id",
                    "",
                )
            ),
            _safe_text(
                record.get(
                    "surface",
                    "",
                )
            ).upper(),
            _safe_text(
                record.get(
                    "applied_image",
                    "",
                )
            ),
        ]
    )


def _normalize_visualization_record(
    record: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Normalize a registry record before attaching it to
    a moodboard.
    """

    if not isinstance(
        record,
        dict,
    ):
        raise TypeError(
            "visualization record must be a dictionary."
        )

    required_fields = [
        "product_id",
        "surface",
        "applied_image",
    ]

    for field in required_fields:

        if not _safe_text(
            record.get(field)
        ):
            raise ValueError(
                "Visualization record is missing "
                f"required field: {field}"
            )

    normalized = dict(record)

    normalized["product_id"] = _safe_text(
        normalized.get(
            "product_id"
        )
    )

    normalized["product_name"] = _safe_text(
        normalized.get(
            "product_name",
            "",
        )
    )

    normalized["surface"] = _safe_text(
        normalized.get(
            "surface"
        )
    ).upper()

    normalized["applied_image"] = _safe_text(
        normalized.get(
            "applied_image"
        )
    )

    normalized["drive_file_id"] = _safe_text(
        normalized.get(
            "drive_file_id",
            "",
        )
    )

    normalized["drive_url"] = _safe_text(
        normalized.get(
            "drive_url",
            "",
        )
    )

    normalized["status"] = (
        _safe_text(
            normalized.get(
                "status",
                "",
            )
        ).upper()
        or "PENDING"
    )

    normalized.setdefault(
        "visualization_id",
        "",
    )

    normalized.setdefault(
        "scene_id",
        "",
    )

    normalized.setdefault(
        "tile_image",
        "",
    )

    normalized.setdefault(
        "source_scene_image",
        "",
    )

    normalized.setdefault(
        "model",
        "",
    )

    normalized.setdefault(
        "metadata_path",
        "",
    )

    return normalized


# ============================================================
# ATTACH TO MOODBOARD
# ============================================================

def attach_visualization_to_moodboard(
    moodboard: Dict[str, Any],
    visualization_record: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Add one applied visualization to a moodboard.

    The existing moodboard structure is preserved.
    """

    if not isinstance(
        moodboard,
        dict,
    ):
        raise TypeError(
            "moodboard must be a dictionary."
        )

    visualization = (
        _normalize_visualization_record(
            visualization_record
        )
    )

    result = dict(
        moodboard
    )

    existing = result.get(
        "applied_visualizations",
        [],
    )

    if existing is None:
        existing = []

    if not isinstance(
        existing,
        list,
    ):
        raise ValueError(
            "moodboard.applied_visualizations "
            "must be a list."
        )

    key = _visualization_key(
        visualization
    )

    updated = False
    new_items = []

    for item in existing:

        if not isinstance(
            item,
            dict,
        ):
            continue

        if (
            _visualization_key(item)
            == key
        ):

            new_items.append(
                visualization
            )

            updated = True

        else:

            new_items.append(
                item
            )

    if not updated:
        new_items.append(
            visualization
        )

    result[
        "applied_visualizations"
    ] = new_items

    result[
        "applied_visualization_count"
    ] = len(
        new_items
    )

    result[
        "visualization_updated_at"
    ] = _utc_now()

    return result


# ============================================================
# ATTACH MULTIPLE
# ============================================================

def attach_visualizations_to_moodboard(
    moodboard: Dict[str, Any],
    visualization_records: List[
        Dict[str, Any]
    ],
) -> Dict[str, Any]:
    """
    Attach multiple visualization records.
    """

    if not isinstance(
        visualization_records,
        list,
    ):
        raise TypeError(
            "visualization_records must be a list."
        )

    result = dict(
        moodboard
    )

    for visualization in visualization_records:

        result = (
            attach_visualization_to_moodboard(
                result,
                visualization,
            )
        )

    return result


# ============================================================
# ATTACH TO FINAL DESIGN
# ============================================================

def attach_visualization_to_final_design(
    final_design: Dict[str, Any],
    visualization_record: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Attach an applied visualization to the existing
    final bathroom design object.

    The existing selected_moodboard is also enriched when it
    exists.
    """

    if not isinstance(
        final_design,
        dict,
    ):
        raise TypeError(
            "final_design must be a dictionary."
        )

    result = dict(
        final_design
    )

    visualization = (
        _normalize_visualization_record(
            visualization_record
        )
    )

    # --------------------------------------------------------
    # Attach at final-design level
    # --------------------------------------------------------

    existing = result.get(
        "applied_visualizations",
        [],
    )

    if existing is None:
        existing = []

    if not isinstance(
        existing,
        list,
    ):
        raise ValueError(
            "final_design.applied_visualizations "
            "must be a list."
        )

    key = _visualization_key(
        visualization
    )

    replaced = False
    updated_visualizations = []

    for item in existing:

        if (
            isinstance(
                item,
                dict,
            )
            and _visualization_key(item)
            == key
        ):

            updated_visualizations.append(
                visualization
            )

            replaced = True

        else:

            updated_visualizations.append(
                item
            )

    if not replaced:

        updated_visualizations.append(
            visualization
        )

    result[
        "applied_visualizations"
    ] = updated_visualizations

    result[
        "applied_visualization_count"
    ] = len(
        updated_visualizations
    )

    # --------------------------------------------------------
    # Enrich selected moodboard
    # --------------------------------------------------------

    selected_moodboard = result.get(
        "selected_moodboard"
    )

    if isinstance(
        selected_moodboard,
        dict,
    ):

        result[
            "selected_moodboard"
        ] = (
            attach_visualization_to_moodboard(
                selected_moodboard,
                visualization,
            )
        )

    # --------------------------------------------------------
    # Rendering metadata
    # --------------------------------------------------------

    rendering = result.get(
        "rendering"
    )

    if not isinstance(
        rendering,
        dict,
    ):
        rendering = {}

    rendering = dict(
        rendering
    )

    rendering[
        "applied_visualization_status"
    ] = visualization.get(
        "status",
        "",
    )

    rendering[
        "applied_visualization_image"
    ] = visualization.get(
        "applied_image",
        "",
    )

    rendering[
        "applied_visualization_drive_url"
    ] = visualization.get(
        "drive_url",
        "",
    )

    rendering[
        "applied_visualization_id"
    ] = visualization.get(
        "visualization_id",
        "",
    )

    result[
        "rendering"
    ] = rendering

    return result


# ============================================================
# BUILD MOODBOARD OUTPUT
# ============================================================

def build_moodboard_visualization_package(
    moodboard: Dict[str, Any],
    visualization_records: List[
        Dict[str, Any]
    ],
    *,
    scene_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Create a standalone moodboard visualization package.

    This does not alter the original moodboard object.
    """

    if not isinstance(
        moodboard,
        dict,
    ):
        raise TypeError(
            "moodboard must be a dictionary."
        )

    result = attach_visualizations_to_moodboard(
        moodboard,
        visualization_records,
    )

    package = {
        "package_type": (
            "MOODBOARD_APPLIED_VISUALIZATIONS"
        ),
        "created_at": _utc_now(),
        "scene_id": (
            _safe_text(scene_id)
            or _safe_text(
                moodboard.get(
                    "scene_id",
                    "",
                )
            )
        ),
        "moodboard_id": _safe_text(
            moodboard.get(
                "moodboard_id",
                "",
            )
        ),
        "moodboard_name": _safe_text(
            moodboard.get(
                "name",
                "",
            )
        ),
        "moodboard": result,
        "applied_visualizations": (
            result.get(
                "applied_visualizations",
                [],
            )
        ),
        "visualization_count": (
            result.get(
                "applied_visualization_count",
                0,
            )
        ),
    }

    return package


# ============================================================
# SAVE PACKAGE
# ============================================================

def save_moodboard_visualization_package(
    package: Dict[str, Any],
    output_path: Optional[Path] = None,
) -> Path:
    """
    Save the integrated moodboard package as JSON.
    """

    if not isinstance(
        package,
        dict,
    ):
        raise TypeError(
            "package must be a dictionary."
        )

    if output_path is None:

        moodboard_id = (
            _safe_text(
                package.get(
                    "moodboard_id",
                    "MOODBOARD",
                )
            )
            or "MOODBOARD"
        )

        output_path = (
            MOODBOARD_VISUALIZATION_ROOT
            / (
                f"{moodboard_id}"
                "_visualization_package.json"
            )
        )

    output_path = Path(
        output_path
    )

    output_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    output_path.write_text(
        json.dumps(
            package,
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    return output_path


# ============================================================
# END
# ============