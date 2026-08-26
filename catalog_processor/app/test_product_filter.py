# ============================================================
# PRODUCT FILTER TEST
# ============================================================

from app.product_filter import (
    passes_hard_filters,
    calculate_soft_score,
    filter_products,
    get_top_candidates,
    filter_summary,
    print_filter_results,
)


# ============================================================
# TEST PRODUCTS
# ============================================================

products = [

    {
        "Product ID": "P001",
        "Product Name": "Modern Matte Floor Tile",
        "Brand": "Brand A",
        "Catalog": "Modern Collection",

        "Resolved Budget": "MID RANGE",
        "Resolved Finish": "MATTE",

        "Bathroom Floor": "YES",
        "Bathroom Wall": "YES",
        "Shower Area": "YES",
        "Highlight Suitable": "YES",

        "Dimensions": "6X4",

        "AI Style": "MODERN",
    },

    {
        "Product ID": "P002",
        "Product Name": "Gloss Wall Tile",
        "Brand": "Brand B",
        "Catalog": "Luxury Collection",

        "Resolved Budget": "HIGH RANGE",
        "Resolved Finish": "GLOSS",

        "Bathroom Floor": "NO",
        "Bathroom Wall": "YES",
        "Shower Area": "YES",
        "Highlight Suitable": "YES",

        "Dimensions": "4X4",

        "AI Style": "LUXURY",
    },

    {
        "Product ID": "P003",
        "Product Name": "Unknown Application Tile",
        "Brand": "Brand C",
        "Catalog": "Unknown Collection",

        "Resolved Budget": "MID RANGE",
        "Resolved Finish": "MATTE",

        "Bathroom Floor": "UNKNOWN",
        "Bathroom Wall": "UNKNOWN",
        "Shower Area": "UNKNOWN",
        "Highlight Suitable": "UNKNOWN",

        "Dimensions": "6X4",

        "AI Style": "MODERN",
    },

    {
        "Product ID": "P004",
        "Product Name": "Modern Floor Tile",
        "Brand": "Brand D",
        "Catalog": "Modern Collection",

        "Resolved Budget": "MID RANGE",
        "Resolved Finish": "MATTE",

        "Bathroom Floor": "YES",
        "Bathroom Wall": "YES",
        "Shower Area": "YES",
        "Highlight Suitable": "NO",

        "Dimensions": "4X4",

        "AI Style": "MODERN",
    },

    {
        "Product ID": "P005",
        "Product Name": "Budget Floor Tile",
        "Brand": "Brand E",
        "Catalog": "Budget Collection",

        "Resolved Budget": "BUDGET FRIENDLY",
        "Resolved Finish": "MATTE",

        "Bathroom Floor": "YES",
        "Bathroom Wall": "YES",
        "Shower Area": "NO",
        "Highlight Suitable": "NO",

        "Dimensions": "6X4",

        "AI Style": "MINIMAL",
    },
]


# ============================================================
# REQUIREMENTS
# ============================================================

requirements = {

    "space": "BATHROOM",

    "budget": "MID RANGE",

    "floor_required": "YES",
    "floor_size": "6X4",
    "floor_finish": "MATTE",

    "wall_requirement": "REQUIRED",
    "wall_size": "4X4",
    "wall_finish": "MATTE",

    "highlight_requirement": "REQUIRED",

    "shower_required": "YES",
    "shower_type": "GLASS PARTITION",
    "shower_highlight_required": "YES",

    "style": "MODERN",
}


# ============================================================
# TEST 1 — HARD FILTER
# ============================================================

print("")
print("=" * 70)
print("TEST 1 - HARD FILTER")
print("=" * 70)

for product in products:

    result = passes_hard_filters(
        product,
        requirements,
    )

    print(
        product["Product ID"],
        "=>",
        result,
    )


# ============================================================
# TEST 2 — UNKNOWN MUST FAIL
# ============================================================

print("")
print("=" * 70)
print("TEST 2 - UNKNOWN")
print("=" * 70)

unknown_product = products[2]

result = passes_hard_filters(
    unknown_product,
    requirements,
)

print(
    "P003 passes:",
    result,
)

assert result is False

print(
    "PASS: UNKNOWN was not treated as YES."
)


# ============================================================
# TEST 3 — SCORE
# ============================================================

print("")
print("=" * 70)
print("TEST 3 - SOFT SCORE")
print("=" * 70)

score, matches = calculate_soft_score(
    products[0],
    requirements,
)

print(
    "Product:",
    products[0]["Product ID"]
)

print(
    "Score:",
    score
)

print(
    "Matches:",
    matches
)


# ============================================================
# TEST 4 — FILTER ALL PRODUCTS
# ============================================================

print("")
print("=" * 70)
print("TEST 4 - FILTER PRODUCTS")
print("=" * 70)

results = filter_products(
    products,
    requirements,
)

print_filter_results(
    results
)


# ============================================================
# TEST 5 — TOP CANDIDATES
# ============================================================

print("")
print("=" * 70)
print("TEST 5 - TOP CANDIDATES")
print("=" * 70)

top_candidates = get_top_candidates(
    products,
    requirements,
    limit=3,
)

for result in top_candidates:

    print(
        result["product"]["Product ID"],
        "Score:",
        result["score"]
    )


# ============================================================
# TEST 6 — SUMMARY
# ============================================================

print("")
print("=" * 70)
print("TEST 6 - SUMMARY")
print("=" * 70)

summary = filter_summary(
    products,
    requirements,
    limit=3,
)

print(
    "Total products:",
    summary["total_products"]
)

print(
    "After hard filter:",
    summary["products_after_hard_filter"]
)

print(
    "Top candidates:",
    summary["top_candidates"]
)


# ============================================================
# COMPLETE
# ============================================================

print("")
print("=" * 70)
print("PRODUCT FILTER TEST COMPLETE")
print("=" * 70)