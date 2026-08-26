"""
scene_product_ai.py

REAL Gemini Vision product identification.

Pipeline:
    Cropped Product Image
            ↓
    Gemini Vision
            ↓
    Structured Product Metadata
            ↓
    Normalized JSON
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict

from dotenv import load_dotenv
from google import genai
from google.genai import types


# ============================================================
# ENVIRONMENT
# ============================================================

load_dotenv()


# ============================================================
# CONFIGURATION
# ============================================================

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

GEMINI_MODEL = os.getenv(
    "GEMINI_MODEL",
    "gemini-2.5-flash",
)


# ============================================================
# VALIDATION
# ============================================================

if not GEMINI_API_KEY:
    raise RuntimeError(
        "GEMINI_API_KEY is missing. "
        "Add GEMINI_API_KEY=your_key to .env"
    )


# ============================================================
# GEMINI CLIENT
# ============================================================

client = genai.Client(
    api_key=GEMINI_API_KEY
)


# ============================================================
# PRODUCT SCHEMA
# ============================================================

PRODUCT_SCHEMA = {
    "type": "object",
    "properties": {
        "product_type": {
            "type": "string",
            "description": (
                "The type of product visible in the image. "
                "Examples: tile, basin, faucet, shower, "
                "bathtub, vanity, toilet, mirror."
            ),
        },

        "product_name": {
            "type": "string",
            "description": (
                "Best visual description/name of the product."
            ),
        },

        "material": {
            "type": "string",
            "description": (
                "Visible or strongly inferable material. "
                "Examples: ceramic, porcelain, marble, "
                "stone, metal, glass, wood."
            ),
        },

        "color": {
            "type": "string",
            "description": (
                "Primary visible color."
            ),
        },

        "finish": {
            "type": "string",
            "description": (
                "Visible surface finish. "
                "Examples: glossy, matte, polished, "
                "textured, brushed."
            ),
        },

        "pattern": {
            "type": "string",
            "description": (
                "Visible pattern. "
                "Examples: marble veins, plain, geometric, "
                "floral, wood grain."
            ),
        },

        "shape": {
            "type": "string",
            "description": (
                "Visible product shape/form."
            ),
        },

        "style": {
            "type": "string",
            "description": (
                "Visual style. "
                "Examples: modern, contemporary, classic, "
                "minimal, luxury, industrial."
            ),
        },

        "surface_texture": {
            "type": "string",
            "description": (
                "Visible texture of the product."
            ),
        },

        "dominant_features": {
            "type": "array",
            "items": {
                "type": "string"
            },
            "description": (
                "Important visual characteristics."
            ),
        },

        "confidence": {
            "type": "number",
            "description": (
                "Confidence from 0.0 to 1.0."
            ),
        },

        "is_product_image": {
            "type": "boolean",
            "description": (
                "True if the image contains an identifiable "
                "physical product."
            ),
        },
    },

    "required": [
        "product_type",
        "product_name",
        "material",
        "color",
        "finish",
        "pattern",
        "shape",
        "style",
        "surface_texture",
        "dominant_features",
        "confidence",
        "is_product_image",
    ],
}


# ============================================================
# PROMPT
# ============================================================

PRODUCT_PROMPT = """
You are a product-identification system for a bathroom,
tiles and interior-material catalog.

Analyze ONLY the supplied product image.

Identify the actual physical product visible in the image.

Important rules:

1. Do not invent a brand.
2. Do not invent a model number.
3. Do not invent dimensions.
4. Do not invent technical specifications.
5. Do not infer information that cannot reasonably be
   determined visually.
6. If something is uncertain, use a conservative description.
7. Focus on visual characteristics.
8. Return ONLY the requested JSON structure.

Pay special attention to:

- product type
- material
- color
- finish
- pattern
- shape
- style
- surface texture
- important visual features

For tiles, pay special attention to:

- stone appearance
- marble veins
- grain
- color variation
- surface finish
- pattern
- texture
- visual style

For bathroom fixtures, pay attention to:

- shape
- geometry
- visible material
- finish
- color
- design style.
"""


# ============================================================
# HELPERS
# ============================================================

def _validate_image_path(image_path: str | Path) -> Path:
    """
    Validate that the image exists.
    """

    path = Path(image_path)

    if not path.exists():
        raise FileNotFoundError(
            f"Product image not found: {path}"
        )

    if not path.is_file():
        raise ValueError(
            f"Product image path is not a file: {path}"
        )

    allowed_extensions = {
        ".jpg",
        ".jpeg",
        ".png",
        ".webp",
    }

    if path.suffix.lower() not in allowed_extensions:
        raise ValueError(
            f"Unsupported image format: {path.suffix}"
        )

    return path


def _normalize_result(
    product_id: str,
    image_path: Path,
    result: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Normalize Gemini output into the project's
    product-understanding structure.
    """

    confidence = result.get("confidence", 0.0)

    try:
        confidence = float(confidence)
    except (TypeError, ValueError):
        confidence = 0.0

    confidence = max(
        0.0,
        min(1.0, confidence),
    )

    features = result.get(
        "dominant_features",
        [],
    )

    if not isinstance(features, list):
        features = [str(features)]

    features = [
        str(item).strip()
        for item in features
        if str(item).strip()
    ]

    normalized = {
        "product_id": str(product_id),

        "image_path": str(image_path),

        "product_type": str(
            result.get("product_type", "")
        ).strip(),

        "product_name": str(
            result.get("product_name", "")
        ).strip(),

        "material": str(
            result.get("material", "")
        ).strip(),

        "color": str(
            result.get("color", "")
        ).strip(),

        "finish": str(
            result.get("finish", "")
        ).strip(),

        "pattern": str(
            result.get("pattern", "")
        ).strip(),

        "shape": str(
            result.get("shape", "")
        ).strip(),

        "style": str(
            result.get("style", "")
        ).strip(),

        "surface_texture": str(
            result.get("surface_texture", "")
        ).strip(),

        "dominant_features": features,

        "confidence": confidence,

        "is_product_image": bool(
            result.get(
                "is_product_image",
                False,
            )
        ),

        "ai_provider": "google_gemini",

        "ai_model": GEMINI_MODEL,

        "ai_mode": "real",

    }

    return normalized


# ============================================================
# REAL GEMINI IDENTIFICATION
# ============================================================

def identify_product_with_gemini(
    product_id: str,
    image_path: str | Path,
) -> Dict[str, Any]:
    """
    Send one cropped product image to Gemini Vision.

    Returns normalized product metadata.
    """

    path = _validate_image_path(image_path)

    print()
    print("=" * 70)
    print("GEMINI PRODUCT IDENTIFICATION")
    print("=" * 70)

    print(f"Product ID : {product_id}")
    print(f"Image      : {path}")
    print(f"Model      : {GEMINI_MODEL}")

    # --------------------------------------------------------
    # Read image bytes
    # --------------------------------------------------------

    image_bytes = path.read_bytes()

    mime_type_map = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }

    mime_type = mime_type_map[
        path.suffix.lower()
    ]

    image_part = types.Part.from_bytes(
        data=image_bytes,
        mime_type=mime_type,
    )

    # --------------------------------------------------------
    # Gemini request
    # --------------------------------------------------------

    response = client.models.generate_content(
        model=GEMINI_MODEL,

        contents=[
            types.Content(
                role="user",
                parts=[
                    types.Part.from_text(
                        text=PRODUCT_PROMPT
                    ),
                    image_part,
                ],
            )
        ],

        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=PRODUCT_SCHEMA,
            temperature=0.1,
        ),
    )

    # --------------------------------------------------------
    # Response validation
    # --------------------------------------------------------

    response_text = response.text

    if not response_text:
        raise RuntimeError(
            "Gemini returned an empty response."
        )

    try:
        result = json.loads(response_text)

    except json.JSONDecodeError as exc:
        raise RuntimeError(
            "Gemini returned invalid JSON:\n"
            f"{response_text}"
        ) from exc

    if not isinstance(result, dict):
        raise RuntimeError(
            "Gemini response is not a JSON object."
        )

    # --------------------------------------------------------
    # Normalize
    # --------------------------------------------------------

    normalized = _normalize_result(
        product_id=product_id,
        image_path=path,
        result=result,
    )

    # --------------------------------------------------------
    # Output
    # --------------------------------------------------------

    print()
    print("[PASS] Gemini response received.")

    print(
        f"[PASS] Product Type : "
        f"{normalized['product_type']}"
    )

    print(
        f"[PASS] Material     : "
        f"{normalized['material']}"
    )

    print(
        f"[PASS] Color        : "
        f"{normalized['color']}"
    )

    print(
        f"[PASS] Finish       : "
        f"{normalized['finish']}"
    )

    print(
        f"[PASS] Pattern      : "
        f"{normalized['pattern']}"
    )

    print(
        f"[PASS] Style        : "
        f"{normalized['style']}"
    )

    print(
        f"[PASS] Confidence   : "
        f"{normalized['confidence']}"
    )

    return normalized


# ============================================================
# BATCH IDENTIFICATION
# ============================================================

def identify_products_with_gemini(
    cropped_products: Dict[str, str | Path],
) -> Dict[str, Dict[str, Any]]:
    """
    Process multiple cropped products.

    Example:

        {
            "TEST-P001": "output/crops/001_TEST-P001.png",
            "TEST-P002": "output/crops/002_TEST-P002.png",
        }
    """

    results: Dict[str, Dict[str, Any]] = {}

    print()
    print("=" * 70)
    print("GEMINI BATCH PRODUCT IDENTIFICATION")
    print("=" * 70)

    print(
        f"Products to process: "
        f"{len(cropped_products)}"
    )

    for product_id, image_path in cropped_products.items():

        try:

            result = identify_product_with_gemini(
                product_id=product_id,
                image_path=image_path,
            )

            results[product_id] = result

        except Exception as exc:

            print()
            print(
                f"[ERROR] {product_id}: {exc}"
            )

            results[product_id] = {
                "product_id": product_id,
                "image_path": str(image_path),
                "error": str(exc),
                "ai_provider": "google_gemini",
                "ai_model": GEMINI_MODEL,
                "ai_mode": "real",
            }

    return results


# ============================================================
# SAVE JSON
# ============================================================

def save_ai_results(
    results: Dict[str, Dict[str, Any]],
    output_path: str | Path,
) -> Path:
    """
    Save Gemini results to JSON.
    """

    output = Path(output_path)

    output.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    output.write_text(
        json.dumps(
            results,
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    print()
    print(
        f"[PASS] AI results saved: {output}"
    )

    return output


# ============================================================
# SINGLE IMAGE CLI TEST
# ============================================================

def main() -> None:

    import argparse

    parser = argparse.ArgumentParser(
        description=(
            "Identify a cropped product image "
            "using real Gemini Vision."
        )
    )

    parser.add_argument(
        "--product-id",
        required=True,
        help="Product ID",
    )

    parser.add_argument(
        "--image",
        required=True,
        help="Path to cropped product image",
    )

    parser.add_argument(
        "--output",
        default="output/scene_product_ai_results.json",
        help="Output JSON path",
    )

    args = parser.parse_args()

    result = identify_product_with_gemini(
        product_id=args.product_id,
        image_path=args.image,
    )

    save_ai_results(
        {
            args.product_id: result
        },
        args.output,
    )

    print()
    print("=" * 70)
    print("REAL GEMINI PRODUCT AI TEST PASSED")
    print("=" * 70)


if __name__ == "__main__":
    main()