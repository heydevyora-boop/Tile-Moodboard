# ============================================================
# FINAL BATHROOM COMPOSITION ENGINE
# PHASE 10
# ============================================================

import json
from datetime import datetime
from pathlib import Path

from app import scene_manager


# ============================================================
# CONSTANTS
# ============================================================

ENGINE_VERSION = "1.0"

UNKNOWN = "UNKNOWN"


# ============================================================
# NORMALIZATION
# ============================================================

def normalize(value):
    """
    Normalize a value safely.
    """

    if value is None:
        return ""

    return str(value).strip()


# ============================================================
# GET PRODUCT
# ============================================================

def get_product_from_result(
    result
):
    """
    Extract product information from either:

    1. A raw product dictionary
    2. A Phase 7 recommendation result
    3. A Phase 8 moodboard result
    """

    if not result:
        return None

    if isinstance(
        result,
        dict
    ):

        if "product" in result:

            return result[
                "product"
            ]

        if "fixture" in result:

            return result[
                "fixture"
            ]

        return result

    return None


# ============================================================
# SELECT BEST MOODBOARD
# ============================================================

def select_best_moodboard(
    moodboards,
):
    """
    Select the strongest moodboard based on
    the highest total product mood score.
    """

    if not moodboards:
        return None

    best = None
    best_score = -1

    for moodboard in moodboards:

        products = moodboard.get(
            "products",
            []
        )

        total_score = 0

        if products:

            scores = []

            for item in products:

                score = item.get(
                    "total_score",
                    item.get(
                        "mood_score",
                        0
                    )
                )

                try:
                    score = float(
                        score
                    )

                except (
                    TypeError,
                    ValueError
                ):

                    score = 0

                scores.append(
                    score
                )

            if scores:

                # Give more importance to the
                # strongest product while still
                # considering the complete moodboard.
                total_score = (
                    max(scores)
                    + (
                        sum(scores)
                        / len(scores)
                    )
                )

        if total_score > best_score:

            best_score = total_score

            best = {
                "moodboard": moodboard,
                "selection_score": total_score,
            }

    return best


# ============================================================
# EXTRACT MOODBOARD PRODUCTS
# ============================================================

def extract_moodboard_products(
    moodboard
):
    """
    Extract the products belonging to the
    selected moodboard.
    """

    if not moodboard:
        return []

    products = []

    for item in moodboard.get(
        "products",
        []
    ):

        product = get_product_from_result(
            item
        )

        if not product:
            continue

        products.append(
            {
                "product": product,

                "mood_score": item.get(
                    "mood_score",
                    0
                ),

                "total_score": item.get(
                    "total_score",
                    0
                ),

                "matches": item.get(
                    "mood_matches",
                    []
                ),
            }
        )

    return products


# ============================================================
# EXTRACT FIXTURE
# ============================================================

def extract_fixture(
    fixture_result
):
    """
    Convert a Phase 9 fixture result
    into final output format.
    """

    if not fixture_result:
        return None

    fixture = fixture_result.get(
        "fixture"
    )

    if not fixture:
        return None

    return {
        "product_id": fixture.get(
            "Product ID",
            ""
        ),

        "product_name": fixture.get(
            "Product Name",
            ""
        ),

        "brand": fixture.get(
            "Brand",
            ""
        ),

        "category": fixture.get(
            "Category",
            ""
        ),

        "style": fixture.get(
            "Style",
            UNKNOWN
        ),

        "color": fixture.get(
            "Color",
            UNKNOWN
        ),

        "tone": fixture.get(
            "Tone",
            UNKNOWN
        ),

        "finish": fixture.get(
            "Finish",
            UNKNOWN
        ),

        "budget": fixture.get(
            "Budget",
            UNKNOWN
        ),

        "score": fixture_result.get(
            "score",
            0
        ),

        "technical_verified": (
            fixture_result.get(
                "technical_verified",
                False
            )
        ),

        "reasons": fixture_result.get(
            "reasons",
            []
        ),
    }


# ============================================================
# BUILD FIXTURE SECTION
# ============================================================

def build_fixture_section(
    fixture_package
):
    """
    Convert Phase 9 package into
    final fixture output.
    """

    if not fixture_package:
        return {}

    output = {}

    for category in (
        "BASIN",
        "WC",
        "FAUCET",
        "SHOWER",
    ):

        output[
            category
        ] = extract_fixture(
            fixture_package.get(
                category
            )
        )

    return output


# ============================================================
# BUILD TILE SECTION
# ============================================================

def build_tile_section(
    moodboard_products
):
    """
    Convert moodboard products into
    final tile/product selections.
    """

    tiles = []

    for item in moodboard_products:

        product = item.get(
            "product"
        )

        if not product:
            continue

        tiles.append(
            {
                "product_id": product.get(
                    "Product ID",
                    ""
                ),

                "product_name": product.get(
                    "Product Name",
                    ""
                ),

                "brand": product.get(
                    "Brand",
                    ""
                ),

                "catalog": product.get(
                    "Catalog",
                    ""
                ),

                "dimensions": product.get(
                    "Dimensions",
                    ""
                ),

                "finish": product.get(
                    "Resolved Finish",
                    ""
                ),

                "budget": product.get(
                    "Resolved Budget",
                    ""
                ),

                "ai_style": product.get(
                    "AI Style",
                    UNKNOWN
                ),

                "ai_color": product.get(
                    "AI Color",
                    UNKNOWN
                ),

                "ai_tone": product.get(
                    "AI Tone",
                    UNKNOWN
                ),

                "ai_pattern": product.get(
                    "AI Pattern",
                    UNKNOWN
                ),

                "mood_score": item.get(
                    "mood_score",
                    0
                ),

                "total_score": item.get(
                    "total_score",
                    0
                ),

                "matches": item.get(
                    "matches",
                    []
                ),
            }
        )

    return tiles


# ============================================================
# DESIGN SUMMARY
# ============================================================

def create_design_summary(
    requirements,
    moodboard,
    tiles,
    fixtures
):
    """
    Create a human-readable summary
    of the final bathroom design.
    """

    moodboard_name = (
        moodboard.get(
            "name",
            "Bathroom Design"
        )
        if moodboard
        else "Bathroom Design"
    )

    style = (
        requirements.get(
            "style",
            UNKNOWN
        )
    )

    budget = (
        requirements.get(
            "budget",
            UNKNOWN
        )
    )

    parts = []

    parts.append(
        f"{moodboard_name} bathroom design"
    )

    if style:
        parts.append(
            f"with {style.lower()} styling"
        )

    if budget:
        parts.append(
            f"for a {budget.lower()} budget direction"
        )

    tile_count = len(
        tiles
    )

    fixture_count = sum(
        1
        for value in fixtures.values()
        if value
    )

    parts.append(
        f"using {tile_count} selected surface products"
    )

    parts.append(
        f"and {fixture_count} compatible fixtures"
    )

    return (
        ". ".join(parts)
        + "."
    )


# ============================================================
# FINAL DESIGN SCORE
# ============================================================

def calculate_final_score(
    moodboard_selection,
    fixtures
):
    """
    Calculate a final composition score.

    This is a presentation/composition score,
    not a technical certification.
    """

    if not moodboard_selection:
        return 0

    mood_score = (
        moodboard_selection.get(
            "selection_score",
            0
        )
    )

    fixture_scores = []

    for fixture in fixtures.values():

        if not fixture:
            continue

        try:

            fixture_scores.append(
                float(
                    fixture.get(
                        "score",
                        0
                    )
                )
            )

        except (
            TypeError,
            ValueError
        ):

            pass

    if fixture_scores:

        average_fixture_score = (
            sum(fixture_scores)
            / len(fixture_scores)
        )

    else:

        average_fixture_score = 0

    # Normalize moodboard contribution
    # so it does not dominate the fixtures.
    mood_component = min(
        mood_score,
        100
    )

    fixture_component = min(
        average_fixture_score,
        100
    )

    final_score = (
        (
            mood_component * 0.70
        )
        +
        (
            fixture_component * 0.30
        )
    )

    return round(
        final_score,
        2
    )


# ============================================================
# BUILD FINAL DESIGN
# ============================================================

def build_final_bathroom_design(
    requirements,
    moodboards,
    fixture_packages,
):
    """
    Build the final complete bathroom
    design package.
    """

    # --------------------------------------------------------
    # Select best moodboard
    # --------------------------------------------------------

    moodboard_selection = (
        select_best_moodboard(
            moodboards
        )
    )

    if not moodboard_selection:

        raise ValueError(
            "No moodboard available."
        )

    selected_moodboard = (
        moodboard_selection[
            "moodboard"
        ]
    )

    # --------------------------------------------------------
    # Products
    # --------------------------------------------------------

    moodboard_products = (
        extract_moodboard_products(
            selected_moodboard
        )
    )

    tiles = build_tile_section(
        moodboard_products
    )

    # --------------------------------------------------------
    # Find matching fixture package
    # --------------------------------------------------------

    selected_fixture_package = None

    selected_id = (
        selected_moodboard.get(
            "moodboard_id",
            ""
        )
    )

    for package in fixture_packages:

        if (
            package.get(
                "moodboard_id",
                ""
            )
            == selected_id
        ):

            selected_fixture_package = (
                package.get(
                    "fixture_package",
                    {}
                )
            )

            break

    # --------------------------------------------------------
    # Fixtures
    # --------------------------------------------------------

    fixtures = build_fixture_section(
        selected_fixture_package
    )

    # --------------------------------------------------------
    # Final score
    # --------------------------------------------------------

    final_score = (
        calculate_final_score(
            moodboard_selection=(
                moodboard_selection
            ),
            fixtures=fixtures
        )
    )

    # --------------------------------------------------------
    # Design summary
    # --------------------------------------------------------

    summary = create_design_summary(
        requirements=requirements,

        moodboard=selected_moodboard,

        tiles=tiles,

        fixtures=fixtures
    )

    # --------------------------------------------------------
    # Technical verification summary
    # --------------------------------------------------------

    verified_fixture_count = sum(
        1
        for fixture in fixtures.values()
        if fixture
        and fixture.get(
            "technical_verified",
            False
        )
    )

    total_fixture_count = sum(
        1
        for fixture in fixtures.values()
        if fixture
    )

    # --------------------------------------------------------
    # Final object
    # --------------------------------------------------------

    final_design = {

        "engine": {
            "name": (
                "Final Bathroom "
                "Composition Engine"
            ),

            "version": ENGINE_VERSION,

            "generated_at": (
                datetime.now().isoformat()
            ),
        },

        "requirements": requirements,

        "selected_moodboard": {

            "id": selected_moodboard.get(
                "moodboard_id",
                ""
            ),

            "name": selected_moodboard.get(
                "name",
                ""
            ),

            "description": selected_moodboard.get(
                "description",
                ""
            ),

            "selection_score": (
                moodboard_selection.get(
                    "selection_score",
                    0
                )
            ),
        },

        "surface_products": tiles,

        "fixtures": fixtures,

        "scores": {

            "final_composition_score": (
                final_score
            ),

            "verified_fixtures": (
                verified_fixture_count
            ),

            "total_fixtures": (
                total_fixture_count
            ),
        },

        "summary": summary,

        "rendering": {

            "status": "NOT_RENDERED",

            "renderer": None,

            "image_path": None,

            "render_version": None,
        },

        "storage": {

            "status": "LOCAL_ONLY",

            "google_drive": False,

            "google_sheets": False,
        },
    }

    # --------------------------------------------------------
    # CREATE LOCKED SCENE
    # --------------------------------------------------------
    #
    # The final bathroom design is now stored as a locked
    # scene. The generated SCENE_ID will be reused for all
    # future camera-angle generations.
    #
    # Products, layout, finishes, fixtures and other selected
    # design attributes remain associated with this scene.
    # Angle generation must use this existing scene instead
    # of creating a new bathroom design.
    #

    scene = scene_manager.create_scene(
        final_design
    )

    final_design["scene"] = scene

    return final_design


# ============================================================
# VALIDATE FINAL DESIGN
# ============================================================

def validate_final_design(
    design
):
    """
    Validate the final design package.
    """

    errors = []

    if not design:

        errors.append(
            "Final design is empty."
        )

        return errors

    if not design.get(
        "selected_moodboard"
    ):

        errors.append(
            "Selected moodboard missing."
        )

    if not design.get(
        "surface_products"
    ):

        errors.append(
            "Surface products missing."
        )

    fixtures = design.get(
        "fixtures",
        {}
    )

    for category in (
        "BASIN",
        "WC",
        "FAUCET",
        "SHOWER",
    ):

        if not fixtures.get(
            category
        ):

            errors.append(
                f"{category} fixture missing."
            )

    if not design.get(
        "summary"
    ):

        errors.append(
            "Design summary missing."
        )

    return errors


# ============================================================
# EXPORT JSON
# ============================================================

def export_final_design(
    design,
    output_path
):
    """
    Export final design as JSON.
    """

    output_path = Path(
        output_path
    )

    output_path.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    with open(
        output_path,
        "w",
        encoding="utf-8"
    ) as file:

        json.dump(
            design,
            file,
            indent=4,
            ensure_ascii=False
        )

    return str(
        output_path
    )


# ============================================================
# PRINT FINAL DESIGN
# ============================================================

def print_final_design(
    design
):
    """
    Print final bathroom design.
    """

    print("")
    print("=" * 80)
    print("FINAL BATHROOM DESIGN")
    print("=" * 80)

    moodboard = design[
        "selected_moodboard"
    ]

    print("")
    print(
        "SELECTED MOODBOARD:"
    )

    print(
        f"  {moodboard['name']}"
    )

    print(
        f"  ID: {moodboard['id']}"
    )

    print(
        f"  Selection Score: "
        f"{moodboard['selection_score']:.2f}"
    )

    print("")
    print(
        "SURFACE PRODUCTS:"
    )

    for product in design[
        "surface_products"
    ]:

        print(
            f"  - "
            f"{product['product_name']} "
            f"({product['product_id']})"
        )

    print("")
    print(
        "FIXTURES:"
    )

    for category, fixture in design[
        "fixtures"
    ].items():

        if fixture:

            print(
                f"  {category}: "
                f"{fixture['product_name']} "
                f"({fixture['product_id']})"
            )

        else:

            print(
                f"  {category}: NONE"
            )

    print("")
    print(
        "FINAL COMPOSITION SCORE:",
        design[
            "scores"
        ][
            "final_composition_score"
        ]
    )

    print("")
    print(
        "TECHNICAL VERIFICATION:"
    )

    print(
        f"  Verified fixtures: "
        f"{design['scores']['verified_fixtures']}/"
        f"{design['scores']['total_fixtures']}"
    )

    print("")
    print(
        "SUMMARY:"
    )

    print(
        f"  {design['summary']}"
    )

    print("")
    print(
        "RENDERING STATUS:"
    )

    print(
        f"  {design['rendering']['status']}"
    )

    print("")
    print(
        "STORAGE STATUS:"
    )

    print(
        f"  {design['storage']['status']}"
    )


# ============================================================
# END
# ===============