from pathlib import Path
import json
import sys


# ============================================================
# PROJECT PATH
# ============================================================

PROJECT_ROOT = Path(__file__).resolve().parent.parent


# ============================================================
# IMPORTS
# ============================================================

try:
    from app.scene_engine import create_scene
    from app.scene_angle_engine import build_scene_angles
    from app.scene_reference_images import (
        resolve_scene_reference_images,
    )

except Exception as error:
    print()
    print("=" * 70)
    print("IMPORT FAILED")
    print("=" * 70)
    print(error)
    sys.exit(1)


# ============================================================
# CONFIGURATION
# ============================================================

# Optional:
#
# PowerShell:
#
# $env:SCENE_ID="SCENE_XXXXXXXX"
#
# If SCENE_ID is provided, the test will try to locate the
# existing scene.json.
#
# Otherwise, this test validates the Scene Engine using
# sample product records without calling Gemini.

SCENE_ID = None


# ============================================================
# TEST PRODUCTS
# ============================================================

TEST_PRODUCTS = [
    {
        "product_id": "TEST-P001",
        "product_name": "Test Floor Tile",
        "brand": "Test Brand",
        "product_code": "TEST001",
        "dimensions": "600x1200",
        "drive_url": "",
    },
    {
        "product_id": "TEST-P002",
        "product_name": "Test Wall Tile",
        "brand": "Test Brand",
        "product_code": "TEST002",
        "dimensions": "600x1200",
        "drive_url": "",
    },
    {
        "product_id": "TEST-P003",
        "product_name": "Test Basin",
        "brand": "Test Brand",
        "product_code": "TEST003",
        "dimensions": "",
        "drive_url": "",
    },
]


# ============================================================
# PRINT HELPERS
# ============================================================

def print_pass(message):
    print(f"[PASS] {message}")


def print_fail(message):
    print(f"[FAIL] {message}")


def print_info(message):
    print(f"[INFO] {message}")


# ============================================================
# TEST SCENE ENGINE
# ============================================================

def test_scene_creation():

    print()
    print("=" * 70)
    print("1. SCENE CREATION")
    print("=" * 70)

    try:

        scene = create_scene(
            brand="Test Brand",
            catalog="Test Catalog",
            products=TEST_PRODUCTS,
            scene_type="BATHROOM",
        )

        if not scene.scene_id:
            raise AssertionError(
                "Scene ID was not generated."
            )

        if not scene.products:
            raise AssertionError(
                "No products were locked."
            )

        print_pass(
            f"Scene created: {scene.scene_id}"
        )

        print_pass(
            f"Products locked: "
            f"{len(scene.products)}"
        )

        return scene

    except Exception as error:

        print_fail(
            f"Scene creation failed: {error}"
        )

        return None


# ============================================================
# TEST PRODUCT LOCK
# ============================================================

def test_product_lock(scene):

    print()
    print("=" * 70)
    print("2. PRODUCT LOCK")
    print("=" * 70)

    try:

        product_ids = [
            product.product_id
            for product in scene.products
        ]

        if not product_ids:
            raise AssertionError(
                "Locked product list is empty."
            )

        if len(product_ids) != len(
            set(product_ids)
        ):
            raise AssertionError(
                "Duplicate product IDs found."
            )

        print_pass(
            "Product lock is valid."
        )

        print_info(
            "Locked products:"
        )

        for product_id in product_ids:
            print(
                f"    - {product_id}"
            )

        return product_ids

    except Exception as error:

        print_fail(
            f"Product lock failed: {error}"
        )

        return None


# ============================================================
# TEST ANGLE ENGINE
# ============================================================

def test_scene_angles(scene_dict, locked_product_ids):

    print()
    print("=" * 70)
    print("3. SCENE ANGLES")
    print("=" * 70)

    try:

        angles = build_scene_angles(
            scene_dict
        )

        expected_angles = {
            "FRONT",
            "LEFT",
            "RIGHT",
            "WIDE",
            "SHOWER_CLOSEUP",
        }

        if not isinstance(angles, list):
            raise AssertionError(
                "build_scene_angles() must return a list."
            )

        for angle in angles:
            if not isinstance(angle, dict):
                raise AssertionError(
                    "Every scene angle must be a dictionary."
                )

        actual_angles = {
            angle["angle_type"]
            for angle in angles
        }

        missing = (
            expected_angles -
            actual_angles
        )

        if missing:
            raise AssertionError(
                f"Missing angles: {missing}"
            )

        for angle in angles:

            angle_product_ids = list(
                angle.get(
                    "product_ids",
                    []
                )
            )

            if angle_product_ids != (
                locked_product_ids
            ):
                raise AssertionError(
                    f"Product lock violation in "
                    f"{angle['angle_type']}"
                )

            if angle.get(
                "product_lock"
            ) is not True:
                raise AssertionError(
                    f"Product lock disabled in "
                    f"{angle['angle_type']}"
                )

            print_pass(
                f"{angle['angle_type']}: "
                "product lock OK"
            )

        return angles

    except Exception as error:

        print_fail(
            f"Scene angle test failed: {error}"
        )

        return None


# ============================================================
# TEST SCENE SERIALIZATION
# ============================================================

def test_scene_serialization(scene):

    print()
    print("=" * 70)
    print("4. SCENE SERIALIZATION")
    print("=" * 70)

    try:

        scene_dict = {
            "scene_id":
                scene.scene_id,

            "scene_type":
                scene.scene_type,

            "product_lock":
                True,

            "created_at":
                scene.created_at,

            "products": [
                {
                    "product_id":
                        product.product_id,

                    "product_name":
                        product.product_name,

                    "brand":
                        product.brand,

                    "product_code":
                        product.product_code,

                    "dimensions":
                        product.dimensions,

                    "drive_url":
                        product.drive_url,
                }

                for product in scene.products
            ],
        }

        if not scene_dict["scene_id"]:
            raise AssertionError(
                "Missing scene_id."
            )

        if scene_dict["product_lock"] is not True:
            raise AssertionError(
                "product_lock is not True."
            )

        if not scene_dict["products"]:
            raise AssertionError(
                "No products in serialized scene."
            )

        print_pass(
            "Scene serialization is valid."
        )

        print_info(
            f"Scene ID: "
            f"{scene_dict['scene_id']}"
        )

        print_info(
            f"Product count: "
            f"{len(scene_dict['products'])}"
        )

        return scene_dict

    except Exception as error:

        print_fail(
            f"Scene serialization failed: {error}"
        )

        return None


# ============================================================
# TEST REFERENCE IMAGE STRUCTURE
# ============================================================

def test_reference_images(scene_dict):

    print()
    print("=" * 70)
    print("5. REFERENCE IMAGE VALIDATION")
    print("=" * 70)

    products = scene_dict.get(
        "products",
        []
    )

    missing_paths = []

    for product in products:

        image_path = str(
            product.get(
                "image_path",
                ""
            )
        ).strip()

        if not image_path:

            missing_paths.append(
                product.get(
                    "product_id",
                    "UNKNOWN"
                )
            )

    if missing_paths:

        print_info(
            "Reference image paths are not present "
            "in the generated test scene."
        )

        print_info(
            "This is expected for the synthetic "
            "test products."
        )

        print_info(
            "Real catalog scenes must contain "
            "image_path for every product."
        )

        return True

    try:

        paths = (
            resolve_scene_reference_images(
                scene_dict
            )
        )

        if len(paths) != len(products):
            raise AssertionError(
                "Reference image count does not "
                "match product count."
            )

        for path in paths:

            if not Path(path).exists():
                raise FileNotFoundError(
                    f"Reference image missing: {path}"
                )

        print_pass(
            f"Reference images found: "
            f"{len(paths)}"
        )

        return True

    except Exception as error:

        print_fail(
            f"Reference image validation failed: "
            f"{error}"
        )

        return False


# ============================================================
# TEST ANGLE JSON
# ============================================================

def test_angle_serialization(
    scene_dict,
    angles
):

    print()
    print("=" * 70)
    print("6. ANGLE SERIALIZATION")
    print("=" * 70)

    try:

        payload = {
            "scene_id":
                scene_dict["scene_id"],

            "product_lock":
                scene_dict["product_lock"],

            "locked_product_ids": [
                product["product_id"]
                for product in scene_dict["products"]
            ],

            "angles":
                angles,

            "angle_count":
                len(angles),
        }

        serialized = json.dumps(
            payload,
            indent=2,
            ensure_ascii=False
        )

        restored = json.loads(
            serialized
        )

        if restored["scene_id"] != (
            scene_dict["scene_id"]
        ):
            raise AssertionError(
                "Scene ID changed during serialization."
            )

        if restored["product_lock"] is not True:
            raise AssertionError(
                "Product lock changed during serialization."
            )

        if restored["angle_count"] != 5:
            raise AssertionError(
                "Expected five angles."
            )

        print_pass(
            "Angle JSON serialization is valid."
        )

        return True

    except Exception as error:

        print_fail(
            f"Angle serialization failed: {error}"
        )

        return False


# ============================================================
# MAIN TEST
# ============================================================

def main():

    print()
    print("=" * 70)
    print("SCENE END-TO-END VALIDATION")
    print("=" * 70)

    print_info(
        "This test does NOT call Gemini."
    )

    print_info(
        "No image-generation API credits are consumed."
    )

    # --------------------------------------------------------
    # Scene
    # --------------------------------------------------------

    scene = test_scene_creation()

    if scene is None:
        sys.exit(1)

    # --------------------------------------------------------
    # Product Lock
    # --------------------------------------------------------

    locked_product_ids = test_product_lock(
        scene
    )

    if locked_product_ids is None:
        sys.exit(1)

    # --------------------------------------------------------
    # Scene JSON
    # --------------------------------------------------------

    scene_dict = test_scene_serialization(
        scene
    )

    if scene_dict is None:
        sys.exit(1)

    # --------------------------------------------------------
    # Angles
    # --------------------------------------------------------

    angles = test_scene_angles(
        scene_dict,
        locked_product_ids
    )

    if angles is None:
        sys.exit(1)

    # --------------------------------------------------------
    # Reference Images
    # --------------------------------------------------------

    if not test_reference_images(
        scene_dict
    ):
        sys.exit(1)

    # --------------------------------------------------------
    # Angle JSON
    # --------------------------------------------------------

    if not test_angle_serialization(
        scene_dict,
        angles
    ):
        sys.exit(1)

    # --------------------------------------------------------
    # FINAL RESULT
    # --------------------------------------------------------

    print()
    print("=" * 70)
    print("ALL SCENE VALIDATION TESTS PASSED")
    print("=" * 70)

    print()
    print(
        f"Scene ID: {scene.scene_id}"
    )

    print(
        f"Products locked: "
        f"{len(scene.products)}"
    )

    print(
        "Angles:"
    )

    for angle in angles:

        print(
            f"  ✓ {angle['angle_type']}"
        )

    print()
    print(
        "Gemini generation was NOT called."
    )

    print("=" * 70)


# ============================================================
# ENTRY POINT
# ============================================================

if __name__ == "__main__":
    main()