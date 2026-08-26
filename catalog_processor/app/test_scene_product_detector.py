from app import scene_product_detector


def fake_gemini_result():
    return {
        "is_scene_image": True,
        "scene_type": "BATHROOM",
        "products": [
            {
                "product_type": "WALL_TILE",
                "product_name_hint": "Wall tile",
                "confidence": 0.97,
                "bbox": [0.00, 0.00, 0.62, 0.82],
                "visibility": "VISIBLE",
                "reason": "Large visible tiled wall surface."
            },
            {
                "product_type": "BASIN",
                "product_name_hint": "Wash basin",
                "confidence": 0.95,
                "bbox": [0.55, 0.38, 0.76, 0.67],
                "visibility": "VISIBLE",
                "reason": "Visible sanitary basin."
            },
            {
                "product_type": "FAUCET",
                "product_name_hint": "Basin faucet",
                "confidence": 0.94,
                "bbox": [0.63, 0.28, 0.72, 0.45],
                "visibility": "VISIBLE",
                "reason": "Faucet visibly mounted above basin."
            },
            {
                "product_type": "WC",
                "product_name_hint": "Wall mounted WC",
                "confidence": 0.96,
                "bbox": [0.74, 0.45, 0.98, 0.88],
                "visibility": "VISIBLE",
                "reason": "Visible WC."
            },
            {
                "product_type": "MIRROR",
                "product_name_hint": "Bathroom mirror",
                "confidence": 0.91,
                "bbox": [0.48, 0.08, 0.77, 0.39],
                "visibility": "VISIBLE",
                "reason": "Visible wall-mounted mirror."
            }
        ]
    }


def test_offline_detection():

    print()
    print("=" * 70)
    print("SCENE PRODUCT DETECTOR OFFLINE TEST")
    print("=" * 70)

    raw = fake_gemini_result()

    products = []

    for item in raw["products"]:

        product = (
            scene_product_detector
            ._normalize_product(item)
        )

        if product:
            products.append(product)

    products = (
        scene_product_detector
        ._remove_duplicate_products(
            products
        )
    )

    products = (
        scene_product_detector
        ._validate_products(
            products
        )
    )

    assert raw["is_scene_image"] is True

    assert (
        raw["scene_type"]
        == "BATHROOM"
    )

    assert len(products) == 5

    expected_types = {
        "WALL_TILE",
        "BASIN",
        "FAUCET",
        "WC",
        "MIRROR",
    }

    actual_types = {
        product["product_type"]
        for product in products
    }

    assert (
        actual_types
        == expected_types
    )

    for product in products:

        assert len(
            product["bbox"]
        ) == 4

        x1, y1, x2, y2 = (
            product["bbox"]
        )

        assert 0 <= x1 <= 1
        assert 0 <= y1 <= 1
        assert 0 <= x2 <= 1
        assert 0 <= y2 <= 1

        assert x2 > x1
        assert y2 > y1

        assert 0 <= (
            product["confidence"]
        ) <= 1

    print()
    print(
        "[PASS] Scene recognized."
    )

    print(
        "[PASS] Five products detected."
    )

    print(
        "[PASS] Product types validated."
    )

    print(
        "[PASS] Bounding boxes validated."
    )

    print(
        "[PASS] Confidence values validated."
    )

    print()
    print("=" * 70)
    print(
        "SCENE PRODUCT DETECTOR TEST PASSED"
    )
    print("=" * 70)


if __name__ == "__main__":
    test_offline_detection()