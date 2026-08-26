import os
import mimetypes
import threading
from pathlib import Path

from dotenv import load_dotenv

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow

from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload


# ============================================================
# ENVIRONMENT
# ============================================================

load_dotenv()


# ============================================================
# PROJECT PATHS
# ============================================================

# Project root:
# catalog_processor/
BASE_DIR = Path(__file__).resolve().parent.parent

CREDENTIALS_FILE = BASE_DIR / "credentials.json"
TOKEN_FILE = BASE_DIR / "token.json"


# ============================================================
# GOOGLE API SCOPES
# ============================================================

SCOPES = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
]


# ============================================================
# GOOGLE AUTHENTICATION + SERVICE CACHE
# ============================================================
#
# IMPORTANT:
#
# Google authentication must happen ONCE per Python process.
#
# The catalog processor can process hundreds of images. Every
# image must NOT reload token.json and rebuild Drive/Sheets
# services.
#
# This module therefore keeps:
#
#     1. OAuth credentials
#     2. Google Drive service
#     3. Google Sheets service
#
# in memory and reuses them for the complete run.
#
# Gemini code does not need to be changed for this fix.
# ============================================================


# ------------------------------------------------------------
# PROCESS-LEVEL GOOGLE CACHE
# ------------------------------------------------------------

_CREDENTIALS_CACHE = None
_DRIVE_SERVICE_CACHE = None
_SHEETS_SERVICE_CACHE = None

# Protect initialization if more than one worker/thread reaches
# Google services at the same time.
_GOOGLE_LOCK = threading.RLock()


# ------------------------------------------------------------
# GOOGLE AUTHENTICATION
# ------------------------------------------------------------

def get_credentials():
    """
    Get valid Google OAuth credentials.

    Authentication is performed only once per Python process.

    Flow:

        1. Return cached credentials if already initialized.
        2. Load existing token.json.
        3. Refresh expired credentials when possible.
        4. If the refresh token is unusable, delete token.json.
        5. Start a new browser OAuth login.
        6. Save token.json.
        7. Cache the credentials for the rest of the run.
    """

    global _CREDENTIALS_CACHE

    # ========================================================
    # FAST PATH
    # ========================================================
    #
    # Most calls during catalog processing should end here.
    # No filesystem access.
    # No OAuth work.
    # No token parsing.
    #

    if (
        _CREDENTIALS_CACHE is not None
        and _CREDENTIALS_CACHE.valid
    ):
        return _CREDENTIALS_CACHE

    # ========================================================
    # INITIALIZE ONLY ONCE
    # ========================================================

    with _GOOGLE_LOCK:

        # Another thread may have initialized the credentials
        # while this thread was waiting for the lock.
        if (
            _CREDENTIALS_CACHE is not None
            and _CREDENTIALS_CACHE.valid
        ):
            return _CREDENTIALS_CACHE

        print()
        print("=" * 60)
        print("GOOGLE AUTHENTICATION - INITIALIZING ONCE")
        print("=" * 60)

        print(
            f"Credentials file: {CREDENTIALS_FILE}"
        )

        print(
            f"Token file      : {TOKEN_FILE}"
        )

        # ----------------------------------------------------
        # CHECK credentials.json
        # ----------------------------------------------------

        if not CREDENTIALS_FILE.exists():

            raise FileNotFoundError(
                "\ncredentials.json not found.\n\n"
                f"Expected location:\n{CREDENTIALS_FILE}\n\n"
                "Download a Desktop OAuth client "
                "credentials.json from Google Cloud Console."
            )

        credentials = None

        # ----------------------------------------------------
        # LOAD EXISTING TOKEN
        # ----------------------------------------------------

        if TOKEN_FILE.exists():

            print()
            print(
                "Existing token.json found."
            )

            try:

                credentials = (
                    Credentials.from_authorized_user_file(
                        str(TOKEN_FILE),
                        SCOPES
                    )
                )

                print(
                    "Existing Google credentials loaded."
                )

            except Exception as error:

                print()
                print(
                    "WARNING: Existing token.json "
                    "could not be loaded."
                )

                print(
                    f"Reason: {error}"
                )

                credentials = None

                try:

                    TOKEN_FILE.unlink()

                    print(
                        "Old token.json deleted."
                    )

                except Exception as delete_error:

                    print(
                        "WARNING: Could not delete token.json: "
                        f"{delete_error}"
                    )

        # ----------------------------------------------------
        # CHECK EXISTING CREDENTIALS
        # ----------------------------------------------------

        if credentials:

            # ------------------------------------------------
            # ALREADY VALID
            # ------------------------------------------------

            if credentials.valid:

                print()
                print(
                    "Google credentials are valid."
                )

                print(
                    "Using existing token."
                )

                _CREDENTIALS_CACHE = credentials

                return _CREDENTIALS_CACHE

            # ------------------------------------------------
            # REFRESH EXPIRED TOKEN
            # ------------------------------------------------

            if (
                credentials.expired
                and credentials.refresh_token
            ):

                print()
                print(
                    "Google token is expired."
                )

                print(
                    "Attempting automatic refresh..."
                )

                try:

                    credentials.refresh(
                        Request()
                    )

                    TOKEN_FILE.write_text(
                        credentials.to_json(),
                        encoding="utf-8"
                    )

                    print(
                        "Google token refreshed successfully."
                    )

                    _CREDENTIALS_CACHE = credentials

                    return _CREDENTIALS_CACHE

                except Exception as error:

                    print()
                    print(
                        "WARNING: Google token refresh failed."
                    )

                    print(
                        f"Reason: {error}"
                    )

                    credentials = None

                    try:

                        TOKEN_FILE.unlink()

                        print(
                            "Old token.json deleted."
                        )

                    except Exception as delete_error:

                        print(
                            "WARNING: Could not delete old token: "
                            f"{delete_error}"
                        )

        # ----------------------------------------------------
        # NEW GOOGLE OAUTH LOGIN
        # ----------------------------------------------------

        print()
        print("=" * 60)
        print("STARTING NEW GOOGLE OAUTH LOGIN")
        print("=" * 60)

        print()
        print(
            "A browser window will open."
        )

        print(
            "Sign in with the Google account that owns "
            "your Drive and Google Sheet."
        )

        try:

            flow = (
                InstalledAppFlow
                .from_client_secrets_file(
                    str(CREDENTIALS_FILE),
                    SCOPES
                )
            )

            credentials = flow.run_local_server(
                host="localhost",
                port=0,
                access_type="offline",
                prompt="consent",
                authorization_prompt_message=(
                    "\nPlease authorize Google access "
                    "in your browser.\n"
                ),
                success_message=(
                    "Google authentication successful. "
                    "You can close this browser window."
                ),
                open_browser=True
            )

        except Exception as error:

            raise RuntimeError(
                "\nGoogle OAuth authentication failed.\n\n"
                f"Error: {error}\n\n"
                "Check that credentials.json is a Desktop "
                "OAuth client credentials file."
            ) from error

        # ----------------------------------------------------
        # SAVE NEW TOKEN
        # ----------------------------------------------------

        try:

            TOKEN_FILE.write_text(
                credentials.to_json(),
                encoding="utf-8"
            )

        except Exception as error:

            raise RuntimeError(
                "Google authentication succeeded, "
                "but token.json could not be saved.\n\n"
                f"Path: {TOKEN_FILE}\n"
                f"Error: {error}"
            ) from error

        print()
        print(
            "New token.json created successfully."
        )

        print(
            f"Saved at: {TOKEN_FILE}"
        )

        print()
        print(
            "Google authentication completed."
        )

        _CREDENTIALS_CACHE = credentials

        return _CREDENTIALS_CACHE


# ============================================================
# DRIVE SERVICE
# ============================================================

def get_drive_service():
    """
    Return the cached Google Drive service.

    The Drive API client is created only once per Python process.
    """

    global _DRIVE_SERVICE_CACHE

    # --------------------------------------------------------
    # FAST PATH
    # --------------------------------------------------------

    if _DRIVE_SERVICE_CACHE is not None:

        return _DRIVE_SERVICE_CACHE

    # --------------------------------------------------------
    # INITIALIZE ONCE
    # --------------------------------------------------------

    with _GOOGLE_LOCK:

        if _DRIVE_SERVICE_CACHE is None:

            print(
                "Initializing Google Drive service..."
            )

            _DRIVE_SERVICE_CACHE = build(
                "drive",
                "v3",
                credentials=get_credentials(),
                cache_discovery=False
            )

            print(
                "Google Drive service ready."
            )

    return _DRIVE_SERVICE_CACHE


# ============================================================
# SHEETS SERVICE
# ============================================================

def get_sheets_service():
    """
    Return the cached Google Sheets service.

    The Sheets API client is created only once per Python process.
    """

    global _SHEETS_SERVICE_CACHE

    # --------------------------------------------------------
    # FAST PATH
    # --------------------------------------------------------

    if _SHEETS_SERVICE_CACHE is not None:

        return _SHEETS_SERVICE_CACHE

    # --------------------------------------------------------
    # INITIALIZE ONCE
    # --------------------------------------------------------

    with _GOOGLE_LOCK:

        if _SHEETS_SERVICE_CACHE is None:

            print(
                "Initializing Google Sheets service..."
            )

            _SHEETS_SERVICE_CACHE = build(
                "sheets",
                "v4",
                credentials=get_credentials(),
                cache_discovery=False
            )

            print(
                "Google Sheets service ready."
            )

    return _SHEETS_SERVICE_CACHE


# ============================================================
# GOOGLE DRIVE ROOT FOLDER
# ============================================================

def get_drive_root_folder_id():

    root_folder_id = os.getenv(
        "GOOGLE_DRIVE_ROOT_FOLDER_ID"
    )

    if not root_folder_id:

        raise RuntimeError(
            "GOOGLE_DRIVE_ROOT_FOLDER_ID is missing "
            "from .env"
        )

    return root_folder_id.strip()


# ============================================================
# GOOGLE SHEET ID
# ============================================================

def get_google_sheet_id():

    spreadsheet_id = os.getenv(
        "GOOGLE_SHEET_ID"
    )

    if not spreadsheet_id:

        raise RuntimeError(
            "GOOGLE_SHEET_ID is missing from .env"
        )

    return spreadsheet_id.strip()


# ============================================================
# FIND OR CREATE DRIVE FOLDER
# ============================================================

def find_or_create_folder(
    drive_service,
    folder_name,
    parent_id
):

    folder_name = (
        str(folder_name).strip()
        if folder_name
        else "Unknown"
    )

    parent_id = str(parent_id).strip()

    # Google Drive query escaping
    safe_name = folder_name.replace(
        "\\",
        "\\\\"
    ).replace(
        "'",
        "\\'"
    )

    query = (
        f"name = '{safe_name}' "
        "and mimeType = "
        "'application/vnd.google-apps.folder' "
        f"and '{parent_id}' in parents "
        "and trashed = false"
    )

    response = (
        drive_service.files()
        .list(
            q=query,
            spaces="drive",
            fields="files(id,name)",
            pageSize=100
        )
        .execute()
    )

    folders = response.get(
        "files",
        []
    )

    if folders:

        return folders[0]["id"]

    # --------------------------------------------------------
    # CREATE FOLDER
    # --------------------------------------------------------

    metadata = {
        "name": folder_name,
        "mimeType": (
            "application/vnd.google-apps.folder"
        ),
        "parents": [
            parent_id
        ],
    }

    folder = (
        drive_service.files()
        .create(
            body=metadata,
            fields="id,name"
        )
        .execute()
    )

    return folder["id"]


# ============================================================
# UPLOAD PRODUCT IMAGE
# ============================================================

def upload_product_image(
    image_path,
    brand,
    product_name
):

    image_path = Path(
        image_path
    )

    if not image_path.exists():

        raise FileNotFoundError(
            f"Image not found: {image_path}"
        )

    if not image_path.is_file():

        raise ValueError(
            f"Image path is not a file: {image_path}"
        )

    drive_service = get_drive_service()

    root_folder_id = get_drive_root_folder_id()

    brand = (
        str(brand).strip()
        if brand
        else "Unknown Brand"
    )

    product_name = (
        str(product_name).strip()
        if product_name
        else image_path.stem
    )

    # --------------------------------------------------------
    # BRAND FOLDER
    # --------------------------------------------------------

    brand_folder_id = find_or_create_folder(
        drive_service,
        brand,
        root_folder_id
    )

    # --------------------------------------------------------
    # PRODUCT FOLDER
    # --------------------------------------------------------

    product_folder_id = find_or_create_folder(
        drive_service,
        product_name,
        brand_folder_id
    )

    # --------------------------------------------------------
    # CHECK DUPLICATE FILENAME
    # --------------------------------------------------------

    filename = image_path.name

    safe_filename = filename.replace(
        "\\",
        "\\\\"
    ).replace(
        "'",
        "\\'"
    )

    query = (
        f"name = '{safe_filename}' "
        f"and '{product_folder_id}' in parents "
        "and trashed = false"
    )

    existing = (
        drive_service.files()
        .list(
            q=query,
            spaces="drive",
            fields="files(id,name,webViewLink)",
            pageSize=100
        )
        .execute()
    )

    existing_files = existing.get(
        "files",
        []
    )

    if existing_files:

        existing_file = existing_files[0]

        return {
            "file_id": existing_file["id"],
            "name": existing_file["name"],
            "url": existing_file.get(
                "webViewLink",
                ""
            ),
            "duplicate": True,
        }

    # --------------------------------------------------------
    # DETERMINE MIME TYPE
    # --------------------------------------------------------

    mime_type, _ = mimetypes.guess_type(
        str(image_path)
    )

    if not mime_type:

        mime_type = "application/octet-stream"

    # --------------------------------------------------------
    # UPLOAD
    # --------------------------------------------------------

    metadata = {
        "name": filename,
        "parents": [
            product_folder_id
        ],
    }

    media = MediaFileUpload(
        str(image_path),
        mimetype=mime_type,
        resumable=True
    )

    uploaded = (
        drive_service.files()
        .create(
            body=metadata,
            media_body=media,
            fields="id,name,webViewLink"
        )
        .execute()
    )

    # --------------------------------------------------------
    # PUBLIC VIEW PERMISSION
    # --------------------------------------------------------

    try:

        drive_service.permissions().create(
            fileId=uploaded["id"],
            body={
                "type": "anyone",
                "role": "reader"
            },
            fields="id"
        ).execute()

    except Exception as error:

        print()
        print(
            "WARNING: Could not create public "
            "Drive permission."
        )

        print(
            f"Reason: {error}"
        )

    # --------------------------------------------------------
    # GET FINAL FILE INFORMATION
    # --------------------------------------------------------

    file_info = (
        drive_service.files()
        .get(
            fileId=uploaded["id"],
            fields=(
                "id,"
                "name,"
                "webViewLink,"
                "webContentLink"
            )
        )
        .execute()
    )

    return {
        "file_id": file_info["id"],
        "name": file_info["name"],
        "url": file_info.get(
            "webViewLink",
            ""
        ),
        "web_content_url": file_info.get(
            "webContentLink",
            ""
        ),
        "duplicate": False,
    }


# ============================================================
# GOOGLE SHEETS
# ============================================================

def get_sheet_name():

    return os.getenv(
        "GOOGLE_SHEET_NAME",
        "Products"
    ).strip()


# ============================================================
# APPEND PRODUCT ROW
# ============================================================

def append_product_row(
    product_id,
    pdf_name,
    tile_name,
    brand,
    page_number,
    drive_url,
    confidence,
    status
):

    sheets_service = get_sheets_service()

    spreadsheet_id = get_google_sheet_id()

    sheet_name = get_sheet_name()

    # --------------------------------------------------------
    # NORMALIZE CONFIDENCE
    # --------------------------------------------------------

    try:

        confidence_value = round(
            float(confidence or 0),
            4
        )

    except (
        TypeError,
        ValueError
    ):

        confidence_value = 0.0

    # --------------------------------------------------------
    # BUILD ROW
    # --------------------------------------------------------

    row = [[
        product_id or "",
        pdf_name or "",
        tile_name or "",
        brand or "",
        page_number or "",
        drive_url or "",
        confidence_value,
        status or "",
    ]]

    body = {
        "values": row
    }

    # --------------------------------------------------------
    # APPEND
    # --------------------------------------------------------

    (
        sheets_service
        .spreadsheets()
        .values()
        .append(
            spreadsheetId=spreadsheet_id,
            range=f"{sheet_name}!A:H",
            valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS",
            body=body
        )
        .execute()
    )

    return True


# ============================================================
# GOOGLE SHEETS CONNECTION TEST
# ============================================================

def test_sheets_connection():

    sheets_service = get_sheets_service()

    spreadsheet_id = get_google_sheet_id()

    response = (
        sheets_service
        .spreadsheets()
        .get(
            spreadsheetId=spreadsheet_id,
            fields="spreadsheetId,properties(title)"
        )
        .execute()
    )

    title = (
        response
        .get("properties", {})
        .get("title", "")
    )

    print()
    print(
        f"Google Sheets connected: {title}"
    )

    return True


# ============================================================
# GOOGLE DRIVE CONNECTION TEST
# ============================================================

def test_drive_connection():

    drive_service = get_drive_service()

    root_folder_id = get_drive_root_folder_id()

    response = (
        drive_service.files()
        .get(
            fileId=root_folder_id,
            fields="id,name,mimeType"
        )
        .execute()
    )

    print()
    print(
        "Google Drive connected:"
    )

    print(
        f"Folder: {response.get('name', '')}"
    )

    print(
        f"ID: {response.get('id', '')}"
    )

    return True


# ============================================================
# TEST BOTH SERVICES
# ============================================================

def test_google_connection():

    print()
    print("=" * 60)
    print("GOOGLE DRIVE + SHEETS CONNECTION TEST")
    print("=" * 60)

    test_drive_connection()

    test_sheets_connection()

    print()
    print("=" * 60)
    print("GOOGLE CONNECTION TEST SUCCESSFUL")
    print("=" * 60)


# ============================================================
# MAIN TEST
# ============================================================

if __name__ == "__main__":

    test_google_connection()