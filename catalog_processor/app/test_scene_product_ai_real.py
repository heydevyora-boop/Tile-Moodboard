"""
test_scene_product_ai_real.py

REAL GEMINI VISION INTEGRATION TEST

Pipeline:
    Cropped Product Image
            ↓
       Gemini Vision
            ↓
    Product Metadata JSON
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import types


# ============================================================
# PROJECT PATHS
# ============================================================

# This file:
#
# catalog_processor/
# └── app/
#     └── test_scene_product_ai_real.py
#
# Therefore:
#
# Path(__file__).resolve()        = this Python file
# .parent                         = app
# .parent.parent                  = catalog_processor

PROJECT_ROOT = Path(__file__).resolve().parent.parent

OUTPUT_ROOT = PROJECT_ROOT / "output"
CROPS_ROOT = OUTPUT_ROOT / "crops"

SCENE_AI_OUTPUT_ROOT = (
    OUTPUT_ROOT / "scene_product_ai"
)


# ============================================================
# ENVIRONMENT
# ============================================================

ENV_FILE = PROJECT_ROOT / ".env"

load_dotenv(ENV_FILE)


API_KEY = os.getenv("GEMINI_API_KEY")

MODEL = os.getenv(
    "GEMINI_MODEL",
    "gemini-2.5-flash",
)


# ============================================================
# VALIDATE ENVIRONMENT
# ============================================================

if not API_KEY:
    raise RuntimeError(
        "GEMINI_API_KEY not found.\n\n"
        f"Expected .env file:\n{ENV_FILE}\n\n"
        "Add GEMINI_API_KEY to catalog_processor/.env"
    )


# ============================================================
# GEMINI CLIENT
# ============================================================

client = genai.Client(
    api_key=API_KEY
)


# ============================================================
# PRODUCT SCHEMA
# ============================================================

PRODUCT_SCHEMA = {
    "type": "object",

    "properties": {

        "product_type": {
            "type": "string"
        },

        "product_name": {
            "type": "string"
        },

        "material": {
            "type": "string"
        },

        "color": {
            "type": "string"
        },

        "finish": {
            "type": "string"
        },

        "pattern": {
            "type": "string"
        },

        "shape": {
            "type": "string"
        },

        "style": {
            "type": "string"
        },

        "surface_texture": {
            "type": "string"
        },

        "dominant_features": {
            "type": "array",

            "items": {
                "type": "string"
            }
        },

        "confidence": {
            "type": "number"
        },

        "is_product_image": {
            "type": "boolean"
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

PROMPT = """
You are a product identification AI for a bathroom
and interior-products catalog.

Analyze the supplied cropped product image.

Identify only information that can reasonably be
determined from the image.

Return:

- product type
- product name/visual description
- material
- color
- finish
- pattern
- shape
- style
- surface texture
- dominant visual features
- confidence
- whether this is actually a product image

For tiles specifically inspect:

- marble/stone appearance
- veins
- grain
- pattern
- color
- surface finish
- texture
- visual style

Do NOT invent:

- brand
- model number
- SKU
- dimensions
- price
- technical specifications

Return only JSON.
"""


# ============================================================
# IMAGE MIME TYPE
# ============================================================

def get_mime_type(path: Path) -> str:

    extension = path.suffix.lower()

    mapping = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }

    if extension not in mapping:
        raise ValueError(
            f"Unsupported image type: {extension}"
        )

    return mapping[extension]


# ============================================================
# FIND CROPPED PRODUCT IMAGE
# ============================================================

def find_cropped_product_image(
    product_id: str,
) -> Path:
    """
    Locate the cropped product image using the
    absolute project-root-based output directory.

    Expected:
        catalog_processor/output/crops/001_TEST-P001.png

    Also checks jpg/jpeg/webp variants.
    """

    print()
    print("Searching for cropped product image...")
    print()
    print(f"Project root : {PROJECT_ROOT}")
    print(f"Output root  : {OUTPUT_ROOT}")
    print(f"Crops root   : {CROPS_ROOT}")

    # --------------------------------------------------------
    # Expected filenames
    # --------------------------------------------------------

    expected_names = [
        f"001_{product_id}.png",
        f"001_{product_id}.jpg",
        f"001_{product_id}.jpeg",
        f"001_{product_id}.webp",
    ]

    # --------------------------------------------------------
    # Direct lookup
    # --------------------------------------------------------

    for filename in expected_names:

        candidate = CROPS_ROOT / filename

        print()
        print(
            f"Checking: {candidate}"
        )

        if candidate.exists() and candidate.is_file():

            print(
                f"[PASS] Found: {candidate}"
            )

            return candidate

    # --------------------------------------------------------
    # Fallback search
    # --------------------------------------------------------

    print()
    print("Direct lookup failed.")
    print("Searching output/crops recursively...")

    if CROPS_ROOT.exists():

        matches = []

        for path in CROPS_ROOT.rglob("*"):

            if not path.is_file():
                continue

            if path.suffix.lower() not in {
                ".png",
                ".jpg",
                ".jpeg",
                ".webp",
            }:
                continue

            if product_id.lower() in path.name.lower():

                matches.append(path)

        if matches:

            print()
            print("[PASS] Matching crop found:")

            for path in matches:
                print(
                    f"   {path}"
                )

            return matches[0]

    # --------------------------------------------------------
    # Nothing found
    # --------------------------------------------------------

    print()
    print("[FAIL] Cropped product image was not found.")

    print()
    print("Expected location:")
    print(
        CROPS_ROOT /
        f"001_{product_id}.png"
    )

    print()
    print("Does crops directory exist?")
    print(
        CROPS_ROOT.exists()
    )

    if CROPS_ROOT.exists():

        print()
        print("Files currently inside crops:")

        files = list(
            CROPS_ROOT.rglob("*")
        )

        if not files:

            print("   <EMPTY>")

        else:

            for path in files:

                if path.is_file():

                    print(
                        f"   {path}"
                    )

    raise FileNotFoundError(
        "\n\n"
        "Cropped product image was not found.\n\n"
        f"Product ID:\n{product_id}\n\n"
        f"Expected directory:\n{CROPS_ROOT}\n\n"
        "Run the cropper first:\n"
        "python -m app.test_scene_product_cropper"
    )


# ============================================================
# GEMINI IMAGE ANALYSIS
# ============================================================

def analyze_product(
    product_id: str,
    image_path: Path,
) -> dict:

    print()
    print("=" * 70)
    print("REAL GEMINI PRODUCT ANALYSIS")
    print("=" * 70)

    print(
        f"Product ID : {product_id}"
    )

    print(
        f"Image      : {image_path}"
    )

    print(
        f"Model      : {MODEL}"
    )

    # --------------------------------------------------------
    # Validate image
    # --------------------------------------------------------

    image_path = Path(
        image_path
    ).resolve()

    if not image_path.exists():

        raise FileNotFoundError(
            f"Image not found: {image_path}"
        )

    if not image_path.is_file():

        raise ValueError(
            f"Not a file: {image_path}"
        )

    print()
    print(
        "[PASS] Image exists."
    )

    # --------------------------------------------------------
    # Read image
    # --------------------------------------------------------

    image_bytes = image_path.read_bytes()

    if not image_bytes:

        raise ValueError(
            f"Image file is empty: {image_path}"
        )

    mime_type = get_mime_type(
        image_path
    )

    print(
        f"[PASS] Image loaded: "
        f"{len(image_bytes)} bytes"
    )

    print(
        f"[PASS] MIME type: {mime_type}"
    )

    image_part = types.Part.from_bytes(
        data=image_bytes,
        mime_type=mime_type,
    )

    # --------------------------------------------------------
    # Gemini request
    # --------------------------------------------------------

    print()
    print(
        "Calling REAL Gemini Vision..."
    )

    response = client.models.generate_content(

        model=MODEL,

        contents=[
            types.Content(
                role="user",

                parts=[
                    types.Part.from_text(
                        text=PROMPT
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

    print(
        "[PASS] Gemini response received."
    )

    # --------------------------------------------------------
    # Validate response
    # --------------------------------------------------------

    if not response.text:

        raise RuntimeError(
            "Gemini returned an empty response."
        )

    try:

        data = json.loads(
            response.text
        )

    except json.JSONDecodeError as exc:

        raise RuntimeError(
            "Gemini returned invalid JSON:\n"
            + response.text
        ) from exc

    if not isinstance(
        data,
        dict
    ):

        raise RuntimeError(
            "Gemini response is not an object."
        )

    # --------------------------------------------------------
    # Add pipeline metadata
    # --------------------------------------------------------

    data["product_id"] = (
        product_id
    )

    data["image_path"] = (
        str(image_path)
    )

    data["ai_provider"] = (
        "google_gemini"
    )

    data["ai_model"] = (
        MODEL
    )

    data["ai_mode"] = (
        "real"
    )

    return data


# ============================================================
# PRINT RESULT
# ============================================================

def print_result(
    result: dict,
) -> None:

    print()
    print("-" * 70)
    print("GEMINI RESULT")
    print("-" * 70)

    print(
        "Product Type :",
        result.get(
            "product_type",
            ""
        )
    )

    print(
        "Product Name :",
        result.get(
            "product_name",
            ""
        )
    )

    print(
        "Material     :",
        result.get(
            "material",
            ""
        )
    )

    print(
        "Color        :",
        result.get(
            "color",
            ""
        )
    )

    print(
        "Finish       :",
        result.get(
            "finish",
            ""
        )
    )

    print(
        "Pattern      :",
        result.get(
            "pattern",
            ""
        )
    )

    print(
        "Shape        :",
        result.get(
            "shape",
            ""
        )
    )

    print(
        "Style        :",
        result.get(
            "style",
            ""
        )
    )

    print(
        "Texture      :",
        result.get(
            "surface_texture",
            ""
        )
    )

    print(
        "Confidence   :",
        result.get(
            "confidence",
            ""
        )
    )

    print(
        "Is Product   :",
        result.get(
            "is_product_image",
            ""
        )
    )

    print(
        "Features     :",
        result.get(
            "dominant_features",
            []
        )
    )


# ============================================================
# TEST
# ============================================================

def test_real_gemini():

    print()
    print("=" * 70)
    print("SCENE PRODUCT AI - REAL GEMINI TEST")
    print("=" * 70)

    print()
    print(
        f"Python file  : {Path(__file__).resolve()}"
    )

    print(
        f"Project root : {PROJECT_ROOT}"
    )

    print(
        f"Current dir  : {Path.cwd()}"
    )

    # --------------------------------------------------------
    # Product
    # --------------------------------------------------------

    product_id = "TEST-P001"

    # --------------------------------------------------------
    # Locate crop
    # --------------------------------------------------------

    print()
    print("1. Checking input image...")

    image_path = (
        find_cropped_product_image(
            product_id
        )
    )

    print()
    print(
        "[PASS] Cropped product image exists."
    )

    print(
        f"Using image: {image_path}"
    )

    # --------------------------------------------------------
    # Gemini
    # --------------------------------------------------------

    print()
    print("2. Calling REAL Gemini Vision...")

    result = analyze_product(
        product_id=product_id,
        image_path=image_path,
    )

    print(
        "[PASS] Gemini response received."
    )

    # --------------------------------------------------------
    # Validate
    # --------------------------------------------------------

    print()
    print(
        "3. Validating Gemini metadata..."
    )

    required_fields = [
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
    ]

    for field in required_fields:

        if field not in result:

            raise RuntimeError(
                f"Missing Gemini field: {field}"
            )

    print(
        "[PASS] All metadata fields present."
    )

    # --------------------------------------------------------
    # Confidence
    # --------------------------------------------------------

    print()
    print(
        "4. Validating confidence..."
    )

    confidence = result[
        "confidence"
    ]

    if not isinstance(
        confidence,
        (int, float)
    ):

        raise RuntimeError(
            "Confidence must be numeric."
        )

    if not 0 <= confidence <= 1:

        raise RuntimeError(
            f"Invalid confidence: {confidence}"
        )

    print(
        "[PASS] Confidence validated."
    )

    # --------------------------------------------------------
    # Product image validation
    # --------------------------------------------------------

    print()
    print(
        "5. Validating product image..."
    )

    is_product_image = result[
        "is_product_image"
    ]

    if not isinstance(
        is_product_image,
        bool
    ):

        raise RuntimeError(
            "is_product_image must be boolean."
        )

    print(
        "[PASS] Product image flag validated."
    )

    # --------------------------------------------------------
    # Display
    # --------------------------------------------------------

    print()
    print(
        "6. Gemini metadata:"
    )

    print_result(
        result
    )

    # --------------------------------------------------------
    # Save
    # --------------------------------------------------------

    print()
    print(
        "7. Saving metadata..."
    )

    SCENE_AI_OUTPUT_ROOT.mkdir(
        parents=True,
        exist_ok=True
    )

    output_file = (
        SCENE_AI_OUTPUT_ROOT /
        f"{product_id}_gemini.json"
    )

    output_file.write_text(

        json.dumps(
            result,
            indent=2,
            ensure_ascii=False
        ),

        encoding="utf-8"
    )

    print()
    print(
        f"[PASS] Saved:"
    )

    print(
        output_file
    )

    # --------------------------------------------------------
    # Final
    # --------------------------------------------------------

    print()
    print("=" * 70)
    print(
        "REAL GEMINI PRODUCT AI TEST PASSED"
    )
    print("=" * 70)

    print()

    print(
        "Project Root      : OK"
    )

    print(
        "Image Input       : OK"
    )

    print(
        "Gemini Vision     : OK"
    )

    print(
        "JSON Parsing      : OK"
    )

    print(
        "Product Type      : OK"
    )

    print(
        "Product Attributes: OK"
    )

    print(
        "Confidence        : OK"
    )

    print(
        "Metadata Save     : OK"
    )

    print()

    print(
        "REAL GEMINI API WAS USED."
    )

    print("=" * 70)


# ============================================================
# MAIN
# ============================================================

if __name__ == "__main__":

    test_real_gemini()