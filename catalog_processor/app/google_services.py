from pathlib import Path

from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request

from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload


# ============================================================
# GOOGLE API CONFIGURATION
# ============================================================

SCOPES = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
]

CREDENTIALS_FILE = "credentials.json"
TOKEN_FILE = "token.json"

# Canonical product/master tab used by the catalog pipeline.
PRODUCT_SHEET_NAME = "MASTER"


# ============================================================
# MASTER GOOGLE SHEET STRUCTURE
# ============================================================

MASTER_SHEETS = {

    "BRANDS": [
        "Brand ID",
        "Brand Name",
        "Parent Folder",
        "Status",
        "Notes",
    ],

    "CATALOGS": [
        "Catalog ID",
        "Brand ID",
        "Brand Name",
        "Catalog Name",
        "PDF Name",
        "Default Finish",
        "Default Budget",
        "Finish Source",
        "Budget Source",
        "Status",
        "Notes",
    ],

    "MASTER": [
        "Product ID",
        "Brand ID",
        "Brand",
        "Catalog ID",
        "Catalog",
        "PDF Name",
        "Product Name",
        "SKU / Product Code",
        "Page",
        "Image Index",
        "Drive URL",
        "Image Filename",

        "Finish Override",
        "Finish Extracted",
        "Finish AI",
        "Finish Source",
        "Resolved Finish",

        "Budget Override",
        "Budget Source",
        "Resolved Budget",

        "Suitable for Wall",
        "Suitable for Floor",
        "Bathroom Wall",
        "Bathroom Floor",
        "Shower Area",
        "Highlight Suitable",

        "Floor / Wall",
        "Application Source",

        "Dimensions",
        "Length",
        "Width",
        "Thickness",
        "Format",
        "Slip Rating",
        "PEI",
        "DCOF",
        "Technical Notes",

        "AI Style",
        "AI Color",
        "AI Tone",
        "AI Pattern",
        "AI Veining",
        "AI Contrast",
        "AI Classification Status",
        "AI Classification Source",

        "Status",
        "Notes",
    ],

    "SANITARY": [
        "Product ID",
        "Brand ID",
        "Brand",
        "Product Name",
        "Category",
        "Type",
        "Color / Finish",
        "Dimensions",
        "Budget Tier",
        "Image",
        "Drive URL",
        "Source",
        "Status",
        "Notes",
    ],

    "FAUCETS": [
        "Product ID",
        "Brand ID",
        "Brand",
        "Product Name",
        "Category",
        "Type",
        "Color / Finish",
        "Image",
        "Drive URL",
        "Budget Tier",
        "Source",
        "Status",
        "Notes",
    ],

    "BASINS": [
        "Product ID",
        "Brand ID",
        "Brand",
        "Product Name",
        "Category",
        "Type",
        "Color / Finish",
        "Dimensions",
        "Budget Tier",
        "Image",
        "Drive URL",
        "Source",
        "Status",
        "Notes",
    ],

    "WC": [
        "Product ID",
        "Brand ID",
        "Brand",
        "Product Name",
        "Category",
        "Type",
        "Color",
        "Dimensions",
        "Budget Tier",
        "Image",
        "Drive URL",
        "Source",
        "Status",
        "Notes",
    ],

    "FLUSH_PLATES": [
        "Product ID",
        "Brand ID",
        "Brand",
        "Product Name",
        "Category",
        "Type",
        "Color / Finish",
        "Dimensions",
        "Budget Tier",
        "Image",
        "Drive URL",
        "Source",
        "Status",
        "Notes",
    ],

    "SETTINGS": [
        "Setting Group",
        "Setting Key",
        "Allowed Value",
        "Active",
        "Notes",
    ],
}


# ============================================================
# GOOGLE AUTHENTICATION
# ============================================================

def get_credentials():
    """
    Get Google OAuth credentials.

    Reuses token.json if available.
    Refreshes expired credentials when possible.
    Opens browser authentication on first run.
    """

    credentials = None

    token_path = Path(TOKEN_FILE)

    # --------------------------------------------------------
    # Reuse existing token
    # --------------------------------------------------------

    if token_path.exists():

        credentials = Credentials.from_authorized_user_file(
            TOKEN_FILE,
            SCOPES,
        )

    # --------------------------------------------------------
    # Refresh expired token
    # --------------------------------------------------------

    if (
        credentials
        and credentials.expired
        and credentials.refresh_token
    ):

        credentials.refresh(Request())

    # --------------------------------------------------------
    # First-time authentication
    # --------------------------------------------------------

    if not credentials or not credentials.valid:

        flow = InstalledAppFlow.from_client_secrets_file(
            CREDENTIALS_FILE,
            SCOPES,
        )

        credentials = flow.run_local_server(
            port=0
        )

        with open(
            TOKEN_FILE,
            "w",
            encoding="utf-8",
        ) as token:

            token.write(
                credentials.to_json()
            )

    return credentials


# ============================================================
# GOOGLE DRIVE SERVICE
# ============================================================

def get_drive_service():

    return build(
        "drive",
        "v3",
        credentials=get_credentials(),
    )


# ============================================================
# GOOGLE SHEETS SERVICE
# ============================================================

def get_sheets_service():

    return build(
        "sheets",
        "v4",
        credentials=get_credentials(),
    )


# ============================================================
# DRIVE QUERY HELPER
# ============================================================

def escape_drive_query_value(value):
    """
    Escape values used inside Google Drive search queries.
    """

    return (
        str(value)
        .replace("\\", "\\\\")
        .replace("'", "\\'")
    )


# ============================================================
# GET OR CREATE GOOGLE DRIVE FOLDER
# ============================================================

def get_or_create_folder(
    drive_service,
    folder_name,
    parent_id=None,
):
    """
    Find an existing Drive folder or create it.

    If parent_id is provided, the folder is created
    inside that parent folder.
    """

    safe_name = escape_drive_query_value(
        folder_name
    )

    query_parts = [
        "mimeType='application/vnd.google-apps.folder'",
        f"name='{safe_name}'",
        "trashed=false",
    ]

    if parent_id:
        query_parts.append(
            f"'{parent_id}' in parents"
        )

    query = " and ".join(query_parts)

    response = drive_service.files().list(
        q=query,
        spaces="drive",
        fields="files(id,name,parents)",
        pageSize=100,
    ).execute()

    folders = response.get(
        "files",
        [],
    )

    # Existing folder
    if folders:

        return folders[0]["id"]

    # Create new folder
    metadata = {
        "name": folder_name,
        "mimeType": "application/vnd.google-apps.folder",
    }

    if parent_id:
        metadata["parents"] = [
            parent_id
        ]

    folder = drive_service.files().create(
        body=metadata,
        fields="id,name,parents",
    ).execute()

    return folder["id"]


# ============================================================
# UPLOAD FILE TO GOOGLE DRIVE
# ============================================================

def upload_file(
    drive_service,
    file_path,
    folder_id,
):
    """
    Upload a local file to a Google Drive folder.
    """

    file_path = Path(file_path)

    metadata = {
        "name": file_path.name,
        "parents": [
            folder_id
        ],
    }

    media = MediaFileUpload(
        str(file_path),
        resumable=True,
    )

    uploaded_file = drive_service.files().create(
        body=metadata,
        media_body=media,
        fields="id,name,webViewLink,webContentLink",
    ).execute()

    return uploaded_file


# ============================================================
# GET GOOGLE SHEET METADATA
# ============================================================

def get_sheet_metadata(
    sheets_service,
    spreadsheet_id,
):

    return sheets_service.spreadsheets().get(
        spreadsheetId=spreadsheet_id,
        fields="sheets(properties(sheetId,title,index))",
    ).execute()


# ============================================================
# GET EXISTING SHEET TAB NAMES
# ============================================================

def get_existing_sheet_titles(
    sheets_service,
    spreadsheet_id,
):

    metadata = get_sheet_metadata(
        sheets_service,
        spreadsheet_id,
    )

    return {
        sheet["properties"]["title"]
        for sheet in metadata.get(
            "sheets",
            [],
        )
    }


# ============================================================
# CREATE MASTER GOOGLE SHEET STRUCTURE
# ============================================================

def ensure_master_workbook(
    sheets_service,
    spreadsheet_id,
):
    """
    Creates required tabs and headers.

    Existing tabs and existing data are NOT deleted.
    """

    existing_titles = get_existing_sheet_titles(
        sheets_service,
        spreadsheet_id,
    )

    requests = []

    # --------------------------------------------------------
    # Create missing tabs
    # --------------------------------------------------------

    for title in MASTER_SHEETS:

        if title not in existing_titles:

            requests.append(
                {
                    "addSheet": {
                        "properties": {
                            "title": title,
                        }
                    }
                }
            )

    if requests:

        sheets_service.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={
                "requests": requests
            },
        ).execute()

    # --------------------------------------------------------
    # Add headers to empty tabs
    # --------------------------------------------------------

    for title, headers in MASTER_SHEETS.items():

        response = (
            sheets_service
            .spreadsheets()
            .values()
            .get(
                spreadsheetId=spreadsheet_id,
                range=f"'{title}'!1:1",
            )
            .execute()
        )

        first_row = response.get(
            "values",
            [],
        )

        if not first_row:

            (
                sheets_service
                .spreadsheets()
                .values()
                .update(
                    spreadsheetId=spreadsheet_id,
                    range=f"'{title}'!A1",
                    valueInputOption="RAW",
                    body={
                        "values": [
                            headers
                        ]
                    },
                )
                .execute()
            )

    print(
        "Master Google Sheet structure is ready."
    )

# ============================================================
# UPDATE BATHROOM CLASSIFICATION
# ============================================================

def update_bathroom_classification(
    sheets_service,
    spreadsheet_id,
    row_number,
    classification,
):
    """
    Update bathroom classification fields in MASTER.

    MASTER columns:

    U = Suitable for Wall
    V = Suitable for Floor
    W = Bathroom Wall
    X = Bathroom Floor
    Y = Shower Area
    Z = Highlight Suitable
    AA = Floor / Wall
    AB = Application Source
    """

    values = [
        [
            classification["suitable_for_wall"],
            classification["suitable_for_floor"],
            classification["bathroom_wall"],
            classification["bathroom_floor"],
            classification["shower_area"],
            classification["highlight_suitable"],
            classification["floor_wall"],
            classification["application_source"],
        ]
    ]

    (
        sheets_service
        .spreadsheets()
        .values()
        .update(
            spreadsheetId=spreadsheet_id,
            range=f"'{PRODUCT_SHEET_NAME}'!U{row_number}:AB{row_number}",
            valueInputOption="RAW",
            body={
                "values": values
            },
        )
        .execute()
    )

# ============================================================
# CHECK UNIQUE ID
# ============================================================

def append_unique_row(
    sheets_service,
    spreadsheet_id,
    sheet_name,
    row,
    unique_column=0,
):
    """
    Add a row only if its first-column ID
    does not already exist.

    Prevents duplicate Brand/Catalog/Product rows.
    """

    response = (
        sheets_service
        .spreadsheets()
        .values()
        .get(
            spreadsheetId=spreadsheet_id,
            range=f"'{sheet_name}'!A:A",
        )
        .execute()
    )

    values = response.get(
        "values",
        [],
    )

    unique_value = str(
        row[unique_column]
    ).strip()

    # Skip header
    for existing_row in values[1:]:

        if (
            existing_row
            and str(existing_row[0]).strip()
            == unique_value
        ):
            return False

    (
        sheets_service
        .spreadsheets()
        .values()
        .append(
            spreadsheetId=spreadsheet_id,
            range=f"'{sheet_name}'!A:ZZ",
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

    return True


# ============================================================
# ADD BRAND
# ============================================================

def append_brand(
    sheets_service,
    spreadsheet_id,
    brand_id,
    brand_name,
    parent_folder="",
):

    row = [
        brand_id,
        brand_name,
        parent_folder,
        "ACTIVE",
        "",
    ]

    return append_unique_row(
        sheets_service,
        spreadsheet_id,
        "BRANDS",
        row,
    )


# ============================================================
# ADD CATALOG
# ============================================================

def append_catalog(
    sheets_service,
    spreadsheet_id,
    catalog_id,
    brand_id,
    brand_name,
    catalog_name,
    pdf_name,
):

    row = [
        catalog_id,
        brand_id,
        brand_name,
        catalog_name,
        pdf_name,

        # Default Finish
        "UNKNOWN",

        # Default Budget
        "UNKNOWN",

        # Finish Source
        "MANUAL_CATALOG",

        # Budget Source
        "MANUAL_CATALOG",

        # Status
        "ACTIVE",

        # Notes
        "",
    ]

    return append_unique_row(
        sheets_service,
        spreadsheet_id,
        "CATALOGS",
        row,
    )


# ============================================================
# ADD PRODUCT
# ============================================================

def append_product(
    sheets_service,
    spreadsheet_id,
    product_id,
    brand_id,
    brand,
    catalog_id,
    catalog,
    pdf_name,
    product_name,
    sku,
    page,
    image_index,
    drive_url,
    image_filename,
):
    """
    Add one extracted product/image
    to the MASTER sheet.

    Intelligence fields remain UNKNOWN/blank
    until the classification phase.
    """

    row = [

        # ----------------------------------------------------
        # BASIC PRODUCT INFORMATION
        # ----------------------------------------------------

        product_id,
        brand_id,
        brand,
        catalog_id,
        catalog,
        pdf_name,
        product_name,
        sku,
        page,
        image_index,
        drive_url,
        image_filename,

        # ----------------------------------------------------
        # FINISH
        # ----------------------------------------------------

        "",                  # Finish Override
        "",                  # Finish Extracted
        "",                  # Finish AI
        "",                  # Finish Source
        "UNKNOWN",           # Resolved Finish

        # ----------------------------------------------------
        # BUDGET
        # ----------------------------------------------------

        "",                  # Budget Override
        "",                  # Budget Source
        "UNKNOWN",           # Resolved Budget

        # ----------------------------------------------------
        # APPLICATION
        # ----------------------------------------------------

        "UNKNOWN",           # Suitable for Wall
        "UNKNOWN",           # Suitable for Floor
        "UNKNOWN",           # Bathroom Wall
        "UNKNOWN",           # Bathroom Floor
        "UNKNOWN",           # Shower Area
        "UNKNOWN",           # Highlight Suitable

        "UNKNOWN",           # Floor / Wall
        "EXTRACTION",        # Application Source

        # ----------------------------------------------------
        # TECHNICAL INFORMATION
        # ----------------------------------------------------

        "",                  # Dimensions
        "",                  # Length
        "",                  # Width
        "",                  # Thickness
        "",                  # Format
        "",                  # Slip Rating
        "",                  # PEI
        "",                  # DCOF
        "",                  # Technical Notes

        # ----------------------------------------------------
        # AI ATTRIBUTES
        # ----------------------------------------------------

        "",                  # AI Style
        "",                  # AI Color
        "",                  # AI Tone
        "",                  # AI Pattern
        "",                  # AI Veining
        "",                  # AI Contrast
        "NOT_CLASSIFIED",    # AI Classification Status
        "",                  # AI Classification Source

        # ----------------------------------------------------
        # STATUS
        # ----------------------------------------------------

        "ACTIVE",
        "",
    ]

    return append_unique_row(
        sheets_service,
        spreadsheet_id,
        PRODUCT_SHEET_NAME,
        row,
    )


# ============================================================
# GET CATALOG DEFAULTS
# ============================================================

def get_catalog_defaults(
    sheets_service,
    spreadsheet_id,
    catalog_id,
):
    """
    Read catalog-level default Finish and Budget.
    """

    response = (
        sheets_service
        .spreadsheets()
        .values()
        .get(
            spreadsheetId=spreadsheet_id,
            range="'CATALOGS'!A:L",
        )
        .execute()
    )

    rows = response.get(
        "values",
        [],
    )

    if not rows:

        return {
            "finish": "UNKNOWN",
            "budget": "UNKNOWN",
        }

    headers = rows[0]

    for row in rows[1:]:

        row_data = dict(
            zip(
                headers,
                row,
            )
        )

        if (
            row_data.get("Catalog ID")
            == catalog_id
        ):

            return {
                "finish": row_data.get(
                    "Default Finish",
                    "UNKNOWN",
                ),

                "budget": row_data.get(
                    "Default Budget",
                    "UNKNOWN",
                ),
            }

    return {
        "finish": "UNKNOWN",
        "budget": "UNKNOWN",
    }


# ============================================================
# GET PRODUCT OVERRIDES
# ============================================================

def get_product_overrides(
    sheets_service,
    spreadsheet_id,
    product_id,
):
    """
    Read one product's existing information
    from MASTER.
    """

    response = (
        sheets_service
        .spreadsheets()
        .values()
        .get(
            spreadsheetId=spreadsheet_id,
            range=f"'{PRODUCT_SHEET_NAME}'!A:AU",
        )
        .execute()
    )

    rows = response.get(
        "values",
        [],
    )

    if not rows:
        return {}

    headers = rows[0]

    for row in rows[1:]:

        row_data = dict(
            zip(
                headers,
                row,
            )
        )

        if (
            row_data.get("Product ID")
            == product_id
        ):

            return row_data

    return {}


# ============================================================
# UPDATE CELL
# ============================================================

def update_cell(
    sheets_service,
    spreadsheet_id,
    sheet_name,
    cell_range,
    value,
):
    """
    Update one Google Sheet cell.
    """

    (
        sheets_service
        .spreadsheets()
        .values()
        .update(
            spreadsheetId=spreadsheet_id,
            range=f"{sheet_name}!{cell_range}",
            valueInputOption="RAW",
            body={
                "values": [
                    [value]
                ]
            },
        )
        .execute()
    )


# ============================================================
# UPDATE PRODUCT RESOLVED ATTRIBUTES
# ============================================================

def update_product_resolved_attributes(
    sheets_service,
    spreadsheet_id,
    row_number,
    resolved_finish,
    finish_source,
    resolved_budget,
    budget_source,
):
    """
    Update resolved Finish/Budget fields.

    MASTER column positions:

    P = Finish Source
    Q = Resolved Finish
    S = Budget Source
    T = Resolved Budget
    """

    range_name = (
        f"'{PRODUCT_SHEET_NAME}'!P{row_number}:T{row_number}"
    )

    values = [
        [
            finish_source,
            resolved_finish,
            "",
            budget_source,
            resolved_budget,
        ]
    ]

    (
        sheets_service
        .spreadsheets()
        .values()
        .update(
            spreadsheetId=spreadsheet_id,
            range=range_name,
            valueInputOption="RAW",
            body={
                "values": values
            },
        )
        .execute()
    )


# ============================================================
# LEGACY append_row
# ============================================================

def append_row(
    sheets_service,
    spreadsheet_id,
    row,
):
    """
    Kept for compatibility with older test scripts.

    New pipeline should use:
        append_brand()
        append_catalog()
        append_product()
    """

    (
        sheets_service
        .spreadsheets()
        .values()
        .append(
            spreadsheetId=spreadsheet_id,
            range=f"'{PRODUCT_SHEET_NAME}'!A:ZZ",
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
def read_sheet_records(
    sheets_service,
    spreadsheet_id,
    sheet_name="MASTER",
    start_column="A",
    end_column="BS",
    start_row=1,
    end_row=1000,
):
    """
    Read records from Google Sheets.

    Automatically finds the requested sheet tab
    using case-insensitive and whitespace-insensitive matching.

    Example:
        MASTER
        master
        MASTER 
        master

    are treated as the same sheet name.
    """

    # ------------------------------------------------------------
    # GET ALL SHEET TAB NAMES
    # ------------------------------------------------------------

    metadata = (
        sheets_service
        .spreadsheets()
        .get(
            spreadsheetId=spreadsheet_id,
            fields="sheets(properties(title))",
        )
        .execute()
    )

    sheets = metadata.get("sheets", [])

    requested_name = str(sheet_name).strip().lower()

    actual_sheet_name = None

    for sheet in sheets:

        title = sheet["properties"]["title"]

        if title.strip().lower() == requested_name:
            actual_sheet_name = title
            break

    # ------------------------------------------------------------
    # SHEET NOT FOUND
    # ------------------------------------------------------------

    if actual_sheet_name is None:

        available_sheets = [
            sheet["properties"]["title"]
            for sheet in sheets
        ]

        raise ValueError(
            "\nGoogle Sheet tab not found.\n"
            f"Requested tab: {sheet_name!r}\n"
            f"Available tabs: {available_sheets}\n\n"
            "Rename your Google Sheet tab to MASTER."
        )

    # ------------------------------------------------------------
    # BUILD RANGE
    # ------------------------------------------------------------

    range_name = (
        f"'{actual_sheet_name}'!"
        f"{start_column}{start_row}:"
        f"{end_column}{end_row}"
    )

    print(
        f"Reading Google Sheet range: {range_name}"
    )

    # ------------------------------------------------------------
    # READ GOOGLE SHEETS
    # ------------------------------------------------------------

    response = (
        sheets_service
        .spreadsheets()
        .values()
        .get(
            spreadsheetId=spreadsheet_id,
            range=range_name,
        )
        .execute()
    )

    values = response.get("values", [])

    if not values:
        return []

    # ------------------------------------------------------------
    # FIRST ROW = HEADERS
    # ------------------------------------------------------------

    headers = values[0]

    records = []

    # ------------------------------------------------------------
    # CONVERT ROWS TO DICTIONARIES
    # ------------------------------------------------------------

    for row in values[1:]:

        # Make row same length as headers
        if len(row) < len(headers):

            row = row + [
                ""
            ] * (
                len(headers) - len(row)
            )

        record = {}

        for index, header in enumerate(headers):

            key = str(header).strip()

            if not key:
                continue

            record[key] = row[index]

        records.append(record)

    return records