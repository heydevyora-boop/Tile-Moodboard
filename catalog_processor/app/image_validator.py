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
# TILE PURITY GATE
#
# validate_product_decision above answers "is this image ABOUT a tile
# product?". That is the wrong question for deciding what pixels to
# save, and asking only it is what put a kitchen, a caption and a
# person into the catalog:
#
#   a bathroom photo with a girl in front of a tiled wall IS about a
#   tile product -- the classifier is even instructed to approve a
#   product "occupying only part of the image" -- so it was approved,
#   and the girl was saved with it.
#
# This gate answers the other question: is this frame ACTUALLY a tile
# surface and nothing else? It reads the observations from
# gemini_service.verify_tile_only and applies the rule here, in pure
# code, so the policy can be tested without an API key.
#
# Three outcomes, and the middle one is the point. A dirty frame is NOT
# rejected: the tile in it is real, so the caller is told to go isolate
# it. Rejecting here would recreate the "extract nothing" failure.
# ============================================================

PURITY_CLEAN = "CLEAN"
PURITY_CONTAMINATED = "CONTAMINATED"
PURITY_NOT_TILE = "NOT_TILE"


# The frame must be overwhelmingly tile surface. This is deliberately
# high: the output is a material swatch, and anything that leaves room
# for a sofa in the corner is not one. Tile genuinely present below this
# is not lost -- it routes to isolation instead.
MIN_TILE_FRACTION = 0.80

# Materials that are stone/marble/continuous but are NOT the catalog's
# tile product. Named separately from the generic non-tile materials so
# the log can say why a handsome marble surface was turned down.
SLAB_MATERIALS = {"COUNTERTOP", "STONE_SLAB"}

# A photograph of a BUILDING. Named separately for the same reason: a
# landmark clad in tile draws a confident EXTERIOR detection and a high
# detector score, and neither is evidence that the frame is a tile
# sample. The Dubai Frame is the case this exists for.
ARCHITECTURE_MATERIALS = {"ARCHITECTURE", "BUILDING", "FACADE"}

# What each contamination flag is called in a log line.
CONTAMINANT_LABELS = (
    ("contains_person", "a person"),
    ("contains_text", "text"),
    ("contains_logo", "a logo"),
    ("contains_furniture", "furniture"),
    ("contains_fixture", "a fixture"),
    ("contains_object", "an object"),
)


def describe_contaminants(observation):
    """Names everything the verifier saw that is not tile."""
    return [
        label
        for key, label in CONTAMINANT_LABELS
        if observation.get(key)
    ]


# Materials that mean "I could not tell", as opposed to a positive
# identification of something that is not tile. Only these can be
# overridden by a parent's evidence below.
UNDECIDED_MATERIALS = {"OTHER", "UNKNOWN", ""}


def assess_tile_purity(observation, parent=None):
    """Decides whether one frame is a tile-only swatch.

    `observation` is a gemini_service.verify_tile_only result. Returns
    {state, reason, contaminants} where state is PURITY_CLEAN (save it),
    PURITY_CONTAMINATED (real tile, wrong framing -- go isolate it) or
    PURITY_NOT_TILE (no tile product here).

    `parent` is the observation of the frame this one was cut out of,
    when there is one. It exists for the split path: a candidate judged
    100% TILE that contained two designs gets divided, and the pieces --
    smaller, and stripped of the surrounding context the verifier reads
    material from -- came back OTHER and were thrown away. Both halves
    of a surface that was just called tile cannot stop being tile by
    being looked at separately.

    So a piece may inherit its parent's material, and ONLY when the
    piece's own answer was "I cannot tell". A positive call of
    countertop, stone slab, architecture, painted wall or artwork stands
    on its own and is never overridden -- the piece really might be the
    worktop next to the tile. Everything else the piece is judged on
    itself: its contaminants, its scene reading, its design count.
    """
    material = str(observation.get("material") or "OTHER").strip().upper()
    contaminants = describe_contaminants(observation)

    inherited = False
    if (
        parent is not None
        and material in UNDECIDED_MATERIALS
        and str(parent.get("material") or "").strip().upper() == "TILE"
    ):
        try:
            parent_fraction = float(parent.get("tile_fraction", 0.0))
        except (TypeError, ValueError):
            parent_fraction = 0.0

        # Only a parent that was confidently, overwhelmingly tile. A
        # borderline parent has no evidence to lend.
        if parent_fraction >= MIN_TILE_FRACTION:
            material = "TILE"
            inherited = True

    try:
        tile_fraction = float(observation.get("tile_fraction", 0.0))
    except (TypeError, ValueError):
        tile_fraction = 0.0

    # RULE 1 -- the surface has to be tile at all.
    #
    # A countertop and a stone slab get their own message because they
    # are the convincing near-miss: stone, patterned, photogenic, and
    # routinely shot in the same catalogs. They are still not the tile.
    if material in ARCHITECTURE_MATERIALS:
        return {
            "state": PURITY_NOT_TILE,
            "reason": (
                "this is a photograph of a structure, not of a tile "
                "surface -- a landmark clad in tile is still a landmark"
            ),
            "contaminants": contaminants,
        }

    if material in SLAB_MATERIALS:
        return {
            "state": PURITY_NOT_TILE,
            "reason": (
                f"the surface is a {material.lower().replace('_', ' ')}, "
                f"not a tile"
            ),
            "contaminants": contaminants,
        }

    if material != "TILE":
        return {
            "state": PURITY_NOT_TILE,
            "reason": (
                f"the surface is {material.lower().replace('_', ' ')}, "
                f"not tile"
            ),
            "contaminants": contaminants,
        }

    # RULE 2 -- a photograph of a space is never a swatch, however much
    # tile it contains. This is the "complete room / complete wall /
    # complete floor" case: the tile is real, so it routes to isolation.
    if observation.get("is_scene"):
        return {
            "state": PURITY_CONTAMINATED,
            "reason": "this is a view of a space, not a piece of surface",
            "contaminants": contaminants,
        }

    # RULE 3 -- one product per image.
    #
    # A frame showing several different tile designs is a LAYOUT of
    # products, not a product: saved as one swatch it would be a Tile row
    # whose image shows four other tiles alongside the one it names.
    # Contaminated rather than rejected, because those designs are real
    # products -- they just have to be cut out one at a time.
    try:
        distinct_designs = int(observation.get("distinct_tile_designs", 1))
    except (TypeError, ValueError):
        distinct_designs = 1

    if distinct_designs > 1:
        return {
            "state": PURITY_CONTAMINATED,
            "reason": (
                f"{distinct_designs} different tile designs are in this "
                f"frame; each is a separate product and has to be "
                f"extracted on its own"
            ),
            "contaminants": contaminants,
        }

    # RULE 4 -- anything present that is not tile.
    if contaminants:
        return {
            "state": PURITY_CONTAMINATED,
            "reason": f"the frame also contains {', '.join(contaminants)}",
            "contaminants": contaminants,
        }

    # RULE 5 -- mostly tile, but not tile enough.
    if tile_fraction < MIN_TILE_FRACTION:
        return {
            "state": PURITY_CONTAMINATED,
            "reason": (
                f"only {tile_fraction:.0%} of the frame is tile surface, "
                f"below the {MIN_TILE_FRACTION:.0%} minimum"
            ),
            "contaminants": contaminants,
        }

    return {
        "state": PURITY_CLEAN,
        "reason": (
            (
                f"{tile_fraction:.0%} tile surface, nothing else in frame "
                f"(material taken from the candidate it was cut from, "
                f"which read as tile)"
            )
            if inherited else (
                observation.get("reason")
                or f"{tile_fraction:.0%} tile surface, nothing else in frame"
            )
        ),
        "contaminants": [],
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