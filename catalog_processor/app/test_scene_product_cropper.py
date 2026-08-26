"""
test_scene_product_cropper.py

Offline test for scene_product_cropper.py.

No Gemini API.
No Google Drive.
No Google Sheets.

The test creates a synthetic scene image and five
synthetic bounding boxes, then verifies that all five
products are cropped successfully.

Cropped test products are stored permanently in:

    catalog_processor/output/crops/

This allows the next test, such as
test_scene_product_ai_real.py, to use the generated
crop images.
"""

from pathlib import Path
import tempfile

from PIL import Image, ImageDraw

from app.scene_product_cropper import (
    crop_scene_products,
)


# ============================================================
# PROJECT PATHS
# ============================================================

# This file is:
#
# catalog_processor/app/test_scene_product_cropper.py
#
# Therefore:
#
# .parent        = app
# .parent.parent = catalog_processor
#
PROJECT_ROOT = Path(__file__).resolve().parent.parent

OUTPUT_ROOT = (
    PROJECT_ROOT
    / "output"
)

CROPS_ROOT = (
    OUTPUT_ROOT
    / "crops"
)


# ============================================================
# CREATE TEST IMAGE
# ============================================================

def create_test_scene(
    path: Path,
) -> None:

    width = 1000
    height = 700

    image = Image.new(
        "RGB",
        (width, height),
        "white",
    )

    draw = ImageDraw.Draw(
        image
    )

    # --------------------------------------------------------
    # Five synthetic products
    # --------------------------------------------------------

    products = [
        (
            "TEST-P001",
            (50, 50, 250, 250),
        ),
        (
            "TEST-P002",
            (300, 50, 500, 250),
        ),
        (
            "TEST-P003",
            (550, 50, 750, 250),
        ),
        (
            "TEST-P004",
            (150, 350, 400, 600),
        ),
        (
            "TEST-P005",
            (550, 350, 850, 600),
        ),
    ]

    for product_id, box in products:

        draw.rectangle(
            box,
            outline="black",
            width=5,
        )

        draw.text(
            (
                box[0] + 20,
                box[1] + 20,
            ),
            product_id,
            fill="black",
        )

    image.save(
        path,
        format="PNG",
    )


# ============================================================
# CLEAN OLD TEST CROPS
# ============================================================

def clean_old_test_crops() -> None:
    """
    Remove only synthetic TEST-Pxxx crops.

    Other files inside output/crops are preserved.
    """

    CROPS_ROOT.mkdir(
        parents=True,
        exist_ok=True,
    )

    for path in CROPS_ROOT.iterdir():

        if not path.is_file():
            continue

        name = path.name.upper()

        if (
            "TEST-P001" in name
            or "TEST-P002" in name
            or "TEST-P003" in name
            or "TEST-P004" in name
            or "TEST-P005" in name
        ):
            try:
                path.unlink()

            except Exception as error:
                raise RuntimeError(
                    f"Could not remove old test crop: "
                    f"{path}\n"
                    f"Error: {error}"
                )


# ============================================================
# TEST
# ============================================================

def test_offline_crop() -> None:

    print("")
    print("=" * 70)
    print("SCENE PRODUCT CROPPER OFFLINE TEST")
    print("=" * 70)

    print("")
    print(
        f"Project root: {PROJECT_ROOT}"
    )

    print(
        f"Crop output : {CROPS_ROOT}"
    )

    # --------------------------------------------------------
    # Clean previous synthetic test crops
    # --------------------------------------------------------

    print("")
    print(
        "0. Preparing persistent crop directory..."
    )

    clean_old_test_crops()

    print(
        "[PASS] Crop directory ready."
    )

    # --------------------------------------------------------
    # Temporary source image
    # --------------------------------------------------------

    with tempfile.TemporaryDirectory() as temp:

        temp_dir = Path(temp)

        # ----------------------------------------------------
        # Source image
        # ----------------------------------------------------

        source_image = (
            temp_dir
            / "scene.png"
        )

        create_test_scene(
            source_image
        )

        print("")
        print(
            "1. Test scene created."
        )

        print(
            f"   {source_image}"
        )

        # ----------------------------------------------------
        # Detector output
        # ----------------------------------------------------

        detections = [

            {
                "product_id": "TEST-P001",
                "product_type": "TILE",
                "confidence": 0.98,
                "bounding_box": [
                    50,
                    50,
                    250,
                    250,
                ],
            },

            {
                "product_id": "TEST-P002",
                "product_type": "TILE",
                "confidence": 0.97,
                "bounding_box": [
                    300,
                    50,
                    500,
                    250,
                ],
            },

            {
                "product_id": "TEST-P003",
                "product_type": "TAP",
                "confidence": 0.96,
                "bounding_box": [
                    550,
                    50,
                    750,
                    250,
                ],
            },

            {
                "product_id": "TEST-P004",
                "product_type": "BASIN",
                "confidence": 0.95,
                "bounding_box": [
                    150,
                    350,
                    400,
                    600,
                ],
            },

            {
                "product_id": "TEST-P005",
                "product_type": "SHOWER",
                "confidence": 0.94,
                "bounding_box": [
                    550,
                    350,
                    850,
                    600,
                ],
            },

        ]

        print("")
        print(
            "2. Detector output prepared."
        )

        print(
            f"   Products: {len(detections)}"
        )

        # ----------------------------------------------------
        # Persistent output
        # ----------------------------------------------------

        output_dir = CROPS_ROOT

        output_dir.mkdir(
            parents=True,
            exist_ok=True,
        )

        print("")
        print(
            "3. Running product cropper..."
        )

        print(
            f"   Output: {output_dir}"
        )

        # ----------------------------------------------------
        # Run cropper
        # ----------------------------------------------------

        result = crop_scene_products(
            image_path=source_image,
            detections=detections,
            output_dir=output_dir,
            coordinate_mode="pixel",
            padding=0,
        )

        # ----------------------------------------------------
        # Result
        # ----------------------------------------------------

        print("")
        print(
            "4. Checking crop result..."
        )

        if result["status"] != "COMPLETED":

            raise RuntimeError(
                "Crop pipeline did not complete."
            )

        print(
            "[PASS] Crop pipeline completed."
        )

        # ----------------------------------------------------
        # Product count
        # ----------------------------------------------------

        if result["product_count"] != 5:

            raise RuntimeError(
                "Expected 5 cropped products."
            )

        print(
            "[PASS] Five products cropped."
        )

        # ----------------------------------------------------
        # Check individual images
        # ----------------------------------------------------

        print("")
        print(
            "5. Checking individual crop images..."
        )

        for product in result["products"]:

            product_id = (
                product["product_id"]
            )

            image_path = Path(
                product["image_path"]
            )

            if not image_path.exists():

                raise RuntimeError(
                    f"Crop missing: {product_id}\n"
                    f"Expected: {image_path}"
                )

            if image_path.stat().st_size == 0:

                raise RuntimeError(
                    f"Crop is empty: {product_id}"
                )

            print(
                f"[PASS] "
                f"{product_id} -> "
                f"{image_path.name}"
            )

        # ----------------------------------------------------
        # Verify all five expected files
        # ----------------------------------------------------

        print("")
        print(
            "6. Verifying persistent crop files..."
        )

        expected_products = [
            "TEST-P001",
            "TEST-P002",
            "TEST-P003",
            "TEST-P004",
            "TEST-P005",
        ]

        found_files = []

        for product_id in expected_products:

            matches = list(
                output_dir.glob(
                    f"*_{product_id}.*"
                )
            )

            if not matches:

                raise RuntimeError(
                    f"Persistent crop not found "
                    f"for {product_id}"
                )

            valid_match = None

            for match in matches:

                if (
                    match.is_file()
                    and match.stat().st_size > 0
                ):
                    valid_match = match
                    break

            if valid_match is None:

                raise RuntimeError(
                    f"Persistent crop is empty "
                    f"for {product_id}"
                )

            found_files.append(
                valid_match
            )

            print(
                f"[PASS] {product_id} -> "
                f"{valid_match}"
            )

        # ----------------------------------------------------
        # Metadata
        # ----------------------------------------------------

        metadata_file = (
            output_dir
            / "cropped_products.json"
        )

        if not metadata_file.exists():

            raise RuntimeError(
                "cropped_products.json was not created."
            )

        if metadata_file.stat().st_size == 0:

            raise RuntimeError(
                "cropped_products.json is empty."
            )

        print(
            "[PASS] Crop metadata created."
        )

        # ----------------------------------------------------
        # Final persistent verification
        # ----------------------------------------------------

        print("")
        print(
            "7. Persistent output verification..."
        )

        if len(found_files) != 5:

            raise RuntimeError(
                "Expected exactly five test crop files."
            )

        print(
            "[PASS] Five persistent crop images confirmed."
        )

    # ========================================================
    # IMPORTANT:
    #
    # The temporary source image has now been deleted.
    #
    # The crops remain because they were written to:
    #
    #     PROJECT_ROOT/output/crops/
    #
    # ========================================================

    print("")
    print(
        "=" * 70
    )

    print(
        "SCENE PRODUCT CROPPER TEST PASSED"
    )

    print(
        "=" * 70
    )

    print("")

    print(
        "Source Image        : OK"
    )

    print(
        "Detector Data       : OK"
    )

    print(
        "Bounding Boxes      : OK"
    )

    print(
        "Product Cropping    : OK"
    )

    print(
        "Five Product Images : OK"
    )

    print(
        "Metadata            : OK"
    )

    print(
        "Persistent Crops    : OK"
    )

    print("")

    print(
        "Crops saved to:"
    )

    print(
        f"  {CROPS_ROOT}"
    )

    print("")


# ============================================================
# MAIN
# ============================================================

if __name__ == "__main__":

    test_offline_crop()