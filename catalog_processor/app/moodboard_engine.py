# ============================================================
# MOODBOARD ENGINE
# PHASE 8
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
# MOODBOARD DEFINITIONS
# ============================================================

MOODBOARD_DEFINITIONS = {

    "MODERN": {
        "name": "Modern Serenity",

        "description": (
            "A clean contemporary bathroom direction "
            "using refined surfaces, balanced contrast "
            "and simple modern forms."
        ),

        "preferred_styles": {
            "MODERN",
            "CONTEMPORARY",
        },

        "preferred_tones": {
            "NEUTRAL",
            "COOL",
            "WARM",
        },

        "preferred_patterns": {
            "PLAIN",
            "VEINED",
            "MARBLED",
            "STONE",
        },

        "preferred_finishes": {
            "MATTE",
            "SATIN",
            "LAPPATO",
        },

        "preferred_contrasts": {
            "LOW",
            "MEDIUM",
        },
    },


    "LUXURY": {
        "name": "Luxury Marble",

        "description": (
            "An elegant premium bathroom direction "
            "built around sophisticated surfaces, "
            "marble character and refined contrast."
        ),

        "preferred_styles": {
            "LUXURY",
            "CONTEMPORARY",
        },

        "preferred_tones": {
            "NEUTRAL",
            "COOL",
        },

        "preferred_patterns": {
            "MARBLED",
            "VEINED",
            "STONE",
        },

        "preferred_finishes": {
            "POLISHED",
            "LAPPATO",
            "GLOSS",
        },

        "preferred_contrasts": {
            "MEDIUM",
            "HIGH",
        },
    },


    "NATURAL": {
        "name": "Natural Retreat",

        "description": (
            "A warm organic bathroom direction "
            "inspired by stone, earthy surfaces "
            "and calm natural tones."
        ),

        "preferred_styles": {
            "NATURAL",
            "EARTHY",
            "CONTEMPORARY",
        },

        "preferred_tones": {
            "WARM",
            "NEUTRAL",
        },

        "preferred_patterns": {
            "STONE",
            "WOOD",
            "TEXTURED",
        },

        "preferred_finishes": {
            "MATTE",
            "TEXTURED",
            "SATIN",
        },

        "preferred_contrasts": {
            "LOW",
            "MEDIUM",
        },
    },


    "MINIMAL": {
        "name": "Minimal Calm",

        "description": (
            "A restrained bathroom direction using "
            "simple surfaces, quiet colors and "
            "low visual complexity."
        ),

        "preferred_styles": {
            "MINIMAL",
            "MODERN",
        },

        "preferred_tones": {
            "LIGHT",
            "NEUTRAL",
            "COOL",
        },

        "preferred_patterns": {
            "PLAIN",
            "CONCRETE",
            "STONE",
        },

        "preferred_finishes": {
            "MATTE",
            "SATIN",
        },

        "preferred_contrasts": {
            "LOW",
        },
    },
}


# ============================================================
# PRODUCT VALUE HELPERS
# ============================================================

def get_product_style(product):
    """
    Get AI style or fallback style.
    """

    value = product.get(
        "AI Style",
        "",
    )

    if not value:
        value = product.get(
            "Style",
            "",
        )

    return normalize(value)


def get_product_tone(product):

    return normalize(
        product.get(
            "AI Tone",
            "",
        )
    )


def get_product_pattern(product):

    return normalize(
        product.get(
            "AI Pattern",
            "",
        )
    )


def get_product_finish(product):

    return normalize(
        product.get(
            "Resolved Finish",
            "",
        )
    )


def get_product_contrast(product):

    return normalize(
        product.get(
            "AI Contrast",
            "",
        )
    )


# ============================================================
# PRODUCT MOOD SCORE
# ============================================================

def calculate_mood_score(
    product,
    mood_key,
):
    """
    Calculate how well a product fits
    a particular moodboard.

    Maximum = 50
    """

    definition = MOODBOARD_DEFINITIONS[
        mood_key
    ]

    score = 0
    reasons = []

    # --------------------------------------------------------
    # STYLE
    # --------------------------------------------------------

    style = get_product_style(
        product
    )

    if style in definition[
        "preferred_styles"
    ]:

        score += 15

        reasons.append(
            "STYLE"
        )

    # --------------------------------------------------------
    # TONE
    # --------------------------------------------------------

    tone = get_product_tone(
        product
    )

    if tone in definition[
        "preferred_tones"
    ]:

        score += 8

        reasons.append(
            "TONE"
        )

    # --------------------------------------------------------
    # PATTERN
    # --------------------------------------------------------

    pattern = get_product_pattern(
        product
    )

    if pattern in definition[
        "preferred_patterns"
    ]:

        score += 10

        reasons.append(
            "PATTERN"
        )

    # --------------------------------------------------------
    # FINISH
    # --------------------------------------------------------

    finish = get_product_finish(
        product
    )

    if finish in definition[
        "preferred_finishes"
    ]:

        score += 5

        reasons.append(
            "FINISH"
        )

    # --------------------------------------------------------
    # CONTRAST
    # --------------------------------------------------------

    contrast = get_product_contrast(
        product
    )

    if contrast in definition[
        "preferred_contrasts"
    ]:

        score += 5

        reasons.append(
            "CONTRAST"
        )

    # --------------------------------------------------------
    # BATHROOM COMPATIBILITY
    # --------------------------------------------------------

    if (
        normalize(
            product.get(
                "Bathroom Floor",
                UNKNOWN,
            )
        )
        == "YES"
    ):

        score += 7

        reasons.append(
            "BATHROOM_FLOOR"
        )

    return score, reasons


# ============================================================
# RECOMMEND PRODUCTS FOR MOOD
# ============================================================

def rank_products_for_mood(
    products,
    mood_key,
    limit=5,
):
    """
    Rank products according to one moodboard.
    """

    ranked = []

    for item in products:

        # ----------------------------------------------------
        # Accept Phase 7 recommendation objects
        # ----------------------------------------------------

        if "product" in item:

            product = item[
                "product"
            ]

            base_score = item.get(
                "recommendation_score",
                item.get(
                    "score",
                    0,
                ),
            )

        else:

            product = item
            base_score = 0

        mood_score, reasons = (
            calculate_mood_score(
                product,
                mood_key,
            )
        )

        # Base recommendation score is
        # used as a tie-breaker.
        total_score = (
            mood_score
            + (
                base_score * 0.25
            )
        )

        ranked.append(
            {
                "product": product,

                "base_score": base_score,

                "mood_score": mood_score,

                "total_score": total_score,

                "mood_matches": reasons,
            }
        )

    ranked.sort(
        key=lambda item: (
            item["total_score"],
            item["mood_score"],
            item["base_score"],
        ),
        reverse=True,
    )

    return ranked[:limit]


# ============================================================
# CREATE ONE MOODBOARD
# ============================================================

def create_moodboard(
    products,
    mood_key,
    product_limit=5,
):
    """
    Create one complete moodboard.
    """

    if mood_key not in (
        MOODBOARD_DEFINITIONS
    ):
        raise ValueError(
            f"Unknown moodboard: {mood_key}"
        )

    definition = (
        MOODBOARD_DEFINITIONS[
            mood_key
        ]
    )

    ranked_products = (
        rank_products_for_mood(
            products=products,
            mood_key=mood_key,
            limit=product_limit,
        )
    )

    return {

        "moodboard_id": mood_key,

        "name": definition[
            "name"
        ],

        "description": definition[
            "description"
        ],

        "products": ranked_products,
    }


# ============================================================
# CREATE FOUR MOODBOARDS
# ============================================================

def create_four_moodboards(
    products,
    product_limit=5,
):
    """
    Generate the four bathroom moodboards.
    """

    moodboards = []

    for mood_key in (
        "MODERN",
        "LUXURY",
        "NATURAL",
        "MINIMAL",
    ):

        moodboard = create_moodboard(
            products=products,
            mood_key=mood_key,
            product_limit=product_limit,
        )

        moodboards.append(
            moodboard
        )

    return moodboards


# ============================================================
# DIVERSITY CHECK
# ============================================================

def calculate_mood_diversity(
    moodboards,
):
    """
    Check whether the four moodboards
    actually produce different product sets.
    """

    product_sets = []

    for moodboard in moodboards:

        ids = set()

        for item in moodboard[
            "products"
        ]:

            product = item[
                "product"
            ]

            product_id = product.get(
                "Product ID",
                "",
            )

            if product_id:
                ids.add(
                    product_id
                )

        product_sets.append(
            ids
        )

    unique_sets = set(
        frozenset(
            item
        )
        for item in product_sets
    )

    return {
        "total_moodboards": len(
            moodboards
        ),

        "unique_product_sets": len(
            unique_sets
        ),

        "diverse": (
            len(unique_sets) > 1
        ),
    }


# ============================================================
# SUMMARY
# ============================================================

def moodboard_summary(
    moodboards,
):
    """
    Return a UI-friendly summary.
    """

    summary = []

    for moodboard in moodboards:

        products = []

        for item in moodboard[
            "products"
        ]:

            product = item[
                "product"
            ]

            products.append(
                {
                    "product_id": product.get(
                        "Product ID",
                        "",
                    ),

                    "product_name": product.get(
                        "Product Name",
                        "",
                    ),

                    "mood_score": round(
                        item[
                            "mood_score"
                        ],
                        2,
                    ),

                    "total_score": round(
                        item[
                            "total_score"
                        ],
                        2,
                    ),

                    "matches": item[
                        "mood_matches"
                    ],
                }
            )

        summary.append(
            {
                "moodboard_id": (
                    moodboard[
                        "moodboard_id"
                    ]
                ),

                "name": moodboard[
                    "name"
                ],

                "description": moodboard[
                    "description"
                ],

                "products": products,
            }
        )

    return summary


# ============================================================
# DEBUG PRINT
# ============================================================

def print_moodboards(
    moodboards,
):
    """
    Print moodboards in readable form.
    """

    print("")
    print("=" * 75)
    print("FOUR BATHROOM MOODBOARDS")
    print("=" * 75)

    for moodboard in moodboards:

        print("")
        print(
            f"MOODBOARD: "
            f"{moodboard['name']}"
        )

        print(
            f"ID: "
            f"{moodboard['moodboard_id']}"
        )

        print(
            f"Description: "
            f"{moodboard['description']}"
        )

        print(
            "-" * 75
        )

        for rank, item in enumerate(
            moodboard["products"],
            start=1,
        ):

            product = item[
                "product"
            ]

            print(
                f"{rank}. "
                f"{product.get('Product Name', '')}"
            )

            print(
                f"   ID: "
                f"{product.get('Product ID', '')}"
            )

            print(
                f"   Mood Score: "
                f"{item['mood_score']}"
            )

            print(
                f"   Total Score: "
                f"{item['total_score']:.2f}"
            )

            print(
                f"   Matches: "
                f"{', '.join(item['mood_matches'])}"
            )


# ============================================================
# END
# ============================================================