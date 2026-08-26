# ============================================================
# FIXTURE ENGINE TEST
# PHASE 9
# ============================================================

from app.fixture_engine import (
    create_all_fixture_packages,
    print_fixture_packages,
    package_summary,
)


# ============================================================
# TEST FIXTURES
# ============================================================

fixtures = [

    # --------------------------------------------------------
    # BASINS
    # --------------------------------------------------------

    {
        "Product ID": "B001",
        "Product Name": "Modern Countertop Basin",
        "Brand": "Bath Brand A",
        "Category": "BASIN",
        "Style": "MODERN",
        "Color": "WHITE",
        "Tone": "NEUTRAL",
        "Finish": "MATTE",
        "Budget": "MID RANGE",
        "Technical Verified": "YES",
    },

    {
        "Product ID": "B002",
        "Product Name": "Luxury Marble Basin",
        "Brand": "Bath Brand B",
        "Category": "BASIN",
        "Style": "LUXURY",
        "Color": "WHITE",
        "Tone": "COOL",
        "Finish": "GLOSS",
        "Budget": "HIGH RANGE",
        "Technical Verified": "YES",
    },

    {
        "Product ID": "B003",
        "Product Name": "Natural Stone Basin",
        "Brand": "Bath Brand C",
        "Category": "BASIN",
        "Style": "NATURAL",
        "Color": "BEIGE",
        "Tone": "WARM",
        "Finish": "MATTE",
        "Budget": "MID RANGE",
        "Technical Verified": "YES",
    },


    # --------------------------------------------------------
    # WC
    # --------------------------------------------------------

    {
        "Product ID": "W001",
        "Product Name": "Modern Wall Hung WC",
        "Brand": "Bath Brand A",
        "Category": "WC",
        "Style": "MODERN",
        "Color": "WHITE",
        "Tone": "NEUTRAL",
        "Finish": "MATTE",
        "Budget": "MID RANGE",
        "Technical Verified": "YES",
    },

    {
        "Product ID": "W002",
        "Product Name": "Luxury Rimless WC",
        "Brand": "Bath Brand B",
        "Category": "WC",
        "Style": "LUXURY",
        "Color": "WHITE",
        "Tone": "COOL",
        "Finish": "GLOSS",
        "Budget": "HIGH RANGE",
        "Technical Verified": "YES",
    },

    {
        "Product ID": "W003",
        "Product Name": "Natural Compact WC",
        "Brand": "Bath Brand C",
        "Category": "WC",
        "Style": "NATURAL",
        "Color": "WHITE",
        "Tone": "WARM",
        "Finish": "MATTE",
        "Budget": "MID RANGE",
        "Technical Verified": "YES",
    },


    # --------------------------------------------------------
    # FAUCETS
    # --------------------------------------------------------

    {
        "Product ID": "F001",
        "Product Name": "Brushed Steel Basin Faucet",
        "Brand": "Faucet Brand A",
        "Category": "FAUCET",
        "Style": "MODERN",
        "Color": "STEEL",
        "Tone": "COOL",
        "Finish": "SATIN",
        "Budget": "MID RANGE",
        "Technical Verified": "YES",
    },

    {
        "Product ID": "F002",
        "Product Name": "Brushed Gold Luxury Faucet",
        "Brand": "Faucet Brand B",
        "Category": "FAUCET",
        "Style": "LUXURY",
        "Color": "GOLD",
        "Tone": "WARM",
        "Finish": "SATIN",
        "Budget": "HIGH RANGE",
        "Technical Verified": "YES",
    },

    {
        "Product ID": "F003",
        "Product Name": "Bronze Natural Faucet",
        "Brand": "Faucet Brand C",
        "Category": "FAUCET",
        "Style": "NATURAL",
        "Color": "BRONZE",
        "Tone": "WARM",
        "Finish": "MATTE",
        "Budget": "MID RANGE",
        "Technical Verified": "YES",
    },


    # --------------------------------------------------------
    # SHOWERS
    # --------------------------------------------------------

    {
        "Product ID": "S001",
        "Product Name": "Modern Rain Shower",
        "Brand": "Shower Brand A",
        "Category": "SHOWER",
        "Style": "MODERN",
        "Color": "STEEL",
        "Tone": "COOL",
        "Finish": "SATIN",
        "Budget": "MID RANGE",
        "Technical Verified": "YES",
    },

    {
        "Product ID": "S002",
        "Product Name": "Luxury Overhead Shower",
        "Brand": "Shower Brand B",
        "Category": "SHOWER",
        "Style": "LUXURY",
        "Color": "GOLD",
        "Tone": "WARM",
        "Finish": "GLOSS",
        "Budget": "HIGH RANGE",
        "Technical Verified": "YES",
    },

    {
        "Product ID": "S003",
        "Product Name": "Natural Rain Shower",
        "Brand": "Shower Brand C",
        "Category": "SHOWER",
        "Style": "NATURAL",
        "Color": "BRONZE",
        "Tone": "WARM",
        "Finish": "MATTE",
        "Budget": "MID RANGE",
        "Technical Verified": "YES",
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

}


# ============================================================
# MOODBOARDS
# ============================================================

moodboards = [

    {
        "moodboard_id": "MODERN",

        "name": "Modern Serenity",

        "preferred_style": "MODERN",

        "preferred_tone": "NEUTRAL",

        "preferred_color": "WHITE",

        "preferred_finish": "MATTE",
    },

    {
        "moodboard_id": "LUXURY",

        "name": "Luxury Marble",

        "preferred_style": "LUXURY",

        "preferred_tone": "COOL",

        "preferred_color": "WHITE",

        "preferred_finish": "GLOSS",
    },

    {
        "moodboard_id": "NATURAL",

        "name": "Natural Retreat",

        "preferred_style": "NATURAL",

        "preferred_tone": "WARM",

        "preferred_color": "BEIGE",

        "preferred_finish": "MATTE",
    },

    {
        "moodboard_id": "MINIMAL",

        "name": "Minimal Calm",

        "preferred_style": "MODERN",

        "preferred_tone": "NEUTRAL",

        "preferred_color": "WHITE",

        "preferred_finish": "MATTE",
    },
]


# ============================================================
# TEST
# ============================================================

print("")
print("=" * 75)
print("FIXTURE ENGINE TEST")
print("=" * 75)


packages = create_all_fixture_packages(
    fixtures=fixtures,

    moodboards=moodboards,

    requirements=requirements,
)


# ============================================================
# PRINT
# ============================================================

print_fixture_packages(
    packages
)


# ============================================================
# SUMMARY
# ============================================================

print("")
print("=" * 75)
print("FIXTURE PACKAGE SUMMARY")
print("=" * 75)


summary = package_summary(
    packages
)


for item in summary:

    print("")
    print(
        f"Moodboard: "
        f"{item['moodboard_name']}"
    )

    for category, fixture in item[
        "fixtures"
    ].items():

        if fixture is None:

            print(
                f"  {category}: NONE"
            )

        else:

            print(
                f"  {category}: "
                f"{fixture['name']} "
                f"(Score: {fixture['score']})"
            )


# ============================================================
# VALIDATION
# ============================================================

assert len(
    packages
) == 4


for package in packages:

    fixture_package = package[
        "fixture_package"
    ]

    assert (
        "BASIN"
        in fixture_package
    )

    assert (
        "WC"
        in fixture_package
    )

    assert (
        "FAUCET"
        in fixture_package
    )

    assert (
        "SHOWER"
        in fixture_package
    )


# ============================================================
# COMPLETE
# ============================================================

print("")
print("=" * 75)
print("FIXTURE ENGINE TEST COMPLETE")
print("=" * 75)