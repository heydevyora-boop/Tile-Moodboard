import os
import json
import math
import time
from pathlib import Path
from dataclasses import dataclass
from typing import Optional

from dotenv import load_dotenv
from google import genai
from google.genai import types


# ============================================================
# ENVIRONMENT
# ============================================================

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

GEMINI_MODEL = os.getenv(
    "GEMINI_MODEL",
    "gemini-3.1-flash-lite"
)

if not GEMINI_API_KEY:
    raise RuntimeError(
        "GEMINI_API_KEY is missing from .env"
    )


# ============================================================
# GEMINI CALL TRACING
#
# Set GEMINI_DEBUG=1 to have every Gemini call announce itself: which
# stage, which file, which model, whether a response came back, and what
# the response was understood to mean.
#
# This exists because the log could not distinguish "Gemini looked at
# this crop and said it is architecture" from "Gemini was never called,
# or answered something unreadable, and the parser filled in defaults
# that happen to read as a confident rejection". Those need different
# fixes, and no amount of reading the old output told them apart.
#
# Never prints the API key, and never prints image bytes.
# ============================================================

GEMINI_DEBUG = os.getenv("GEMINI_DEBUG", "").strip().lower() in (
    "1", "true", "yes", "on",
)


def _debug(message):
    if GEMINI_DEBUG:
        print(f"[gemini-debug] {message}")


# How long any single Gemini request may take before it is abandoned.
#
# WHY THIS EXISTS: the client was built with no http_options, so the
# SDK's timeout defaulted to None -- meaning generate_content() would
# wait on a stalled connection FOREVER. The retry logic below never
# helped, because a hang raises nothing to retry. A catalog run that
# hit one bad connection sat there until someone pressed Ctrl-C, and
# the KeyboardInterrupt took the whole run down mid-extraction.
#
# A bounded timeout turns that hang into an ordinary transient error.
# "TIMEOUT" is already in GEMINI_TRANSIENT_MARKERS, so the existing
# retry path picks it up, and when the retries are spent the callers
# treat it as "no verdict reached" and DEFER the image rather than
# dropping it. Worst case per image is therefore bounded at roughly
# GEMINI_TRANSIENT_RETRIES x this, plus backoff, instead of unbounded.
GEMINI_REQUEST_TIMEOUT_SECONDS = float(
    os.getenv("GEMINI_REQUEST_TIMEOUT_SECONDS", "45")
)


client = genai.Client(
    api_key=GEMINI_API_KEY,
    http_options=types.HttpOptions(
        # The SDK takes milliseconds.
        timeout=int(GEMINI_REQUEST_TIMEOUT_SECONDS * 1000),
    ),
)


# ============================================================
# GEMINI QUOTA / RATE-LIMIT GUARD
# ============================================================
# When Gemini returns HTTP 429 / RESOURCE_EXHAUSTED, do not keep
# calling the API for every remaining image. The catalog pipeline
# should continue and mark those images for review/retry instead.
#
# This is intentionally process-local. Restarting the application
# resets the flag, which allows a later run to try Gemini again.
# ============================================================

GEMINI_QUOTA_EXHAUSTED = False


def is_quota_exhausted():
    """True once this process has hit Gemini's quota/rate limit.

    Callers use it to skip work that can only end in a deferred verdict --
    every further Gemini call this run returns None immediately, so
    spending time preparing images for classification is pure waste.
    """
    return GEMINI_QUOTA_EXHAUSTED


def _is_gemini_quota_error(error):
    """
    Return True when the Gemini SDK error indicates a quota/rate-limit
    condition (HTTP 429 / RESOURCE_EXHAUSTED).

    Only quota/rate-limit errors are swallowed. Other API/programming
    errors are still raised so real problems are not hidden.
    """

    status_code = getattr(error, "code", None)

    if status_code == 429:
        return True

    status_code = getattr(error, "status_code", None)

    if status_code == 429:
        return True

    message = str(error).upper()

    quota_markers = (
        "429",
        "RESOURCE_EXHAUSTED",
        "QUOTA EXCEEDED",
        "RATE LIMIT",
        "RATE_LIMIT",
        "TOO MANY REQUESTS",
    )

    return any(marker in message for marker in quota_markers)


# A dropped connection or a 5xx is not a verdict about the image. The
# validator fails closed, so an un-retried blip permanently rejects a
# candidate that was never actually classified -- observed in a real run as
# "Gemini validation failed (Server disconnected without sending a
# response.) -- needs review". These markers are matched on the exception
# text to decide whether another attempt is worth making.
GEMINI_TRANSIENT_MARKERS = (
    "SERVER DISCONNECTED",
    "CONNECTION RESET",
    "CONNECTION ABORTED",
    "CONNECTION ERROR",
    "REMOTEDISCONNECTED",
    "REMOTE END CLOSED",
    "BROKEN PIPE",
    "TIMED OUT",
    "TIMEOUT",
    "TEMPORARILY UNAVAILABLE",
    "SERVICE UNAVAILABLE",
    "INTERNAL ERROR",
    "BAD GATEWAY",
    "500",
    "502",
    "503",
    "504",
)

GEMINI_TRANSIENT_RETRIES = 3
GEMINI_TRANSIENT_DELAY = 2


def _is_gemini_transient_error(error) -> bool:
    """True for connection/5xx blips that are worth another attempt.

    Quota errors are deliberately excluded: they are handled by the
    short-circuit below, and retrying a rate limit only makes it worse.
    """

    if _is_gemini_quota_error(error):
        return False

    message = f"{type(error).__name__} {error}".upper()

    return any(marker in message for marker in GEMINI_TRANSIENT_MARKERS)


def _generate_content_safe(*args, **kwargs):
    """
    Call Gemini, retrying only transient connection/5xx failures, unless
    the current process has already hit a quota/rate-limit error.

    Returns:
        Gemini response object on success.
        None when Gemini quota/rate limit is exhausted.

    Raises:
        Original exception for non-quota errors that did not recover.
    """

    global GEMINI_QUOTA_EXHAUSTED

    if GEMINI_QUOTA_EXHAUSTED:
        return None

    attempt = 0

    while True:
        attempt += 1

        try:
            return client.models.generate_content(
                *args,
                **kwargs,
            )

        except Exception as error:

            # Unchanged behaviour: a quota/rate-limit error disables Gemini
            # for the rest of the process and is never retried.
            if _is_gemini_quota_error(error):
                GEMINI_QUOTA_EXHAUSTED = True

                print("")
                print("=" * 70)
                print("GEMINI QUOTA / RATE LIMIT REACHED")
                print("=" * 70)
                print(
                    "Gemini analysis is temporarily unavailable."
                )
                print(
                    "Remaining images will be marked for REVIEW "
                    "instead of stopping the catalog pipeline."
                )
                print(
                    "Restart the process after the quota resets "
                    "to retry Gemini."
                )
                print("=" * 70)
                print("")

                return None

            # A dropped connection is not a verdict about the image. Retry
            # it rather than let the validator fail the candidate closed on
            # a blip. The retried call runs the SAME classification, so no
            # accept/reject criterion is relaxed by getting an answer.
            if (
                attempt < GEMINI_TRANSIENT_RETRIES
                and _is_gemini_transient_error(error)
            ):
                wait_time = GEMINI_TRANSIENT_DELAY * attempt

                print(
                    f"  [tile-validation] transient Gemini error "
                    f"(attempt {attempt}/{GEMINI_TRANSIENT_RETRIES}): "
                    f"{error} -- retrying in {wait_time}s"
                )

                time.sleep(wait_time)
                continue

            raise


# ============================================================
# RESULT
# ============================================================

@dataclass
class ProductAnalysis:

    is_product_image: bool = False

    product_name: Optional[str] = None

    brand: Optional[str] = None

    product_code: Optional[str] = None

    confidence: float = 0.0

    reason: str = ""

    image_type: str = "UNKNOWN"

    decision: str = "REJECTED"

    product_bbox: Optional[list[float]] = None

    # Legacy per-image count. Kept for backward compatibility.
    product_count: int = 0

    # Product-centric V9 fields.
    unique_product_count: int = 0
    duplicate_image_indices: list[int] = None
    primary_image_index: Optional[int] = None
    dimensions: Optional[str] = None


# ============================================================
# ALLOWED PRODUCT TYPES
#
# ONLY THESE TYPES CAN BE SAVED AS PRODUCTS.
# Keep this list explicit so unrelated images are not approved.
# ============================================================

ALLOWED_PRODUCT_TYPES = {
    # Tiles / surfaces
    "TILE",
    "TILE_SAMPLE",
    "TILE_SLAB",
    "SLAB",
    "MOSAIC_TILE",
    "STONE_TILE",
    "MARBLE_TILE",
    "PORCELAIN_TILE",
    "CERAMIC_TILE",

    # Mirrors
    "LED_MIRROR",
    "MIRROR",

    # Bathroom / sanitary products
    "SANITARYWARE",
    "BASIN",
    "WASH_BASIN",
    "TOILET",
    "WC",
    "URINAL",
    "BATHTUB",
    "SHOWER",
    "SHOWER_PANEL",
    "BATHROOM_ACCESSORY",

    # Faucets / fittings
    "FAUCET",
    "TAP",
    "MIXER",
    "SHOWER_MIXER",
    "FITTING",
}


# ============================================================
# BBOX NORMALIZER
#
# IMPORTANT:
# NO SIZE CHECK
# NO ASPECT RATIO CHECK
# ============================================================

def _normalize_bbox(bbox):

    if bbox is None:
        return None

    # --------------------------------------------------------
    # Dictionary
    # --------------------------------------------------------

    if isinstance(bbox, dict):

        try:

            values = [
                float(bbox.get("x1", 0)),
                float(bbox.get("y1", 0)),
                float(bbox.get("x2", 1)),
                float(bbox.get("y2", 1)),
            ]

        except (
            TypeError,
            ValueError
        ):

            return None

    # --------------------------------------------------------
    # List / tuple
    # --------------------------------------------------------

    elif isinstance(
        bbox,
        (list, tuple)
    ):

        if len(bbox) < 4:
            return None

        try:

            values = [
                float(x)
                for x in bbox[:4]
            ]

        except (
            TypeError,
            ValueError
        ):

            return None

    else:

        return None

    # --------------------------------------------------------
    # Normalize to 0..1
    # --------------------------------------------------------

    values = [
        max(
            0.0,
            min(
                1.0,
                value
            )
        )
        for value in values
    ]

    x1, y1, x2, y2 = values

    # --------------------------------------------------------
    # Coordinate validity ONLY
    #
    # This is NOT a size filter.
    # --------------------------------------------------------

    if x2 <= x1:
        return None

    if y2 <= y1:
        return None

    return [
        x1,
        y1,
        x2,
        y2
    ]


# ============================================================
# GEMINI SYSTEM PROMPT
# ============================================================

SYSTEM_PROMPT = """
You are a visual product-image classifier for a PRODUCT CATALOG.

Your ONLY task is to determine whether the supplied image shows ONE
STANDALONE PHYSICAL PRODUCT that should be stored in the product database.

The IMAGE is the primary evidence. Page text is supporting evidence only.

============================================================
APPROVE
============================================================

Approve when the image clearly presents ONE physical catalog product,
including examples such as:
- one standalone tile or tile sample
- one standalone LED mirror or mirror
- one standalone basin / sanitaryware product
- one standalone toilet / WC
- one standalone faucet / tap / mixer
- one standalone shower or bathroom fitting
- one standalone physical product photographed separately

The product may be:
- on a plain background
- on a dark or colored background
- photographed at an angle
- photographed with shadows
- occupying only part of the image
- tall, wide, square, rectangular, or irregular

IMAGE SIZE AND ASPECT RATIO ARE NEVER CLASSIFICATION RULES.

============================================================
REJECT
============================================================

Reject when the image is primarily:
- a room interior
- a bathroom or kitchen scene
- a lifestyle photograph
- an architectural photograph
- an installed product shown as part of a room
- a product being used as furniture
- a countertop, table, wall, floor, or other installation
- multiple different physical products in one image
- a collage of multiple product images
- a color chart or palette
- a logo, brand mark, banner, advertisement, or text graphic
- a decorative object unrelated to the catalog product
- a rendering where the physical standalone product is not clearly presented
- an unrelated photograph

IMPORTANT: A product appearing inside a bathroom or room does NOT become
a standalone product merely because it is visually recognizable.
If it is installed or part of the environment, reject it.

============================================================
IMAGE TYPE
============================================================

Return ONE type. You MUST return EXACTLY one of the values listed below,
copied verbatim. Never invent a new type string, never add prefixes or
suffixes, and never return a type that is not on one of these two lists.
If no listed product type fits, return OTHER.

TILE
TILE_SAMPLE
TILE_SLAB
SLAB
MOSAIC_TILE
STONE_TILE
MARBLE_TILE
PORCELAIN_TILE
CERAMIC_TILE
LED_MIRROR
MIRROR
SANITARYWARE
BASIN
WASH_BASIN
TOILET
WC
URINAL
BATHTUB
SHOWER
SHOWER_PANEL
BATHROOM_ACCESSORY
FAUCET
TAP
MIXER
SHOWER_MIXER
FITTING

For non-product images use one of:
LIFESTYLE
INSTALLATION
ROOM_INTERIOR
LOGO
GRAPHIC
TEXTURE
BANNER
COLLAGE
OTHER
UNKNOWN

MOSAIC -- product sample vs decorative artwork:

Mosaic appears in tile catalogs BOTH as a sellable product and as
decoration, and the two are opposite decisions.

ACCEPT as a product (TILE_SAMPLE or MOSAIC_TILE) when the mosaic is
presented as ONE catalog product: a mosaic sheet, panel or swatch shown by
itself, typically square or rectangular, on a plain or neutral background,
with no room around it. A mosaic being made of many small chips does NOT
make it multiple products -- one mosaic sheet is ONE product.

REJECT when the mosaic is decoration rather than the product being sold:
- a mosaic mural, feature wall or artwork installed in a space
- a mosaic that depicts a picture, scene, face, figure or logo
- a mosaic shown as part of a room, bathroom or building
- a close-up of a mosaic surface with no product boundary, sheet edge or
  catalog presentation visible -- that is a surface texture, not a product

The test is presentation, not pattern. Never reject an image merely for
containing a mosaic pattern.

TEXTURE vs TILE_SAMPLE -- read this carefully, it is the most common
mistake on a tile catalog:

A catalog photograph of ONE tile shot flat and straight-on fills the frame
with tile surface and has no room, no furniture and no depth. That is still
a standalone product photograph. Classify it as TILE_SAMPLE (or the
specific material type) and set is_product_image = true.

Use TEXTURE ONLY for a seamless repeating swatch that is presented as a
background/material graphic rather than as one catalog product -- for
example a pattern that tiles infinitely with no edge, border or product
boundary anywhere in the frame.

Filling the frame is NOT a reason to reject. A tile sample photographed
edge-to-edge is the normal way a tile catalog presents its product.

============================================================
PRODUCT COUNT
============================================================

Set product_count = 1 ONLY when exactly ONE physical catalog product is
clearly represented.

Set product_count = 0 when there is no standalone physical product.

Set product_count >= 2 when multiple distinct physical products are shown.

Do not count text, logos, shadows, or background elements as products.

============================================================
PRODUCT METADATA
============================================================

Use page text and visible information only as supporting evidence.
Never invent product name, brand, product code, or dimensions.
Use null when information is unavailable.

============================================================
BOUNDING BOX
============================================================

For an approved standalone product, return the normalized bounding box of
the actual product. Coordinates are 0.0 to 1.0:
{x1, y1, x2, y2}.

If the entire image is the product, use:
{x1: 0, y1: 0, x2: 1, y2: 1}

For rejected images return product_bbox = null.

============================================================
CONFIDENCE
============================================================

0.90 - 1.00 = extremely clear
0.75 - 0.89 = strong
0.50 - 0.74 = uncertain
below 0.50 = weak

Confidence describes classification certainty, not image size.

============================================================
FINAL RULE
============================================================

Approve ONLY when:
1. is_product_image is true
2. exactly one physical product is represented
3. image_type is in the allowed product types
4. the product is standalone, not installed or merely shown in a room

Return ONLY valid JSON.
"""


# ============================================================
# JSON SCHEMA
# ============================================================

RESPONSE_SCHEMA = {

    "type": "OBJECT",

    "properties": {

        "is_product_image": {
            "type": "BOOLEAN"
        },

        "product_name": {
            "type": "STRING",
            "nullable": True
        },

        "brand": {
            "type": "STRING",
            "nullable": True
        },

        "product_code": {
            "type": "STRING",
            "nullable": True
        },

        "confidence": {
            "type": "NUMBER"
        },

        "reason": {
            "type": "STRING"
        },

        "image_type": {
            "type": "STRING"
        },

        "decision": {
            "type": "STRING"
        },

        "product_count": {
            "type": "INTEGER",
            "description": "Legacy number of physical products visible in one candidate image."
        },

        "unique_product_count": {
            "type": "INTEGER",
            "description": "Number of unique products represented by the supplied image set."
        },

        "primary_image_index": {
            "type": "INTEGER",
            "nullable": True
        },

        "duplicate_image_indices": {
            "type": "ARRAY",
            "items": {"type": "INTEGER"}
        },

        "dimensions": {
            "type": "STRING",
            "nullable": True
        },

        "product_bbox": {

            "type": "OBJECT",

            "nullable": True,

            "properties": {

                "x1": {
                    "type": "NUMBER"
                },

                "y1": {
                    "type": "NUMBER"
                },

                "x2": {
                    "type": "NUMBER"
                },

                "y2": {
                    "type": "NUMBER"
                }
            },

            "required": [
                "x1",
                "y1",
                "x2",
                "y2"
            ]
        }
    },

    "required": [
        "is_product_image",
        "product_name",
        "brand",
        "product_code",
        "confidence",
        "reason",
        "image_type",
        "decision",
        "product_count",
        "product_bbox"
    ]
}

def analyze_text(prompt: str):
    """
    Backward-compatible text analysis entry point.

    Used by the legacy Gemini text test.
    Image/catalog processing should continue using
    analyze_product_image().
    """

    if not prompt or not prompt.strip():
        raise ValueError("Prompt cannot be empty.")

    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=[
            f"""
{SYSTEM_PROMPT}

============================================================
TEXT ANALYSIS REQUEST
============================================================

Analyze the following catalog information:

{prompt}

Return the same JSON structure required by the
ProductAnalysis schema.

Since no image is supplied:

- Do not invent a product.
- Use the supplied text only.
- If the text does not provide enough evidence,
  return UNCERTAIN.
- product_bbox must be null.
"""
        ],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=RESPONSE_SCHEMA,
            temperature=0.0,
        ),
    )

    raw_text = response.text or ""

    if not raw_text:
        raise RuntimeError(
            "Gemini returned an empty response."
        )

    try:
        data = json.loads(raw_text)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"Gemini returned invalid JSON: {error}\n"
            f"Response: {raw_text}"
        )

    confidence = data.get(
        "confidence",
        0.0,
    )

    try:
        confidence = float(confidence)
    except (TypeError, ValueError):
        confidence = 0.0

    confidence = max(
        0.0,
        min(1.0, confidence),
    )

    is_product = bool(
        data.get(
            "is_product_image",
            False,
        )
    )

    decision = str(
        data.get(
            "decision",
            "UNCERTAIN",
        )
    ).strip().upper()

    if is_product and decision == "REJECTED":
        decision = "UNCERTAIN"

    if not is_product and decision == "APPROVED":
        decision = "REJECTED"

    return ProductAnalysis(
        is_product_image=is_product,
        product_name=data.get("product_name"),
        brand=data.get("brand"),
        product_code=data.get("product_code"),
        confidence=confidence,
        reason=str(
            data.get("reason", "")
        ),
        image_type=str(
            data.get(
                "image_type",
                "UNKNOWN",
            )
        ),
        decision=decision,
        product_bbox=None,
    )

# ============================================================
# ANALYZE PRODUCT IMAGE
# ============================================================

def analyze_product_image(
    image_path,
    page_text=""
):

    image_path = Path(
        image_path
    )

    # --------------------------------------------------------
    # FILE CHECK ONLY
    # --------------------------------------------------------

    if not image_path.exists():

        raise FileNotFoundError(
            f"Image not found: {image_path}"
        )

    image_bytes = (
        image_path.read_bytes()
    )

    # --------------------------------------------------------
    # MIME TYPE
    # --------------------------------------------------------

    suffix = (
        image_path
        .suffix
        .lower()
    )

    if suffix in (
        ".jpg",
        ".jpeg"
    ):

        mime_type = "image/jpeg"

    elif suffix == ".png":

        mime_type = "image/png"

    elif suffix == ".webp":

        mime_type = "image/webp"

    else:

        mime_type = "image/jpeg"

    # --------------------------------------------------------
    # PAGE TEXT
    # --------------------------------------------------------

    text_context = (
        page_text or ""
    )

    prompt = f"""
{SYSTEM_PROMPT}

============================================================
CATALOG PAGE CONTEXT
============================================================

The candidate image was extracted from a catalog page.

The following text belongs to that page.

Use it ONLY as supporting evidence for:
- product name
- collection name
- brand
- product code

Do NOT use text to assume that an image is a product.

The IMAGE itself is the primary evidence.

PAGE TEXT:

{text_context[:12000]}

============================================================
UNIQUE PRODUCT RULE
============================================================

When several catalog images represent the same physical product,
do NOT treat them as separate products. The product identity is based
on product code/SKU first, then normalized brand + product name, then
brand + product name + dimensions. Image hashes are only a secondary
safety check.

For multi-image analysis, return exactly ONE primary image for each
unique product and list alternate/repeated representations as
duplicate_image_indices.

Do not invent a product code or product name.

============================================================
FINAL IMAGE TEST
============================================================

Look at the supplied image.

Determine whether the image shows ONE standalone tile
product sample.

Remember:

NO IMAGE SIZE FILTER.

NO ASPECT RATIO FILTER.

NO OPEN-CV THRESHOLD.

A wide, narrow, tall, short, square, rectangular or
irregular standalone tile can be APPROVED.

A tile used as a table, counter, wall, floor, furniture
or part of an environment MUST be REJECTED.

Return ONLY JSON.
"""

    # --------------------------------------------------------
    # GEMINI
    # --------------------------------------------------------

    _debug("CALL")
    _debug("  stage            : product-classify (analyze_product_image)")
    _debug(f"  image/candidate  : {image_path.name} ({len(image_bytes)} bytes)")
    _debug(f"  model            : {GEMINI_MODEL}")

    response = _generate_content_safe(

        model=GEMINI_MODEL,

        contents=[

            types.Part.from_bytes(
                data=image_bytes,
                mime_type=mime_type
            ),

            prompt
        ],

        config=types.GenerateContentConfig(

            response_mime_type="application/json",

            response_schema=RESPONSE_SCHEMA,

            temperature=0.0
        )
    )

    # --------------------------------------------------------
    # QUOTA FALLBACK
    # --------------------------------------------------------
    # Do not stop the catalog pipeline when Gemini is exhausted.
    # The image is deliberately NOT approved automatically.
    # It is marked REVIEW so it can be retried later.
    # --------------------------------------------------------

    if response is None:
        return ProductAnalysis(
            is_product_image=False,
            product_name=None,
            brand=None,
            product_code=None,
            confidence=0.0,
            reason=(
                "Gemini analysis unavailable because the API quota "
                "or rate limit was reached. Image requires retry/review."
            ),
            image_type="UNKNOWN",
            decision="REVIEW",
            product_bbox=None,
            product_count=0,
            unique_product_count=0,
            duplicate_image_indices=[],
            primary_image_index=None,
            dimensions=None,
        )

    # --------------------------------------------------------
    # RESPONSE
    # --------------------------------------------------------

    raw_text = (
        response.text or ""
    )

    if not raw_text:

        raise RuntimeError(
            "Gemini returned empty response."
        )

    try:

        data = json.loads(
            raw_text
        )

    except json.JSONDecodeError as error:

        raise RuntimeError(
            f"Gemini returned invalid JSON: {error}\n"
            f"Response: {raw_text}"
        )

    # ========================================================
    # NORMALIZE
    # ========================================================

    confidence = data.get(
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

    # --------------------------------------------------------
    # Product flag
    # --------------------------------------------------------

    is_product = bool(
        data.get(
            "is_product_image",
            False
        )
    )

    # --------------------------------------------------------
    # PRODUCT COUNT
    # --------------------------------------------------------
    #
    # 0 = no standalone physical product
    # 1 = exactly one standalone physical tile/product
    # 2+ = multiple/repeated products
    #
    # Default is 0.
    # No image-size or aspect-ratio logic is used here.
    # --------------------------------------------------------

    product_count = data.get(
        "product_count",
        0
    )

    try:
        product_count = int(product_count)
    except (TypeError, ValueError):
        product_count = 0

    product_count = max(
        0,
        product_count
    )

    unique_product_count = data.get("unique_product_count", 1 if is_product else 0)
    try:
        unique_product_count = max(0, int(unique_product_count))
    except (TypeError, ValueError):
        unique_product_count = 0

    primary_image_index = data.get("primary_image_index")
    try:
        primary_image_index = int(primary_image_index) if primary_image_index is not None else None
    except (TypeError, ValueError):
        primary_image_index = None

    duplicate_image_indices = data.get("duplicate_image_indices", []) or []
    try:
        duplicate_image_indices = [int(x) for x in duplicate_image_indices]
    except (TypeError, ValueError):
        duplicate_image_indices = []

    dimensions = data.get("dimensions")

    # --------------------------------------------------------
    # Image type
    # --------------------------------------------------------

    image_type = str(
        data.get(
            "image_type",
            "UNKNOWN"
        )
    ).strip().upper()

    # --------------------------------------------------------
    # Decision
    # --------------------------------------------------------

    decision = str(
        data.get(
            "decision",
            "REJECTED"
        )
    ).strip().upper()

    # --------------------------------------------------------
    # HARD PRODUCT SAFETY
    #
    # The model must explicitly classify the image as one of the
    # configured product types. This is deliberately independent of
    # image dimensions, aspect ratio, or OpenCV scores.
    # --------------------------------------------------------

    if (
        is_product
        and image_type in ALLOWED_PRODUCT_TYPES
        and product_count == 1
    ):

        decision = "APPROVED"

    else:

        is_product = False
        decision = "REJECTED"

    # --------------------------------------------------------
    # BBOX
    # --------------------------------------------------------

    bbox = _normalize_bbox(
        data.get(
            "product_bbox"
        )
    )

    # --------------------------------------------------------
    # FINAL SINGLE-PRODUCT SAFETY
    # --------------------------------------------------------
    # Exactly one standalone physical product is required.
    # --------------------------------------------------------

    if product_count != 1:
        is_product = False
        decision = "REJECTED"
        bbox = None

    # --------------------------------------------------------
    # Approved product MUST have bbox
    # --------------------------------------------------------

    if (
        is_product
        and bbox is None
    ):

        # If Gemini says the whole image is the product,
        # use the complete image.
        bbox = [
            0.0,
            0.0,
            1.0,
            1.0
        ]

    # --------------------------------------------------------
    # Rejected image has no bbox
    # --------------------------------------------------------

    if not is_product:

        bbox = None

    # ========================================================
    # RETURN
    # ========================================================

    return ProductAnalysis(

        is_product_image=is_product,

        product_name=data.get(
            "product_name"
        ),

        brand=data.get(
            "brand"
        ),

        product_code=data.get(
            "product_code"
        ),

        confidence=confidence,

        reason=str(
            data.get(
                "reason",
                ""
            )
        ),

        image_type=image_type,

        decision=decision,

        product_bbox=bbox,

        product_count=product_count
    )

# ============================================================
# V9 MULTI-IMAGE UNIQUE PRODUCT ANALYSIS
# ============================================================

PAGE_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "products": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "product_name": {"type": "STRING", "nullable": True},
                    "brand": {"type": "STRING", "nullable": True},
                    "product_code": {"type": "STRING", "nullable": True},
                    "dimensions": {"type": "STRING", "nullable": True},
                    "primary_image_index": {"type": "INTEGER"},
                    "duplicate_image_indices": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                    "confidence": {"type": "NUMBER"},
                    "image_type": {"type": "STRING"},
                    "reason": {"type": "STRING"},
                },
                "required": [
                    "product_name", "brand", "product_code", "dimensions",
                    "primary_image_index", "duplicate_image_indices",
                    "confidence", "image_type", "reason"
                ]
            }
        },
        "rejected_image_indices": {
            "type": "ARRAY", "items": {"type": "INTEGER"}
        },
        "review_image_indices": {
            "type": "ARRAY", "items": {"type": "INTEGER"}
        }
    },
    "required": ["products", "rejected_image_indices", "review_image_indices"]
}


def analyze_product_page(image_records, page_text=""):
    """
    Analyze a group of candidate images together so Gemini can see that
    multiple representations may be the same product.

    Python still owns image_index/processing_id. Gemini only receives the
    already-assigned Python image indexes and never creates IDs.
    """
    parts = []
    labels = []
    for record in image_records:
        path = Path(record["path"])
        if not path.exists():
            continue
        suffix = path.suffix.lower()
        mime = "image/png" if suffix == ".png" else "image/jpeg"
        parts.append(types.Part.from_bytes(data=path.read_bytes(), mime_type=mime))
        labels.append(int(record["image_index"]))
        parts.append(
            f"IMAGE_INDEX={int(record['image_index'])}\n"
            f"PROCESSING_ID={record.get('processing_id', '')}"
        )

    if not parts:
        return {"products": [], "rejected_image_indices": [], "review_image_indices": []}

    prompt = f"""
{SYSTEM_PROMPT}

============================================================
MULTI-IMAGE UNIQUE PRODUCT ANALYSIS
============================================================

You are analyzing multiple candidate images from the SAME catalog page.
The numbers IMAGE_INDEX are assigned by Python and are authoritative.

Your task is to identify UNIQUE physical tile products represented by the
whole image set.

IMPORTANT:
- Several images may show the SAME tile/product.
- Alternate views, repeated crops, detail shots, swatches and duplicate
  representations of the same tile are ONE product, not multiple products.
- Select exactly ONE primary image index for each unique product.
- Put all other image indexes showing that same product into
  duplicate_image_indices.
- Product code/SKU has highest identity priority.
- If code is unavailable, use normalized Brand + Product Name.
- If identity is still ambiguous, do NOT merge aggressively; put the
  uncertain image in review_image_indices.
- A room, installation, furniture, graphic, texture, banner, etc. is not
  a product.
- Do not use image dimensions or aspect ratio as a rejection rule.
- Do not invent names, brands, codes or dimensions.

Return ONLY JSON.

PAGE TEXT:
{page_text[:12000]}

IMAGE INDEXES PRESENT:
{labels}
"""

    response = _generate_content_safe(
        model=GEMINI_MODEL,
        contents=parts + [prompt],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=PAGE_RESPONSE_SCHEMA,
            temperature=0.0,
        ),
    )

    # --------------------------------------------------------
    # QUOTA FALLBACK
    # --------------------------------------------------------
    # Keep the page pipeline alive. Images are sent to REVIEW rather
    # than being silently rejected or incorrectly approved.
    # --------------------------------------------------------

    if response is None:
        return {
            "products": [],
            "rejected_image_indices": [],
            "review_image_indices": labels,
        }

    raw = response.text or ""
    if not raw:
        raise RuntimeError("Gemini returned empty multi-image response.")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Gemini returned invalid multi-image JSON: {error}")

    data.setdefault("products", [])
    data.setdefault("rejected_image_indices", [])
    data.setdefault("review_image_indices", [])
    return data

# ============================================================
# TILE REGION DETECTION
#
# Separate from analyze_product_image on purpose. That function answers
# "is this WHOLE image one standalone tile product", and a bathroom photo
# is correctly a no. This one answers a different question -- "where
# inside this image is there a flat tiled SURFACE" -- so a room scene is
# an expected, useful input rather than a rejection.
#
# It deliberately does NOT decide anything. It locates candidates; each
# extracted region is then put back through the normal strict validator,
# which is what keeps a room scene from ever becoming a Tile row.
# ============================================================

TILE_REGION_PROMPT = """
You locate flat TILED SURFACES inside a photograph. You do not judge
whether the photograph is a product image -- something else does that.

Find every region showing a real tiled/paved/clad surface made of
repeating units: wall tiles, floor tiles, ceiling tiles, terrace, parking,
exterior cladding, or a tile sample board. Interior scenes are normal
input. Report the surface wherever it appears.

For EACH distinct tiled surface return:

- surface: one of WALL, FLOOR, CEILING, EXTERIOR, SAMPLE, OTHER
- quad: the four corners of the flat surface plane, in order
  top-left, top-right, bottom-right, bottom-left, each {x, y} normalized
  0.0-1.0. Follow the real perspective of the plane: for a floor receding
  from the camera the far edge is shorter than the near edge. Cover only
  the tiled plane itself, not the whole photo.
- occluders: bounding boxes {x1, y1, x2, y2} normalized 0.0-1.0 for
  anything sitting ON TOP of that surface and hiding the tile --
  furniture, sofa, table, bed, toilet, basin, shower, taps, mirror,
  cabinets, rugs, plants, people, animals, decorations, appliances, doors,
  windows, text, logos, watermarks. Be generous: a box that is slightly
  too large costs a little tile, a box that is too small leaks furniture
  into the product image. Return [] when the surface is clear.
- confidence: 0.0-1.0 that this really is a tiled surface.

Rules:

Return a SEPARATE entry per distinct tiled surface. A room whose wall and
floor use different tiles is two entries. Do not return the same surface
twice.

Only report a surface where you can actually see repeating tile units or
tile joints. A plain painted wall, a bare concrete floor, a wooden floor,
a carpet, a curtain, a worktop or a single flat colour is NOT a tiled
surface -- omit it entirely.

If the image contains no tiled surface at all, return an empty list.
Never invent a region to have something to return.

Return ONLY valid JSON.
"""


TILE_REGION_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "regions": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "surface": {"type": "STRING"},
                    "confidence": {"type": "NUMBER"},
                    "quad": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "x": {"type": "NUMBER"},
                                "y": {"type": "NUMBER"},
                            },
                            "required": ["x", "y"],
                        },
                    },
                    "occluders": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "x1": {"type": "NUMBER"},
                                "y1": {"type": "NUMBER"},
                                "x2": {"type": "NUMBER"},
                                "y2": {"type": "NUMBER"},
                            },
                            "required": ["x1", "y1", "x2", "y2"],
                        },
                    },
                },
                "required": ["surface", "confidence", "quad"],
            },
        }
    },
    "required": ["regions"],
}


# Below this the detector is guessing at a surface it cannot really see.
# Regions are re-validated downstream anyway, so this only avoids the cost
# of extracting and re-classifying obvious noise.
TILE_REGION_MIN_CONFIDENCE = 0.55

# More than this many surfaces in one image means the detector is
# fragmenting a scene rather than finding distinct products.
TILE_REGION_MAX = 6


# ============================================================
# TILE PURITY VERIFIER
#
# A SECOND, DIFFERENT QUESTION from analyze_product_image.
#
# analyze_product_image asks "which catalog PRODUCT is this image
# about?", and its own prompt tells it to approve a product that is
# "occupying only part of the image". For a tile that is exactly wrong:
# a bathroom photo with a girl standing in front of a tiled wall IS an
# image about a tile product, so it is approved, and the girl is saved
# into the catalog with it.
#
# This prompt asks about the FRAME instead: forget what is being sold,
# what is actually IN this picture? It is the difference between "the
# area where a tile exists" and "a tile image", and nothing else in the
# pipeline was asking it.
# ============================================================

TILE_PURITY_PROMPT = """
You are inspecting ONE image that is about to be saved as a tile swatch
in a product catalog. It must show the TILE SURFACE ITSELF and nothing
else, like a material sample.

Do NOT ask what product this picture advertises. Ask only what is
physically visible inside this frame.

Report:

- tile_fraction: 0.0-1.0, how much of the frame is actual tile/clad
  surface. A photo of a room with a tiled wall in it has a LOW value
  even though the room is full of tile, because floor, ceiling,
  furniture and fittings are not tile surface.

- material: what the main surface really is, one of
  TILE          repeating tile/paved/clad units, with joints
  COUNTERTOP    a kitchen worktop / vanity top / island top
  STONE_SLAB    a continuous stone or marble slab, no tile joints
  WOOD          wooden floor, panel or furniture surface
  PAINTED_WALL  plain painted or plastered wall
  CONCRETE      bare concrete or screed
  FABRIC        carpet, rug, curtain, upholstery
  GLASS         glass or mirror
  METAL         metal panel or appliance
  ARTWORK       a printed picture, poster, mural or decorative panel
  ARCHITECTURE  a building, facade, monument, landmark or structure seen
                as an object -- the Dubai Frame, a tower, an archway, a
                window frame. Clad in tile or not, a photograph OF A
                BUILDING is not a tile sample.
  OTHER         anything else
  A COUNTERTOP or STONE_SLAB is NOT a tile even when it is stone and
  even when it is beautiful. Only call it TILE if you can see the
  repeating units or the joints between them.
  Report TILE only when the frame is filled by the surface itself, close
  enough to read its pattern. If you are looking AT a structure rather
  than at its material, that is ARCHITECTURE.

- contains_person: a human, or any part of one -- face, hand, leg,
  hair, clothing.
- contains_text: readable text, product names, sizes, SKU codes,
  headings, captions, marketing copy, watermarks.
- contains_logo: a brand mark, emblem or logotype.
- contains_furniture: sofa, table, chair, bed, cabinet, shelving.
- contains_fixture: toilet, basin, bath, shower, tap, mirror, sink,
  radiator, door, window frame.
- contains_object: plant, vase, bottle, lamp, appliance, equipment,
  ornament or any other loose object.

- is_scene: true when this reads as a photograph OF A SPACE (a room, a
  kitchen, a bathroom, an elevation, an interior view) rather than a
  flat piece of surface. A whole wall or a whole floor photographed as
  part of a room is a scene.

- distinct_tile_designs: how many DIFFERENT tile designs are visible.
  One tile repeated across the whole frame is 1, however many individual
  units you can count. Two panels of different colour, pattern or
  format side by side is 2, and so on. A catalog sheet showing six
  samples is 6. This must be 1 for the frame to be a swatch of one
  product -- several designs in one picture is a layout of products,
  not a product.

- reason: one short sentence naming what is actually in the frame.

Be strict. Something that is small, blurred, in shadow, or at the very
edge of the frame still counts as present -- say true.

Return ONLY valid JSON.
"""


TILE_PURITY_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "tile_fraction": {"type": "NUMBER"},
        "material": {"type": "STRING"},
        "contains_person": {"type": "BOOLEAN"},
        "contains_text": {"type": "BOOLEAN"},
        "contains_logo": {"type": "BOOLEAN"},
        "contains_furniture": {"type": "BOOLEAN"},
        "contains_fixture": {"type": "BOOLEAN"},
        "contains_object": {"type": "BOOLEAN"},
        "is_scene": {"type": "BOOLEAN"},
        "distinct_tile_designs": {"type": "INTEGER"},
        "reason": {"type": "STRING"},
    },
    "required": ["tile_fraction", "material", "is_scene", "reason"],
}


# Gemini emits spatial coordinates in more than one convention, and which
# one arrives is not something the prompt reliably controls. The vision
# models are trained to report points and boxes normalized to 0-1000, and
# they fall back to that convention regularly even when asked for 0.0-1.0
# -- especially behind a response_schema whose fields are plain NUMBERs.
#
# Assuming a single convention and clamping to it is destructive rather
# than merely inaccurate: clamping a 0-1000 quad into 0.0-1.0 collapses
# all four corners onto (width, height), i.e. one point, which then reads
# downstream as "degenerate region geometry" and silently discards a
# correctly detected tile surface. So the space is DETECTED from the
# values themselves instead of assumed.
#
# The quad is the anchor: it is the required field, it carries eight
# values, and whatever convention it uses is the convention the occluder
# boxes in the same response use. Deciding once from the quad and applying
# that same decision to the occluders is what keeps the two in step --
# reading occluders in the wrong space would collapse them to zero area,
# drop them as junk, and leak the very furniture they mark into a swatch.

# At or below this, values are read as the 0.0-1.0 fractions the prompt
# asks for. Slightly above 1.0 to tolerate a corner reported just outside
# the frame.
UNIT_SPACE_MAX = 1.5

# At or below this (and above UNIT_SPACE_MAX), values are read as Gemini's
# native 0-1000 grid. Anything larger can only be raw pixels.
THOUSAND_SPACE_MAX = 1000.0


def _coordinate_space(values):
    """Names the convention a set of raw coordinates is expressed in.

    Returns "unit" (0.0-1.0), "thousand" (0-1000) or "pixel". Ambiguity is
    resolved towards "thousand" because that is what the vision models
    actually emit: a value of 780 from an 800px-wide image is far more
    likely to be 0.78 of the width than 780 pixels of it.
    """
    largest = max((abs(value) for value in values), default=0.0)

    if largest <= UNIT_SPACE_MAX:
        return "unit"
    if largest <= THOUSAND_SPACE_MAX:
        return "thousand"
    return "pixel"


def _to_pixels(x, y, space, width, height):
    """Maps one coordinate pair out of `space` into clamped pixel space."""
    if space == "unit":
        fraction_x, fraction_y = x, y
    elif space == "thousand":
        fraction_x, fraction_y = x / 1000.0, y / 1000.0
    else:
        fraction_x = x / width if width else 0.0
        fraction_y = y / height if height else 0.0

    return (
        max(0.0, min(1.0, fraction_x)) * width,
        max(0.0, min(1.0, fraction_y)) * height,
    )


def _raw_corners(raw_quad):
    """Parses a quad into four raw (x, y) floats, without reading scale.

    Scale is deliberately not interpreted here -- _coordinate_space needs
    to see the untouched values to tell which convention they are in.
    """
    if not isinstance(raw_quad, (list, tuple)) or len(raw_quad) != 4:
        return None

    corners = []
    for corner in raw_quad:
        if isinstance(corner, dict):
            x, y = corner.get("x"), corner.get("y")
        elif isinstance(corner, (list, tuple)) and len(corner) >= 2:
            x, y = corner[0], corner[1]
        else:
            return None

        try:
            x = float(x)
            y = float(y)
        except (TypeError, ValueError):
            return None

        if not (math.isfinite(x) and math.isfinite(y)):
            return None

        corners.append((x, y))

    return corners


def _region_points(raw_quad, width, height, space=None):
    """Converts a detected quad into pixel corners, or None if unusable.

    `space` overrides the auto-detected convention; pass the value from
    _coordinate_space when several fields of one region must be read
    together.
    """
    corners = _raw_corners(raw_quad)
    if corners is None:
        return None

    if space is None:
        space = _coordinate_space([value for corner in corners for value in corner])

    return [_to_pixels(x, y, space, width, height) for x, y in corners]


def _region_occluders(raw_occluders, width, height, space=None):
    """Converts occluder boxes into pixel boxes, dropping junk.

    `space` must be the convention resolved for the region's quad -- see
    the note above on why these cannot be detected independently.
    """
    parsed = []

    for entry in raw_occluders or []:
        if not isinstance(entry, dict):
            continue
        try:
            x1 = float(entry.get("x1", 0))
            y1 = float(entry.get("y1", 0))
            x2 = float(entry.get("x2", 0))
            y2 = float(entry.get("y2", 0))
        except (TypeError, ValueError):
            continue

        values = (x1, y1, x2, y2)
        if not all(math.isfinite(value) for value in values):
            continue

        parsed.append(values)

    if space is None:
        space = _coordinate_space(
            [value for entry in parsed for value in entry]
        )

    boxes = []
    for x1, y1, x2, y2 in parsed:
        px1, py1 = _to_pixels(x1, y1, space, width, height)
        px2, py2 = _to_pixels(x2, y2, space, width, height)

        px1, px2 = sorted((px1, px2))
        py1, py2 = sorted((py1, py2))

        if px2 <= px1 or py2 <= py1:
            continue

        boxes.append((px1, py1, px2, py2))

    return boxes


def detect_tile_regions(image_path, width, height):
    """Locates tiled surfaces inside one image.

    Returns a list of {surface, confidence, quad, occluders} with
    pixel-space geometry, ordered most confident first. Returns [] when
    there is no tiled surface, when Gemini is unavailable, or when the
    response cannot be parsed -- a caller that gets nothing back simply
    keeps the existing whole-image decision.
    """
    try:
        with open(image_path, "rb") as handle:
            image_bytes = handle.read()
    except OSError:
        return []

    _debug("CALL")
    _debug("  stage            : region-detect (detect_tile_regions)")
    _debug(f"  image/candidate  : {Path(image_path).name} "
           f"({width}x{height}, {len(image_bytes)} bytes)")
    _debug(f"  model            : {GEMINI_MODEL}")

    try:
        response = _generate_content_safe(
            model=GEMINI_MODEL,
            contents=[
                types.Part.from_bytes(
                    data=image_bytes,
                    mime_type="image/webp",
                ),
                TILE_REGION_PROMPT,
            ],
            config={
                "response_mime_type": "application/json",
                "response_schema": TILE_REGION_SCHEMA,
            },
        )
    except Exception:  # noqa: BLE001 -- never break extraction over this
        return []

    if response is None:
        return []

    try:
        payload = json.loads(response.text)
    except (AttributeError, ValueError, TypeError):
        return []

    regions = []
    below_threshold = []
    unusable_geometry = 0

    for raw in (payload or {}).get("regions", []) or []:
        if not isinstance(raw, dict):
            continue

        try:
            confidence = float(raw.get("confidence", 0.0))
        except (TypeError, ValueError):
            confidence = 0.0

        if confidence < TILE_REGION_MIN_CONFIDENCE:
            below_threshold.append(confidence)
            continue

        corners = _raw_corners(raw.get("quad"))
        if corners is None:
            unusable_geometry += 1
            continue

        # Resolved once from the quad and reused for the occluders, so both
        # are read in the same convention -- see _coordinate_space.
        space = _coordinate_space(
            [value for corner in corners for value in corner]
        )

        quad = _region_points(raw.get("quad"), width, height, space)
        if quad is None:
            continue

        regions.append({
            "surface": str(raw.get("surface") or "OTHER").strip().upper(),
            "confidence": max(0.0, min(1.0, confidence)),
            "quad": quad,
            "coordinate_space": space,
            "occluders": _region_occluders(
                raw.get("occluders"), width, height, space
            ),
        })

    regions.sort(key=lambda region: region["confidence"], reverse=True)

    _debug("  response received : YES")
    _debug(f"  surfaces returned : {len(regions)} kept, "
           f"{len(below_threshold)} below the confidence floor, "
           f"{unusable_geometry} with unreadable geometry")
    for region in regions[:TILE_REGION_MAX]:
        _debug(f"    - {region['surface']} @ {region['confidence']:.2f}, "
               f"{len(region['occluders'])} occluder(s)")

    # Surfaces the detector DID see and this function then discarded.
    # Silently dropping them makes a thresholding decision look exactly
    # like "the model saw nothing", which is the difference between
    # "tune the floor" and "the tile is not being detected at all".
    if below_threshold:
        print(
            f"  [tile-region] {len(below_threshold)} surface(s) seen but "
            f"below the {TILE_REGION_MIN_CONFIDENCE} confidence floor "
            f"(highest {max(below_threshold):.2f}) -- discarded before "
            f"extraction"
        )

    if unusable_geometry:
        print(
            f"  [tile-region] {unusable_geometry} surface(s) discarded "
            f"because their quad could not be read"
        )

    return regions[:TILE_REGION_MAX]


def verify_tile_only(image_path):
    """Inspects what is physically inside one candidate swatch.

    Returns a dict of observations (see TILE_PURITY_PROMPT) or None when
    no verdict could be reached -- quota exhausted, API error, or an
    unparseable response. None is deliberately distinct from "the frame
    is dirty": the caller must defer on None rather than delete, for the
    same reason analyze_product_image's REVIEW path exists.

    This makes NO accept/reject decision. It reports what it sees and
    leaves the judgement to image_validator.assess_tile_purity, so the
    rule can be tested without an API key.
    """
    try:
        with open(image_path, "rb") as handle:
            image_bytes = handle.read()
    except OSError:
        return None

    suffix = str(image_path).lower()
    if suffix.endswith(".png"):
        mime_type = "image/png"
    elif suffix.endswith((".jpg", ".jpeg")):
        mime_type = "image/jpeg"
    else:
        mime_type = "image/webp"

    _debug("CALL")
    _debug("  stage            : tile-purity (verify_tile_only)")
    _debug(f"  image/candidate  : {Path(image_path).name} ({len(image_bytes)} bytes)")
    _debug(f"  model            : {GEMINI_MODEL}")

    try:
        response = _generate_content_safe(
            model=GEMINI_MODEL,
            contents=[
                types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
                TILE_PURITY_PROMPT,
            ],
            config={
                "response_mime_type": "application/json",
                "response_schema": TILE_PURITY_SCHEMA,
            },
        )
    except Exception as exc:  # noqa: BLE001 -- "no verdict", never "clean"
        _debug(f"  response received : NO -- call raised ({exc})")
        _debug("  final interpretation: NO VERDICT -> defer, not 'not a tile'")
        return None

    if response is None:
        # None means quota exhausted or the call gave up; either way
        # nothing looked at this crop.
        _debug("  response received : NO -- quota exhausted or call abandoned")
        _debug("  final interpretation: NO VERDICT -> defer, not 'not a tile'")
        return None

    _debug("  response received : YES")

    try:
        payload = json.loads(response.text)
    except (AttributeError, ValueError, TypeError) as exc:
        _debug(f"  raw response      : {str(getattr(response, 'text', ''))[:400]!r}")
        _debug(f"  response received : YES, but unparseable ({exc})")
        _debug("  final interpretation: NO VERDICT -> defer, not 'not a tile'")
        return None

    if not isinstance(payload, dict):
        return None

    # A PAYLOAD THAT ANSWERS NOTHING IS NOT AN ANSWER.
    #
    # The defaults below used to fabricate a verdict out of a response
    # that carried no verdict: a missing material became "OTHER" and a
    # missing tile_fraction became 0.0, so a truncated reply, a schema
    # slip or a refusal arrived at the validator as a confident
    # "0% tile, unidentifiable material" and the candidate was rejected
    # as NOT a tile. That is a Gemini failure wearing the costume of a
    # Gemini judgement, and it is indistinguishable downstream from the
    # model actually having looked and said no.
    #
    # Both fields are declared required in TILE_PURITY_SCHEMA. If either
    # is absent, nothing judged this crop, so None is returned and the
    # callers defer the image for review instead of deleting it.
    if payload.get("material") is None or payload.get("tile_fraction") is None:
        _debug(
            "purity response missing required fields "
            f"(material={payload.get('material')!r}, "
            f"tile_fraction={payload.get('tile_fraction')!r}) "
            f"-- treating as NO VERDICT, not as 'not a tile'"
        )
        return None

    try:
        tile_fraction = float(payload.get("tile_fraction", 0.0))
    except (TypeError, ValueError):
        # Present but unparseable is the same kind of non-answer.
        _debug(
            f"purity tile_fraction is unreadable "
            f"({payload.get('tile_fraction')!r}) -- treating as NO VERDICT"
        )
        return None

    if not math.isfinite(tile_fraction):
        return None

    try:
        distinct_designs = int(payload.get("distinct_tile_designs", 1))
    except (TypeError, ValueError):
        distinct_designs = 1

    observation = {
        "distinct_tile_designs": max(1, distinct_designs),
        "tile_fraction": max(0.0, min(1.0, tile_fraction)),
        "material": str(payload.get("material") or "OTHER").strip().upper(),
        "contains_person": bool(payload.get("contains_person")),
        "contains_text": bool(payload.get("contains_text")),
        "contains_logo": bool(payload.get("contains_logo")),
        "contains_furniture": bool(payload.get("contains_furniture")),
        "contains_fixture": bool(payload.get("contains_fixture")),
        "contains_object": bool(payload.get("contains_object")),
        "is_scene": bool(payload.get("is_scene")),
        "reason": str(payload.get("reason") or "").strip(),
    }

    _debug(f"  material          : {observation['material']}")
    _debug(f"  tile_fraction     : {observation['tile_fraction']:.0%}")
    _debug(f"  scene             : {observation['is_scene']}")
    _debug(f"  designs           : {observation['distinct_tile_designs']}")
    _debug(
        "  objects           : "
        + (", ".join(
            name for name, present in (
                ("person", observation["contains_person"]),
                ("text", observation["contains_text"]),
                ("logo", observation["contains_logo"]),
                ("furniture", observation["contains_furniture"]),
                ("fixture", observation["contains_fixture"]),
                ("object", observation["contains_object"]),
            ) if present
        ) or "none")
    )
    _debug("  final interpretation: a real verdict from the model")

    return observation
