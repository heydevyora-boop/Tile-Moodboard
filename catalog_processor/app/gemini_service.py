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


client = genai.Client(
    api_key=GEMINI_API_KEY
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


def _region_points(raw_quad, width, height):
    """Converts a normalized quad into pixel corners, or None if unusable."""
    if not isinstance(raw_quad, (list, tuple)) or len(raw_quad) != 4:
        return None

    points = []
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

        # Coordinates are specified normalized; clamp rather than reject so
        # a corner marginally outside the frame still yields a usable plane.
        points.append((
            max(0.0, min(1.0, x)) * width,
            max(0.0, min(1.0, y)) * height,
        ))

    return points


def _region_occluders(raw_occluders, width, height):
    """Converts normalized occluder boxes into pixel boxes, dropping junk."""
    boxes = []

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

        x1, x2 = sorted((max(0.0, min(1.0, x1)), max(0.0, min(1.0, x2))))
        y1, y2 = sorted((max(0.0, min(1.0, y1)), max(0.0, min(1.0, y2))))

        if x2 <= x1 or y2 <= y1:
            continue

        boxes.append((x1 * width, y1 * height, x2 * width, y2 * height))

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

    for raw in (payload or {}).get("regions", []) or []:
        if not isinstance(raw, dict):
            continue

        try:
            confidence = float(raw.get("confidence", 0.0))
        except (TypeError, ValueError):
            confidence = 0.0

        if confidence < TILE_REGION_MIN_CONFIDENCE:
            continue

        quad = _region_points(raw.get("quad"), width, height)
        if quad is None:
            continue

        regions.append({
            "surface": str(raw.get("surface") or "OTHER").strip().upper(),
            "confidence": max(0.0, min(1.0, confidence)),
            "quad": quad,
            "occluders": _region_occluders(raw.get("occluders"), width, height),
        })

    regions.sort(key=lambda region: region["confidence"], reverse=True)

    return regions[:TILE_REGION_MAX]
