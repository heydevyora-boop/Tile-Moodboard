from app.drive_sheets import (
    get_drive_service,
    get_sheets_service
)


def main():

    print("=" * 60)
    print("GOOGLE DRIVE + SHEETS TEST")
    print("=" * 60)

    try:

        drive = get_drive_service()

        drive.about().get(
            fields="user"
        ).execute()

        print("Google Drive: CONNECTED")

    except Exception as error:

        print(
            f"Google Drive: FAILED\n{error}"
        )

        return

    try:

        sheets = get_sheets_service()

        print(
            "Google Sheets: CONNECTED"
        )

    except Exception as error:

        print(
            f"Google Sheets: FAILED\n{error}"
        )

        return

    print()
    print("GOOGLE SERVICES READY")


if __name__ == "__main__":
    main()