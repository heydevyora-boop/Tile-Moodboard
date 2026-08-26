from google_services import (
    get_drive_service,
    get_sheets_service
)


print("Starting Google connection test...")

try:
    # Connect to Google Drive
    drive_service = get_drive_service()

    drive_service.files().list(
        pageSize=1,
        fields="files(id,name)"
    ).execute()

    print("Google Drive API: CONNECTED")

    # Connect to Google Sheets
    sheets_service = get_sheets_service()

    test_sheet = sheets_service.spreadsheets().create(
        body={
            "properties": {
                "title": "Catalog Automation Connection Test"
            }
        },
        fields="spreadsheetId,spreadsheetUrl"
    ).execute()

    spreadsheet_id = test_sheet["spreadsheetId"]
    spreadsheet_url = test_sheet["spreadsheetUrl"]

    print("Google Sheets API: CONNECTED")
    print("Test spreadsheet created successfully.")
    print("Spreadsheet ID:", spreadsheet_id)
    print("Spreadsheet URL:", spreadsheet_url)

    # Delete the temporary test spreadsheet
    drive_service.files().delete(
        fileId=spreadsheet_id
    ).execute()

    print("Temporary test spreadsheet deleted.")
    print("")
    print("====================================")
    print("GOOGLE CONNECTION TEST PASSED")
    print("====================================")

except Exception as error:

    print("")
    print("====================================")
    print("GOOGLE CONNECTION TEST FAILED")
    print("====================================")
    print(error)