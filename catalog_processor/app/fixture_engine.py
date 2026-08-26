# ============================================================
# FIXTURE RECOMMENDATION ENGINE
# PHASE 9
# ============================================================

from typing import List


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
# FIXTURE CATEGORIES
# ============================================================

FIXTURE_CATEGORIES = {
    "BASIN",
    "WC",
    "FAUCET",
    "SHOWER",
}


# ============================================================
# STYLE MATCHING
# ============================================================

def style_match(
    fixture,
    moodboard,
):
    """
    Compare fixture style with moodboard style.
    """

    fixture_style = normalize(
        fixture.get(
            "Style",
            UNKNOWN,
        )
    )

    mood_style = normalize(
        moodboard.get(
            "preferred_style",
            UNKNOWN,
        )
    )

    if (
        fixture_style == mood_style
        and fixture_style not in (
            "",
            UNKNOWN,
        )
    ):
        return 20

    return 0


# ============================================================
# TONE MATCHING
# ============================================================

def tone_match(
    fixture,
    moodboard,
):
    """
    Compare fixture tone with moodboard tone.
    """

    fixture_tone = normalize(
        fixture.get(
            "Tone",
            UNKNOWN,
        )
    )

    mood_tone = normalize(
        moodboard.get(
            "preferred_tone",
            UNKNOWN,
        )
    )

    if (
        fixture_tone == mood_tone
        and fixture_tone not in (
            "",
            UNKNOWN,
        )
    ):
        return 15

    return 0


# ============================================================
# COLOR MATCHING
# ============================================================

def color_match(
    fixture,
    moodboard,
):
    """
    Compare fixture color with moodboard color.
    """

    fixture_color = normalize(
        fixture.get(
            "Color",
            UNKNOWN,
        )
    )

    mood_color = normalize(
        moodboard.get(
            "preferred_color",
            UNKNOWN,
        )
    )

    if (
        fixture_color == mood_color
        and fixture_color not in (
            "",
            UNKNOWN,
        )
    ):
        return 15

    return 0


# ============================================================
# FINISH MATCHING
# ============================================================

def finish_match(
    fixture,
    moodboard,
):
    """
    Compare fixture finish with moodboard preference.
    """

    fixture_finish = normalize(
        fixture.get(
            "Finish",
            UNKNOWN,
        )
    )

    mood_finish = normalize(
        moodboard.get(
            "preferred_finish",
            UNKNOWN,
        )
    )

    if (
        fixture_finish == mood_finish
        and fixture_finish not in (
            "",
            UNKNOWN,
        )
    ):
        return 15

    return 0


# ============================================================
# BUDGET MATCHING
# ============================================================

def budget_match(
    fixture,
    requirements,
):
    """
    Compare fixture budget with bathroom budget.
    """

    fixture_budget = normalize(
        fixture.get(
            "Budget",
            UNKNOWN,
        )
    )

    requested_budget = normalize(
        requirements.get(
            "budget",
            ANY,
        )
    )

    if requested_budget in (
        "",
        ANY,
        UNKNOWN,
    ):
        return 0

    if (
        fixture_budget
        == requested_budget
    ):
        return 15

    return 0


# ============================================================
# CATEGORY VALIDATION
# ============================================================

def valid_category(
    fixture,
    category,
):
    """
    Verify that fixture belongs to requested category.
    """

    fixture_category = normalize(
        fixture.get(
            "Category",
            "",
        )
    )

    return (
        fixture_category
        == normalize(category)
    )


# ============================================================
# TECHNICAL DATA CHECK
# ============================================================

def has_verified_technical_data(
    fixture,
):
    """
    Check whether the fixture contains explicitly
    verified technical information.

    This function DOES NOT infer technical suitability.
    """

    value = normalize(
        fixture.get(
            "Technical Verified",
            "NO",
        )
    )

    return value == "YES"


# ============================================================
# SCORE ONE FIXTURE
# ============================================================

def calculate_fixture_score(
    fixture,
    moodboard,
    requirements,
):
    """
    Calculate compatibility score.

    Maximum normal score = 80.

    Technical verification is tracked separately and
    is NOT fabricated from visual information.
    """

    score = 0
    reasons = []

    points = style_match(
        fixture,
        moodboard,
    )

    if points:
        score += points

        reasons.append(
            {
                "reason": "Style matches moodboard",
                "points": points,
            }
        )

    points = tone_match(
        fixture,
        moodboard,
    )

    if points:
        score += points

        reasons.append(
            {
                "reason": "Tone matches moodboard",
                "points": points,
            }
        )

    points = color_match(
        fixture,
        moodboard,
    )

    if points:
        score += points

        reasons.append(
            {
                "reason": "Color matches moodboard",
                "points": points,
            }
        )

    points = finish_match(
        fixture,
        moodboard,
    )

    if points:
        score += points

        reasons.append(
            {
                "reason": "Finish matches moodboard",
                "points": points,
            }
        )

    points = budget_match(
        fixture,
        requirements,
    )

    if points:
        score += points

        reasons.append(
            {
                "reason": "Budget matches",
                "points": points,
            }
        )

    # --------------------------------------------------------
    # Technical verification
    # --------------------------------------------------------

    technical_verified = (
        has_verified_technical_data(
            fixture
        )
    )

    return {
        "fixture": fixture,

        "score": score,

        "reasons": reasons,

        "technical_verified": (
            technical_verified
        ),
    }


# ============================================================
# RANK FIXTURES
# ============================================================

def rank_fixtures(
    fixtures,
    category,
    moodboard,
    requirements,
    limit=3,
):
    """
    Rank fixtures belonging to one category.
    """

    ranked = []

    for fixture in fixtures:

        if not valid_category(
            fixture,
            category,
        ):
            continue

        result = calculate_fixture_score(
            fixture=fixture,
            moodboard=moodboard,
            requirements=requirements,
        )

        ranked.append(
            result
        )

    ranked.sort(
        key=lambda item: (
            item["score"],
            item["technical_verified"],
        ),
        reverse=True,
    )

    for rank, item in enumerate(
        ranked[:limit],
        start=1,
    ):
        item[
            "rank"
        ] = rank

    return ranked[:limit]


# ============================================================
# SELECT ONE FIXTURE
# ============================================================

def select_best_fixture(
    fixtures,
    category,
    moodboard,
    requirements,
):
    """
    Select the highest-ranked fixture.
    """

    ranked = rank_fixtures(
        fixtures=fixtures,
        category=category,
        moodboard=moodboard,
        requirements=requirements,
        limit=1,
    )

    if not ranked:
        return None

    return ranked[0]


# ============================================================
# CREATE COMPLETE FIXTURE PACKAGE
# ============================================================

def create_fixture_package(
    fixtures,
    moodboard,
    requirements,
):
    """
    Select the best basin, WC, faucet and shower.
    """

    package = {}

    for category in (
        "BASIN",
        "WC",
        "FAUCET",
        "SHOWER",
    ):

        selected = select_best_fixture(
            fixtures=fixtures,
            category=category,
            moodboard=moodboard,
            requirements=requirements,
        )

        package[
            category
        ] = selected

    return package


# ============================================================
# CREATE PACKAGES FOR ALL MOODBOARDS
# ============================================================

def create_all_fixture_packages(
    fixtures,
    moodboards,
    requirements,
):
    """
    Create one fixture package for every moodboard.
    """

    results = []

    for moodboard in moodboards:

        package = create_fixture_package(
            fixtures=fixtures,
            moodboard=moodboard,
            requirements=requirements,
        )

        results.append(
            {
                "moodboard_id": moodboard.get(
                    "moodboard_id",
                    "",
                ),

                "moodboard_name": moodboard.get(
                    "name",
                    "",
                ),

                "fixture_package": package,
            }
        )

    return results


# ============================================================
# PACKAGE SUMMARY
# ============================================================

def package_summary(
    packages,
):
    """
    Convert packages into UI-friendly output.
    """

    summary = []

    for package in packages:

        fixtures = {}

        for category, result in package[
            "fixture_package"
        ].items():

            if result is None:

                fixtures[
                    category
                ] = None

                continue

            fixture = result[
                "fixture"
            ]

            fixtures[
                category
            ] = {
                "product_id": fixture.get(
                    "Product ID",
                    "",
                ),

                "name": fixture.get(
                    "Product Name",
                    "",
                ),

                "brand": fixture.get(
                    "Brand",
                    "",
                ),

                "score": result.get(
                    "score",
                    0,
                ),

                "technical_verified": (
                    result.get(
                        "technical_verified",
                        False,
                    )
                ),

                "reasons": result.get(
                    "reasons",
                    [],
                ),
            }

        summary.append(
            {
                "moodboard_id": package[
                    "moodboard_id"
                ],

                "moodboard_name": package[
                    "moodboard_name"
                ],

                "fixtures": fixtures,
            }
        )

    return summary


# ============================================================
# DEBUG PRINT
# ============================================================

def print_fixture_packages(
    packages,
):
    """
    Print fixture packages.
    """

    print("")
    print("=" * 75)
    print("PHASE 9 FIXTURE PACKAGES")
    print("=" * 75)

    for package in packages:

        print("")
        print(
            f"MOODBOARD: "
            f"{package['moodboard_name']}"
        )

        print(
            "-" * 75
        )

        for category, result in package[
            "fixture_package"
        ].items():

            print("")
            print(
                f"{category}:"
            )

            if result is None:

                print(
                    "  No suitable fixture found"
                )

                continue

            fixture = result[
                "fixture"
            ]

            print(
                f"  Product ID: "
                f"{fixture.get('Product ID', '')}"
            )

            print(
                f"  Product: "
                f"{fixture.get('Product Name', '')}"
            )

            print(
                f"  Brand: "
                f"{fixture.get('Brand', '')}"
            )

            print(
                f"  Score: "
                f"{result['score']}"
            )

            print(
                f"  Technical Data Verified: "
                f"{result['technical_verified']}"
            )

            print(
                "  Matches:"
            )

            for reason in result[
                "reasons"
            ]:

                print(
                    f"    + "
                    f"{reason['points']} "
                    f"{reason['reason']}"
                )


# ============================================================
# END
# ============================================================