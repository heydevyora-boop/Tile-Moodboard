# ============================================================
# PRODUCT FILTERING ENGINE
# ============================================================

from typing import Dict, List, Tuple


# ============================================================
# CONSTANTS
# ============================================================

UNKNOWN = "UNKNOWN"
ANY = "ANY"

YES = "YES"
NO = "NO"


# ============================================================
# NORMALIZATION
# ============================================================

def normalize(value):
    """
    Convert a value to a consistent comparison format.
    """

    if value is None:
        return ""

    return str(value).strip().upper()


# ============================================================
# SAFE VALUE HELPERS
# ============================================================

def is_yes(value):
    """
    Return True only when the value is definitely YES.

    UNKNOWN is intentionally NOT treated as YES.
    """

    return normalize(value) == YES


def is_unknown(value):
    return (
        normalize(value) == ""
        or normalize(value) == UNKNOWN
    )


# ============================================================
# BUDGET
# ============================================================

BUDGET_ORDER = {
    "BUDGET FRIENDLY": 1,
    "MID RANGE": 2,
    "HIGH RANGE": 3,
}


def budget_matches(
    product_budget,
    requested_budget,
):
    """
    Check whether the product satisfies
    the requested budget.

    ANY means no budget restriction.

    UNKNOWN product budget does not satisfy
    a specific budget requirement.
    """

    requested_budget = normalize(
        requested_budget
    )

    product_budget = normalize(
        product_budget
    )

    if requested_budget in ("", ANY):
        return True

    if product_budget in ("", UNKNOWN):
        return False

    return product_budget == requested_budget


# ============================================================
# FLOOR HARD FILTER
# ============================================================

def floor_matches(
    product,
    requirements,
):
    """
    Determine whether a product satisfies
    the floor requirement.
    """

    floor_required = normalize(
        requirements.get(
            "floor_required",
            YES
        )
    )

    if floor_required != YES:
        return True

    return is_yes(
        product.get(
            "Bathroom Floor",
            UNKNOWN
        )
    )


# ============================================================
# WALL HARD FILTER
# ============================================================

def wall_matches(
    product,
    requirements,
):
    """
    Determine whether a product satisfies
    the wall requirement.
    """

    wall_requirement = normalize(
        requirements.get(
            "wall_requirement",
            "NOT REQUIRED"
        )
    )

    if wall_requirement != "REQUIRED":
        return True

    return is_yes(
        product.get(
            "Bathroom Wall",
            UNKNOWN
        )
    )


# ============================================================
# SHOWER HARD FILTER
# ============================================================

def shower_matches(
    product,
    requirements,
):
    """
    Determine whether a product satisfies
    the shower-area requirement.
    """

    shower_required = normalize(
        requirements.get(
            "shower_required",
            NO
        )
    )

    if shower_required != YES:
        return True

    return is_yes(
        product.get(
            "Shower Area",
            UNKNOWN
        )
    )


# ============================================================
# HIGHLIGHT HARD FILTER
# ============================================================

def highlight_matches(
    product,
    requirements,
):
    """
    Determine whether a product satisfies
    the highlight requirement.
    """

    highlight_requirement = normalize(
        requirements.get(
            "highlight_requirement",
            "NOT REQUIRED"
        )
    )

    if highlight_requirement != "REQUIRED":
        return True

    return is_yes(
        product.get(
            "Highlight Suitable",
            UNKNOWN
        )
    )


# ============================================================
# HARD FILTER
# ============================================================

def passes_hard_filters(
    product,
    requirements,
):
    """
    Apply all hard requirements.

    Returns:

        True
        False

    A product is rejected if any required
    condition is definitely incompatible.

    UNKNOWN is NOT treated as YES.
    """

    # --------------------------------------------------------
    # FLOOR
    # --------------------------------------------------------

    if not floor_matches(
        product,
        requirements
    ):
        return False

    # --------------------------------------------------------
    # WALL
    # --------------------------------------------------------

    if not wall_matches(
        product,
        requirements
    ):
        return False

    # --------------------------------------------------------
    # SHOWER
    # --------------------------------------------------------

    if not shower_matches(
        product,
        requirements
    ):
        return False

    # --------------------------------------------------------
    # HIGHLIGHT
    # --------------------------------------------------------

    if not highlight_matches(
        product,
        requirements
    ):
        return False

    # --------------------------------------------------------
    # BUDGET
    # --------------------------------------------------------

    if not budget_matches(
        product.get(
            "Resolved Budget",
            UNKNOWN
        ),
        requirements.get(
            "budget",
            ANY
        ),
    ):
        return False

    return True


# ============================================================
# SIZE NORMALIZATION
# ============================================================

def normalize_size(value):
    """
    Normalize common size formats.

    Examples:

        6X4
        6 x 4
        6*4

    become:

        6X4
    """

    value = normalize(value)

    value = value.replace(
        " ",
        ""
    )

    value = value.replace(
        "*",
        "X"
    )

    value = value.replace(
        "×",
        "X"
    )

    return value


# ============================================================
# SIZE MATCH
# ============================================================

def size_matches(
    product_size,
    requested_size,
):
    """
    Compare product and requested size.
    """

    requested_size = normalize_size(
        requested_size
    )

    product_size = normalize_size(
        product_size
    )

    if requested_size in (
        "",
        ANY,
    ):
        return False

    if product_size in (
        "",
        UNKNOWN,
    ):
        return False

    return (
        product_size
        == requested_size
    )


# ============================================================
# FINISH MATCH
# ============================================================

def finish_matches(
    product_finish,
    requested_finish,
):
    """
    Soft preference for finish.
    """

    requested_finish = normalize(
        requested_finish
    )

    product_finish = normalize(
        product_finish
    )

    if requested_finish in (
        "",
        ANY,
    ):
        return False

    if product_finish in (
        "",
        UNKNOWN,
    ):
        return False

    return (
        product_finish
        == requested_finish
    )


# ============================================================
# STYLE MATCH
# ============================================================

def style_matches(
    product,
    requirements,
):
    """
    Soft preference for AI/manual style.

    Multiple possible product fields are checked
    to remain compatible with your existing sheet.
    """

    requested_style = normalize(
        requirements.get(
            "style",
            ANY
        )
    )

    if requested_style in (
        "",
        ANY,
    ):
        return False

    product_style = normalize(
        product.get(
            "AI Style",
            ""
        )
    )

    if not product_style:
        product_style = normalize(
            product.get(
                "Style",
                ""
            )
        )

    if product_style in (
        "",
        UNKNOWN,
    ):
        return False

    return (
        requested_style
        in product_style
    )


# ============================================================
# SOFT SCORE
# ============================================================

def calculate_soft_score(
    product,
    requirements,
):
    """
    Calculate a preference score.

    Current scoring:

        Floor size       +25
        Floor finish     +20
        Wall size        +15
        Wall finish      +15
        Style             +15
        Shower highlight  +10

    Maximum = 100
    """

    score = 0

    matched_preferences = []

    # --------------------------------------------------------
    # FLOOR SIZE
    # --------------------------------------------------------

    requested_floor_size = requirements.get(
        "floor_size",
        ANY
    )

    if size_matches(
        product.get(
            "Dimensions",
            ""
        ),
        requested_floor_size,
    ):
        score += 25

        matched_preferences.append(
            "FLOOR_SIZE"
        )

    # --------------------------------------------------------
    # FLOOR FINISH
    # --------------------------------------------------------

    requested_floor_finish = requirements.get(
        "floor_finish",
        ANY
    )

    if finish_matches(
        product.get(
            "Resolved Finish",
            ""
        ),
        requested_floor_finish,
    ):
        score += 20

        matched_preferences.append(
            "FLOOR_FINISH"
        )

    # --------------------------------------------------------
    # WALL SIZE
    # --------------------------------------------------------

    wall_requirement = normalize(
        requirements.get(
            "wall_requirement",
            "NOT REQUIRED"
        )
    )

    if wall_requirement == "REQUIRED":

        requested_wall_size = requirements.get(
            "wall_size",
            ANY
        )

        if size_matches(
            product.get(
                "Dimensions",
                ""
            ),
            requested_wall_size,
        ):
            score += 15

            matched_preferences.append(
                "WALL_SIZE"
            )

    # --------------------------------------------------------
    # WALL FINISH
    # --------------------------------------------------------

    if wall_requirement == "REQUIRED":

        requested_wall_finish = requirements.get(
            "wall_finish",
            ANY
        )

        if finish_matches(
            product.get(
                "Resolved Finish",
                ""
            ),
            requested_wall_finish,
        ):
            score += 15

            matched_preferences.append(
                "WALL_FINISH"
            )

    # --------------------------------------------------------
    # STYLE
    # --------------------------------------------------------

    if style_matches(
        product,
        requirements
    ):
        score += 15

        matched_preferences.append(
            "STYLE"
        )

    # --------------------------------------------------------
    # SHOWER HIGHLIGHT
    # --------------------------------------------------------

    shower_highlight_required = normalize(
        requirements.get(
            "shower_highlight_required",
            NO
        )
    )

    if shower_highlight_required == YES:

        if is_yes(
            product.get(
                "Highlight Suitable",
                UNKNOWN
            )
        ):
            score += 10

            matched_preferences.append(
                "SHOWER_HIGHLIGHT"
            )

    return score, matched_preferences


# ============================================================
# FILTER ONE PRODUCT
# ============================================================

def evaluate_product(
    product,
    requirements,
):
    """
    Evaluate one product.

    Returns a result dictionary.
    """

    if not passes_hard_filters(
        product,
        requirements,
    ):
        return {
            "product": product,
            "passes": False,
            "score": 0,
            "matched_preferences": [],
        }

    score, matched_preferences = (
        calculate_soft_score(
            product,
            requirements,
        )
    )

    return {
        "product": product,
        "passes": True,
        "score": score,
        "matched_preferences": matched_preferences,
    }


# ============================================================
# FILTER PRODUCT LIST
# ============================================================

def filter_products(
    products: List[Dict],
    requirements: Dict,
):
    """
    Apply hard filters to the complete product list.

    Then calculate soft preference scores.

    Returns only products that pass hard filters.
    """

    results = []

    for product in products:

        result = evaluate_product(
            product,
            requirements,
        )

        if result["passes"]:
            results.append(
                result
            )

    # --------------------------------------------------------
    # Highest score first
    # --------------------------------------------------------

    results.sort(
        key=lambda item: item["score"],
        reverse=True,
    )

    return results


# ============================================================
# TOP CANDIDATES
# ============================================================

def get_top_candidates(
    products: List[Dict],
    requirements: Dict,
    limit=100,
):
    """
    Return the top N products after filtering
    and ranking.
    """

    results = filter_products(
        products,
        requirements,
    )

    return results[:limit]


# ============================================================
# FILTER SUMMARY
# ============================================================

def filter_summary(
    products: List[Dict],
    requirements: Dict,
    limit=100,
):
    """
    Return a useful summary for debugging,
    UI, and later Gemini processing.
    """

    total_products = len(
        products
    )

    filtered_results = filter_products(
        products,
        requirements,
    )

    hard_filter_count = len(
        filtered_results
    )

    top_candidates = (
        filtered_results[:limit]
    )

    return {
        "total_products": total_products,

        "products_after_hard_filter": (
            hard_filter_count
        ),

        "top_candidates": len(
            top_candidates
        ),

        "candidate_results": (
            top_candidates
        ),
    }


# ============================================================
# DEBUG PRINT
# ============================================================

def print_filter_results(
    results,
):
    """
    Print candidate products in a readable format.
    """

    print("")
    print("=" * 70)
    print("PRODUCT FILTER RESULTS")
    print("=" * 70)

    print(
        f"Candidates: {len(results)}"
    )

    for index, result in enumerate(
        results,
        start=1,
    ):

        product = result[
            "product"
        ]

        print("")
        print(
            f"{index}. "
            f"{product.get('Product ID', 'UNKNOWN')}"
        )

        print(
            f"   Product: "
            f"{product.get('Product Name', '')}"
        )

        print(
            f"   Brand: "
            f"{product.get('Brand', '')}"
        )

        print(
            f"   Catalog: "
            f"{product.get('Catalog', '')}"
        )

        print(
            f"   Score: "
            f"{result['score']}"
        )

        print(
            f"   Matches: "
            f"{', '.join(result['matched_preferences'])}"
        )


# ============================================================
# END
# ============================================================