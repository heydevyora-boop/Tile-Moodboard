# ============================================================
# MOODBOARD ENGINE TEST
# ============================================================

from app.moodboard_engine import (
    create_four_moodboards,
    print_moodboards,
    calculate_mood_diversity,
    moodboard_summary,
)


# ============================================================
# TEST PRODUCTS
# ============================================================

products = [

    {
        "Product ID": "P001",

        "Product Name": (
            "Modern Matte Marble Tile"
        ),

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

        "AI Color": "BEIGE",

        "AI Tone": "WARM",

        "AI Pattern": "MARBLED",

        "AI Contrast": "MEDIUM",

        "AI Confidence": "HIGH",
    },


    {
        "Product ID": "P002",

        "Product Name": (
            "Luxury Polished Marble"
        ),

        "Brand": "Brand B",

        "Catalog": "Luxury Collection",

        "Resolved Budget": "HIGH RANGE",

        "Resolved Finish": "POLISHED",

        "Bathroom Floor": "YES",

        "Bathroom Wall": "YES",

        "Shower Area": "YES",

        "Highlight Suitable": "YES",

        "Dimensions": "4X4",

        "AI Style": "LUXURY",

        "AI Color": "WHITE",

        "AI Tone": "COOL",

        "AI Pattern": "VEINED",

        "AI Contrast": "HIGH",

        "AI Confidence": "HIGH",
    },


    {
        "Product ID": "P003",

        "Product Name": (
            "Natural Stone Beige"
        ),

        "Brand": "Brand C",

        "Catalog": "Natural Collection",

        "Resolved Budget": "MID RANGE",

        "Resolved Finish": "MATTE",

        "Bathroom Floor": "YES",

        "Bathroom Wall": "YES",

        "Shower Area": "YES",

        "Highlight Suitable": "YES",

        "Dimensions": "6X4",

        "AI Style": "NATURAL",

        "AI Color": "BEIGE",

        "AI Tone": "WARM",

        "AI Pattern": "STONE",

        "AI Contrast": "LOW",

        "AI Confidence": "HIGH",
    },


    {
        "Product ID": "P004",

        "Product Name": (
            "Minimal White Concrete"
        ),

        "Brand": "Brand D",

        "Catalog": "Minimal Collection",

        "Resolved Budget": "MID RANGE",

        "Resolved Finish": "MATTE",

        "Bathroom Floor": "YES",

        "Bathroom Wall": "YES",

        "Shower Area": "YES",

        "Highlight Suitable": "YES",

        "Dimensions": "4X4",

        "AI Style": "MINIMAL",

        "AI Color": "WHITE",

        "AI Tone": "LIGHT",

        "AI Pattern": "CONCRETE",

        "AI Contrast": "LOW",

        "AI Confidence": "HIGH",
    },


    {
        "Product ID": "P005",

        "Product Name": (
            "Contemporary Veined Stone"
        ),

        "Brand": "Brand E",

        "Catalog": "Contemporary Collection",

        "Resolved Budget": "HIGH RANGE",

        "Resolved Finish": "LAPPATO",

        "Bathroom Floor": "YES",

        "Bathroom Wall": "YES",

        "Shower Area": "YES",

        "Highlight Suitable": "YES",

        "Dimensions": "6X4",

        "AI Style": "CONTEMPORARY",

        "AI Color": "GREY",

        "AI Tone": "COOL",

        "AI Pattern": "VEINED",

        "AI Contrast": "MEDIUM",

        "AI Confidence": "MEDIUM",
    },
]


# ============================================================
# SIMULATE PHASE 7 OUTPUT
# ============================================================

phase_7_results = [

    {
        "product": products[0],
        "recommendation_score": 108,
        "filter_score": 85,
    },

    {
        "product": products[1],
        "recommendation_score": 95,
        "filter_score": 70,
    },

    {
        "product": products[2],
        "recommendation_score": 92,
        "filter_score": 82,
    },

    {
        "product": products[3],
        "recommendation_score": 78,
        "filter_score": 65,
    },

    {
        "product": products[4],
        "recommendation_score": 88,
        "filter_score": 76,
    },
]


# ============================================================
# CREATE FOUR MOODBOARDS
# ============================================================

print("")
print("=" * 75)
print("MOODBOARD ENGINE TEST")
print("=" * 75)


moodboards = create_four_moodboards(
    products=phase_7_results,
    product_limit=3,
)


# ============================================================
# PRINT
# ============================================================

print_moodboards(
    moodboards
)


# ============================================================
# DIVERSITY
# ============================================================

print("")
print("=" * 75)
print("MOODBOARD DIVERSITY")
print("=" * 75)


diversity = calculate_mood_diversity(
    moodboards
)


print(
    "Total moodboards:",
    diversity[
        "total_moodboards"
    ]
)

print(
    "Unique product sets:",
    diversity[
        "unique_product_sets"
    ]
)

print(
    "Diverse:",
    diversity[
        "diverse"
    ]
)


# ============================================================
# SUMMARY
# ============================================================

print("")
print("=" * 75)
print("MOODBOARD SUMMARY")
print("=" * 75)


summary = moodboard_summary(
    moodboards
)


for item in summary:

    print("")
    print(
        "Moodboard:",
        item["name"]
    )

    print(
        "Products:",
        len(
            item["products"]
        )
    )

    for product in item[
        "products"
    ]:

        print(
            f"  - "
            f"{product['product_name']} "
            f"({product['mood_score']})"
        )


# ============================================================
# VALIDATION
# ============================================================

assert len(
    moodboards
) == 4


assert (
    moodboards[0][
        "moodboard_id"
    ]
    == "MODERN"
)


assert (
    moodboards[1][
        "moodboard_id"
    ]
    == "LUXURY"
)


assert (
    moodboards[2][
        "moodboard_id"
    ]
    == "NATURAL"
)


assert (
    moodboards[3][
        "moodboard_id"
    ]
    == "MINIMAL"
)


for moodboard in moodboards:

    assert len(
        moodboard["products"]
    ) <= 3


print("")
print("=" * 75)
print("MOODBOARD ENGINE TEST COMPLETE")
print("=" * 75)