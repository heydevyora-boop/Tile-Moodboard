"""
test_visualization_drive_service.py

Offline test for visualization_drive_service.py.

No real Google Drive request is made.

The Drive module functions are replaced with fakes so the
folder hierarchy, file upload flow, metadata generation and
registry update can be tested without network access.
"""

from pathlib import Path
import tempfile

from app import visualization_drive_service as service


# ============================================================
# FAKE DRIVE
# ============================================================

class FakeDrive:
    pass


# ============================================================
# FAKE DRIVE FUNCTIONS
# ============================================================

def fake_get_drive_service():
    return FakeDrive()


def fake_get_or_create_folder(
    drive,
    folder_name,
    parent_id,
):
    """
    Return deterministic fake folder IDs.
    """

    safe_name = (
        str(folder_name)
        .replace(" ", "_")
        .upper()
    )

    return (
        f"FAKE_FOLDER_"
        f"{safe_name}_"
        f"{parent_id}"
    )


def fake_upload_file_to_folder(
    file_path,
    folder_id,
    filename=None,
):
    """
    Simulates a successful Google Drive upload.
    """

    path = Path(
        file_path
    )

    return {
        "id": (
            f"FAKE_FILE_"
            f"{path.stem.upper()}"
        ),
        "name": (
            filename
            or path.name
        ),
        "webViewLink": (
            "https://drive.google.com/"
            f"file/d/FAKE_FILE_{path.stem.upper()}"
        ),
        "parents": [
            folder_id
        ],
    }


# ============================================================
# MAIN TEST
# ============================================================

def main():

    print("")
    print("=" * 70)
    print(
        "VISUALIZATION DRIVE SERVICE TEST"
    )
    print("=" * 70)

    with tempfile.TemporaryDirectory() as temp_dir:

        temp = Path(
            temp_dir
        )

        # ----------------------------------------------------
        # Create fake applied image
        # ----------------------------------------------------

        applied_image = (
            temp
            / "TEST-P001_floor.png"
        )

        # File content is sufficient because the Drive layer
        # only needs to prove that the generated file exists.
        applied_image.write_bytes(
            b"FAKE_APPLIED_IMAGE"
        )

        print("")
        print(
            "1. Fake applied image created."
        )

        print(
            applied_image
        )

        # ----------------------------------------------------
        # Create registry record
        # ----------------------------------------------------

        record = {
            "visualization_id": (
                "VIZ_TEST_001"
            ),

            "scene_id": (
                "SCENE_TEST_001"
            ),

            "product_id": (
                "TEST-P001"
            ),

            "product_name": (
                "Test Marble Tile"
            ),

            "surface": "FLOOR",

            "source_scene_image": (
                "input/bathroom.png"
            ),

            "tile_image": (
                "output/crops/"
                "001_TEST-P001.png"
            ),

            "applied_image": str(
                applied_image
            ),

            "model": (
                "gemini-3.1-flash-image"
            ),

            "status": "GENERATED",
        }

        # ----------------------------------------------------
        # Patch existing Drive infrastructure
        # ----------------------------------------------------

        original_get_drive_service = (
            service.drive_folders
            .get_drive_service
        )

        original_get_or_create_folder = (
            service.drive_folders
            .get_or_create_folder
        )

        original_upload_file = (
            service.drive_folders
            .upload_file_to_folder
        )

        original_root_folder_id = (
            getattr(
                service.drive_folders,
                "ROOT_FOLDER_ID",
                "",
            )
        )

        original_update_registry = (
            service.update_visualization_status
        )

        try:

            service.drive_folders.get_drive_service = (
                fake_get_drive_service
            )

            service.drive_folders.get_or_create_folder = (
                fake_get_or_create_folder
            )

            service.drive_folders.upload_file_to_folder = (
                fake_upload_file_to_folder
            )

            service.drive_folders.ROOT_FOLDER_ID = (
                "FAKE_ROOT_FOLDER"
            )

            # Prevent this test from requiring the real
            # persistent registry.
            service.update_visualization_status = (
                lambda **kwargs: {
                    "visualization_id": kwargs[
                        "visualization_id"
                    ],
                    "status": kwargs[
                        "status"
                    ],
                    "drive_file_id": kwargs[
                        "drive_file_id"
                    ],
                    "drive_url": kwargs[
                        "drive_url"
                    ],
                }
            )

            # ------------------------------------------------
            # 2. Folder hierarchy
            # ------------------------------------------------

            print("")
            print(
                "2. Checking Drive folder hierarchy..."
            )

            folders = (
                service.ensure_visualization_drive_folder(
                    scene_id="SCENE_TEST_001",
                    product_id="TEST-P001",
                    surface="FLOOR",
                )
            )

            assert folders[
                "generated_root_folder_id"
            ].startswith(
                "FAKE_FOLDER_"
            )

            assert folders[
                "scene_folder_id"
            ]

            assert folders[
                "product_folder_id"
            ]

            assert folders[
                "surface_folder_id"
            ]

            print(
                "[PASS] Drive folder hierarchy."
            )

            # ------------------------------------------------
            # 3. Image upload
            # ------------------------------------------------

            print("")
            print(
                "3. Checking visualization upload..."
            )

            uploaded = (
                service.upload_visualization_to_drive(
                    record,
                    update_registry=True,
                )
            )

            assert (
                uploaded["status"]
                == "UPLOADED"
            )

            assert (
                uploaded["visualization_id"]
                == "VIZ_TEST_001"
            )

            assert (
                uploaded["image"]["file_id"]
            )

            assert (
                uploaded["image"]["webViewLink"]
            )

            print(
                "[PASS] Visualization upload."
            )

            # ------------------------------------------------
            # 4. Metadata upload
            # ------------------------------------------------

            print("")
            print(
                "4. Checking metadata upload..."
            )

            assert (
                uploaded["metadata"][
                    "file_id"
                ]
            )

            assert (
                uploaded["metadata"][
                    "webViewLink"
                ]
            )

            print(
                "[PASS] Metadata upload."
            )

            # ------------------------------------------------
            # 5. Registry update
            # ------------------------------------------------

            print("")
            print(
                "5. Checking registry update..."
            )

            assert (
                uploaded["registry"][
                    "status"
                ]
                == "UPLOADED"
            )

            assert (
                uploaded["registry"][
                    "drive_file_id"
                ]
            )

            assert (
                uploaded["registry"][
                    "drive_url"
                ]
            )

            print(
                "[PASS] Registry update."
            )

            # ------------------------------------------------
            # FINAL
            # ------------------------------------------------

            print("")
            print("=" * 70)
            print(
                "VISUALIZATION DRIVE SERVICE TEST PASSED"
            )
            print("=" * 70)

            print("")
            print(
                "Folder Creation : OK"
            )

            print(
                "Image Upload    : OK"
            )

            print(
                "Metadata Upload : OK"
            )

            print(
                "Drive URL       : OK"
            )

            print(
                "Registry Update : OK"
            )

            print("")
            print(
                "No real Google Drive request was made."
            )

        finally:

            service.drive_folders.get_drive_service = (
                original_get_drive_service
            )

            service.drive_folders.get_or_create_folder = (
                original_get_or_create_folder
            )

            service.drive_folders.upload_file_to_folder = (
                original_upload_file
            )

            service.drive_folders.ROOT_FOLDER_ID = (
                original_root_folder_id
            )

            service.update_visualization_status = (
                original_update_registry
            )


if __name__ == "__main__":
    main()