"""
diagnose_sheet_write.py

Proves, against the REAL Google Sheet configured in .env, whether the
extraction pipeline can write a product row -- and shows exactly why
if it cannot.

Run:

    python catalog_processor/diagnose_sheet_write.py

It writes one clearly-labelled test row into MASTER and reads it back.
Delete that row afterwards; nothing else in the sheet is touched.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dotenv import load_dotenv

load_dotenv(
    Path(__file__).resolve().parent / ".env"
)

from app.google_services import (          # noqa: E402
    MASTER_SHEETS,
    PRODUCT_SHEET_NAME,
    append_product,
    ensure_master_workbook,
    get_sheet_metadata,
    get_sheets_service,
)


DIAGNOSTIC_PRODUCT_ID = "ZZ-DIAGNOSTIC-TEST-ROW"


def show_tabs(sheets_service, spreadsheet_id, heading):

    print("")
    print(heading)
    print("-" * 60)

    metadata = get_sheet_metadata(
        sheets_service,
        spreadsheet_id,
    )

    found = {}

    for sheet in metadata.get("sheets", []):

        properties = sheet["properties"]
        title = properties["title"]

        columns = (
            properties
            .get("gridProperties", {})
            .get("columnCount", 0)
        )

        found[title] = columns

        required = len(
            MASTER_SHEETS.get(title, [])
        )

        if not required:
            print(f"  {title:16} {columns:4} columns")
            continue

        verdict = (
            "OK"
            if columns >= required
            else f"TOO NARROW (needs {required})"
        )

        print(
            f"  {title:16} {columns:4} columns   {verdict}"
        )

    for title in MASTER_SHEETS:
        if title not in found:
            print(f"  {title:16}    -- MISSING")

    return found


def main():

    spreadsheet_id = (
        os.getenv("GOOGLE_SHEET_ID")
        or os.getenv("GOOGLE_SPREADSHEET_ID")
        or os.getenv("SPREADSHEET_ID")
    )

    print("")
    print("=" * 60)
    print("GOOGLE SHEET WRITE DIAGNOSTIC")
    print("=" * 60)

    print("")
    print(f"GOOGLE_SHEET_ID       : {os.getenv('GOOGLE_SHEET_ID')}")
    print(f"GOOGLE_SPREADSHEET_ID : {os.getenv('GOOGLE_SPREADSHEET_ID')}")
    print(f"Using spreadsheet     : {spreadsheet_id}")
    print(f"Product rows go to tab: {PRODUCT_SHEET_NAME}")
    print(
        f"{PRODUCT_SHEET_NAME} schema width   : "
        f"{len(MASTER_SHEETS[PRODUCT_SHEET_NAME])} columns"
    )

    if not spreadsheet_id:
        print("")
        print("FAIL: no spreadsheet ID in .env.")
        return 1

    print("")
    print("Open this sheet in the browser to compare:")
    print(
        "  https://docs.google.com/spreadsheets/d/"
        f"{spreadsheet_id}/edit"
    )

    sheets_service = get_sheets_service()

    show_tabs(
        sheets_service,
        spreadsheet_id,
        "TAB WIDTHS BEFORE REPAIR",
    )

    print("")
    print("Running ensure_master_workbook() ...")

    ensure_master_workbook(
        sheets_service=sheets_service,
        spreadsheet_id=spreadsheet_id,
    )

    show_tabs(
        sheets_service,
        spreadsheet_id,
        "TAB WIDTHS AFTER REPAIR",
    )

    print("")
    print("Writing one diagnostic product row ...")

    try:

        written = append_product(
            sheets_service=sheets_service,
            spreadsheet_id=spreadsheet_id,
            product_id=DIAGNOSTIC_PRODUCT_ID,
            brand_id="BRAND-DIAGNOSTIC",
            brand="DIAGNOSTIC",
            catalog_id="CAT-DIAGNOSTIC",
            catalog="Diagnostic Catalog",
            pdf_name="diagnostic.pdf",
            product_name="DIAGNOSTIC TEST ROW - safe to delete",
            sku="",
            page=1,
            image_index=1,
            drive_url="",
            image_filename="diagnostic.webp",
        )

    except Exception as error:  # noqa: BLE001

        print("")
        print("=" * 60)
        print("FAIL: the sheet write was rejected.")
        print("=" * 60)
        print("")
        print(f"{type(error).__name__}: {error}")
        return 1

    response = (
        sheets_service
        .spreadsheets()
        .values()
        .get(
            spreadsheetId=spreadsheet_id,
            range=f"'{PRODUCT_SHEET_NAME}'!A:A",
        )
        .execute()
    )

    column_a = [
        row[0]
        for row in response.get("values", [])
        if row
    ]

    print("")
    print("=" * 60)

    if DIAGNOSTIC_PRODUCT_ID in column_a:

        print("PASS: the row is in the sheet.")
        print("=" * 60)
        print("")
        print(
            f"{PRODUCT_SHEET_NAME} now holds "
            f"{max(len(column_a) - 1, 0)} product row(s)."
        )
        print("")
        print(
            f"Delete the '{DIAGNOSTIC_PRODUCT_ID}' row, then run:"
        )
        print("  python catalog_processor/main_step6_complete.py --pipeline")
        return 0

    if not written:
        print(
            "NOTE: a row with this Product ID already existed "
            "(nothing was duplicated)."
        )
        print("=" * 60)
        return 0

    print("FAIL: the API accepted the write but the row is not there.")
    print("=" * 60)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
