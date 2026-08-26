from pathlib import Path

from google_services import (
    get_drive_service,
    get_sheets_service,
    get_or_create_folder,
    upload_file,
    append_row
)


# ==========================================
# CONFIGURATION
# ==========================================

SPREADSHEET_ID = "1y4Ix3erUgmkefN50BFkd-nomAwZyngU7rOCa3Nk1ulI"

DRIVE_FOLDER_NAME = "Catalog Images"

TEST_IMAGE = None


# ==========================================
# MAIN TEST
# ==========================================

def main():

    print("Starting V2 Google Drive + Sheets test...")

    # Connect to Google
    drive_service = get_drive_service()
    sheets_service = get_sheets_service()

    print("Google services connected.")

    # Create/find Drive folder
    folder_id = get_or_create_folder(
        drive_service,
        DRIVE_FOLDER_NAME
    )

    print(
        f"Google Drive folder ready: {folder_id}"
    )

    # Find a WebP image from V1 output
    webp_files = list(
        Path("output").rglob("*.webp")
    )

    if not webp_files:

        print(
            "No WebP images found in output/."
        )

        print(
            "Run V1 first and generate at least "
            "one WebP image."
        )

        return

    image_path = webp_files[0]

    print(
        f"Uploading: {image_path}"
    )

    # Upload WebP
    uploaded = upload_file(
        drive_service,
        image_path,
        folder_id
    )

    print(
        "Image uploaded successfully."
    )

    print(
        f"Drive file ID: {uploaded['id']}"
    )

    print(
        f"Drive URL: "
        f"{uploaded.get('webViewLink')}"
    )

    # Get catalog name
    catalog_name = image_path.parent.parent.name

    # Get page number from filename
    page_number = ""

    filename_parts = image_path.stem.split("_")

    if "page" in filename_parts:

        page_index = filename_parts.index("page")

        if page_index + 1 < len(filename_parts):

            page_number = filename_parts[
                page_index + 1
            ]

    # Add row to Google Sheet
    row = [
        catalog_name,
        "",
        "",
        "",
        "",
        page_number,
        image_path.name,
        uploaded.get("webViewLink", "")
    ]

    append_row(
        sheets_service,
        SPREADSHEET_ID,
        row
    )

    print(
        "Google Sheets row added successfully."
    )

    print("")
    print("======================================")
    print("V2 TEST PASSED")
    print("======================================")


if __name__ == "__main__":
    main()