from app.google_master_loader import (
    load_master_data,
    load_master_records,
    group_master_records,
    get_products,
    get_catalogs,
    get_requirements,
    get_fixtures,
    get_moodboards,
    get_recommendations,
    get_designs,
    get_runs,
    find_record_by_id,
    validate_master_records,
)


# ============================================================
# CONFIGURATION
# ============================================================

SPREADSHEET_ID = (
    "1y4Ix3erUgmkefN50BFkd-nomAwZyngU7rOCa3Nk1ulI"
)

SHEET_NAME = "MASTER"


# ============================================================
# START
# ============================================================

print("=" * 70)
print("GOOGLE MASTER LOADER TEST")
print("=" * 70)


# ============================================================
# LOAD RAW MASTER
# ============================================================

print("")
print("=" * 70)
print("RAW MASTER LOAD")
print("=" * 70)

raw_records = load_master_records(
    spreadsheet_id=SPREADSHEET_ID,
    sheet_name=SHEET_NAME,
)

print("")
print(
    f"Total raw records loaded: {len(raw_records)}"
)

assert raw_records, (
    "MASTER returned no records."
)

print(
    "RAW MASTER LOAD CHECK: PASSED"
)


# ============================================================
# LOAD CANONICAL MASTER DATA
# ============================================================
#
# IMPORTANT:
#
# load_master_data() is the application's canonical MASTER
# database entry point.
#
# It loads MASTER once and prepares all record-type groups:
#
# CATALOG
# PRODUCT
# REQUIREMENT
# FIXTURE
# MOODBOARD
# RECOMMENDATION
# DESIGN
# RUN
#
# ============================================================

print("")
print("=" * 70)
print("CANONICAL MASTER LOAD")
print("=" * 70)

master_data = load_master_data(
    spreadsheet_id=SPREADSHEET_ID,
)

assert isinstance(
    master_data,
    dict,
), (
    "load_master_data() did not return a dictionary."
)


# ============================================================
# EXTRACT MASTER RECORDS
# ============================================================

records = master_data.get(
    "records",
    []
)

print("")
print(
    f"Canonical MASTER records: {len(records)}"
)

assert records, (
    "Canonical MASTER returned no records."
)

print(
    "CANONICAL MASTER LOAD CHECK: PASSED"
)


# ============================================================
# VALIDATE
# ============================================================

print("")
print("=" * 70)
print("MASTER VALIDATION")
print("=" * 70)

errors = validate_master_records(
    records
)

if errors:
    print("")
    print(
        "MASTER VALIDATION ERRORS:"
    )

    for error in errors:
        print(
            " -",
            error
        )

assert not errors, (
    "MASTER validation failed:\n"
    + "\n".join(errors)
)

print(
    "MASTER VALIDATION CHECK: PASSED"
)


# ============================================================
# GROUP RECORDS
# ============================================================

groups = group_master_records(
    records
)

print("")
print("=" * 70)
print("MASTER RECORD GROUPS")
print("=" * 70)

for record_type in sorted(
    groups
):
    print(
        f"{record_type}: "
        f"{len(groups[record_type])}"
    )


# ============================================================
# LOAD EACH RECORD TYPE
# ============================================================

catalogs = get_catalogs(
    records
)

products = get_products(
    records
)

requirements = get_requirements(
    records
)

fixtures = get_fixtures(
    records
)

moodboards = get_moodboards(
    records
)

recommendations = get_recommendations(
    records
)

designs = get_designs(
    records
)

runs = get_runs(
    records
)


# ============================================================
# RECORD TYPE COUNTS
# ============================================================

print("")
print("=" * 70)
print("MASTER RECORD TYPE COUNTS")
print("=" * 70)

print(
    "CATALOGS:",
    len(catalogs)
)

print(
    "PRODUCTS:",
    len(products)
)

print(
    "REQUIREMENTS:",
    len(requirements)
)

print(
    "FIXTURES:",
    len(fixtures)
)

print(
    "MOODBOARDS:",
    len(moodboards)
)

print(
    "RECOMMENDATIONS:",
    len(recommendations)
)

print(
    "DESIGNS:",
    len(designs)
)

print(
    "RUNS:",
    len(runs)
)


# ============================================================
# VERIFY MASTER DATA DICTIONARY
# ============================================================

print("")
print("=" * 70)
print("MASTER DATA DICTIONARY CHECK")
print("=" * 70)

assert (
    master_data.get("catalogs")
    == catalogs
), (
    "MASTER catalogs do not match."
)

assert (
    master_data.get("products")
    == products
), (
    "MASTER products do not match."
)

assert (
    master_data.get("requirements")
    == requirements
), (
    "MASTER requirements do not match."
)

assert (
    master_data.get("fixtures")
    == fixtures
), (
    "MASTER fixtures do not match."
)

assert (
    master_data.get("moodboards")
    == moodboards
), (
    "MASTER moodboards do not match."
)

assert (
    master_data.get("recommendations")
    == recommendations
), (
    "MASTER recommendations do not match."
)

assert (
    master_data.get("designs")
    == designs
), (
    "MASTER designs do not match."
)

assert (
    master_data.get("runs")
    == runs
), (
    "MASTER runs do not match."
)

print(
    "MASTER DATA DICTIONARY CHECK: PASSED"
)


# ============================================================
# CHECK PRODUCT DATA
# ============================================================

print("")
print("=" * 70)
print("PRODUCT CHECK")
print("=" * 70)

if products:

    for product in products:

        print("")

        print(
            "Product ID:",
            product.get(
                "Product ID",
                ""
            )
        )

        print(
            "Name:",
            product.get(
                "Name",
                ""
            )
        )

        print(
            "Category:",
            product.get(
                "Category",
                ""
            )
        )

        print(
            "Style:",
            product.get(
                "Style",
                ""
            )
        )

else:

    print(
        "WARNING: No PRODUCT records found."
    )


# ============================================================
# CHECK CATALOG
# ============================================================

if catalogs:

    catalog = catalogs[0]

    print("")
    print("=" * 70)
    print("CATALOG CHECK")
    print("=" * 70)

    print(
        "Record ID:",
        catalog.get(
            "Record ID",
            ""
        )
    )

    print(
        "Name:",
        catalog.get(
            "Name",
            ""
        )
    )

else:

    print("")
    print(
        "WARNING: No CATALOG records found."
    )


# ============================================================
# CHECK REQUIREMENT
# ============================================================

if requirements:

    requirement = requirements[0]

    print("")
    print("=" * 70)
    print("REQUIREMENT CHECK")
    print("=" * 70)

    print(
        "Requirement ID:",
        requirement.get(
            "Requirement ID",
            ""
        )
    )

    print(
        "Name:",
        requirement.get(
            "Name",
            ""
        )
    )

else:

    print("")
    print(
        "WARNING: No REQUIREMENT records found."
    )


# ============================================================
# CHECK FIXTURES
# ============================================================

if fixtures:

    print("")
    print("=" * 70)
    print("FIXTURE CHECK")
    print("=" * 70)

    for fixture in fixtures[:10]:

        print(
            fixture.get(
                "Fixture ID",
                ""
            ),
            "-",
            fixture.get(
                "Name",
                ""
            )
        )

else:

    print("")
    print(
        "WARNING: No FIXTURE records found."
    )


# ============================================================
# CHECK MOODBOARDS
# ============================================================

if moodboards:

    print("")
    print("=" * 70)
    print("MOODBOARD CHECK")
    print("=" * 70)

    for moodboard in moodboards[:10]:

        print(
            moodboard.get(
                "Moodboard ID",
                ""
            ),
            "-",
            moodboard.get(
                "Name",
                ""
            )
        )

else:

    print("")
    print(
        "WARNING: No MOODBOARD records found."
    )


# ============================================================
# CHECK RECOMMENDATIONS
# ============================================================

if recommendations:

    print("")
    print("=" * 70)
    print("RECOMMENDATION CHECK")
    print("=" * 70)

    for recommendation in recommendations[:10]:

        print(
            recommendation.get(
                "Recommendation ID",
                ""
            ),
            "-",
            recommendation.get(
                "Name",
                ""
            )
        )

else:

    print("")
    print(
        "WARNING: No RECOMMENDATION records found."
    )


# ============================================================
# CHECK DESIGNS
# ============================================================

if designs:

    print("")
    print("=" * 70)
    print("DESIGN CHECK")
    print("=" * 70)

    for design in designs[:10]:

        print(
            design.get(
                "Design ID",
                ""
            ),
            "-",
            design.get(
                "Name",
                ""
            )
        )

else:

    print("")
    print(
        "WARNING: No DESIGN records found."
    )


# ============================================================
# CHECK RUNS
# ============================================================

if runs:

    print("")
    print("=" * 70)
    print("RUN CHECK")
    print("=" * 70)

    for run in runs[:10]:

        print(
            run.get(
                "Run ID",
                ""
            ),
            "-",
            run.get(
                "Name",
                ""
            )
        )

else:

    print("")
    print(
        "WARNING: No RUN records found."
    )


# ============================================================
# FIND RECORD BY ID
# ============================================================

print("")
print("=" * 70)
print("RECORD ID LOOKUP TEST")
print("=" * 70)

record = find_record_by_id(
    records,
    "CAT001"
)

if record:

    print(
        "CAT001 FOUND"
    )

    print(
        "Type:",
        record.get(
            "Record Type",
            ""
        )
    )

    print(
        "Name:",
        record.get(
            "Name",
            ""
        )
    )

else:

    print(
        "CAT001 not found."
    )


# ============================================================
# VERIFY ALL GROUPS ARE CONSISTENT
# ============================================================

print("")
print("=" * 70)
print("GROUP CONSISTENCY CHECK")
print("=" * 70)

assert len(
    groups.get(
        "CATALOG",
        []
    )
) == len(catalogs)

assert len(
    groups.get(
        "PRODUCT",
        []
    )
) == len(products)

assert len(
    groups.get(
        "REQUIREMENT",
        []
    )
) == len(requirements)

assert len(
    groups.get(
        "FIXTURE",
        []
    )
) == len(fixtures)

assert len(
    groups.get(
        "MOODBOARD",
        []
    )
) == len(moodboards)

assert len(
    groups.get(
        "RECOMMENDATION",
        []
    )
) == len(recommendations)

assert len(
    groups.get(
        "DESIGN",
        []
    )
) == len(designs)

assert len(
    groups.get(
        "RUN",
        []
    )
) == len(runs)

print(
    "GROUP CONSISTENCY CHECK: PASSED"
)


# ============================================================
# FINAL
# ============================================================

print("")
print("=" * 70)
print("GOOGLE MASTER LOADER TEST COMPLETE")
print("=" * 70)

print("")
print(
    "ALL MASTER LOADER CHECKS PASSED"
)

print("=" * 70)