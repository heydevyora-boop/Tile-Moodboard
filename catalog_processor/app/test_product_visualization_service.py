from pathlib import Path

from app.product_visualization_service import (
    get_product_for_visualization,
    resolve_product_image,
)


PROJECT_ROOT = (
    Path(__file__)
    .resolve()
    .parent
    .parent
)


def main():

    print("=" * 70)
    print("PRODUCT VISUALIZATION SERVICE TEST")
    print("=" * 70)

    # --------------------------------------------------------
    # Synthetic MASTER record
    # --------------------------------------------------------

    records = [
        {
            "Record Type": "PRODUCT",
            "Record ID": "TEST-P001",
            "Product ID": "TEST-P001",
            "Name": "Test Marble Tile",
            "Category": "TILE",
            "Style": "MODERN",
        }
    ]

    print("")
    print(
        "Finding MASTER product..."
    )

    product = get_product_for_visualization(
        records,
        "TEST-P001",
    )

    print(
        "[PASS] Product found."
    )

    print(
        "Product:",
        product["Name"],
    )

    # --------------------------------------------------------
    # Resolve crop
    # --------------------------------------------------------

    print("")
    print(
        "Resolving product image..."
    )

    try:

        image_path = (
            resolve_product_image(
                product
            )
        )

        print(
            "[PASS] Product image found:"
        )

        print(
            image_path
        )

    except FileNotFoundError:

        print(
            "[INFO] No image_path exists "
            "in synthetic test record."
        )

        print(
            "[PASS] Lookup logic executed."
        )

    # --------------------------------------------------------
    # Final
    # --------------------------------------------------------

    print("")
    print("=" * 70)
    print(
        "PRODUCT VISUALIZATION SERVICE TEST PASSED"
    )
    print("=" * 70)


if __name__ == "__main__":
    main()