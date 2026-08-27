# ============================================================
# GOOGLE DRIVE FOLDER MANAGER
# ============================================================
#
# Pen Drive = SOURCE OF TRUTH
#
# Pen Drive:
#   Brand/
#       Collection.pdf
#
# Google Drive:
#   ROOT/
#       Brand/
#           Collection/
#               image_1
#               image_2
#               image_3
#
# No brand names are hardcoded.
# No collection/catalog names are hardcoded.
#
# ============================================================

from pathlib import Path
from typing import Any, Dict, Optional

from googleapiclient.discovery import build
from google.oauth2 import service_account
from googleapiclient.http import MediaFileUpload


# ============================================================
# CONFIGURATION
# ============================================================

SCOPES = [
    "https://www.googleapis.com/auth/drive"
]


# ------------------------------------------------------------
# SERVICE ACCOUNT
# ------------------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parent.parent

SERVICE_ACCOUNT_FILE = (
    PROJECT_ROOT / "credentials.json"
)


# ------------------------------------------------------------
# GOOGLE DRIVE ROOT FOLDER
# ------------------------------------------------------------

ROOT_FOLDER_ID = (
    "1Dscf5u6HHSFb3M9hFpsN97_eTFaFSAIJ"
)


# ============================================================
# DRIVE SERVICE
# ============================================================

def get_drive_service():
    """
    Create and return an authenticated Google Drive service.
    """

    if not SERVICE_ACCOUNT_FILE.exists():
        raise FileNotFoundError(
            "Google service account credentials not found: "
            f"{SERVICE_ACCOUNT_FILE}"
        )

    credentials = (
        service_account.Credentials
        .from_service_account_file(
            str(SERVICE_ACCOUNT_FILE),
            scopes=SCOPES
        )
    )

    return build(
        "drive",
        "v3",
        credentials=credentials,
        cache_discovery=False
    )


# ============================================================
# CLEAN FOLDER NAME
# ============================================================

def clean_folder_name(
    name: str
) -> str:
    """
    Normalize folder names.

    Removes whitespace and accidental .pdf extension.
    """

    if not name:
        return "Unknown"

    name = str(name).strip()

    if name.lower().endswith(".pdf"):
        name = name[:-4].strip()

    return name


# ============================================================
# FIND EXISTING FOLDER
# ============================================================

def find_folder(
    name: str,
    parent_id: str,
    drive=None
) -> Optional[Dict[str, Any]]:
    """
    Find an existing Google Drive folder with the requested
    name directly inside parent_id.
    """

    if drive is None:
        drive = get_drive_service()

    if not name:
        return None

    if not parent_id:
        raise ValueError(
            "parent_id is required when searching for a folder"
        )

    target_name = clean_folder_name(name)
    
    # Escape single quotes in folder names to avoid API syntax errors
    safe_target_name = target_name.replace("'", "\\'")

    query = (
        f"'{parent_id}' in parents and "
        f"name = '{safe_target_name}' and "
        f"mimeType = 'application/vnd.google-apps.folder' and "
        f"trashed = false"
    )

    page_token = None

    while True:
        response = (
            drive.files()
            .list(
                q=query,
                spaces="drive",
                fields="nextPageToken, files(id, name, mimeType, parents)",
                pageSize=100,
                pageToken=page_token,
                # Required to see items inside a Shared Drive -- the
                # service account has no personal Drive quota, so
                # ROOT_FOLDER_ID must live in a Shared Drive, and
                # without these flags the API silently excludes it.
                supportsAllDrives=True,
                includeItemsFromAllDrives=True
            )
            .execute()
        )

        folders = response.get("files", [])

        for folder in folders:
            existing_name = clean_folder_name(folder.get("name", ""))
            if existing_name == target_name:
                return folder

        page_token = response.get("nextPageToken")
        if not page_token:
            break

    return None


# ============================================================
# CREATE FOLDER
# ============================================================

def create_folder(
    drive,
    folder_name: str,
    parent_id: str
):
    """
    Create a Google Drive folder inside parent_id.
    """

    folder_name = clean_folder_name(folder_name)

    metadata = {
        "name": folder_name,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": [parent_id]
    }

    folder = (
        drive.files()
        .create(
            body=metadata,
            fields="id,name,parents",
            supportsAllDrives=True
        )
        .execute()
    )

    return folder


# ============================================================
# GET OR CREATE FOLDER
# ============================================================

def get_or_create_folder(
    drive,
    folder_name: str,
    parent_id: str
):
    """
    Return an existing folder or create it.
    """

    existing = find_folder(
        folder_name,
        parent_id,
        drive
    )

    if existing:
        print(f"  Drive folder exists: {existing['name']}")
        return existing

    created = create_folder(
        drive,
        folder_name,
        parent_id
    )

    print(f"  Drive folder created: {created['name']}")
    return created


# ============================================================
# BRAND FOLDER
# ============================================================

def get_or_create_brand_folder(
    brand_name: str,
    root_folder_id: str = None
) -> Dict[str, str]:
    """
    Create or reuse:
    ROOT -> BRAND
    """

    drive = get_drive_service()
    root_id = root_folder_id or ROOT_FOLDER_ID

    if not root_id or root_id.startswith("PASTE_"):
        raise ValueError("GOOGLE DRIVE ROOT_FOLDER_ID is not configured.")

    brand_name = clean_folder_name(brand_name)

    brand_folder = get_or_create_folder(
        drive,
        brand_name,
        root_id
    )

    return {
        "brand_name": brand_name,
        "brand_folder_id": brand_folder["id"]
    }


# ============================================================
# CATALOG FOLDER
# ============================================================

def get_or_create_catalog_folder(
    catalog_name: str,
    brand_folder_id: str
) -> Dict[str, str]:
    """
    Create or reuse:
    BRAND -> CATALOG
    """

    drive = get_drive_service()

    if not brand_folder_id:
        raise ValueError("brand_folder_id is required.")

    catalog_name = clean_folder_name(catalog_name)

    catalog_folder = get_or_create_folder(
        drive,
        catalog_name,
        brand_folder_id
    )

    return {
        "catalog_name": catalog_name,
        "catalog_folder_id": catalog_folder["id"]
    }


# ============================================================
# BUILD COMPLETE CATALOG STRUCTURE
# ============================================================

def get_or_create_catalog_structure(
    brand_name: str,
    catalog_name: str,
    root_folder_id: str = None
) -> Dict[str, str]:
    """
    Creates/reuses the complete Google Drive structure:
    ROOT -> BRAND -> CATALOG -> IMAGES
    """

    drive = get_drive_service()
    root_id = root_folder_id or ROOT_FOLDER_ID

    if not root_id or root_id.startswith("PASTE_"):
        raise ValueError("GOOGLE DRIVE ROOT_FOLDER_ID is not configured.")

    brand_name = clean_folder_name(brand_name)
    catalog_name = clean_folder_name(catalog_name)

    print("\n==============================================")
    print("GOOGLE DRIVE FOLDER STRUCTURE")
    print("==============================================")
    print(f"Brand   : {brand_name}")
    print(f"Catalog : {catalog_name}")
    print(f"Root ID : {root_id}")

    brand_folder = get_or_create_folder(
        drive,
        brand_name,
        root_id
    )
    brand_folder_id = brand_folder["id"]

    catalog_folder = get_or_create_folder(
        drive,
        catalog_name,
        brand_folder_id
    )
    catalog_folder_id = catalog_folder["id"]

    result = {
        "brand_name": brand_name,
        "catalog_name": catalog_name,
        "brand_folder_id": brand_folder_id,
        "catalog_folder_id": catalog_folder_id
    }

    print("\nDrive structure ready.")
    print(f"Brand Folder ID   : {brand_folder_id}")
    print(f"Catalog Folder ID : {catalog_folder_id}")

    print("\nFINAL DRIVE HIERARCHY:")
    print("ROOT")
    print(f"  └── {brand_name}")
    print(f"      └── {catalog_name}")
    print("          └── IMAGES")

    return result


# ============================================================
# UPLOAD FILE TO FOLDER
# ============================================================

def upload_file_to_folder(
    file_path,
    folder_id: str,
    filename: str = None
):
    """
    Upload a file directly into the supplied folder.
    """

    drive = get_drive_service()
    file_path = Path(file_path)

    if not file_path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")

    if not folder_id:
        raise ValueError("folder_id is required for upload.")

    metadata = {
        "name": filename or file_path.name,
        "parents": [folder_id]
    }

    media = MediaFileUpload(
        str(file_path),
        resumable=True
    )

    uploaded = (
        drive.files()
        .create(
            body=metadata,
            media_body=media,
            fields="id, name, webViewLink, parents",
            supportsAllDrives=True
        )
        .execute()
    )

    print("\n  Drive upload successful:")
    print(f"  File : {uploaded.get('name', '')}")
    print(f"  ID   : {uploaded.get('id', '')}")

    return uploaded


# ============================================================
# UPLOAD IMAGE TO CATALOG
# ============================================================

def upload_image_to_catalog(
    file_path,
    catalog_folder_id: str,
    filename: str = None
):
    """
    Convenience function for uploading an image directly into the Catalog folder.
    """

    return upload_file_to_folder(
        file_path=file_path,
        folder_id=catalog_folder_id,
        filename=filename
    )


# ============================================================
# TEST
# ============================================================

if __name__ == "__main__":
    print("Drive folder manager loaded successfully.")
    print("\nExpected hierarchy:")
    print("ROOT/\n  Brand/\n    Catalog/\n      image_1\n      image_2\n      image_3")