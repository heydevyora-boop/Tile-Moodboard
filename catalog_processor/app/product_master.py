
import os
from pathlib import Path
from dotenv import load_dotenv
from .inheritance import resolve_products


from google_services import (
    get_sheets_service,
)

BASE_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BASE_DIR / ".env"

load_dotenv(dotenv_path=ENV_FILE)


# ============================================================
# CONFIGURATION
# ============================================================

SPREADSHEET_ID = os.getenv("GOOGLE_SHEET_ID")

print("GOOGLE_SHEET_ID loaded:", bool(SPREADSHEET_ID))

if not SPREADSHEET_ID:
    raise ValueError(
        "GOOGLE_SHEET_ID is missing from .env"
    )


# ============================================================
# SHEET STRUCTURE
# ============================================================

SHEET_HEADERS = {

    "PRODUCTS": [
        "Product ID",
        "Brand",
        "Catalog",
        "PDF Name",
        "Product Name",
        "SKU / Product Code",
        "Page",
        "Image Index",
        "Drive URL",

        "Finish",
        "Finish Source",

        "Budget Tier",
        "Budget Source",

        "Suitable for Floor",
        "Suitable for Wall",
        "Bathroom Floor",
        "Bathroom Wall",
        "Shower Area",
        "Highlight Suitable",

        "Dimensions",
        "Length",
        "Width",
        "Thickness",
        "Format",
        "Slip Rating",
        "PEI",
        "DCOF",
        "Technical Notes",

        "Style",
        "Color",
        "Tone",
        "Pattern",
        "Veining",
        "AI Classification Source",

        "Resolved Finish",
        "Resolved Finish Source",
        "Resolved Budget",
        "Resolved Budget Source",
    ],

    "CATALOGS": [
        "Catalog ID",
        "Brand",
        "Catalog",
        "PDF Name",
        "Default Finish",
        "Default Budget",
        "Finish Source",
        "Budget Source",
        "Notes",
    ],

    "BRANDS": [
        "Brand ID",
        "Brand",
        "Notes",
    ],

    "SANITARY": [
        "Product ID",
        "Brand",
        "Product Name",
        "Category",
        "Type",
        "Color",
        "Dimensions",
        "Budget Tier",
        "Image",
        "Drive URL",
        "Technical Notes",
    ],

    "FAUCETS": [
        "Product ID",
        "Brand",
        "Product Name",
        "Category",
        "Type",
        "Color / Finish",
        "Budget Tier",
        "Image",
        "Drive URL",
        "Technical Notes",
    ],

    "BASINS": [
        "Product ID",
        "Brand",
        "Product Name",
        "Category",
        "Type",
        "Color / Finish",
        "Dimensions",
        "Budget Tier",
        "Image",
        "Drive URL",
        "Technical Notes",
    ],

    "WC": [
        "Product ID",
        "Brand",
        "Product Name",
        "Category",
        "Type",
        "Color",
        "Dimensions",
        "Budget Tier",
        "Image",
        "Drive URL",
        "Technical Notes",
    ],

    "FLUSH_PLATES": [
        "Product ID",
        "Brand",
        "Product Name",
        "Category",
        "Type",
        "Color / Finish",
        "Budget Tier",
        "Image",
        "Drive URL",
        "Technical Notes",
    ],

    "SETTINGS": [
        "Setting",
        "Value",
        "Description",
    ],
}

def apply_product_inheritance(products, catalogs):
    """
    Apply catalog defaults and product-level overrides
    to Product Master records.
    """

    resolved_products = resolve_products(
        products=products,
        catalogs=catalogs
    )

    return resolved_products

# ============================================================
# GET EXISTING SHEETS
# ============================================================
def get_catalog_records(sheets_service):
    """
    Read catalog records from the CATALOGS sheet.
    """

    values = (
        sheets_service
        .spreadsheets()
        .values()
        .get(
            spreadsheetId=SPREADSHEET_ID,
            range="CATALOGS"
        )
        .execute()
        .get("values", [])
    )

    if not values:
        return []

    headers = values[0]

    records = []

    for row in values[1:]:

        row = row + [
            ""
        ] * (
            len(headers) - len(row)
        )

        record = dict(
            zip(
                headers,
                row
            )
        )

        records.append(record)

    return records

    
def get_existing_sheets(sheets_service):

    response = (
        sheets_service
        .spreadsheets()
        .get(
            spreadsheetId=SPREADSHEET_ID
        )
        .execute()
    )

    return {
        sheet["properties"]["title"]
        for sheet in response.get("sheets", [])
    }


# ============================================================
# CREATE MISSING SHEETS
# ============================================================

def create_missing_sheets(
    sheets_service,
    existing_sheets
):

    requests = []

    for sheet_name in SHEET_HEADERS:

        if sheet_name not in existing_sheets:

            requests.append({
                "addSheet": {
                    "properties": {
                        "title": sheet_name
                    }
                }
            })

    if not requests:
        return

    (
        sheets_service
        .spreadsheets()
        .batchUpdate(
            spreadsheetId=SPREADSHEET_ID,
            body={
                "requests": requests
            }
        )
        .execute()
    )


# ============================================================
# WRITE HEADERS
# ============================================================

def write_headers(
    sheets_service,
    sheet_name,
    headers
):

    range_name = (
        f"'{sheet_name}'!A1:{column_letter(len(headers))}1"
    )

    body = {
        "values": [
            headers
        ]
    }

    (
        sheets_service
        .spreadsheets()
        .values()
        .update(
            spreadsheetId=SPREADSHEET_ID,
            range=range_name,
            valueInputOption="RAW",
            body=body
        )
        .execute()
    )


# ============================================================
# COLUMN NUMBER → LETTER
# ============================================================

def column_letter(number):

    result = ""

    while number:

        number, remainder = divmod(
            number - 1,
            26
        )

        result = (
            chr(65 + remainder)
            + result
        )

    return result


# ============================================================
# FORMAT SHEET
# ============================================================

def format_header(
    sheets_service,
    spreadsheet_metadata
):

    requests = []

    for sheet in spreadsheet_metadata["sheets"]:

        properties = sheet["properties"]

        sheet_id = properties["sheetId"]
        sheet_name = properties["title"]

        if sheet_name not in SHEET_HEADERS:
            continue

        column_count = len(
            SHEET_HEADERS[sheet_name]
        )

        requests.append({

            "repeatCell": {

                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": 0,
                    "endRowIndex": 1,
                    "startColumnIndex": 0,
                    "endColumnIndex": column_count,
                },

                "cell": {

                    "userEnteredFormat": {

                        "textFormat": {
                            "bold": True
                        },

                        "horizontalAlignment": "CENTER",

                    }

                },

                "fields": (
                    "userEnteredFormat."
                    "textFormat.bold,"
                    "userEnteredFormat."
                    "horizontalAlignment"
                )

            }

        })

        requests.append({

            "updateSheetProperties": {

                "properties": {

                    "sheetId": sheet_id,

                    "gridProperties": {

                        "frozenRowCount": 1

                    }

                },

                "fields": (
                    "gridProperties.frozenRowCount"
                )

            }

        })

    if not requests:
        return

    (
        sheets_service
        .spreadsheets()
        .batchUpdate(
            spreadsheetId=SPREADSHEET_ID,
            body={
                "requests": requests
            }
        )
        .execute()
    )


# ============================================================
# INITIALIZE PRODUCT MASTER
# ============================================================

def initialize_product_master():

    print("")
    print("==============================================")
    print("INITIALIZING PRODUCT MASTER")
    print("==============================================")

    sheets_service = get_sheets_service()

    print("Google Sheets connected.")

    existing_sheets = get_existing_sheets(
        sheets_service
    )

    print(
        "Existing sheets:",
        ", ".join(sorted(existing_sheets))
    )

    create_missing_sheets(
        sheets_service,
        existing_sheets
    )

    print("Required sheets created/verified.")

    # Refresh metadata so newly-created sheets are also formatted.
    metadata = (
        sheets_service
        .spreadsheets()
        .get(
            spreadsheetId=SPREADSHEET_ID
        )
        .execute()
    )

    for sheet_name, headers in SHEET_HEADERS.items():

        write_headers(
            sheets_service,
            sheet_name,
            headers
        )

        print(
            f"Headers initialized: {sheet_name}"
        )

    format_header(
        sheets_service,
        metadata
    )

    print("")
    print("==============================================")
    print("PRODUCT MASTER INITIALIZATION COMPLETE")
    print("==============================================")


# ============================================================
# RUN
# ============================================================

if __name__ == "__main__":

    initialize_product_master()