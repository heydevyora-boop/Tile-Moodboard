import os
from pathlib import Path

from dotenv import load_dotenv


load_dotenv()


def check_environment():

    print()
    print("=" * 60)
    print("PRODUCTION CONFIGURATION CHECK")
    print("=" * 60)

    required_variables = [

        "GEMINI_API_KEY",

        "GOOGLE_SHEET_ID",

        "GOOGLE_DRIVE_ROOT_FOLDER_ID",

        "PENDRIVE_ROOT",
    ]

    valid = True

    for variable in required_variables:

        value = os.getenv(
            variable
        )

        if not value:

            print(
                f"[FAIL] {variable}"
            )

            valid = False

        else:

            print(
                f"[OK] {variable}"
            )

    pendrive_root = Path(
        os.getenv(
            "PENDRIVE_ROOT",
            ""
        )
    )

    print()

    if pendrive_root.exists():

        print(
            f"[OK] Pendrive: "
            f"{pendrive_root}"
        )

    else:

        print(
            f"[FAIL] Pendrive not found: "
            f"{pendrive_root}"
        )

        valid = False

    print()

    if valid:

        print(
            "Configuration check PASSED."
        )

    else:

        print(
            "Configuration check FAILED."
        )

    return valid


if __name__ == "__main__":

    check_environment()