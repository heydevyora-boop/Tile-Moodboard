import ctypes
import os
import time

# main_step6_complete.py resolves .env and OUTPUT_DIR relative to the
# current working directory, which is unpredictable when this agent is
# launched by double-click, a desktop shortcut, or Task Scheduler (rather
# than from a terminal already sitting in catalog_processor/). Anchoring
# cwd to this script's own directory makes the agent work the same way
# no matter how it's started.
os.chdir(os.path.dirname(os.path.abspath(__file__)))

from main_step6_complete import process_drive


DRIVE_REMOVABLE = 2


def get_removable_drives():

    drives = []

    for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":

        drive = f"{letter}:\\"

        drive_type = ctypes.windll.kernel32.GetDriveTypeW(
            drive
        )

        if drive_type == DRIVE_REMOVABLE:

            drives.append(drive)

    return drives


def run_agent():

    print("Catalog Agent started.")

    print("Waiting for USB...")

    known_drives = set(
        get_removable_drives()
    )

    while True:

        time.sleep(2)

        current_drives = set(
            get_removable_drives()
        )

        new_drives = (
            current_drives - known_drives
        )

        for drive in new_drives:

            print(
                f"USB detected: {drive}"
            )

            try:

                process_drive(drive)

            except Exception as exc:

                print(
                    f"Processing failed: {exc}"
                )

        known_drives = current_drives


if __name__ == "__main__":

    run_agent()