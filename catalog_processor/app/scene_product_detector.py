"""
scene_product_detector.py

Detects ALL visible bathroom products from an applied/scene image.

This module is intentionally independent from:
- product master
- Google Drive
- Google Sheets
- scene manager
- scene image generator
- moodboard generation

Current responsibility:

    Applied Image
        ->
    Gemini visual detection
        ->
    Product list
        ->
    Bounding boxes
        ->
    Structured result

The next pipeline stage will consume this result.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from PIL import Image

from app import gemini_service


# ============================================================
# PRODUCT TYPES
# ============================================================

PRODUCT_TYPES = {
    "TILE",
    "WALL_TILE",
    "FLOOR_TILE",
    "BASIN",
    "WC",
    "BIDET",
    "URINAL",
    "FAUCET",
    "SHOWER",
    "HAND_SHOWER",
    "SHOWER_RAIL",
    "FLUSH_PLATE",
    "BATHTUB",
    "SHOWER_TRAY",
    "MIRROR",
    "LED_MIRROR",
    "VANITY",
    "BATHROOM_FURNITURE",
    "ACCESSORY",
    "OTHER",
}


# ============================================================
# DETECTION PROMPT
# ============================================================

SYSTEM_PROMPT = """
You are a bathroom product detection engine.

Your task is to inspect an applied bathroom/interior image and
identify ALL distinct physical bathroom products that are visibly
present.

IMPORTANT RULES:

1. Detect ALL visible products.
2. Do NOT detect only the most prominent product.
3. Do NOT invent products that are not visible.
4. Do NOT infer hidden products.
5. Tiles may cover a large part of the image.
6. A tile surface and a sanitary product are different products.
7. Faucets and showers must be detected separately when visible.
8. A mirror must be detected separately from the basin.
9. A vanity must be detected separately from the basin when both
   are visually distinguishable.
10. WC and bidet must be separate products when both are visible.
11. Multiple products of the same category are allowed.
12. Return normalized bounding boxes.
13. Bounding boxes must cover the visible product itself as closely
    as possible.
14. Do not return the same physical product twice.
15. If a product is partially occluded, detect it if enough of the
    product is visibly identifiable.
16. Do not treat shadows, reflections, walls, empty space or people
    as products.
17. Do not treat decorative objects as bathroom products unless
    they clearly belong to the supported product categories.

SUPPORTED PRODUCT TYPES:

TILE
WALL_TILE
FLOOR_TILE
BASIN
WC
BIDET
URINAL
FAUCET
SHOWER
HAND_SHOWER
SHOWER_RAIL
FLUSH_PLATE
BATHTUB
SHOWER_TRAY
MIRROR
LED_MIRROR
VANITY
BATHROOM_FURNITURE
ACCESSORY
OTHER

NORMALIZED BBOX FORMAT:

[x1, y1, x2, y2]

where:

x1 = left
y1 = top
x2 = right
y2 = bottom

All values must be between 0 and 1.

Return JSON only.
"""


# ============================================================
# RESPONSE SCHEMA
# ============================================================

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "is_scene_image": {
            "type": "boolean"
        },
        "scene_type": {
            "type": "string"
        },
        "products": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "product_type": {
                        "type": "string"
                    },
                    "product_name_hint": {
                        "type": "string"
                    },
                    "confidence": {
                        "type": "number"
                    },
                    "bbox": {
                        "type": "array",
                        "items": {
                            "type": "number"
                        }
                    },
                    "visibility": {
                        "type": "string"
                    },
                    "reason": {
                        "type": "string"
                    }
                },
                "required": [
                    "product_type",
                    "confidence",
                    "bbox",
                    "visibility"
                ]
            }
        }
    },
    "required": [
        "is_scene_image",
        "scene_type",
        "products"
    ]
}


# ============================================================
# HELPERS
# ============================================================

def _clamp(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _normalize_bbox(bbox: Any) -> Optional[List[float]]:
    """
    Validate and normalize a bbox.

    Expected:

        [x1, y1, x2, y2]
    """

    if not isinstance(bbox, list):
        return None

    if len(bbox) != 4:
        return None

    try:
        x1, y1, x2, y2 = (
            float(value)
            for value in bbox
        )
    except (TypeError, ValueError):
        return None

    x1 = _clamp(x1)
    y1 = _clamp(y1)
    x2 = _clamp(x2)
    y2 = _clamp(y2)

    if x2 <= x1:
        return None

    if y2 <= y1:
        return None

    return [
        round(x1, 6),
        round(y1, 6),
        round(x2, 6),
        round(y2, 6),
    ]


def _normalize_product(
    product: Any
) -> Optional[Dict[str, Any]]:
    """
    Normalize one Gemini product result.
    """

    if not isinstance(product, dict):
        return None

    product_type = str(
        product.get(
            "product_type",
            "OTHER"
        )
    ).strip().upper()

    if product_type not in PRODUCT_TYPES:
        product_type = "OTHER"

    bbox = _normalize_bbox(
        product.get("bbox")
    )

    if bbox is None:
        return None

    try:
        confidence = float(
            product.get(
                "confidence",
                0
            )
        )
    except (
        TypeError,
        ValueError
    ):
        confidence = 0.0

    confidence = _clamp(
        confidence
    )

    visibility = str(
        product.get(
            "visibility",
            "VISIBLE"
        )
    ).strip().upper()

    if visibility not in {
        "VISIBLE",
        "PARTIAL",
        "OCCLUDED"
    }:
        visibility = "VISIBLE"

    product_name_hint = str(
        product.get(
            "product_name_hint",
            ""
        )
    ).strip()

    reason = str(
        product.get(
            "reason",
            ""
        )
    ).strip()

    return {
        "product_type": product_type,
        "product_name_hint": product_name_hint,
        "confidence": round(
            confidence,
            4
        ),
        "bbox": bbox,
        "visibility": visibility,
        "reason": reason,
    }


def _remove_duplicate_products(
    products: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    Remove exact duplicate detections.

    We intentionally use a conservative rule here.

    Two products of the same type are allowed if their bounding
    boxes are different.
    """

    unique = []

    seen = set()

    for product in products:

        key = (
            product["product_type"],
            tuple(
                product["bbox"]
            )
        )

        if key in seen:
            continue

        seen.add(key)
        unique.append(product)

    return unique


def _validate_products(
    products: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    Remove invalid detections and sort by confidence.
    """

    valid = []

    for product in products:

        if not isinstance(
            product,
            dict
        ):
            continue

        if product.get(
            "confidence",
            0
        ) < 0.30:
            continue

        bbox = product.get(
            "bbox"
        )

        if not bbox:
            continue

        valid.append(
            product
        )

    valid.sort(
        key=lambda item: item.get(
            "confidence",
            0
        ),
        reverse=True
    )

    return valid


# ============================================================
# GEMINI CALL
# ============================================================

def _call_gemini(
    image_path: Path
) -> Dict[str, Any]:
    """
    Send the applied image to the existing Gemini service.

    This function intentionally keeps Gemini access isolated so
    the detector can later be tested with a mock response.
    """

    image_path = Path(
        image_path
    )

    if not image_path.exists():
        raise FileNotFoundError(
            f"Scene image not found: {image_path}"
        )

    try:
        image = Image.open(
            image_path
        )

        image.load()

    except Exception as error:
        raise RuntimeError(
            f"Unable to open scene image: {error}"
        ) from error

    prompt = (
        SYSTEM_PROMPT
        + "\n\n"
        + "Analyze the supplied image now."
        + "\nReturn JSON only."
    )

    # --------------------------------------------------------
    # Existing Gemini service
    # --------------------------------------------------------
    #
    # We support a few common service APIs so that this new
    # module does not force changes into the existing Gemini
    # implementation.
    #

    if hasattr(
        gemini_service,
        "generate_structured_response"
    ):
        response = (
            gemini_service
            .generate_structured_response(
                image=image,
                prompt=prompt,
                schema=RESPONSE_SCHEMA
            )
        )

    elif hasattr(
        gemini_service,
        "generate_json"
    ):
        response = (
            gemini_service
            .generate_json(
                image=image,
                prompt=prompt,
                schema=RESPONSE_SCHEMA
            )
        )

    elif hasattr(
        gemini_service,
        "analyze_image"
    ):
        response = (
            gemini_service
            .analyze_image(
                image_path=image_path,
                prompt=prompt,
                schema=RESPONSE_SCHEMA
            )
        )

    else:
        raise RuntimeError(
            "Existing gemini_service does not expose a "
            "supported structured-image method. "
            "Add an adapter here instead of changing the "
            "rest of the project."
        )

    if isinstance(
        response,
        str
    ):
        try:
            response = json.loads(
                response
            )
        except json.JSONDecodeError as error:
            raise RuntimeError(
                "Gemini returned invalid JSON."
            ) from error

    if not isinstance(
        response,
        dict
    ):
        raise RuntimeError(
            "Gemini response must be a dictionary."
        )

    return response


# ============================================================
# PUBLIC API
# ============================================================

def detect_scene_products(
    image_path: str | Path
) -> Dict[str, Any]:
    """
    Detect all visible bathroom products.

    Returns:

    {
        "is_scene_image": true,
        "scene_type": "BATHROOM",
        "product_count": 4,
        "products": [...]
    }
    """

    image_path = Path(
        image_path
    )

    raw_result = _call_gemini(
        image_path
    )

    is_scene_image = bool(
        raw_result.get(
            "is_scene_image",
            False
        )
    )

    scene_type = str(
        raw_result.get(
            "scene_type",
            "UNKNOWN"
        )
    ).strip().upper()

    raw_products = raw_result.get(
        "products",
        []
    )

    if not isinstance(
        raw_products,
        list
    ):
        raw_products = []

    products = []

    for raw_product in raw_products:

        product = _normalize_product(
            raw_product
        )

        if product is None:
            continue

        products.append(
            product
        )

    products = (
        _remove_duplicate_products(
            products
        )
    )

    products = (
        _validate_products(
            products
        )
    )

    return {
        "is_scene_image": (
            is_scene_image
        ),
        "scene_type": scene_type,
        "product_count": len(
            products
        ),
        "products": products,
    }


# ============================================================
# DEBUG PRINT
# ============================================================

def print_detection_result(
    result: Dict[str, Any]
) -> None:

    print()
    print("=" * 70)
    print("SCENE PRODUCT DETECTION")
    print("=" * 70)

    print(
        f"Scene image : "
        f"{result.get('is_scene_image')}"
    )

    print(
        f"Scene type  : "
        f"{result.get('scene_type')}"
    )

    print(
        f"Products    : "
        f"{result.get('product_count')}"
    )

    print()

    for index, product in enumerate(
        result.get(
            "products",
            []
        ),
        start=1
    ):

        print(
            f"{index}. "
            f"{product['product_type']} "
            f"| confidence="
            f"{product['confidence']:.2f}"
        )

        print(
            f"   bbox: "
            f"{product['bbox']}"
        )

        if product.get(
            "product_name_hint"
        ):
            print(
                f"   hint: "
                f"{product['product_name_hint']}"
            )

    print()
    print("=" * 70)


# ============================================================
# CLI
# ============================================================

def main() -> None:

    import argparse

    parser = argparse.ArgumentParser(
        description=(
            "Detect all bathroom products "
            "in an applied scene image."
        )
    )

    parser.add_argument(
        "image",
        help=(
            "Path to the applied bathroom "
            "image."
        )
    )

    args = parser.parse_args()

    result = detect_scene_products(
        args.image
    )

    print_detection_result(
        result
    )


if __name__ == "__main__":
    main()