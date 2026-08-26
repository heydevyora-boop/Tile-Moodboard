


"""
scene_product_cropper.py

Extracts individual product images from an applied scene image
using product bounding boxes produced by scene_product_detector.py.

Pipeline:

Applied Scene Image
        ↓
Scene Product Detector
        ↓
Product Bounding Boxes
        ↓
Scene Product Cropper
        ↓
Individual Product Images
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image


# ============================================================
# CONFIGURATION
# ============================================================

DEFAULT_PADDING = 8

SUPPORTED_IMAGE_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".bmp",
}


# ============================================================
# BASIC HELPERS
# ============================================================

def _clean_text(value: Any) -> str:
    """
    Convert a value into a clean string.
    """
    if value is None:
        return ""

    return str(value).strip()


def _safe_filename(value: str) -> str:
    """
    Make a string safe for use as a filename.
    """
    value = _clean_text(value)

    if not value:
        return "PRODUCT"

    allowed = []

    for char in value:
        if char.isalnum() or char in ("-", "_"):
            allowed.append(char)
        else:
            allowed.append("_")

    return "".join(allowed)


def _generate_crop_id() -> str:
    """
    Generate a unique crop ID.
    """
    return f"CROP_{uuid.uuid4().hex[:12].upper()}"


# ============================================================
# IMAGE VALIDATION
# ============================================================

def validate_image_path(image_path: str | Path) -> Path:
    """
    Validate that the source image exists and is supported.
    """
    path = Path(image_path)

    if not path.exists():
        raise FileNotFoundError(
            f"Scene image not found: {path}"
        )

    if not path.is_file():
        raise ValueError(
            f"Scene image path is not a file: {path}"
        )

    if path.suffix.lower() not in SUPPORTED_IMAGE_EXTENSIONS:
        raise ValueError(
            f"Unsupported image format: {path.suffix}"
        )

    return path


# ============================================================
# BOUNDING BOX EXTRACTION
# ============================================================

def _get_bbox_from_detection(
    detection: Dict[str, Any]
) -> Optional[Tuple[float, float, float, float]]:
    """
    Extract a bounding box from a detector record.

    Supported formats:

    1.
    {
        "bounding_box": {
            "x1": ...,
            "y1": ...,
            "x2": ...,
            "y2": ...
        }
    }

    2.
    {
        "bbox": {
            "x": ...,
            "y": ...,
            "width": ...,
            "height": ...
        }
    }

    3.
    {
        "bounding_box": [x1, y1, x2, y2]
    }

    4.
    {
        "bbox": [x1, y1, x2, y2]
    }

    5.
    {
        "x1": ...,
        "y1": ...,
        "x2": ...,
        "y2": ...
    }

    6.
    {
        "x": ...,
        "y": ...,
        "width": ...,
        "height": ...
    }
    """

    # --------------------------------------------------------
    # Direct x1/y1/x2/y2
    # --------------------------------------------------------

    if all(
        key in detection
        for key in ("x1", "y1", "x2", "y2")
    ):
        return (
            float(detection["x1"]),
            float(detection["y1"]),
            float(detection["x2"]),
            float(detection["y2"]),
        )

    # --------------------------------------------------------
    # Direct x/y/width/height
    # --------------------------------------------------------

    if all(
        key in detection
        for key in ("x", "y", "width", "height")
    ):
        x = float(detection["x"])
        y = float(detection["y"])
        width = float(detection["width"])
        height = float(detection["height"])

        return (
            x,
            y,
            x + width,
            y + height,
        )

    # --------------------------------------------------------
    # Nested bounding_box / bbox
    # --------------------------------------------------------

    for key in ("bounding_box", "bbox", "box"):

        box = detection.get(key)

        if box is None:
            continue

        # ----------------------------------------------------
        # List / tuple
        # ----------------------------------------------------

        if isinstance(box, (list, tuple)):

            if len(box) != 4:
                continue

            try:
                values = [float(value) for value in box]
            except (TypeError, ValueError):
                continue

            return (
                values[0],
                values[1],
                values[2],
                values[3],
            )

        # ----------------------------------------------------
        # Dictionary
        # ----------------------------------------------------

        if isinstance(box, dict):

            if all(
                k in box
                for k in ("x1", "y1", "x2", "y2")
            ):
                return (
                    float(box["x1"]),
                    float(box["y1"]),
                    float(box["x2"]),
                    float(box["y2"]),
                )

            if all(
                k in box
                for k in ("x", "y", "width", "height")
            ):
                x = float(box["x"])
                y = float(box["y"])
                width = float(box["width"])
                height = float(box["height"])

                return (
                    x,
                    y,
                    x + width,
                    y + height,
                )

    return None


# ============================================================
# DETECTOR RECORD NORMALIZATION
# ============================================================

def normalize_detection(
    detection: Dict[str, Any],
    index: int,
) -> Dict[str, Any]:
    """
    Normalize a detector product record.

    The detector can use different field names.
    This function gives the cropper one stable structure.
    """

    if not isinstance(detection, dict):
        raise ValueError(
            f"Detection #{index + 1} must be a dictionary."
        )

    product_id = (
        detection.get("product_id")
        or detection.get("id")
        or detection.get("product")
        or f"DETECTED_PRODUCT_{index + 1:03d}"
    )

    product_type = (
        detection.get("product_type")
        or detection.get("type")
        or detection.get("category")
        or ""
    )

    confidence = (
        detection.get("confidence")
        or detection.get("score")
    )

    bbox = _get_bbox_from_detection(detection)

    if bbox is None:
        raise ValueError(
            f"No bounding box found for detection "
            f"#{index + 1} ({product_id})."
        )

    return {
        "product_id": _clean_text(product_id),
        "product_type": _clean_text(product_type),
        "confidence": confidence,
        "bbox": bbox,
        "original_detection": detection,
    }


# ============================================================
# COORDINATE NORMALIZATION
# ============================================================

def convert_bbox_to_pixels(
    bbox: Tuple[float, float, float, float],
    image_width: int,
    image_height: int,
    coordinate_mode: str = "auto",
) -> Tuple[int, int, int, int]:
    """
    Convert a bounding box into pixel coordinates.

    Supported coordinate modes:

    pixel
        Coordinates already represent pixels.

    normalized
        Coordinates are 0.0 - 1.0.

    percent
        Coordinates are 0 - 100.

    gemini
        Coordinates are 0 - 1000.

    auto
        Detect the likely format automatically.
    """

    x1, y1, x2, y2 = bbox

    mode = coordinate_mode.lower().strip()

    # --------------------------------------------------------
    # Automatic detection
    # --------------------------------------------------------

    if mode == "auto":

        maximum = max(
            abs(x1),
            abs(y1),
            abs(x2),
            abs(y2),
        )

        if maximum <= 1.0:
            mode = "normalized"

        elif maximum <= 100.0:
            mode = "percent"

        elif maximum <= 1000.0:
            mode = "gemini"

        else:
            mode = "pixel"

    # --------------------------------------------------------
    # Normalized 0-1
    # --------------------------------------------------------

    if mode == "normalized":

        x1 *= image_width
        x2 *= image_width

        y1 *= image_height
        y2 *= image_height

    # --------------------------------------------------------
    # Percentage 0-100
    # --------------------------------------------------------

    elif mode == "percent":

        x1 = (x1 / 100.0) * image_width
        x2 = (x2 / 100.0) * image_width

        y1 = (y1 / 100.0) * image_height
        y2 = (y2 / 100.0) * image_height

    # --------------------------------------------------------
    # Gemini-style 0-1000
    # --------------------------------------------------------

    elif mode == "gemini":

        x1 = (x1 / 1000.0) * image_width
        x2 = (x2 / 1000.0) * image_width

        y1 = (y1 / 1000.0) * image_height
        y2 = (y2 / 1000.0) * image_height

    elif mode != "pixel":

        raise ValueError(
            f"Unsupported coordinate mode: {coordinate_mode}"
        )

    # --------------------------------------------------------
    # Convert to integers
    # --------------------------------------------------------

    x1 = int(round(x1))
    y1 = int(round(y1))
    x2 = int(round(x2))
    y2 = int(round(y2))

    # --------------------------------------------------------
    # Correct reversed coordinates
    # --------------------------------------------------------

    if x2 < x1:
        x1, x2 = x2, x1

    if y2 < y1:
        y1, y2 = y2, y1

    # --------------------------------------------------------
    # Clamp to image
    # --------------------------------------------------------

    x1 = max(0, min(x1, image_width))
    x2 = max(0, min(x2, image_width))

    y1 = max(0, min(y1, image_height))
    y2 = max(0, min(y2, image_height))

    return x1, y1, x2, y2


# ============================================================
# CROP VALIDATION
# ============================================================

def validate_crop_box(
    crop_box: Tuple[int, int, int, int]
) -> None:
    """
    Validate a pixel crop box.
    """

    x1, y1, x2, y2 = crop_box

    if x2 <= x1:
        raise ValueError(
            f"Invalid crop width: {crop_box}"
        )

    if y2 <= y1:
        raise ValueError(
            f"Invalid crop height: {crop_box}"
        )


# ============================================================
# SINGLE PRODUCT CROP
# ============================================================

def crop_product(
    image: Image.Image,
    detection: Dict[str, Any],
    output_dir: str | Path,
    index: int,
    coordinate_mode: str = "auto",
    padding: int = DEFAULT_PADDING,
) -> Dict[str, Any]:
    """
    Crop one detected product from the scene image.
    """

    normalized = normalize_detection(
        detection,
        index,
    )

    product_id = normalized["product_id"]
    product_type = normalized["product_type"]
    confidence = normalized["confidence"]
    bbox = normalized["bbox"]

    width, height = image.size

    # --------------------------------------------------------
    # Convert coordinates
    # --------------------------------------------------------

    x1, y1, x2, y2 = convert_bbox_to_pixels(
        bbox=bbox,
        image_width=width,
        image_height=height,
        coordinate_mode=coordinate_mode,
    )

    # --------------------------------------------------------
    # Apply padding
    # --------------------------------------------------------

    x1 = max(0, x1 - padding)
    y1 = max(0, y1 - padding)

    x2 = min(width, x2 + padding)
    y2 = min(height, y2 + padding)

    crop_box = (
        x1,
        y1,
        x2,
        y2,
    )

    validate_crop_box(crop_box)

    # --------------------------------------------------------
    # Crop
    # --------------------------------------------------------

    cropped_image = image.crop(crop_box)

    if cropped_image.width <= 0:
        raise ValueError(
            f"Crop produced zero width for {product_id}"
        )

    if cropped_image.height <= 0:
        raise ValueError(
            f"Crop produced zero height for {product_id}"
        )

    # --------------------------------------------------------
    # Output filename
    # --------------------------------------------------------

    safe_product_id = _safe_filename(
        product_id
    )

    output_dir = Path(output_dir)

    output_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    output_path = (
        output_dir
        / f"{index + 1:03d}_{safe_product_id}.png"
    )

    # --------------------------------------------------------
    # Save
    # --------------------------------------------------------

    cropped_image.save(
        output_path,
        format="PNG",
    )

    # --------------------------------------------------------
    # VERIFY FILE WAS ACTUALLY WRITTEN
    # --------------------------------------------------------

    if not output_path.exists():
        raise RuntimeError(
            f"Crop file was not created: {output_path}"
        )

    if not output_path.is_file():
        raise RuntimeError(
            f"Crop path is not a file: {output_path}"
        )

    if output_path.stat().st_size == 0:
        raise RuntimeError(
            f"Crop file is empty: {output_path}"
        )

    # Verify that the saved file is a valid image.
    try:
        with Image.open(output_path) as saved_image:
            saved_image.verify()
    except Exception as error:
        raise RuntimeError(
            f"Saved crop is not a valid image: {output_path}"
        ) from error

    # --------------------------------------------------------
    # Return record
    # --------------------------------------------------------

    return {
        "crop_id": _generate_crop_id(),
        "product_id": product_id,
        "product_type": product_type,
        "confidence": confidence,
        "image_path": str(output_path),
        "source_image": None,
        "bounding_box": {
            "x1": x1,
            "y1": y1,
            "x2": x2,
            "y2": y2,
            "width": x2 - x1,
            "height": y2 - y1,
        },
        "status": "CROPPED",
    }


# ============================================================
# CROP ALL PRODUCTS
# ============================================================

def crop_scene_products(
    image_path: str | Path,
    detections: List[Dict[str, Any]],
    output_dir: str | Path,
    coordinate_mode: str = "auto",
    padding: int = DEFAULT_PADDING,
) -> Dict[str, Any]:
    """
    Crop every detected product from a scene image.

    Returns:

    {
        "status": "COMPLETED",
        "source_image": "...",
        "product_count": 5,
        "products": [...]
    }
    """

    image_path = validate_image_path(
        image_path
    )

    if not isinstance(detections, list):
        raise ValueError(
            "detections must be a list."
        )

    if not detections:
        raise ValueError(
            "No product detections supplied."
        )

    output_dir = Path(output_dir)

    output_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    # --------------------------------------------------------
    # Open source image
    # --------------------------------------------------------

    with Image.open(image_path) as source:

        image = source.convert("RGB")

        results = []

        for index, detection in enumerate(
            detections
        ):

            result = crop_product(
                image=image,
                detection=detection,
                output_dir=output_dir,
                index=index,
                coordinate_mode=coordinate_mode,
                padding=padding,
            )

            result["source_image"] = str(
                image_path
            )

            results.append(result)

    # --------------------------------------------------------
    # Save metadata
    # --------------------------------------------------------

    metadata_path = (
        output_dir
        / "cropped_products.json"
    )

    payload = {
        "status": "COMPLETED",
        "source_image": str(image_path),
        "product_count": len(results),
        "products": results,
    }

    metadata_path.write_text(
        json.dumps(
            payload,
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    return payload


# ============================================================
# DETECTOR RESULT ADAPTER
# ============================================================

def extract_detections(
    detector_result: Any,
) -> List[Dict[str, Any]]:
    """
    Extract product detections from common detector result
    structures.

    Supported:

    {
        "products": [...]
    }

    {
        "detections": [...]
    }

    {
        "items": [...]
    }

    Or directly:

    [...]
    """

    if isinstance(
        detector_result,
        list,
    ):
        return detector_result

    if not isinstance(
        detector_result,
        dict,
    ):
        raise ValueError(
            "Detector result must be a dictionary or list."
        )

    for key in (
        "products",
        "detections",
        "items",
        "scene_products",
    ):

        value = detector_result.get(key)

        if isinstance(value, list):
            return value

    raise ValueError(
        "Could not find product detections in detector result."
    )


# ============================================================
# CONVENIENCE FUNCTION
# ============================================================

def crop_from_detector_result(
    image_path: str | Path,
    detector_result: Any,
    output_dir: str | Path,
    coordinate_mode: str = "auto",
    padding: int = DEFAULT_PADDING,
) -> Dict[str, Any]:
    """
    Convenience function:

    detector result
          ↓
    extract detections
          ↓
    crop products
    """

    detections = extract_detections(
        detector_result
    )

    return crop_scene_products(
        image_path=image_path,
        detections=detections,
        output_dir=output_dir,
        coordinate_mode=coordinate_mode,
        padding=padding,
    )


# ============================================================
# SIMPLE COMMAND LINE SUPPORT
# ============================================================

def main() -> None:
    """
    Basic CLI usage.

    Example:

    python -m app.scene_product_cropper image.jpg detections.json output
    """

    import argparse

    parser = argparse.ArgumentParser(
        description=(
            "Crop detected scene products "
            "from an applied scene image."
        )
    )

    parser.add_argument(
        "image",
        help="Path to the scene image.",
    )

    parser.add_argument(
        "detections",
        help="Path to detector JSON.",
    )

    parser.add_argument(
        "output",
        help="Output directory.",
    )

    parser.add_argument(
        "--coordinate-mode",
        default="auto",
        choices=[
            "auto",
            "pixel",
            "normalized",
            "percent",
            "gemini",
        ],
    )

    parser.add_argument(
        "--padding",
        type=int,
        default=DEFAULT_PADDING,
    )

    args = parser.parse_args()

    image_path = Path(
        args.image
    )

    detections_path = Path(
        args.detections
    )

    output_dir = Path(
        args.output
    )

    detector_result = json.loads(
        detections_path.read_text(
            encoding="utf-8"
        )
    )

    result = crop_from_detector_result(
        image_path=image_path,
        detector_result=detector_result,
        output_dir=output_dir,
        coordinate_mode=args.coordinate_mode,
        padding=args.padding,
    )

    print("")
    print("=" * 70)
    print("SCENE PRODUCT CROPPER")
    print("=" * 70)

    print(
        f"Source image : {result['source_image']}"
    )

    print(
        f"Products     : {result['product_count']}"
    )

    for product in result["products"]:

        image_path = Path(product["image_path"])

        if not image_path.exists():
            raise RuntimeError(
                f"Crop file missing after pipeline completion: "
                f"{image_path}"
            )

        print(
            f"[PASS] "
            f"{product['product_id']} "
            f"-> "
            f"{image_path} "
            f"| {image_path.stat().st_size} bytes"
        )

    print("")
    print(
        "CROP PIPELINE COMPLETED"
    )

    print("=" * 70)


if __name__ == "__main__":
    main()