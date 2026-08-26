# ============================================================
# RECOMMENDATION ENGINE TEST
# ============================================================

from app.recommendation_engine import (
    recommend_products,
    print_recommendations,
    recommendation_summary,
)


# ============================================================
# PRODUCTS
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

        "AI Confidence": "HIGH",
    },


    {
        "Product ID": "P002",

        "Product Name": (
            "Luxury Gloss Marble"
        ),

        "Brand": "Brand B",

        "Catalog": "Luxury Collection",

        "Resolved Budget": "HIGH RANGE",

        "Resolved Finish": "GLOSS",

        "Bathroom Floor": "YES",

        "Bathroom Wall": "YES",

        "Shower Area": "YES",

        "Highlight Suitable": "YES",

        "Dimensions": "4X4",

        "AI Style": "LUXURY",

        "AI Color": "WHITE",

        "AI Tone": "COOL",

        "AI Pattern": "VEINED",

        "AI Confidence": "HIGH",
    },


    {
        "Product ID": "P003",

        "Product Name": (
            "Modern Neutral Stone"
        ),

        "Brand": "Brand C",

        "Catalog": "Contemporary Collection",

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

        "AI Pattern": "STONE",

        "AI Confidence": "MEDIUM",
    },


    {
        "Product ID": "P004",

        "Product Name": (
            "Minimal White Tile"
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

        "AI Tone": "COOL",

        "AI Pattern": "PLAIN",

        "AI Confidence": "HIGH",
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

    "style": "MODERN",

    # Optional AI preferences.
    "color": "BEIGE",

    "tone": "WARM",

    "pattern": "MARBLED",
}


# ============================================================
# SIMULATE PHASE 5 OUTPUT
# ============================================================

phase_5_results = [

    {
        "product": products[0],
        "score": 85,
        "matched_preferences": [
            "FLOOR_SIZE",
            "FLOOR_FINISH",
            "STYLE",
        ],
    },

    {
        "product": products[1],
        "score": 55,
        "matched_preferences": [
            "WALL_FINISH",
        ],
    },

    {
        "product": products[2],
        "score": 78,
        "matched_preferences": [
            "FLOOR_SIZE",
            "FLOOR_FINISH",
            "STYLE",
        ],
    },

    {
        "product": products[3],
        "score": 60,
        "matched_preferences": [
            "FLOOR_FINISH",
        ],
    },
]


# ============================================================
# RUN
# ============================================================

print("")
print("=" * 70)
print("RECOMMENDATION ENGINE TEST")
print("=" * 70)


recommendations = recommend_products(
    phase_5_results,
    requirements,
    limit=4,
)


# ============================================================
# PRINT
# ============================================================

print_recommendations(
    recommendations
)


# ============================================================
# SUMMARY
# ============================================================

print("")
print("=" * 70)
print("RECOMMENDATION SUMMARY")
print("=" * 70)

summary = recommendation_summary(
    recommendations
)

for item in summary:

    print("")
    print(
        f"Rank: {item['rank']}"
    )

    print(
        f"Product: "
        f"{item['product_name']}"
    )

    print(
        f"Score: "
        f"{item['recommendation_score']}"
    )

    print(
        f"Level: "
        f"{item['recommendation_level']}"
    )


# ============================================================
# VALIDATION
# ============================================================

assert len(
    recommendations
) == 4


assert (
    recommendations[0]["product"][
        "Product ID"
    ]
    == "P001"
)


assert (
    recommendations[0][
        "recommendation_score"
    ]
    >= recommendations[1][
        "recommendation_score"
    ]
)


print("")
print("=" * 70)
print("RECOMMENDATION ENGINE TEST COMPLETE")
print("=" * 70)