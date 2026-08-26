import math


# ============================================================
# ALLOWED TILE TYPES
# ============================================================

ALLOWED_TILE_TYPES = {
    "TILE",
    "TILE_SAMPLE",
    "STONE_TILE",
    "MARBLE_TILE",
    "PORCELAIN_TILE",
    "CERAMIC_TILE",
}


# ============================================================
# PRODUCT DECISION VALIDATOR
#
# IMPORTANT:
#
# NO IMAGE SIZE CHECK
# NO ASPECT RATIO CHECK
# NO CV THRESHOLD
# NO PRODUCT NAME REQUIREMENT
# NO CONFIDENCE THRESHOLD
# ============================================================

def validate_product_decision(
    cv_score,
    gemini_result
):

    image_type = str(
        getattr(
            gemini_result,
            "image_type",
            ""
        )
        or ""
    ).strip().upper()

    is_product = bool(
        getattr(
            gemini_result,
            "is_product_image",
            False
        )
    )

    confidence = getattr(
        gemini_result,
        "confidence",
        0.0
    )

    try:

        confidence = float(
            confidence
        )

    except (
        TypeError,
        ValueError
    ):

        confidence = 0.0

    confidence = max(
        0.0,
        min(
            1.0,
            confidence
        )
    )

    reason = (
        getattr(
            gemini_result,
            "reason",
            ""
        )
        or ""
    )

    # ========================================================
    # RULE 1
    #
    # It MUST be a tile type.
    # ========================================================

    if image_type not in ALLOWED_TILE_TYPES:

        return {

            "decision":
                "REJECTED",

            "reason":
                reason
                or
                (
                    "Image is not classified as "
                    "a standalone tile."
                )
        }

    # ========================================================
    # RULE 2
    #
    # Gemini must identify it as a product image.
    # ========================================================

    if not is_product:

        return {

            "decision":
                "REJECTED",

            "reason":
                reason
                or
                (
                    "Image does not show a "
                    "standalone tile product."
                )
        }

    # ========================================================
    # RULE 3
    #
    # No product name requirement.
    # ========================================================

    # ========================================================
    # RULE 4
    #
    # No confidence threshold.
    #
    # Confidence is stored for information only.
    # ========================================================

    return {

        "decision":
            "APPROVED",

        "reason":
            reason
            or
            "Standalone tile product detected."
    }


# ============================================================
# BBOX VALIDATOR
#
# ONLY validates coordinates.
#
# NO SIZE FILTER.
# NO ASPECT RATIO FILTER.
# ============================================================

def validate_bbox(
    bbox,
    image_width,
    image_height
):

    if not bbox:

        return {

            "valid":
                False,

            "reason":
                "No bounding box returned."
        }

    # ========================================================
    # Normalize dictionary/list
    # ========================================================

    try:

        if isinstance(
            bbox,
            dict
        ):

            x1 = float(
                bbox.get(
                    "x1",
                    0
                )
            )

            y1 = float(
                bbox.get(
                    "y1",
                    0
                )
            )

            x2 = float(
                bbox.get(
                    "x2",
                    1
                )
            )

            y2 = float(
                bbox.get(
                    "y2",
                    1
                )
            )

        elif isinstance(
            bbox,
            (list, tuple)
        ):

            if len(bbox) < 4:

                return {

                    "valid":
                        False,

                    "reason":
                        "Bounding box must contain 4 values."
                }

            x1 = float(
                bbox[0]
            )

            y1 = float(
                bbox[1]
            )

            x2 = float(
                bbox[2]
            )

            y2 = float(
                bbox[3]
            )

        else:

            return {

                "valid":
                    False,

                "reason":
                    "Invalid bounding box structure."
            }

    except (
        TypeError,
        ValueError
    ):

        return {

            "valid":
                False,

            "reason":
                "Bounding box contains invalid values."
        }

    # ========================================================
    # Finite numbers
    # ========================================================

    values = [
        x1,
        y1,
        x2,
        y2
    ]

    if not all(
        math.isfinite(
            value
        )
        for value in values
    ):

        return {

            "valid":
                False,

            "reason":
                "Bounding box contains non-finite values."
        }

    # ========================================================
    # Determine normalized vs pixel coordinates
    # ========================================================

    if all(
        0.0 <= value <= 1.0
        for value in values
    ):

        # Gemini normalized coordinates

        x1 *= image_width
        x2 *= image_width

        y1 *= image_height
        y2 *= image_height

    # ========================================================
    # Pixel coordinates
    # ========================================================

    # Clamp ONLY because coordinates must remain
    # inside the actual image.
    #
    # This is NOT a size/aspect filter.

    x1 = max(
        0.0,
        min(
            float(image_width),
            x1
        )
    )

    y1 = max(
        0.0,
        min(
            float(image_height),
            y1
        )
    )

    x2 = max(
        0.0,
        min(
            float(image_width),
            x2
        )
    )

    y2 = max(
        0.0,
        min(
            float(image_height),
            y2
        )
    )

    # ========================================================
    # Coordinate ordering
    # ========================================================

    if x2 <= x1:

        return {

            "valid":
                False,

            "reason":
                "Invalid horizontal bbox coordinates."
        }

    if y2 <= y1:

        return {

            "valid":
                False,

            "reason":
                "Invalid vertical bbox coordinates."
        }

    # ========================================================
    # RETURN
    # ========================================================

    return {

        "valid":
            True,

        "bbox": {

            "x1":
                x1,

            "y1":
                y1,

            "x2":
                x2,

            "y2":
                y2
        }
    }