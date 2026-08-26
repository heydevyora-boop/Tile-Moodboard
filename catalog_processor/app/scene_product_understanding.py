"""
scene_product_understanding.py

Stage:
    Cropped Product Image
            ↓
    Product Understanding
            ↓
    Structured Product Record

This module does NOT modify the original crop.
It only analyzes the cropped product image and produces metadata.

The product image remains the source asset.
"""

from __future__ import annotations

import json
from pathlib import Path
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


# ============================================================
# PRODUCT TYPES
# ============================================================

SUPPORTED_PRODUCT_TYPES = {
    "TILE",
    "FLOOR_TILE",
    "WALL_TILE",
    "MOSAIC",
    "SANITARYWARE",
    "FAUCET",
    "SHOWER",
    "BATHTUB",
    "BASIN",
    "TOILET",
    "MIRROR",
    "ACCESSORY",
    "FURNITURE",
    "LIGHTING",
    "UNKNOWN",
}


# ============================================================
# DEFAULT PRODUCT RECORD
# ============================================================

def _default_product_record(
    product_id: str,
    image_path: str,
) -> Dict[str, Any]:
    return {
        "product_id": product_id,
        "image_path": image_path,

        "product_type": "UNKNOWN",
        "category": "",
        "subcategory": "",

        "material": "",
        "color": "",
        "finish": "",
        "pattern": "",
        "style": "",

        "shape": "",
        "dimensions": {
            "length": None,
            "width": None,
            "height": None,
            "unit": "",
        },

        "confidence": 0.0,

        "source": "SCENE_CROP",

        "created_at": datetime.now(
            timezone.utc
        ).isoformat(),
    }


# ============================================================
# NORMALIZATION
# ============================================================

def _normalize_text(value: Any) -> str:
    if value is None:
        return ""

    return str(value).strip()


def _normalize_confidence(value: Any) -> float:
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        return 0.0

    return max(0.0, min(1.0, confidence))


def _normalize_product_type(value: Any) -> str:
    value = _normalize_text(value).upper()

    if value in SUPPORTED_PRODUCT_TYPES:
        return value

    aliases = {
        "CERAMIC TILE": "TILE",
        "PORCELAIN TILE": "TILE",
        "FLOORING TILE": "FLOOR_TILE",
        "WALL": "WALL_TILE",
        "WALL TILES": "WALL_TILE",
        "FLOOR": "FLOOR_TILE",
        "BASIN SINK": "BASIN",
        "SINK": "BASIN",
        "WASH BASIN": "BASIN",
        "WC": "TOILET",
        "COMMODE": "TOILET",
        "TAP": "FAUCET",
        "TAPS": "FAUCET",
        "SHOWER MIXER": "SHOWER",
        "BATH": "BATHTUB",
    }

    return aliases.get(value, "UNKNOWN")


# ============================================================
# RECORD NORMALIZATION
# ============================================================

def normalize_product_record(
    product_id: str,
    image_path: str,
    data: Optional[Dict[str, Any]],
) -> Dict[str, Any]:

    record = _default_product_record(
        product_id,
        image_path,
    )

    if not isinstance(data, dict):
        return record

    record["product_type"] = _normalize_product_type(
        data.get("product_type")
    )

    record["category"] = _normalize_text(
        data.get("category")
    )

    record["subcategory"] = _normalize_text(
        data.get("subcategory")
    )

    record["material"] = _normalize_text(
        data.get("material")
    )

    record["color"] = _normalize_text(
        data.get("color")
    )

    record["finish"] = _normalize_text(
        data.get("finish")
    )

    record["pattern"] = _normalize_text(
        data.get("pattern")
    )

    record["style"] = _normalize_text(
        data.get("style")
    )

    record["shape"] = _normalize_text(
        data.get("shape")
    )

    record["confidence"] = _normalize_confidence(
        data.get("confidence")
    )

    dimensions = data.get("dimensions")

    if isinstance(dimensions, dict):
        record["dimensions"] = {
            "length": dimensions.get("length"),
            "width": dimensions.get("width"),
            "height": dimensions.get("height"),
            "unit": _normalize_text(
                dimensions.get("unit")
            ),
        }

    return record


# ============================================================
# OFFLINE PRODUCT UNDERSTANDING
# ============================================================

def analyze_product_image_offline(
    product_id: str,
    image_path: str,
) -> Dict[str, Any]:
    """
    Offline-safe analyzer.

    This function does not call Gemini.

    It validates the crop and creates a structured
    product record.

    Actual AI classification can be plugged in later.
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

    if path.stat().st_size == 0:
        raise ValueError(
            f"Product image is empty: {path}"
        )

    record = _default_product_record(
        product_id,
        str(path),
    )

    return record


# ============================================================
# AI RESULT INTEGRATION
# ============================================================

def build_product_record(
    product_id: str,
    image_path: str,
    ai_result: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Convert an AI classification result into the
    project's canonical product record.
    """

    return normalize_product_record(
        product_id=product_id,
        image_path=image_path,
        data=ai_result or {},
    )


# ============================================================
# BATCH PROCESSING
# ============================================================

def analyze_cropped_products(
    crop_metadata: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """
    Process all crops produced by scene_product_cropper.py.

    Expected metadata formats supported:

    {
        "products": [
            {
                "product_id": "TEST-P001",
                "image_path": "..."
            }
        ]
    }

    OR

    {
        "crops": [
            {
                "product_id": "TEST-P001",
                "image_path": "..."
            }
        ]
    }
    """

    if not isinstance(crop_metadata, dict):
        raise ValueError(
            "crop_metadata must be a dictionary"
        )

    products = crop_metadata.get("products")

    if not isinstance(products, list):
        products = crop_metadata.get("crops")

    if not isinstance(products, list):
        raise ValueError(
            "crop metadata must contain 'products' or 'crops'"
        )

    results = []

    for item in products:

        if not isinstance(item, dict):
            continue

        product_id = _normalize_text(
            item.get("product_id")
        )

        image_path = _normalize_text(
            item.get("image_path")
        )

        if not product_id:
            raise ValueError(
                "Crop is missing product_id"
            )

        if not image_path:
            raise ValueError(
                f"Crop {product_id} is missing image_path"
            )

        result = analyze_product_image_offline(
            product_id=product_id,
            image_path=image_path,
        )

        results.append(result)

    return results


# ============================================================
# SAVE PRODUCT UNDERSTANDING
# ============================================================

def save_product_understanding(
    records: List[Dict[str, Any]],
    output_path: str | Path,
) -> Path:

    if not isinstance(records, list):
        raise ValueError(
            "records must be a list"
        )

    output_path = Path(output_path)

    output_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    payload = {
        "product_count": len(records),
        "products": records,
        "created_at": datetime.now(
            timezone.utc
        ).isoformat(),
    }

    output_path.write_text(
        json.dumps(
            payload,
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    return output_path


# ============================================================
# SIMPLE SINGLE-PRODUCT API
# ============================================================

def identify_product(
    product_id: str,
    image_path: str,
    ai_result: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:

    if not product_id:
        raise ValueError(
            "product_id is required"
        )

    if not image_path:
        raise ValueError(
            "image_path is required"
        )

    path = Path(image_path)

    if not path.exists():
        raise FileNotFoundError(
            f"Image does not exist: {path}"
        )

    return build_product_record(
        product_id=product_id,
        image_path=str(path),
        ai_result=ai_result,
    )


# ============================================================
# END
# ============================================================