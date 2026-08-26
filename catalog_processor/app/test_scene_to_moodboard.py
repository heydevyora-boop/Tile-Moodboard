"""
test_scene_to_moodboard.py

Integration test for:

    Scene Product Cropper
            ↓
    Gemini Product Understanding
            ↓
    Product Metadata
            ↓
    Moodboard Candidate
            ↓
    Final Bathroom Composition Engine

This test does NOT call Gemini.

It reads the already-generated Gemini metadata and
builds a normalized moodboard input package.

No Google Drive.
No Google Sheets.

Purpose:
    Verify that an extracted product can move from
    scene understanding into the moodboard pipeline.
"""

from pathlib import Path
import json
import sys


# ============================================================
# PROJECT PATH
# ============================================================

PROJECT_ROOT = (
    Path(__file__)
    .resolve()
    .parent
    .parent
)

OUTPUT_ROOT = (
    PROJECT_ROOT
    / "output"
)

SCENE_AI_ROOT = (
    OUTPUT_ROOT
    / "scene_product_ai"
)

MOODBOARD_OUTPUT_ROOT = (
    OUTPUT_ROOT
    / "scene_moodboard"
)


# ============================================================
# TEST PRODUCT
# ============================================================

TEST_PRODUCT_ID = "TEST-P001"


# ============================================================
# HELPERS
# ============================================================

def normalize(value):
    """
    Safely normalize a value.
    """

    if value is None:
        return ""

    return str(value).strip()


def find_gemini_json(
    product_id: str,
) -> Path:
    """
    Locate Gemini JSON for a product.

    Expected filename:

        TEST-P001_gemini.json
    """

    exact_path = (
        SCENE_AI_ROOT
        / f"{product_id}_gemini.json"
    )

    if exact_path.exists():
        return exact_path

    # --------------------------------------------------------
    # Fallback recursive search
    # --------------------------------------------------------

    matches = list(
        OUTPUT_ROOT.rglob(
            f"{product_id}_gemini.json"
        )
    )

    if matches:
        return matches[0]

    raise FileNotFoundError(
        "\n"
        "Gemini metadata was not found.\n\n"
        f"Product ID: {product_id}\n"
        f"Expected: {exact_path}\n\n"
        "Run first:\n"
        "python -m app.test_scene_product_ai_real\n"
    )


def load_gemini_metadata(
    product_id: str,
) -> dict:
    """
    Load Gemini product metadata.
    """

    json_path = find_gemini_json(
        product_id
    )

    print("")
    print(
        "Gemini metadata:"
    )

    print(
        f"  {json_path}"
    )

    try:

        with open(
            json_path,
            "r",
            encoding="utf-8",
        ) as file:

            data = json.load(
                file
            )

    except json.JSONDecodeError as error:

        raise RuntimeError(
            f"Gemini JSON is invalid:\n"
            f"{json_path}\n"
            f"{error}"
        )

    if not isinstance(
        data,
        dict,
    ):

        raise RuntimeError(
            "Gemini metadata must be a JSON object."
        )

    return data


# ============================================================
# FIND VALUE
# ============================================================

def first_value(
    data: dict,
    *keys,
    default="",
):
    """
    Return the first usable value from multiple
    possible Gemini field names.

    This makes the integration tolerant of small
    schema differences.
    """

    for key in keys:

        value = data.get(
            key
        )

        if value is not None:

            value = normalize(
                value
            )

            if value:
                return value

    return default


# ============================================================
# NORMALIZE GEMINI PRODUCT
# ============================================================

def normalize_product_metadata(
    product_id: str,
    metadata: dict,
) -> dict:
    """
    Convert Gemini metadata into the normalized
    product structure expected by the moodboard layer.
    """

    product = {
        "Product ID": product_id,

        "Product Name": first_value(
            metadata,
            "Product Name",
            "product_name",
            "name",
            default=product_id,
        ),

        "Brand": first_value(
            metadata,
            "Brand",
            "brand",
        ),

        "Category": first_value(
            metadata,
            "Category",
            "category",
            "product_type",
        ),

        "Subcategory": first_value(
            metadata,
            "Subcategory",
            "subcategory",
        ),

        "Style": first_value(
            metadata,
            "Style",
            "style",
            "AI Style",
            "ai_style",
            default="UNKNOWN",
        ),

        "Color": first_value(
            metadata,
            "Color",
            "color",
            "AI Color",
            "ai_color",
            default="UNKNOWN",
        ),

        "Tone": first_value(
            metadata,
            "Tone",
            "tone",
            "AI Tone",
            "ai_tone",
            default="UNKNOWN",
        ),

        "Material": first_value(
            metadata,
            "Material",
            "material",
            default="UNKNOWN",
        ),

        "Finish": first_value(
            metadata,
            "Finish",
            "finish",
            "Resolved Finish",
            "resolved_finish",
            default="UNKNOWN",
        ),

        "Pattern": first_value(
            metadata,
            "Pattern",
            "pattern",
            "AI Pattern",
            "ai_pattern",
            default="UNKNOWN",
        ),

        "Veining": first_value(
            metadata,
            "Veining",
            "veining",
            default="UNKNOWN",
        ),

        "Dimensions": first_value(
            metadata,
            "Dimensions",
            "dimensions",
            "size",
            default="",
        ),

        "Budget": first_value(
            metadata,
            "Budget",
            "budget",
            "Budget Tier",
            "budget_tier",
            "Resolved Budget",
            "resolved_budget",
            default="UNKNOWN",
        ),

        "Resolved Finish": first_value(
            metadata,
            "Resolved Finish",
            "resolved_finish",
            "Finish",
            "finish",
            default="UNKNOWN",
        ),

        "Resolved Budget": first_value(
            metadata,
            "Resolved Budget",
            "resolved_budget",
            "Budget",
            "budget",
            "Budget Tier",
            "budget_tier",
            default="UNKNOWN",
        ),

        "AI Style": first_value(
            metadata,
            "AI Style",
            "ai_style",
            "Style",
            "style",
            default="UNKNOWN",
        ),

        "AI Color": first_value(
            metadata,
            "AI Color",
            "ai_color",
            "Color",
            "color",
            default="UNKNOWN",
        ),

        "AI Tone": first_value(
            metadata,
            "AI Tone",
            "ai_tone",
            "Tone",
            "tone",
            default="UNKNOWN",
        ),

        "AI Pattern": first_value(
            metadata,
            "AI Pattern",
            "ai_pattern",
            "Pattern",
            "pattern",
            default="UNKNOWN",
        ),

        "Image Path": first_value(
            metadata,
            "Image Path",
            "image_path",
            "image",
            default="",
        ),

        "Source": "SCENE_GEMINI",
    }

    return product


# ============================================================
# BUILD MOODBOARD CANDIDATE
# ============================================================

def build_moodboard_candidate(
    product: dict,
) -> dict:
    """
    Convert one understood product into a moodboard
    candidate.

    The product ID is preserved as the authoritative
    identifier.
    """

    return {
        "product": product,

        "mood_score": 0,

        "total_score": 0,

        "mood_matches": [],

        "candidate_source": "SCENE_PRODUCT_AI",

        "product_id": product.get(
            "Product ID",
            "",
        ),
    }


# ============================================================
# BUILD MOODBOARD
# ============================================================

def build_scene_moodboard(
    product: dict,
) -> dict:
    """
    Build the initial moodboard structure.

    This is intentionally a candidate package.

    It does NOT claim that one product alone is a
    completed bathroom design.
    """

    candidate = (
        build_moodboard_candidate(
            product
        )
    )

    style = product.get(
        "AI Style",
        "UNKNOWN",
    )

    color = product.get(
        "AI Color",
        "UNKNOWN",
    )

    tone = product.get(
        "AI Tone",
        "UNKNOWN",
    )

    finish = product.get(
        "Resolved Finish",
        "UNKNOWN",
    )

    material = product.get(
        "Material",
        "UNKNOWN",
    )

    moodboard = {
        "moodboard_id": (
            f"SCENE-{product['Product ID']}"
        ),

        "name": (
            f"Scene Product "
            f"{product['Product ID']}"
        ),

        "description": (
            "Moodboard candidate generated "
            "from scene product understanding."
        ),

        "preferred_style": style,

        "preferred_color": color,

        "preferred_tone": tone,

        "preferred_finish": finish,

        "preferred_materials": [
            material
        ],

        "products": [
            candidate
        ],

        "source": {
            "type": "SCENE_PRODUCT_AI",
            "product_id": product[
                "Product ID"
            ],
        },
    }

    return moodboard


# ============================================================
# VALIDATE PRODUCT
# ============================================================

def validate_product(
    product: dict,
) -> None:
    """
    Validate the normalized product.
    """

    product_id = normalize(
        product.get(
            "Product ID"
        )
    )

    if not product_id:

        raise RuntimeError(
            "Product ID is missing."
        )

    category = normalize(
        product.get(
            "Category"
        )
    )

    if not category:

        raise RuntimeError(
            "Product Category is missing."
        )

    print(
        "[PASS] Product ID validated."
    )

    print(
        f"       {product_id}"
    )

    print(
        "[PASS] Product category validated."
    )

    print(
        f"       {category}"
    )


# ============================================================
# SAVE JSON
# ============================================================

def save_json(
    data: dict,
    path: Path,
) -> None:

    path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    with open(
        path,
        "w",
        encoding="utf-8",
    ) as file:

        json.dump(
            data,
            file,
            indent=4,
            ensure_ascii=False,
        )


# ============================================================
# TEST
# ============================================================

def test_scene_to_moodboard() -> None:

    print("")
    print("=" * 80)
    print(
        "SCENE → PRODUCT AI → MOODBOARD TEST"
    )
    print("=" * 80)

    print("")
    print(
        f"Project root: {PROJECT_ROOT}"
    )

    print(
        f"Output root : {OUTPUT_ROOT}"
    )

    # --------------------------------------------------------
    # 1. Locate Gemini metadata
    # --------------------------------------------------------

    print("")
    print(
        "1. Locating Gemini product metadata..."
    )

    metadata = load_gemini_metadata(
        TEST_PRODUCT_ID
    )

    print(
        "[PASS] Gemini metadata loaded."
    )

    # --------------------------------------------------------
    # 2. Normalize
    # --------------------------------------------------------

    print("")
    print(
        "2. Normalizing product metadata..."
    )

    product = normalize_product_metadata(
        product_id=TEST_PRODUCT_ID,
        metadata=metadata,
    )

    validate_product(
        product
    )

    # --------------------------------------------------------
    # 3. Print AI attributes
    # --------------------------------------------------------

    print("")
    print(
        "3. Extracted product attributes..."
    )

    print(
        f"   Product : "
        f"{product.get('Product Name', '')}"
    )

    print(
        f"   Category: "
        f"{product.get('Category', '')}"
    )

    print(
        f"   Style   : "
        f"{product.get('AI Style', '')}"
    )

    print(
        f"   Color   : "
        f"{product.get('AI Color', '')}"
    )

    print(
        f"   Tone    : "
        f"{product.get('AI Tone', '')}"
    )

    print(
        f"   Finish  : "
        f"{product.get('Resolved Finish', '')}"
    )

    print(
        f"   Material: "
        f"{product.get('Material', '')}"
    )

    print(
        f"   Pattern : "
        f"{product.get('AI Pattern', '')}"
    )

    # --------------------------------------------------------
    # 4. Build moodboard
    # --------------------------------------------------------

    print("")
    print(
        "4. Building moodboard candidate..."
    )

    moodboard = build_scene_moodboard(
        product
    )

    if not moodboard:

        raise RuntimeError(
            "Moodboard was not created."
        )

    if not moodboard.get(
        "products"
    ):

        raise RuntimeError(
            "Moodboard contains no products."
        )

    print(
        "[PASS] Moodboard candidate created."
    )

    # --------------------------------------------------------
    # 5. Verify Product ID
    # --------------------------------------------------------

    print("")
    print(
        "5. Verifying Product ID linkage..."
    )

    candidate = (
        moodboard["products"][0]
    )

    candidate_product = (
        candidate.get(
            "product",
            {}
        )
    )

    candidate_id = normalize(
        candidate_product.get(
            "Product ID"
        )
    )

    if candidate_id != TEST_PRODUCT_ID:

        raise RuntimeError(
            "Product ID was not preserved "
            "through moodboard generation."
        )

    print(
        "[PASS] Product ID preserved."
    )

    print(
        f"       {candidate_id}"
    )

    # --------------------------------------------------------
    # 6. Save moodboard
    # --------------------------------------------------------

    print("")
    print(
        "6. Saving moodboard JSON..."
    )

    output_file = (
        MOODBOARD_OUTPUT_ROOT
        / f"{TEST_PRODUCT_ID}_moodboard.json"
    )

    save_json(
        moodboard,
        output_file,
    )

    if not output_file.exists():

        raise RuntimeError(
            "Moodboard JSON was not created."
        )

    if output_file.stat().st_size == 0:

        raise RuntimeError(
            "Moodboard JSON is empty."
        )

    print(
        "[PASS] Saved:"
    )

    print(
        f"       {output_file}"
    )

    # --------------------------------------------------------
    # 7. Final
    # --------------------------------------------------------

    print("")
    print("=" * 80)

    print(
        "SCENE TO MOODBOARD TEST PASSED"
    )

    print("=" * 80)

    print("")

    print(
        "Gemini Metadata : OK"
    )

    print(
        "Product ID      : OK"
    )

    print(
        "Product Type    : OK"
    )

    print(
        "AI Attributes   : OK"
    )

    print(
        "Moodboard       : OK"
    )

    print(
        "JSON Save       : OK"
    )

    print("")

    print(
        "Moodboard file:"
    )

    print(
        f"  {output_file}"
    )

    print("")


# ============================================================
# MAIN
# ============================================================

if __name__ == "__main__":

    try:

        test_scene_to_moodboard()

    except Exception as error:

        print("")
        print("=" * 80)
        print(
            "SCENE TO MOODBOARD TEST FAILED"
        )
        print("=" * 80)

        print("")
        print(
            f"ERROR: {error}"
        )

        print("")

        sys.exit(1)