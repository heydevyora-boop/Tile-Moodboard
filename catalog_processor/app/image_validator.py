import math


# ============================================================
# ALLOWED TILE TYPES
# ============================================================

# Tile-only. Deliberately NARROWER than gemini_service.ALLOWED_PRODUCT_TYPES:
# that set also admits mirrors, sanitaryware and fittings for the other
# pipeline, and the pen-drive catalog extractor must never turn a basin, WC,
# tap or mirror into a Tile row.
#
# TILE_SLAB/SLAB are included because a slab shown as the actual product is a
# wanted standalone tile product; they are listed in the classifier prompt's
# tile vocabulary too, so they are real values rather than guesses.
ALLOWED_TILE_TYPES = {
    "TILE",
    "TILE_SAMPLE",
    "TILE_SLAB",
    "SLAB",
    "MOSAIC_TILE",
    "STONE_TILE",
    "MARBLE_TILE",
    "PORCELAIN_TILE",
    "CERAMIC_TILE",
}


# Returned when the classifier could not reach a verdict at all -- Gemini
# quota exhausted, rate limited, or otherwise unavailable. It is NOT a
# rejection: nothing has judged the image, so the only honest answer is
# "not decided yet, ask again later".
#
# The string matches catalog_pipeline.STATUS_REVIEW_REQUIRED's vocabulary
# so both pipelines describe this state the same way.
DECISION_REVIEW = "REVIEW"
DECISION_APPROVED = "APPROVED"
DECISION_REJECTED = "REJECTED"


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
    # RULE 0
    #
    # Did the classifier actually reach a verdict?
    #
    # When Gemini is quota-exhausted or rate limited,
    # analyze_product_image returns decision="REVIEW" with
    # image_type="UNKNOWN" and is_product_image=False -- not because the
    # image was examined and found wanting, but because it was never
    # examined at all.
    #
    # Reading only image_type/is_product_image below cannot tell that
    # apart from a genuine "this is a bathroom photo" rejection, and
    # collapsing the two makes an unreviewed image indistinguishable
    # from a refused one. Callers then delete a perfectly good tile
    # because the API ran out of quota. So the undecided case is passed
    # through as its own verdict and left for the caller to handle.
    # ========================================================

    decision = str(
        getattr(
            gemini_result,
            "decision",
            ""
        )
        or ""
    ).strip().upper()

    if decision == DECISION_REVIEW:

        return {

            "decision":
                DECISION_REVIEW,

            "reason":
                reason
                or
                (
                    "Classification did not run; "
                    "the image has not been judged."
                )
        }

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