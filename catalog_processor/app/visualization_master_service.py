"""
visualization_master_service.py

Google Sheets persistence for generated tile visualizations.

Important:
The existing MASTER schema currently contains fixed supported
record types such as CATALOG, PRODUCT, REQUIREMENT, FIXTURE,
MOODBOARD, RECOMMENDATION, DESIGN and RUN.

Therefore this module stores visualization records in a
dedicated VISUALIZATIONS tab inside the SAME spreadsheet.
It does not corrupt the existing MASTER schema.

No new Google authentication is created. The existing
app.google_services.get_sheets_service() is reused.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
import json

from app.google_services import (
    get_sheets_service,
)


# ============================================================
# CONFIGURATION
# ============================================================

DEFAULT_SHEET_NAME = "VISUALIZATIONS"

VISUALIZATION_HEADERS = [
    "Visualization ID",
    "Scene ID",
    "Product ID",
    "Product Name",
    "Surface",
    "Source Scene Image",
    "Tile Image",
    "Applied Image",
    "Drive File ID",
    "Drive URL",
    "Model",
    "Status",
    "Created At",
    "Metadata Path",
]


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


def _record_to_row(
    record: Dict[str, Any],
) -> List[str]:
    """
    Convert a visualization dictionary to the exact
    VISUALIZATIONS sheet column order.
    """

    return [
        _safe_text(
            record.get(
                "visualization_id",
                "",
            )
        ),
        _safe_text(
            record.get(
                "scene_id",
                "",
            )
        ),
        _safe_text(
            record.get(
                "product_id",
                "",
            )
        ),
        _safe_text(
            record.get(
                "product_name",
                "",
            )
        ),
        _safe_text(
            record.get(
                "surface",
                "",
            )
        ),
        _safe_text(
            record.get(
                "source_scene_image",
                "",
            )
        ),
        _safe_text(
            record.get(
                "tile_image",
                "",
            )
        ),
        _safe_text(
            record.get(
                "applied_image",
                "",
            )
        ),
        _safe_text(
            record.get(
                "drive_file_id",
                "",
            )
        ),
        _safe_text(
            record.get(
                "drive_url",
                "",
            )
        ),
        _safe_text(
            record.get(
                "model",
                "",
            )
        ),
        _safe_text(
            record.get(
                "status",
                "",
            )
        ),
        _safe_text(
            record.get(
                "created_at",
                "",
            )
        ),
        _safe_text(
            record.get(
                "metadata_path",
                "",
            )
        ),
    ]


# ============================================================
# SHEET METADATA
# ============================================================

def _get_actual_sheet_title(
    sheets_service,
    spreadsheet_id: str,
    sheet_name: str,
) -> Optional[str]:
    """
    Find a sheet tab case-insensitively.
    """

    metadata = (
        sheets_service
        .spreadsheets()
        .get(
            spreadsheetId=spreadsheet_id,
            fields="sheets(properties(title))",
        )
        .execute()
    )

    requested = _safe_text(
        sheet_name
    ).lower()

    for sheet in metadata.get(
        "sheets",
        [],
    ):

        properties = sheet.get(
            "properties",
            {},
        )

        title = _safe_text(
            properties.get(
                "title",
                "",
            )
        )

        if title.lower() == requested:
            return title

    return None


def ensure_visualization_sheet(
    sheets_service,
    spreadsheet_id: str,
    sheet_name: str = DEFAULT_SHEET_NAME,
) -> str:
    """
    Ensure the VISUALIZATIONS tab exists and has the expected
    header row.

    Returns the actual sheet title.
    """

    sheet_name = _safe_text(
        sheet_name
    )

    if not sheet_name:
        raise ValueError(
            "sheet_name is required."
        )

    actual_title = (
        _get_actual_sheet_title(
            sheets_service,
            spreadsheet_id,
            sheet_name,
        )
    )

    # --------------------------------------------------------
    # CREATE SHEET IF NEEDED
    # --------------------------------------------------------

    if actual_title is None:

        response = (
            sheets_service
            .spreadsheets()
            .batchUpdate(
                spreadsheetId=spreadsheet_id,
                body={
                    "requests": [
                        {
                            "addSheet": {
                                "properties": {
                                    "title": sheet_name
                                }
                            }
                        }
                    ]
                },
            )
            .execute()
        )

        replies = response.get(
            "replies",
            [],
        )

        if not replies:
            raise RuntimeError(
                "Google Sheets did not return "
                "an addSheet reply."
            )

        actual_title = (
            replies[0]
            .get("addSheet", {})
            .get("properties", {})
            .get("title", sheet_name)
        )

    # --------------------------------------------------------
    # ENSURE HEADER ROW
    # --------------------------------------------------------

    header_response = (
        sheets_service
        .spreadsheets()
        .values()
        .get(
            spreadsheetId=spreadsheet_id,
            range=f"'{actual_title}'!A1:N1",
        )
        .execute()
    )

    current_values = (
        header_response.get(
            "values",
            [],
        )
    )

    current_header = (
        current_values[0]
        if current_values
        else []
    )

    normalized_current = [
        _safe_text(value)
        for value in current_header
    ]

    expected = VISUALIZATION_HEADERS

    if normalized_current != expected:

        (
            sheets_service
            .spreadsheets()
            .values()
            .update(
                spreadsheetId=spreadsheet_id,
                range=f"'{actual_title}'!A1:N1",
                valueInputOption="RAW",
                body={
                    "values": [
                        expected
                    ]
                },
            )
            .execute()
        )

    return actual_title


# ============================================================
# LOAD VISUALIZATION RECORDS
# ============================================================

def load_visualization_records(
    spreadsheet_id: str,
    sheet_name: str = DEFAULT_SHEET_NAME,
) -> List[Dict[str, str]]:
    """
    Load all visualization records from the dedicated tab.
    """

    if not spreadsheet_id:
        raise ValueError(
            "spreadsheet_id is required."
        )

    sheets_service = (
        get_sheets_service()
    )

    actual_title = ensure_visualization_sheet(
        sheets_service,
        spreadsheet_id,
        sheet_name,
    )

    response = (
        sheets_service
        .spreadsheets()
        .values()
        .get(
            spreadsheetId=spreadsheet_id,
            range=f"'{actual_title}'!A:N",
        )
        .execute()
    )

    values = response.get(
        "values",
        [],
    )

    if len(values) <= 1:
        return []

    headers = [
        _safe_text(value)
        for value in values[0]
    ]

    records = []

    for row in values[1:]:

        padded = list(row)

        if len(padded) < len(headers):
            padded.extend(
                [""] * (
                    len(headers)
                    - len(padded)
                )
            )

        record = {}

        for index, header in enumerate(
            headers
        ):

            if not header:
                continue

            record[header] = _safe_text(
                padded[index]
            )

        records.append(
            record
        )

    return records


# ============================================================
# FIND RECORD
# ============================================================

def find_visualization_record(
    spreadsheet_id: str,
    visualization_id: str,
    sheet_name: str = DEFAULT_SHEET_NAME,
) -> Optional[Dict[str, str]]:
    """
    Find one visualization record by Visualization ID.
    """

    visualization_id = _safe_text(
        visualization_id
    )

    if not visualization_id:
        raise ValueError(
            "visualization_id is required."
        )

    records = load_visualization_records(
        spreadsheet_id,
        sheet_name,
    )

    for record in records:

        if (
            _safe_text(
                record.get(
                    "Visualization ID"
                )
            )
            == visualization_id
        ):
            return record

    return None


# ============================================================
# APPEND RECORD
# ============================================================

def append_visualization_record(
    spreadsheet_id: str,
    record: Dict[str, Any],
    sheet_name: str = DEFAULT_SHEET_NAME,
) -> Dict[str, Any]:
    """
    Append one visualization record.

    Duplicate Visualization IDs are rejected.
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
            "record.visualization_id is required."
        )

    # Ensure timestamp exists.
    if not _safe_text(
        record.get(
            "created_at"
        )
    ):
        record = dict(record)

        record["created_at"] = (
            _utc_now()
        )

    existing = find_visualization_record(
        spreadsheet_id,
        visualization_id,
        sheet_name,
    )

    if existing is not None:
        raise ValueError(
            "Visualization already exists "
            f"in Google Sheets: {visualization_id}"
        )

    sheets_service = (
        get_sheets_service()
    )

    actual_title = ensure_visualization_sheet(
        sheets_service,
        spreadsheet_id,
        sheet_name,
    )

    row = _record_to_row(
        record
    )

    (
        sheets_service
        .spreadsheets()
        .values()
        .append(
            spreadsheetId=spreadsheet_id,
            range=f"'{actual_title}'!A:N",
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

    result = dict(record)

    result["sheet_name"] = (
        actual_title
    )

    result["sheet_status"] = (
        "UPLOADED"
    )

    return result


# ============================================================
# UPSERT RECORD
# ============================================================

def upsert_visualization_record(
    spreadsheet_id: str,
    record: Dict[str, Any],
    sheet_name: str = DEFAULT_SHEET_NAME,
) -> Dict[str, Any]:
    """
    Insert a visualization if it does not exist.

    If it already exists, update the existing row.
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
            "record.visualization_id is required."
        )

    sheets_service = (
        get_sheets_service()
    )

    actual_title = ensure_visualization_sheet(
        sheets_service,
        spreadsheet_id,
        sheet_name,
    )

    # --------------------------------------------------------
    # FIND EXISTING ROW
    # --------------------------------------------------------

    response = (
        sheets_service
        .spreadsheets()
        .values()
        .get(
            spreadsheetId=spreadsheet_id,
            range=f"'{actual_title}'!A:N",
        )
        .execute()
    )

    values = response.get(
        "values",
        [],
    )

    target_row = None

    if values:

        for row_index, row in enumerate(
            values[1:],
            start=2,
        ):

            if not row:
                continue

            current_id = _safe_text(
                row[0]
            )

            if (
                current_id
                == visualization_id
            ):
                target_row = row_index
                break

    if not _safe_text(
        record.get(
            "created_at"
        )
    ):
        record = dict(record)

        record["created_at"] = (
            _utc_now()
        )

    row = _record_to_row(
        record
    )

    # --------------------------------------------------------
    # UPDATE EXISTING
    # --------------------------------------------------------

    if target_row is not None:

        (
            sheets_service
            .spreadsheets()
            .values()
            .update(
                spreadsheetId=spreadsheet_id,
                range=(
                    f"'{actual_title}'!"
                    f"A{target_row}:N{target_row}"
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

        result = dict(record)

        result["sheet_name"] = (
            actual_title
        )

        result["sheet_status"] = (
            "UPDATED"
        )

        return result

    # --------------------------------------------------------
    # APPEND NEW
    # --------------------------------------------------------

    return append_visualization_record(
        spreadsheet_id,
        record,
        sheet_name,
    )


# ============================================================
# CONVENIENCE FUNCTION
# ============================================================

def save_visualization_to_google_sheets(
    spreadsheet_id: str,
    record: Dict[str, Any],
    sheet_name: str = DEFAULT_SHEET_NAME,
) -> Dict[str, Any]:
    """
    Public production entry point.

    Saves the visualization to the dedicated tab and returns
    the resulting record.
    """

    return upsert_visualization_record(
        spreadsheet_id=spreadsheet_id,
        record=record,
        sheet_name=sheet_name,
    )


# ============================================================
# EXPORT JSON SNAPSHOT
# ============================================================

def save_visualization_sheet_snapshot(
    spreadsheet_id: str,
    output_path: Path,
    sheet_name: str = DEFAULT_SHEET_NAME,
) -> Path:
    """
    Save the current Google Sheets visualization records to a
    local JSON snapshot.

    Useful for debugging and audits.
    """

    records = load_visualization_records(
        spreadsheet_id,
        sheet_name,
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
            records,
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    return output_path