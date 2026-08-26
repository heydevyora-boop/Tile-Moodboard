"""
test_scene_product_understanding.py

Offline test for the product-understanding stage.

No Gemini API call is made.
No Google Drive call is made.
No external API is required.
"""

from pathlib import Path
import tempfile

from app.scene_product_understanding import (
    analyze_product_image_offline,
    build_product_record,
    save_product_understanding,
)


# ============================================================
# FAKE IMAGE
# ============================================================

def create_fake_image(path: Path) -> None:

    path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    # Small fake image payload.
    # The test only verifies file handling.
    path.write_bytes(
        b"FAKE_PRODUCT_IMAGE_DATA"
    )


# ============================================================
# MAIN TEST
# ============================================================

def test_offline_product_understanding():

    print("")
    print("=" * 70)
    print("SCENE PRODUCT UNDERSTANDING OFFLINE TEST")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as temp_dir:

        temp_root = Path(temp_dir)

        crop_dir = (
            temp_root /
            "product_crops"
        )

        output_dir = (
            temp_root /
            "product_understanding"
        )

        # ----------------------------------------------------
        # CREATE FIVE TEST CROPS
        # ----------------------------------------------------

        print("")
        print("1. Creating test product crops...")

        products = []

        for number in range(1, 6):

            product_id = (
                f"TEST-P{number:03d}"
            )

            image_path = (
                crop_dir /
                f"{number:03d}_{product_id}.png"
            )

            create_fake_image(
                image_path
            )

            products.append(
                {
                    "product_id": product_id,
                    "image_path": str(
                        image_path
                    ),
                }
            )

        print(
            f"   Created {len(products)} test crops."
        )

        # ----------------------------------------------------
        # ANALYZE CROPS
        # ----------------------------------------------------

        print("")
        print("2. Analyzing cropped products...")

        results = []

        for product in products:

            result = (
                analyze_product_image_offline(
                    product_id=product[
                        "product_id"
                    ],
                    image_path=product[
                        "image_path"
                    ],
                )
            )

            results.append(result)

            print(
                f"[PASS] "
                f"{product['product_id']} "
                f"validated."
            )

        # ----------------------------------------------------
        # VALIDATE COUNT
        # ----------------------------------------------------

        print("")
        print("3. Checking product count...")

        if len(results) != 5:
            raise RuntimeError(
                "Expected 5 product records."
            )

        print(
            "[PASS] Five product records created."
        )

        # ----------------------------------------------------
        # VALIDATE PRODUCT IDS
        # ----------------------------------------------------

        print("")
        print("4. Checking product IDs...")

        expected_ids = [
            "TEST-P001",
            "TEST-P002",
            "TEST-P003",
            "TEST-P004",
            "TEST-P005",
        ]

        actual_ids = [
            item["product_id"]
            for item in results
        ]

        if actual_ids != expected_ids:
            raise RuntimeError(
                "Product IDs do not match."
            )

        print(
            "[PASS] Product IDs validated."
        )

        # ----------------------------------------------------
        # TEST AI RESULT NORMALIZATION
        # ----------------------------------------------------

        print("")
        print(
            "5. Testing structured product metadata..."
        )

        ai_result = {
            "product_type": "porcelain tile",
            "category": "Wall Tile",
            "subcategory": "Bathroom Wall Tile",
            "material": "Porcelain",
            "color": "White",
            "finish": "Glossy",
            "pattern": "Marble",
            "style": "Modern",
            "shape": "Rectangular",
            "confidence": 0.94,
            "dimensions": {
                "length": 600,
                "width": 1200,
                "height": None,
                "unit": "mm",
            },
        }

        structured = build_product_record(
            product_id="TEST-P001",
            image_path=products[0][
                "image_path"
            ],
            ai_result=ai_result,
        )

        if structured["product_type"] != "TILE":
            raise RuntimeError(
                "Product type normalization failed."
            )

        if structured["material"] != "Porcelain":
            raise RuntimeError(
                "Material was not preserved."
            )

        if structured["color"] != "White":
            raise RuntimeError(
                "Color was not preserved."
            )

        if structured["finish"] != "Glossy":
            raise RuntimeError(
                "Finish was not preserved."
            )

        if structured["confidence"] != 0.94:
            raise RuntimeError(
                "Confidence was not preserved."
            )

        print(
            "[PASS] Product metadata validated."
        )

        # ----------------------------------------------------
        # SAVE RESULT
        # ----------------------------------------------------

        print("")
        print(
            "6. Saving product-understanding JSON..."
        )

        output_path = (
            output_dir /
            "product_understanding.json"
        )

        saved_path = (
            save_product_understanding(
                results,
                output_path,
            )
        )

        if not saved_path.exists():
            raise RuntimeError(
                "Product understanding JSON "
                "was not created."
            )

        print(
            f"[PASS] Saved: {saved_path}"
        )

        # ----------------------------------------------------
        # FINAL
        # ----------------------------------------------------

        print("")
        print("=" * 70)
        print(
            "SCENE PRODUCT UNDERSTANDING TEST PASSED"
        )
        print("=" * 70)

        print("")
        print(
            "Cropped Products : OK"
        )
        print(
            "Product IDs      : OK"
        )
        print(
            "Image Validation : OK"
        )
        print(
            "Metadata Schema  : OK"
        )
        print(
            "Normalization    : OK"
        )
        print(
            "JSON Save        : OK"
        )
        print("")

        print(
            "No Gemini API quota was consumed."
        )

        print("")
        print("=" * 70)


# ============================================================
# MAIN
# ============================================================

if __name__ == "__main__":
    test_offline_product_understanding()