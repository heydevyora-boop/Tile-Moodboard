from pathlib import Path
import tempfile

from app import scene_image_generator


def main():

    print("")
    print("=" * 70)
    print("SCENE DRIVE UPLOAD TEST")
    print("=" * 70)

    scene_id = "SCENE_0FA99DBC"

    # --------------------------------------------------------
    # Create a temporary fake image file
    # --------------------------------------------------------

    with tempfile.TemporaryDirectory() as temp_dir:

        temp_dir = Path(temp_dir)

        fake_image = (
            temp_dir /
            "front_test.png"
        )

        # Small valid PNG file.
        # This is only a storage test.
        png_bytes = bytes.fromhex(
            "89504E470D0A1A0A"
            "0000000D49484452"
            "0000000100000001"
            "08060000001F15C489"
            "0000000D49444154"
            "789C636000000002"
            "0001E221BC33"
            "0000000049454E44"
            "AE426082"
        )

        fake_image.write_bytes(
            png_bytes
        )

        print("")
        print(
            "1. Fake image created"
        )

        print(
            f"   {fake_image}"
        )

        # ----------------------------------------------------
        # Upload to Google Drive
        # ----------------------------------------------------

        print("")
        print(
            "2. Uploading to Google Drive..."
        )

        result = (
            scene_image_generator
            .upload_scene_image_to_drive(
                scene_id=scene_id,
                image_path=fake_image
            )
        )

        # ----------------------------------------------------
        # Validate response
        # ----------------------------------------------------

        file_id = result.get(
            "file_id"
        )

        drive_url = result.get(
            "webViewLink"
        )

        folder_id = result.get(
            "folder_id"
        )

        if not file_id:
            raise RuntimeError(
                "Drive upload returned no file ID."
            )

        if not folder_id:
            raise RuntimeError(
                "Drive upload returned no folder ID."
            )

        if not drive_url:
            raise RuntimeError(
                "Drive upload returned no Drive URL."
            )

        # ----------------------------------------------------
        # Success
        # ----------------------------------------------------

        print("")
        print(
            "3. DRIVE UPLOAD SUCCESS"
        )

        print(
            f"   Scene ID      : {scene_id}"
        )

        print(
            f"   Drive File ID : {file_id}"
        )

        print(
            f"   Folder ID     : {folder_id}"
        )

        print(
            f"   Drive URL     : {drive_url}"
        )

        print("")
        print("=" * 70)
        print(
            "SCENE DRIVE UPLOAD TEST PASSED"
        )
        print("=" * 70)


if __name__ == "__main__":
    main()