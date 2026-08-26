# ============================================================
# PRODUCT RECOMMENDATION ENGINE
# PHASE 7
# ============================================================

from typing import Dict, List


# ============================================================
# CONSTANTS
# ============================================================

UNKNOWN = "UNKNOWN"
ANY = "ANY"


# ============================================================
# NORMALIZATION
# ============================================================

def normalize(value):
    """
    Normalize a value for safe comparison.
    """

    if value is None:
        return ""

    return str(value).strip().upper()


# ============================================================
# SAFE MATCH
# ============================================================

def exact_match(
    product_value,
    requested_value,
):
    """
    Return True when both values match.

    ANY and UNKNOWN do not count as a match.
    """

    product_value = normalize(
        product_value
    )

    requested_value = normalize(
        requested_value
    )

    if requested_value in (
        "",
        ANY,
        UNKNOWN,
    ):
        return False

    if product_value in (
        "",
        UNKNOWN,
    ):
        return False

    return (
        product_value
        == requested_value
    )


# ============================================================
# CONTAINS MATCH
# ============================================================

def contains_match(
    product_value,
    requested_value,
):
    """
    Useful for style and descriptive attributes.
    """

    product_value = normalize(
        product_value
    )

    requested_value = normalize(
        requested_value
    )

    if requested_value in (
        "",
        ANY,
        UNKNOWN,
    ):
        return False

    if product_value in (
        "",
        UNKNOWN,
    ):
        return False

    return (
        requested_value
        in product_value
    )


# ============================================================
# SCORE RESULT
# ============================================================

def add_score(
    score,
    reasons,
    points,
    reason,
):
    """
    Add points and record why they were awarded.
    """

    score += points

    reasons.append(
        {
            "reason": reason,
            "points": points,
        }
    )

    return score


# ============================================================
# REQUIREMENT MATCHING
# ============================================================

def score_floor(
    product,
    requirements,
):
    """
    Score floor-related preferences.
    """

    score = 0
    reasons = []

    requested_size = requirements.get(
        "floor_size",
        ANY,
    )

    product_size = product.get(
        "Dimensions",
        "",
    )

    if exact_match(
        product_size,
        requested_size,
    ):
        score = add_score(
            score,
            reasons,
            15,
            "Floor size matches",
        )

    requested_finish = requirements.get(
        "floor_finish",
        ANY,
    )

    product_finish = product.get(
        "Resolved Finish",
        "",
    )

    if exact_match(
        product_finish,
        requested_finish,
    ):
        score = add_score(
            score,
            reasons,
            12,
            "Floor finish matches",
        )

    return score, reasons


# ============================================================
# WALL MATCHING
# ============================================================

def score_wall(
    product,
    requirements,
):
    """
    Score wall-related preferences.
    """

    score = 0
    reasons = []

    wall_requirement = normalize(
        requirements.get(
            "wall_requirement",
            "NOT REQUIRED",
        )
    )

    if wall_requirement != "REQUIRED":
        return score, reasons

    requested_size = requirements.get(
        "wall_size",
        ANY,
    )

    product_size = product.get(
        "Dimensions",
        "",
    )

    if exact_match(
        product_size,
        requested_size,
    ):
        score = add_score(
            score,
            reasons,
            10,
            "Wall size matches",
        )

    requested_finish = requirements.get(
        "wall_finish",
        ANY,
    )

    product_finish = product.get(
        "Resolved Finish",
        "",
    )

    if exact_match(
        product_finish,
        requested_finish,
    ):
        score = add_score(
            score,
            reasons,
            10,
            "Wall finish matches",
        )

    return score, reasons


# ============================================================
# BUDGET MATCHING
# ============================================================

def score_budget(
    product,
    requirements,
):
    """
    Score budget preference.
    """

    requested_budget = requirements.get(
        "budget",
        ANY,
    )

    product_budget = product.get(
        "Resolved Budget",
        UNKNOWN,
    )

    if exact_match(
        product_budget,
        requested_budget,
    ):
        return (
            15,
            [
                {
                    "reason": "Budget matches",
                    "points": 15,
                }
            ],
        )

    return 0, []


# ============================================================
# STYLE MATCHING
# ============================================================

def score_style(
    product,
    requirements,
):
    """
    Score AI-detected style.
    """

    requested_style = requirements.get(
        "style",
        ANY,
    )

    if normalize(
        requested_style
    ) in (
        "",
        ANY,
    ):
        return 0, []

    product_style = product.get(
        "AI Style",
        "",
    )

    if not product_style:
        product_style = product.get(
            "Style",
            "",
        )

    if contains_match(
        product_style,
        requested_style,
    ):
        return (
            15,
            [
                {
                    "reason": "Style matches",
                    "points": 15,
                }
            ],
        )

    return 0, []


# ============================================================
# COLOR MATCHING
# ============================================================

def score_color(
    product,
    requirements,
):
    """
    Score preferred color when supplied.

    Color is optional at this phase.
    """

    requested_color = requirements.get(
        "color",
        ANY,
    )

    if normalize(
        requested_color
    ) in (
        "",
        ANY,
        UNKNOWN,
    ):
        return 0, []

    product_color = product.get(
        "AI Color",
        "",
    )

    if contains_match(
        product_color,
        requested_color,
    ):
        return (
            8,
            [
                {
                    "reason": "Color matches",
                    "points": 8,
                }
            ],
        )

    return 0, []


# ============================================================
# TONE MATCHING
# ============================================================

def score_tone(
    product,
    requirements,
):
    """
    Score preferred visual tone.
    """

    requested_tone = requirements.get(
        "tone",
        ANY,
    )

    if normalize(
        requested_tone
    ) in (
        "",
        ANY,
        UNKNOWN,
    ):
        return 0, []

    product_tone = product.get(
        "AI Tone",
        "",
    )

    if exact_match(
        product_tone,
        requested_tone,
    ):
        return (
            6,
            [
                {
                    "reason": "Tone matches",
                    "points": 6,
                }
            ],
        )

    return 0, []


# ============================================================
# PATTERN MATCHING
# ============================================================

def score_pattern(
    product,
    requirements,
):
    """
    Score preferred visual pattern.
    """

    requested_pattern = requirements.get(
        "pattern",
        ANY,
    )

    if normalize(
        requested_pattern
    ) in (
        "",
        ANY,
        UNKNOWN,
    ):
        return 0, []

    product_pattern = product.get(
        "AI Pattern",
        "",
    )

    if exact_match(
        product_pattern,
        requested_pattern,
    ):
        return (
            6,
            [
                {
                    "reason": "Pattern matches",
                    "points": 6,
                }
            ],
        )

    return 0, []


# ============================================================
# HIGHLIGHT MATCHING
# ============================================================

def score_highlight(
    product,
    requirements,
):
    """
    Score highlight suitability.

    This is not a hard filter here because Phase 5
    already handles required highlight compatibility.
    """

    requirement = normalize(
        requirements.get(
            "highlight_requirement",
            "NOT REQUIRED",
        )
    )

    if requirement != "REQUIRED":
        return 0, []

    if normalize(
        product.get(
            "Highlight Suitable",
            UNKNOWN,
        )
    ) == "YES":

        return (
            8,
            [
                {
                    "reason": "Suitable for highlight use",
                    "points": 8,
                }
            ],
        )

    return 0, []


# ============================================================
# SHOWER MATCHING
# ============================================================

def score_shower(
    product,
    requirements,
):
    """
    Score shower-area suitability.

    Phase 5 already performs the hard check.
    """

    requirement = normalize(
        requirements.get(
            "shower_required",
            "NO",
        )
    )

    if requirement != "YES":
        return 0, []

    if normalize(
        product.get(
            "Shower Area",
            UNKNOWN,
        )
    ) == "YES":

        return (
            8,
            [
                {
                    "reason": "Suitable for shower area",
                    "points": 8,
                }
            ],
        )

    return 0, []


# ============================================================
# GEMINI CONFIDENCE
# ============================================================

def score_ai_confidence(
    product,
):
    """
    Give a small ranking bonus when Gemini
    classification has higher confidence.

    This does NOT override product compatibility.
    """

    confidence = normalize(
        product.get(
            "AI Confidence",
            "",
        )
    )

    if confidence == "HIGH":

        return (
            5,
            [
                {
                    "reason": "High AI classification confidence",
                    "points": 5,
                }
            ],
        )

    if confidence == "MEDIUM":

        return (
            2,
            [
                {
                    "reason": "Medium AI classification confidence",
                    "points": 2,
                }
            ],
        )

    return 0, []


# ============================================================
# COMPLETE RECOMMENDATION SCORE
# ============================================================

def calculate_recommendation_score(
    product,
    requirements,
):
    """
    Calculate the final recommendation score.

    Maximum theoretical score:

        Floor size        15
        Floor finish      12
        Wall size         10
        Wall finish       10
        Budget            15
        Style             15
        Color              8
        Tone               6
        Pattern            6
        Highlight          8
        Shower             8
        AI confidence      5

        TOTAL = 118
    """

    score = 0
    reasons = []

    scoring_functions = [

        score_floor,

        score_wall,

        score_budget,

        score_style,

        score_color,

        score_tone,

        score_pattern,

        score_highlight,

        score_shower,
    ]

    for scoring_function in scoring_functions:

        points, matches = scoring_function(
            product,
            requirements,
        )

        score += points
        reasons.extend(
            matches
        )

    # AI confidence is separate.
    points, matches = score_ai_confidence(
        product
    )

    score += points
    reasons.extend(
        matches
    )

    return score, reasons


# ============================================================
# RECOMMEND ONE PRODUCT
# ============================================================

def recommend_product(
    product,
    requirements,
    filter_score=0,
):
    """
    Create a recommendation result.
    """

    recommendation_score, reasons = (
        calculate_recommendation_score(
            product,
            requirements,
        )
    )

    return {
        "product": product,

        "filter_score": filter_score,

        "recommendation_score": (
            recommendation_score
        ),

        "matched_reasons": reasons,

        "recommendation_level": (
            get_recommendation_level(
                recommendation_score
            )
        ),
    }


# ============================================================
# RECOMMEND MANY PRODUCTS
# ============================================================

def recommend_products(
    products,
    requirements,
    limit=10,
):
    """
    Rank already-filtered products.
    """

    recommendations = []

    for item in products:

        # ----------------------------------------------------
        # Accept both:
        #
        # 1. Raw product dictionary
        # 2. Phase 5 result dictionary
        # ----------------------------------------------------

        if "product" in item:

            product = item[
                "product"
            ]

            filter_score = item.get(
                "score",
                0,
            )

        else:

            product = item

            filter_score = 0

        recommendation = recommend_product(
            product=product,
            requirements=requirements,
            filter_score=filter_score,
        )

        recommendations.append(
            recommendation
        )

    # --------------------------------------------------------
    # Sort highest recommendation score first
    # --------------------------------------------------------

    recommendations.sort(
        key=lambda item: (
            item["recommendation_score"],
            item["filter_score"],
        ),
        reverse=True,
    )

    # --------------------------------------------------------
    # Assign rank
    # --------------------------------------------------------

    for rank, recommendation in enumerate(
        recommendations[:limit],
        start=1,
    ):

        recommendation[
            "rank"
        ] = rank

    return recommendations[:limit]


# ============================================================
# RECOMMENDATION LEVEL
# ============================================================

def get_recommendation_level(
    score,
):
    """
    Convert score into a readable level.

    The thresholds are intentionally simple
    for Phase 7 and can be tuned later.
    """

    if score >= 80:
        return "EXCELLENT_MATCH"

    if score >= 60:
        return "STRONG_MATCH"

    if score >= 40:
        return "GOOD_MATCH"

    if score >= 20:
        return "PARTIAL_MATCH"

    return "LOW_MATCH"


# ============================================================
# SUMMARY
# ============================================================

def recommendation_summary(
    recommendations,
):
    """
    Create a simple summary for UI/API output.
    """

    output = []

    for item in recommendations:

        product = item[
            "product"
        ]

        output.append(
            {
                "rank": item.get(
                    "rank"
                ),

                "product_id": product.get(
                    "Product ID",
                    "",
                ),

                "product_name": product.get(
                    "Product Name",
                    "",
                ),

                "brand": product.get(
                    "Brand",
                    "",
                ),

                "catalog": product.get(
                    "Catalog",
                    "",
                ),

                "filter_score": item.get(
                    "filter_score",
                    0,
                ),

                "recommendation_score": item.get(
                    "recommendation_score",
                    0,
                ),

                "recommendation_level": item.get(
                    "recommendation_level",
                    "",
                ),

                "reasons": item.get(
                    "matched_reasons",
                    [],
                ),
            }
        )

    return output


# ============================================================
# DEBUG PRINT
# ============================================================

def print_recommendations(
    recommendations,
):
    """
    Print recommendations in a readable format.
    """

    print("")
    print("=" * 70)
    print("FINAL PRODUCT RECOMMENDATIONS")
    print("=" * 70)

    for item in recommendations:

        product = item[
            "product"
        ]

        print("")
        print(
            f"#{item.get('rank', '-')}"
        )

        print(
            f"Product ID: "
            f"{product.get('Product ID', '')}"
        )

        print(
            f"Product: "
            f"{product.get('Product Name', '')}"
        )

        print(
            f"Brand: "
            f"{product.get('Brand', '')}"
        )

        print(
            f"Recommendation Score: "
            f"{item['recommendation_score']}"
        )

        print(
            f"Level: "
            f"{item['recommendation_level']}"
        )

        print("Reasons:")

        for reason in item[
            "matched_reasons"
        ]:

            print(
                f"  + {reason['points']} "
                f"{reason['reason']}"
            )


# ============================================================
# END
# ============================================================