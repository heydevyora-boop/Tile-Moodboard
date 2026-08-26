"""
google_master_persistence.py

Persistence layer for writing visualization/moodboard results
into the existing GOOGLE MASTER sheet.

Important:
    The existing MASTER loader supports these record types:

        CATALOG
        PRODUCT
        REQUIREMENT
        FIXTURE
        MOODBOARD
        RECOMMENDATION
        DESIGN
        RUN

Therefore this module does NOT invent a new VISUALIZATION
Record Type.

Instead, an applied visualization is persisted as an
existing MASTER record type, normally:

    MOODBOARD

The visualization details are stored in the existing columns
when available, and the complete visualization payload is
stored in Notes as JSON.

The module reuses the project's existing Google Sheets service:

    app.google_services.get_sheets_service()

No second authentication system is created.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
import json


from app.google_services import (
    get_sheets_service,
)


# ============================================================
# CONFIGURATION
# ============================================================

MASTER_SHEET_NAME = "MASTER"

DEFAULT_START_COLUMN = "A"
DEFAULT_END_COLUMN = "ZZ"

SUPPORTED_MASTER_RECORD_TYPES = {
    "CATALOG",
    "PRODUCT",
    "REQUIREMENT",
    "FIXTURE",
    "MOODBOARD",
    "RECOMMENDATION",
    "DESIGN",
    "RUN",
}


# ============================================================
# HELPERS
# ============================================================

def _safe_text(
    value: Any,
) -> str:
    """
    Convert value to a clean string.
    """

    if value is None:
        return ""

    return str(value).strip()


def _utc_now() -> str:
    """
    Return UTC ISO timestamp.
    """

    return datetime.now(
        timezone.utc
    ).isoformat()


def _normalize_record_type(
    record_type: str,
) -> str:
    """
    Validate a MASTER Record Type.
    """

    normalized = _safe_text(
        record_type
    ).upper()

    if normalized not in (
        SUPPORTED_MASTER_RECORD_TYPES
    ):
        raise ValueError(
            "Unsupported MASTER Record Type: "
            f"{normalized}. "
            f"Allowed: "
            f"{sorted(SUPPORTED_MASTER_RECORD_TYPES)}"
        )

    return normalized


def _serialize_notes(
    record: Dict[str, Any],
) -> str:
    """
    Serialize complete visualization payload into Notes.

    This preserves fields that are not available as dedicated
    MASTER columns.
    """

    payload = dict(record)

    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(
            ",",
            ":",
        ),
    )


def _headers_to_index(
    headers: List[str],
) -> Dict[str, int]:
    """
    Case/whitespace-insensitive header mapping.
    """

    result = {}

    for index, header in enumerate(
        headers
    ):

        clean_header = _safe_text(
            header
        )

        if not clean_header:
            continue

        result[
            clean_header.lower()
        ] = index

    return result


def _set_if_header_exists(
    row: List[str],
    header_map: Dict[str, int],
    header_name: str,
    value: Any,
) -> None:
    """
    Set a cell only when the MASTER sheet has that header.
    """

    index = header_map.get(
        header_name.lower()
    )

    if index is None:
        return

    while len(row) <= index:
        row.append("")

    row[index] = _safe_text(
        value
    )


# ============================================================
# READ MASTER HEADERS
# ============================================================

def get_master_headers(
    sheets_service,
    spreadsheet_id: str,
    sheet_name: str = MASTER_SHEET_NAME,
) -> List[str]:
    """
    Read the MASTER header row.
    """

    response = (
        sheets_service
        .spreadsheets()
        .values()
        .get(
            spreadsheetId=spreadsheet_id,
            range=f"'{sheet_name}'!A1:{DEFAULT_END_COLUMN}1",
        )
        .execute()
    )

    values = response.get(
        "values",
        [],
    )

    if not values:
        raise RuntimeError(
            "MASTER sheet has no header row."
        )

    headers = [
        _safe_text(
            value
        )
        for value in values[0]
    ]

    headers = [
        value
        for value in headers
        if value
    ]

    if not headers:
        raise RuntimeError(
            "MASTER sheet header row is empty."
        )

    return headers


# ============================================================
# READ MASTER RECORDS
# ============================================================

def load_master_rows(
    sheets_service,
    spreadsheet_id: str,
    sheet_name: str = MASTER_SHEET_NAME,
) -> List[List[str]]:
    """
    Load raw MASTER rows.
    """

    response = (
        sheets_service
        .spreadsheets()
        .values()
        .get(
            spreadsheetId=spreadsheet_id,
            range=f"'{sheet_name}'!A:{DEFAULT_END_COLUMN}",
        )
        .execute()
    )

    values = response.get(
        "values",
        [],
    )

    if len(values) <= 1:
        return []

    return values[1:]


# ============================================================
# FIND MASTER RECORD
# ============================================================

def find_master_record_row(
    sheets_service,
    spreadsheet_id: str,
    record_id: str,
    sheet_name: str = MASTER_SHEET_NAME,
) -> Optional[int]:
    """
    Find a MASTER row by Record ID.

    Returns:
        Actual Google Sheet row number.
        None when not found.
    """

    record_id = _safe_text(
        record_id
    )

    if not record_id:
        raise ValueError(
            "record_id is required."
        )

    headers = get_master_headers(
        sheets_service,
        spreadsheet_id,
        sheet_name,
    )

    header_map = _headers_to_index(
        headers
    )

    record_id_index = (
        header_map.get(
            "record id"
        )
    )

    if record_id_index is None:
        raise RuntimeError(
            "MASTER sheet is missing the "
            "'Record ID' column."
        )

    rows = load_master_rows(
        sheets_service,
        spreadsheet_id,
        sheet_name,
    )

    for offset, row in enumerate(
        rows,
        start=2,
    ):

        if (
            record_id_index
            >= len(row)
        ):
            continue

        existing_id = _safe_text(
            row[record_id_index]
        )

        if existing_id == record_id:
            return offset

    return None


# ============================================================
# BUILD MASTER ROW
# ============================================================

def build_master_row(
    headers: List[str],
    record: Dict[str, Any],
) -> List[str]:
    """
    Build a MASTER-compatible row using the actual sheet
    headers.

    Unknown fields are retained inside Notes as JSON.
    """

    if not isinstance(
        record,
        dict,
    ):
        raise TypeError(
            "record must be a dictionary."
        )

    record_type = _normalize_record_type(
        record.get(
            "record_type",
            record.get(
                "Record Type",
                "MOODBOARD",
            ),
        )
    )

    record_id = _safe_text(
        record.get(
            "record_id",
            record.get(
                "Record ID",
                "",
            ),
        )
    )

    if not record_id:
        raise ValueError(
            "MASTER record_id is required."
        )

    if not headers:
        raise ValueError(
            "MASTER headers are required."
        )

    header_map = _headers_to_index(
        headers
    )

    row = [
        ""
        for _ in headers
    ]

    # --------------------------------------------------------
    # Core MASTER fields
    # --------------------------------------------------------

    _set_if_header_exists(
        row,
        header_map,
        "Record Type",
        record_type,
    )

    _set_if_header_exists(
        row,
        header_map,
        "Record ID",
        record_id,
    )

    _set_if_header_exists(
        row,
        header_map,
        "Catalog ID",
        record.get(
            "catalog_id",
            record.get(
                "Catalog ID",
                "",
            ),
        ),
    )

    _set_if_header_exists(
        row,
        header_map,
        "Name",
        record.get(
            "name",
            record.get(
                "Name",
                record.get(
                    "product_name",
                    "",
                ),
            ),
        ),
    )

    _set_if_header_exists(
        row,
        header_map,
        "Category",
        record.get(
            "category",
            record.get(
                "Category",
                "TILE_VISUALIZATION",
            ),
        ),
    )

    _set_if_header_exists(
        row,
        header_map,
        "Style",
        record.get(
            "style",
            record.get(
                "Style",
                "",
            ),
        ),
    )

    _set_if_header_exists(
        row,
        header_map,
        "Budget",
        record.get(
            "budget",
            record.get(
                "Budget",
                "",
            ),
        ),
    )

    # --------------------------------------------------------
    # Product information
    # --------------------------------------------------------

    _set_if_header_exists(
        row,
        header_map,
        "Product ID",
        record.get(
            "product_id",
            record.get(
                "Product ID",
                "",
            ),
        ),
    )

    _set_if_header_exists(
        row,
        header_map,
        "Product Name",
        record.get(
            "product_name",
            record.get(
                "Product Name",
                "",
            ),
        ),
    )

    _set_if_header_exists(
        row,
        header_map,
        "Surface",
        record.get(
            "surface",
            record.get(
                "Surface",
                "",
            ),
        ),
    )

    _set_if_header_exists(
        row,
        header_map,
        "Scene ID",
        record.get(
            "scene_id",
            record.get(
                "Scene ID",
                "",
            ),
        ),
    )

    # --------------------------------------------------------
    # Image / Drive fields
    # --------------------------------------------------------

    _set_if_header_exists(
        row,
        header_map,
        "Image",
        record.get(
            "applied_image",
            record.get(
                "Image",
                "",
            ),
        ),
    )

    _set_if_header_exists(
        row,
        header_map,
        "Applied Image",
        record.get(
            "applied_image",
            record.get(
                "Applied Image",
                "",
            ),
        ),
    )

    _set_if_header_exists(
        row,
        header_map,
        "Drive URL",
        record.get(
            "drive_url",
            record.get(
                "Drive URL",
                "",
            ),
        ),
    )

    _set_if_header_exists(
        row,
        header_map,
        "Status",
        record.get(
            "status",
            record.get(
                "Status",
                "GENERATED",
            ),
        ),
    )

    _set_if_header_exists(
        row,
        header_map,
        "Source",
        "VISUALIZATION_PIPELINE",
    )

    _set_if_header_exists(
        row,
        header_map,
        "Created At",
        record.get(
            "created_at",
            record.get(
                "Created At",
                _utc_now(),
            ),
        ),
    )

    # --------------------------------------------------------
    # Notes
    # --------------------------------------------------------

    notes_payload = dict(
        record
    )

    notes_payload[
        "master_persistence"
    ] = True

    notes_payload[
        "persisted_at"
    ] = _utc_now()

    _set_if_header_exists(
        row,
        header_map,
        "Notes",
        json.dumps(
            notes_payload,
            ensure_ascii=False,
            separators=(
                ",",
                ":",
            ),
        ),
    )

    return row


# ============================================================
# APPEND MASTER RECORD
# ============================================================

def append_master_record(
    spreadsheet_id: str,
    record: Dict[str, Any],
    sheet_name: str = MASTER_SHEET_NAME,
) -> Dict[str, Any]:
    """
    Append a new record to MASTER after checking Record ID
    uniqueness.
    """

    if not spreadsheet_id:
        raise ValueError(
            "spreadsheet_id is required."
        )

    if not isinstance(
        record,
        dict,
    ):
        raise TypeError(
            "record must be a dictionary."
        )

    record_id = _safe_text(
        record.get(
            "record_id",
            record.get(
                "Record ID",
                "",
            ),
        )
    )

    if not record_id:
        raise ValueError(
            "record_id is required."
        )

    sheets_service = (
        get_sheets_service()
    )

    existing_row = find_master_record_row(
        sheets_service,
        spreadsheet_id,
        record_id,
        sheet_name,
    )

    if existing_row is not None:
        raise ValueError(
            "MASTER record already exists: "
            f"{record_id} "
            f"(row {existing_row})"
        )

    headers = get_master_headers(
        sheets_service,
        spreadsheet_id,
        sheet_name,
    )

    row = build_master_row(
        headers,
        record,
    )

    (
        sheets_service
        .spreadsheets()
        .values()
        .append(
            spreadsheetId=spreadsheet_id,
            range=f"'{sheet_name}'!A:{DEFAULT_END_COLUMN}",
            valueInputOption="RAW",
            insertDataOption="INSERT_ROWS",
            body={
                "values": [
                    row
                ]
            },
        )
        .execute()
    )

    result = dict(
        record
    )

    result[
        "record_type"
    ] = _normalize_record_type(
        record.get(
            "record_type",
            record.get(
                "Record Type",
                "MOODBOARD",
            ),
        )
    )

    result[
        "record_id"
    ] = record_id

    result[
        "sheet_name"
    ] = sheet_name

    result[
        "sheet_status"
    ] = "UPLOADED"

    return result


# ============================================================
# UPDATE MASTER RECORD
# ============================================================

def update_master_record(
    spreadsheet_id: str,
    record_id: str,
    record: Dict[str, Any],
    sheet_name: str = MASTER_SHEET_NAME,
) -> Dict[str, Any]:
    """
    Update an existing MASTER record by Record ID.
    """

    if not spreadsheet_id:
        raise ValueError(
            "spreadsheet_id is required."
        )

    record_id = _safe_text(
        record_id
    )

    if not record_id:
        raise ValueError(
            "record_id is required."
        )

    if not isinstance(
        record,
        dict,
    ):
        raise TypeError(
            "record must be a dictionary."
        )

    sheets_service = (
        get_sheets_service()
    )

    row_number = find_master_record_row(
        sheets_service,
        spreadsheet_id,
        record_id,
        sheet_name,
    )

    if row_number is None:
        raise KeyError(
            "MASTER record not found: "
            f"{record_id}"
        )

    headers = get_master_headers(
        sheets_service,
        spreadsheet_id,
        sheet_name,
    )

    merged_record = dict(
        record
    )

    merged_record[
        "record_id"
    ] = record_id

    row = build_master_row(
        headers,
        merged_record,
    )

    (
        sheets_service
        .spreadsheets()
        .values()
        .update(
            spreadsheetId=spreadsheet_id,
            range=(
                f"'{sheet_name}'!"
                f"A{row_number}:"
                f"{DEFAULT_END_COLUMN}{row_number}"
            ),
            valueInputOption="RAW",
            body={
                "values": [
                    row
                ]
            },
        )
        .execute()
    )

    result = dict(
        merged_record
    )

    result[
        "record_id"
    ] = record_id

    result[
        "sheet_name"
    ] = sheet_name

    result[
        "sheet_status"
    ] = "UPDATED"

    return result


# ============================================================
# UPSERT MASTER RECORD
# ============================================================

def upsert_master_record(
    spreadsheet_id: str,
    record: Dict[str, Any],
    sheet_name: str = MASTER_SHEET_NAME,
) -> Dict[str, Any]:
    """
    Insert or update a MASTER record.
    """

    if not isinstance(
        record,
        dict,
    ):
        raise TypeError(
            "record must be a dictionary."
        )

    record_id = _safe_text(
        record.get(
            "record_id",
            record.get(
                "Record ID",
                "",
            ),
        )
    )

    if not record_id:
        raise ValueError(
            "record_id is required."
        )

    sheets_service = (
        get_sheets_service()
    )

    existing_row = find_master_record_row(
        sheets_service,
        spreadsheet_id,
        record_id,
        sheet_name,
    )

    if existing_row is None:

        return append_master_record(
            spreadsheet_id,
            record,
            sheet_name,
        )

    return update_master_record(
        spreadsheet_id,
        record_id,
        record,
        sheet_name,
    )


# ============================================================
# VISUALIZATION PERSISTENCE
# ============================================================

def persist_visualization_to_master(
    spreadsheet_id: str,
    visualization_record: Dict[str, Any],
    *,
    moodboard_id: Optional[str] = None,
    sheet_name: str = MASTER_SHEET_NAME,
) -> Dict[str, Any]:
    """
    Persist an applied tile visualization into the existing
    MASTER sheet as a MOODBOARD record.

    Record ID strategy:

        VIZ_<visualization_id>

    This keeps visualization records unique while preserving
    the existing MASTER Record Type contract.
    """

    if not isinstance(
        visualization_record,
        dict,
    ):
        raise TypeError(
            "visualization_record must be a dictionary."
        )

    visualization_id = _safe_text(
        visualization_record.get(
            "visualization_id"
        )
    )

    if not visualization_id:
        raise ValueError(
            "visualization_record.visualization_id "
            "is required."
        )

    product_id = _safe_text(
        visualization_record.get(
            "product_id"
        )
    )

    surface = _safe_text(
        visualization_record.get(
            "surface"
        )
    ).upper()

    record_id = (
        f"VIZ_{visualization_id}"
    )

    record = dict(
        visualization_record
    )

    record.update(
        {
            "record_type": "MOODBOARD",
            "record_id": record_id,
            "name": (
                f"Applied Tile - "
                f"{product_id or 'UNKNOWN'} "
                f"{surface or 'UNKNOWN'}"
            ),
            "category": (
                "TILE_VISUALIZATION"
            ),
            "scene_id": _safe_text(
                visualization_record.get(
                    "scene_id",
                    "",
                )
            ),
            "product_id": product_id,
            "product_name": _safe_text(
                visualization_record.get(
                    "product_name",
                    "",
                )
            ),
            "surface": surface,
            "applied_image": _safe_text(
                visualization_record.get(
                    "applied_image",
                    "",
                )
            ),
            "drive_url": _safe_text(
                visualization_record.get(
                    "drive_url",
                    "",
                )
            ),
            "status": (
                _safe_text(
                    visualization_record.get(
                        "status",
                        "GENERATED",
                    )
                ).upper()
                or "GENERATED"
            ),
            "moodboard_id": _safe_text(
                moodboard_id
            ),
            "created_at": (
                visualization_record.get(
                    "created_at",
                    _utc_now(),
                )
            ),
        }
    )

    return upsert_master_record(
        spreadsheet_id,
        record,
        sheet_name,
    )


# ============================================================
# END
# ============================================================
