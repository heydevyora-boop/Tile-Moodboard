# ============================================================
# GEMINI AI PRODUCT CLASSIFIER
# ============================================================

import json
import os
import time

from typing import Literal, Optional

from dotenv import load_dotenv
from google import genai
from google.genai import types
from pydantic import BaseModel, Field


# ============================================================
# ENVIRONMENT
# ============================================================

load_dotenv()


GEMINI_API_KEY = os.getenv(
    "GEMINI_API_KEY"
)

# Keep this configurable.
# You can change the model later without
# changing the classifier logic.
GEMINI_MODEL = os.getenv(
    "GEMINI_MODEL",
    "gemini-3.1-flash-lite"
)


# ============================================================
# CLIENT
# ============================================================

_client = None


def get_gemini_client():
    """
    Create the Gemini client lazily.

    This prevents API initialization when
    the module is imported only for local tests.
    """

    global _client

    if _client is not None:
        return _client

    if not GEMINI_API_KEY:
        raise RuntimeError(
            "GEMINI_API_KEY is missing from .env"
        )

    _client = genai.Client(
        api_key=GEMINI_API_KEY
    )

    return _client


# ============================================================
# CONTROLLED VALUES
# ============================================================

StyleValue = Literal[
    "MODERN",
    "MINIMAL",
    "LUXURY",
    "NATURAL",
    "EARTHY",
    "CONTEMPORARY",
    "CLASSIC",
    "INDUSTRIAL",
    "UNKNOWN",
]

ToneValue = Literal[
    "LIGHT",
    "MEDIUM",
    "DARK",
    "WARM",
    "COOL",
    "NEUTRAL",
    "UNKNOWN",
]

PatternValue = Literal[
    "PLAIN",
    "VEINED",
    "MARBLED",
    "STONE",
    "CONCRETE",
    "WOOD",
    "GEOMETRIC",
    "ABSTRACT",
    "FLORAL",
    "TEXTURED",
    "UNKNOWN",
]

ContrastValue = Literal[
    "LOW",
    "MEDIUM",
    "HIGH",
    "UNKNOWN",
]

BooleanValue = Literal[
    "YES",
    "NO",
    "UNKNOWN",
]


# ============================================================
# GEMINI OUTPUT SCHEMA
# ============================================================

class GeminiClassification(BaseModel):

    style: StyleValue = Field(
        description=(
            "Primary interior/design style "
            "visible in the product."
        )
    )

    color: str = Field(
        description=(
            "Main visible color or color family. "
            "Use UNKNOWN if it cannot be determined."
        )
    )

    tone: ToneValue = Field(
        description=(
            "Overall visual tone of the product."
        )
    )

    pattern: PatternValue = Field(
        description=(
            "Primary visible pattern or surface character."
        )
    )

    veining: BooleanValue = Field(
        description=(
            "Whether visible veining is present."
        )
    )

    contrast: ContrastValue = Field(
        description=(
            "Visual contrast level of the product."
        )
    )

    bathroom_wall: BooleanValue = Field(
        description=(
            "Whether the visual evidence suggests "
            "the product is suitable for bathroom wall "
            "use. Do not infer technical certification."
        )
    )

    bathroom_floor: BooleanValue = Field(
        description=(
            "Whether the visual evidence suggests "
            "the product may be suitable for bathroom "
            "floor use. Do not claim technical certification."
        )
    )

    shower_area: BooleanValue = Field(
        description=(
            "Whether the visual evidence suggests "
            "suitability for shower-area visual use. "
            "Do not claim waterproof or slip certification."
        )
    )

    confidence: Literal[
        "HIGH",
        "MEDIUM",
        "LOW",
    ] = Field(
        description=(
            "Confidence in the visual classification."
        )
    )

    reasoning: str = Field(
        description=(
            "Short explanation based only on "
            "visible evidence."
        )
    )


# ============================================================
# PROMPT
# ============================================================

SYSTEM_INSTRUCTION = """
You are a product catalog classification assistant.

Your task is to classify bathroom surface products
from their product information and, when available,
their product image.

IMPORTANT RULES:

1. Use only visible or explicitly supplied evidence.
2. Never invent manufacturer specifications.
3. Never claim technical certification from appearance.
4. If something cannot be determined reliably,
   return UNKNOWN.
5. Do not confuse visual suitability with certified
   technical suitability.
6. Do not identify a product as floor-safe merely
   because it looks like a floor tile.
7. Do not identify a product as shower-safe merely
   because it is shown in a bathroom.
8. Return exactly the requested structured fields.
9. Keep reasoning short.
10. Use uppercase controlled values where applicable.
"""


# ============================================================
# PRODUCT PROMPT
# ============================================================

def build_product_prompt(
    product: dict,
):
    """
    Build the classification prompt from
    an existing product record.
    """

    safe_product = {
        "Product ID": product.get(
            "Product ID",
            ""
        ),

        "Product Name": product.get(
            "Product Name",
            ""
        ),

        "Brand": product.get(
            "Brand",
            ""
        ),

        "Catalog": product.get(
            "Catalog",
            ""
        ),

        "Dimensions": product.get(
            "Dimensions",
            ""
        ),

        "Resolved Finish": product.get(
            "Resolved Finish",
            ""
        ),

        "Existing Bathroom Wall": product.get(
            "Bathroom Wall",
            ""
        ),

        "Existing Bathroom Floor": product.get(
            "Bathroom Floor",
            ""
        ),

        "Existing Shower Area": product.get(
            "Shower Area",
            ""
        ),

        "Image Filename": product.get(
            "Image Filename",
            ""
        ),
    }

    return f"""
Classify the following bathroom catalog product.

Product data:

{json.dumps(
    safe_product,
    indent=2,
    ensure_ascii=False
)}

The existing bathroom fields are reference data only.
Do not blindly copy UNKNOWN or existing values.

Determine visual characteristics carefully.

For bathroom_wall, bathroom_floor and shower_area:
only return YES when there is sufficient evidence
from the supplied information/image.

If there is not sufficient evidence, return UNKNOWN.

Do not invent technical ratings such as:
- slip resistance
- DCOF
- PEI
- waterproof certification
- manufacturer approval

Those belong to verified technical data.

Return the structured classification.
"""


# ============================================================
# GEMINI CLASSIFICATION
# ============================================================

def classify_product(
    product: dict,
    image_path: Optional[str] = None,
    max_retries: int = 2,
):
    """
    Classify one product using Gemini.

    Returns a dictionary with:

        status
        classification
        error

    The function does NOT crash the whole pipeline
    when Gemini quota is unavailable.
    """

    client = get_gemini_client()

    prompt = build_product_prompt(
        product
    )

    contents = [
        prompt
    ]

    # --------------------------------------------------------
    # Optional image
    # --------------------------------------------------------

    if image_path:

        if os.path.exists(image_path):

            try:

                image_part = types.Part.from_bytes(
                    data=open(
                        image_path,
                        "rb"
                    ).read(),
                    mime_type=get_mime_type(
                        image_path
                    ),
                )

                contents.append(
                    image_part
                )

            except Exception as exc:

                return {
                    "status": "IMAGE_ERROR",
                    "classification": None,
                    "error": str(exc),
                }

    # --------------------------------------------------------
    # Retry
    # --------------------------------------------------------

    for attempt in range(
        max_retries + 1
    ):

        try:

            response = (
                client.models.generate_content(
                    model=GEMINI_MODEL,

                    contents=contents,

                    config=types.GenerateContentConfig(

                        system_instruction=(
                            SYSTEM_INSTRUCTION
                        ),

                        response_mime_type=(
                            "application/json"
                        ),

                        response_schema=(
                            GeminiClassification
                        ),

                        temperature=0.1,

                        max_output_tokens=1000,
                    ),
                )
            )

            # ------------------------------------------------
            # Parse structured output
            # ------------------------------------------------

            if getattr(
                response,
                "parsed",
                None,
            ):

                classification = (
                    response.parsed
                )

            else:

                classification = (
                    GeminiClassification.model_validate_json(
                        response.text
                    )
                )

            return {
                "status": "SUCCESS",

                "classification": (
                    classification.model_dump()
                ),

                "error": None,
            }

        except Exception as exc:

            error_text = str(
                exc
            )

            # --------------------------------------------
            # Quota / resource exhausted
            # --------------------------------------------

            if (
                "RESOURCE_EXHAUSTED"
                in error_text
                or "429"
                in error_text
                or "quota"
                in error_text.lower()
            ):

                if attempt < max_retries:

                    time.sleep(
                        2 ** attempt
                    )

                    continue

                return {
                    "status": "QUOTA_EXHAUSTED",
                    "classification": None,
                    "error": error_text,
                }

            # --------------------------------------------
            # Other API errors
            # --------------------------------------------

            if attempt < max_retries:

                time.sleep(
                    2 ** attempt
                )

                continue

            return {
                "status": "FAILED",
                "classification": None,
                "error": error_text,
            }


# ============================================================
# MIME TYPE
# ============================================================

def get_mime_type(
    image_path,
):
    """
    Determine image MIME type.
    """

    extension = (
        os.path.splitext(
            image_path
        )[1]
        .lower()
    )

    mapping = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }

    return mapping.get(
        extension,
        "image/jpeg"
    )


# ============================================================
# END
# ============================================================