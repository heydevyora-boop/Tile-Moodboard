import sys
from pathlib import Path

from app.gemini_service import analyze_product_image


def main():

    if len(sys.argv) < 2:

        print(
            "Usage:\n"
            "python -m app.product_identification_test "
            "\"path/to/image.jpg\""
        )

        return

    image_path = Path(
        sys.argv[1]
    )

    print("=" * 60)
    print("GEMINI PRODUCT IMAGE TEST")
    print("=" * 60)

    print(
        f"Image: {image_path}"
    )

    result = analyze_product_image(
        image_path
    )

    print("\nRESULT")
    print("-" * 60)

    print(
        f"Product image: "
        f"{result.is_product_image}"
    )

    print(
        f"Type: "
        f"{result.image_type}"
    )

    print(
        f"Product name: "
        f"{result.product_name}"
    )

    print(
        f"Brand: "
        f"{result.brand}"
    )

    print(
        f"Product code: "
        f"{result.product_code}"
    )

    print(
        f"Confidence: "
        f"{result.confidence}"
    )

    print(
        f"Reason: "
        f"{result.reason}"
    )

    print(
        f"BBox: "
        f"{result.product_bbox}"
    )

    print("\nTEST FINISHED")


if __name__ == "__main__":
    main()