"""
test_scene_product_ai.py

Offline test for the Gemini product-identification layer.

The first test does NOT consume Gemini API quota.
"""

from pathlib import Path
import tempfile
from unittest.mock import patch

from app.scene_product_ai import (
    identify_product_with_gemini,
)


# ============================================================
# FAKE GEMINI RESPONSE
# ============================================================

class FakeResponse:

    text = """
    {
        "product_type": "porcelain tile",
        "category": "Wall Tile",
        "subcategory": "Bathroom Wall Tile",
        "material": "Porcelain",
        "color": "White",
        "finish": "Glossy",
        "pattern": "Marble",
        "style": "Modern",
        "shape": "Rectangular",
        "dimensions": {
            "length": null,
            "width": null,
            "height": null,
            "unit": ""
        },
        "confidence": 0.95
    }
    """


class FakeModels:

    def generate_content(
        self,
        *args,
        **kwargs,
    ):
        print("")
        print("FAKE GEMINI REQUEST RECEIVED")
        print(
            f"Model: {kwargs.get('model')}"
        )
        print(
            "Gemini API call simulated."
        )

        return FakeResponse()


class FakeClient:

    def __init__(self):
        self.models = FakeModels()


# ============================================================
# TEST
# ============================================================

def test_offline_gemini_identification():

    print("")
    print("=" * 70)
    print("SCENE PRODUCT AI OFFLINE TEST")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as temp_dir:

        temp_root = Path(temp_dir)

        image_path = (
            temp_root /
            "001_TEST-P001.png"
        )

        # ----------------------------------------------------
        # Fake product image
        # ----------------------------------------------------

        print("")
        print("1. Creating test product image...")

        image_path.write_bytes(
            b"FAKE_PRODUCT_IMAGE_DATA"
        )

        print(
            f"[PASS] Image created: {image_path}"
        )

        # ----------------------------------------------------
        # Fake Gemini client
        # ----------------------------------------------------

        fake_client = FakeClient()

        # ----------------------------------------------------
        # Patch client creation
        # ----------------------------------------------------

        with patch(
            "app.scene_product_ai._create_client",
            return_value=fake_client,
        ):

            print("")
            print(
                "2. Running simulated Gemini identification..."
            )

            result = identify_product_with_gemini(
                product_id="TEST-P001",
                image_path=image_path,
            )

        # ----------------------------------------------------
        # Validate result
        # ----------------------------------------------------

        print("")
        print(
            "3. Checking product identification..."
        )

        if result["product_id"] != "TEST-P001":
            raise RuntimeError(
                "Product ID mismatch."
            )

        print(
            "[PASS] Product ID validated."
        )

        if result["product_type"] != "TILE":
            raise RuntimeError(
                "Product type was not normalized to TILE."
            )

        print(
            "[PASS] Product type: TILE"
        )

        if result["category"] != "Wall Tile":
            raise RuntimeError(
                "Category mismatch."
            )

        print(
            "[PASS] Category: Wall Tile"
        )

        if result["material"] != "Porcelain":
            raise RuntimeError(
                "Material mismatch."
            )

        print(
            "[PASS] Material: Porcelain"
        )

        if result["color"] != "White":
            raise RuntimeError(
                "Color mismatch."
            )

        print(
            "[PASS] Color: White"
        )

        if result["finish"] != "Glossy":
            raise RuntimeError(
                "Finish mismatch."
            )

        print(
            "[PASS] Finish: Glossy"
        )

        if result["pattern"] != "Marble":
            raise RuntimeError(
                "Pattern mismatch."
            )

        print(
            "[PASS] Pattern: Marble"
        )

        if result["confidence"] != 0.95:
            raise RuntimeError(
                "Confidence mismatch."
            )

        print(
            "[PASS] Confidence: 0.95"
        )

        if result["source"] != (
            "SCENE_CROP_GEMINI"
        ):
            raise RuntimeError(
                "AI source metadata mismatch."
            )

        print(
            "[PASS] AI source metadata validated."
        )

        # ----------------------------------------------------
        # Final
        # ----------------------------------------------------

        print("")
        print("=" * 70)
        print(
            "SCENE PRODUCT AI OFFLINE TEST PASSED"
        )
        print("=" * 70)

        print("")
        print(
            "Image Input       : OK"
        )
        print(
            "Gemini Mock       : OK"
        )
        print(
            "JSON Parsing      : OK"
        )
        print(
            "Product Type      : OK"
        )
        print(
            "Product Attributes: OK"
        )
        print(
            "Normalization     : OK"
        )
        print(
            "AI Metadata       : OK"
        )

        print("")
        print(
            "No real Gemini API quota was consumed."
        )

        print("")
        print("=" * 70)


# ============================================================
# MAIN
# ============================================================

if __name__ == "__main__":
    test_offline_gemini_identification()