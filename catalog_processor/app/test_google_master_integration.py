from app.google_sheet_loader import (
    load_products_from_google_sheet,
)


# ============================================================
# CONFIGURATION
# ============================================================

SPREADSHEET_ID = (
    "1y4Ix3erUgmkefN50BFkd-nomAwZyngU7rOCa3Nk1ulI"
)

SHEET_NAME = "MASTER"


# ============================================================
# HELPERS
# ============================================================

def get_first_available_value(
    record,
    field_names,
):
    """
    Return the first non-empty value from the supplied
    field names.

    This is useful for budget because the project may store
    budget information under different fields depending on
    whether it comes from the product itself or inheritance.
    """

    for field_name in field_names:

        value = record.get(
            field_name,
            "",
        )

        if value is None:
            continue

        value = str(value).strip()

        if value:
            return value

    return ""


def get_record_types(records):
    """
    Build a Record Type -> count dictionary.
    """

    record_types = {}

    for record in records:

        record_type = str(
            record.get(
                "Record Type",
                "",
            )
        ).strip().upper()

        if not record_type:
            continue

        record_types[record_type] = (
            record_types.get(
                record_type,
                0,
            )
            + 1
        )

    return record_types


# ============================================================
# TEST MASTER SHEET
# ============================================================

print("=" * 70)

print(
    "GOOGLE SHEETS MASTER INTEGRATION TEST"
)

print("=" * 70)


# ============================================================
# LOAD MASTER
# ============================================================

print("")

print(
    "LOADING MASTER SHEET..."
)

records = load_products_from_google_sheet(
    spreadsheet_id=SPREADSHEET_ID,
    sheet_name=SHEET_NAME,
)

assert isinstance(
    records,
    list,
), (
    "MASTER loader did not return a list."
)

print("")

print(
    f"Total records loaded: {len(records)}"
)


# ============================================================
# BASIC CHECK
# ============================================================

assert len(records) > 0, (
    "MASTER sheet returned no records."
)

print(
    "MASTER RECORD CHECK: PASSED"
)


# ============================================================
# SHOW COLUMNS
# ============================================================

print("")

print(
    "AVAILABLE COLUMNS:"
)

first_record = records[0]

for column in first_record.keys():

    print(
        f"  {column}"
    )


# ============================================================
# REQUIRED MASTER COLUMNS
# ============================================================
#
# These are the columns that this integration test actually
# requires for the MASTER database structure.
#
# Budget is intentionally NOT mandatory here because budget
# may be represented through:
#
#   Budget
#   Budget Tier
#   Resolved Budget
#   Default Budget
#   etc.
#
# ============================================================

required_columns = [
    "Record Type",
    "Record ID",
    "Catalog ID",
    "Name",
    "Category",
    "Style",
]


# ============================================================
# OPTIONAL MASTER COLUMNS
# ============================================================

optional_columns = [
    "Budget",
    "Budget Tier",
    "Resolved Budget",
    "Resolved Budget Source",
    "Default Budget",
    "Image URL",
    "Drive URL",
]


# ============================================================
# CHECK REQUIRED COLUMNS
# ============================================================

print("")

print(
    "CHECKING REQUIRED COLUMNS..."
)

for column in required_columns:

    assert column in first_record, (
        f"Missing required column: {column}"
    )

    print(
        f"  {column}: OK"
    )

print(
    "REQUIRED COLUMN CHECK: PASSED"
)


# ============================================================
# CHECK OPTIONAL COLUMNS
# ============================================================

print("")

print(
    "CHECKING OPTIONAL COLUMNS..."
)

for column in optional_columns:

    if column in first_record:

        print(
            f"  {column}: AVAILABLE"
        )

    else:

        print(
            f"  {column}: NOT PRESENT"
        )


# ============================================================
# RECORD TYPE SUMMARY
# ============================================================

print("")

print("=" * 70)

print(
    "RECORD TYPE SUMMARY"
)

print("=" * 70)

record_types = get_record_types(
    records
)

for record_type, count in sorted(
    record_types.items()
):

    print(
        f"{record_type}: {count}"
    )


# ============================================================
# PRODUCT RECORDS
# ============================================================

products = []

for record in records:

    record_type = str(
        record.get(
            "Record Type",
            "",
        )
    ).strip().upper()

    if record_type == "PRODUCT":

        products.append(
            record
        )


print("")

print("=" * 70)

print(
    "PRODUCT RECORDS"
)

print("=" * 70)

print(
    f"Total products: {len(products)}"
)

assert len(products) > 0, (
    "No PRODUCT records found in MASTER sheet."
)


# ============================================================
# VALIDATE PRODUCTS
# ============================================================

print("")

print(
    "CHECKING PRODUCT DATA..."
)

for index, product in enumerate(
    products,
    start=1,
):

    product_id = str(
        product.get(
            "Product ID",
            "",
        )
    ).strip()

    # --------------------------------------------------------
    # Fallback:
    # Some MASTER records may use Record ID as the primary
    # product identifier.
    # --------------------------------------------------------

    if not product_id:

        product_id = str(
            product.get(
                "Record ID",
                "",
            )
        ).strip()

    name = str(
        product.get(
            "Name",
            "",
        )
    ).strip()

    # --------------------------------------------------------
    # Fallback:
    # Some product data may use Product Name.
    # --------------------------------------------------------

    if not name:

        name = str(
            product.get(
                "Product Name",
                "",
            )
        ).strip()

    category = str(
        product.get(
            "Category",
            "",
        )
    ).strip()

    style = str(
        product.get(
            "Style",
            "",
        )
    ).strip()

    budget = get_first_available_value(
        product,
        [
            "Budget",
            "Budget Tier",
            "Resolved Budget",
            "Default Budget",
        ],
    )

    print("")

    print(
        f"Product {index}"
    )

    print(
        f"  Product ID: {product_id}"
    )

    print(
        f"  Name: {name}"
    )

    print(
        f"  Category: {category}"
    )

    print(
        f"  Style: {style}"
    )

    if budget:

        print(
            f"  Budget: {budget}"
        )

    else:

        print(
            "  Budget: NOT PROVIDED"
        )

    # --------------------------------------------------------
    # HARD PRODUCT CHECKS
    # --------------------------------------------------------

    assert product_id != "", (
        f"Product {index} has no Product ID "
        "or Record ID."
    )

    assert name != "", (
        f"Product {index} has no Name "
        "or Product Name."
    )


print("")

print(
    "PRODUCT DATA CHECK: PASSED"
)


# ============================================================
# CHECK PRODUCT IDENTIFIERS
# ============================================================

print("")

print(
    "CHECKING PRODUCT IDENTIFIERS..."
)

product_ids = set()

for index, product in enumerate(
    products,
    start=1,
):

    product_id = str(
        product.get(
            "Product ID",
            "",
        )
    ).strip()

    if not product_id:

        product_id = str(
            product.get(
                "Record ID",
                "",
            )
        ).strip()

    assert product_id, (
        f"Product {index} has an empty identifier."
    )

    if product_id in product_ids:

        print(
            f"  WARNING: Duplicate Product ID: "
            f"{product_id}"
        )

    product_ids.add(
        product_id
    )

print(
    f"Unique product identifiers: "
    f"{len(product_ids)}"
)

print(
    "PRODUCT IDENTIFIER CHECK: PASSED"
)


# ============================================================
# CHECK OTHER MASTER RECORDS
# ============================================================

expected_record_types = [
    "CATALOG",
    "PRODUCT",
    "REQUIREMENT",
    "FIXTURE",
    "MOODBOARD",
    "RECOMMENDATION",
    "DESIGN",
    "RUN",
]


print("")

print(
    "CHECKING MASTER RECORD TYPES..."
)

for record_type in expected_record_types:

    if record_type in record_types:

        print(
            f"  {record_type}: "
            f"{record_types[record_type]} "
            "record(s)"
        )

    else:

        print(
            f"  {record_type}: "
            "NOT PRESENT"
        )


# ============================================================
# CHECK CATALOG RECORDS
# ============================================================

catalogs = []

for record in records:

    record_type = str(
        record.get(
            "Record Type",
            "",
        )
    ).strip().upper()

    if record_type == "CATALOG":

        catalogs.append(
            record
        )


print("")

print(
    "CATALOG RECORD CHECK..."
)

print(
    f"Catalog records: {len(catalogs)}"
)

if catalogs:

    catalog = catalogs[0]

    catalog_id = str(
        catalog.get(
            "Record ID",
            "",
        )
    ).strip()

    catalog_name = str(
        catalog.get(
            "Name",
            "",
        )
    ).strip()

    print(
        f"  First Catalog ID: "
        f"{catalog_id}"
    )

    print(
        f"  First Catalog Name: "
        f"{catalog_name}"
    )


# ============================================================
# CHECK REQUIREMENT RECORDS
# ============================================================

requirements = []

for record in records:

    record_type = str(
        record.get(
            "Record Type",
            "",
        )
    ).strip().upper()

    if record_type == "REQUIREMENT":

        requirements.append(
            record
        )


print("")

print(
    "REQUIREMENT RECORD CHECK..."
)

print(
    f"Requirement records: "
    f"{len(requirements)}"
)

if requirements:

    requirement = requirements[0]

    print(
        "  Requirement ID:",
        requirement.get(
            "Record ID",
            "",
        ),
    )

    print(
        "  Name:",
        requirement.get(
            "Name",
            "",
        ),
    )


# ============================================================
# CHECK FIXTURE RECORDS
# ============================================================

fixtures = []

for record in records:

    record_type = str(
        record.get(
            "Record Type",
            "",
        )
    ).strip().upper()

    if record_type == "FIXTURE":

        fixtures.append(
            record
        )


print("")

print(
    "FIXTURE RECORD CHECK..."
)

print(
    f"Fixture records: "
    f"{len(fixtures)}"
)

for fixture in fixtures[:10]:

    fixture_id = (
        fixture.get(
            "Fixture ID",
            "",
        )
        or fixture.get(
            "Record ID",
            "",
        )
    )

    print(
        f"  {fixture_id} - "
        f"{fixture.get('Name', '')}"
    )


# ============================================================
# CHECK MOODBOARD RECORDS
# ============================================================

moodboards = []

for record in records:

    record_type = str(
        record.get(
            "Record Type",
            "",
        )
    ).strip().upper()

    if record_type == "MOODBOARD":

        moodboards.append(
            record
        )


print("")

print(
    "MOODBOARD RECORD CHECK..."
)

print(
    f"Moodboard records: "
    f"{len(moodboards)}"
)

for moodboard in moodboards[:10]:

    moodboard_id = (
        moodboard.get(
            "Moodboard ID",
            "",
        )
        or moodboard.get(
            "Record ID",
            "",
        )
    )

    print(
        f"  {moodboard_id} - "
        f"{moodboard.get('Name', '')}"
    )


# ============================================================
# CHECK RECOMMENDATION RECORDS
# ============================================================

recommendations = []

for record in records:

    record_type = str(
        record.get(
            "Record Type",
            "",
        )
    ).strip().upper()

    if record_type == "RECOMMENDATION":

        recommendations.append(
            record
        )


print("")

print(
    "RECOMMENDATION RECORD CHECK..."
)

print(
    f"Recommendation records: "
    f"{len(recommendations)}"
)

for recommendation in recommendations[:10]:

    recommendation_id = (
        recommendation.get(
            "Recommendation ID",
            "",
        )
        or recommendation.get(
            "Record ID",
            "",
        )
    )

    print(
        f"  {recommendation_id} - "
        f"{recommendation.get('Name', '')}"
    )


# ============================================================
# CHECK DESIGN RECORDS
# ============================================================

designs = []

for record in records:

    record_type = str(
        record.get(
            "Record Type",
            "",
        )
    ).strip().upper()

    if record_type == "DESIGN":

        designs.append(
            record
        )


print("")

print(
    "DESIGN RECORD CHECK..."
)

print(
    f"Design records: "
    f"{len(designs)}"
)

for design in designs[:10]:

    design_id = (
        design.get(
            "Design ID",
            "",
        )
        or design.get(
            "Record ID",
            "",
        )
    )

    print(
        f"  {design_id} - "
        f"{design.get('Name', '')}"
    )


# ============================================================
# CHECK RUN RECORDS
# ============================================================

runs = []

for record in records:

    record_type = str(
        record.get(
            "Record Type",
            "",
        )
    ).strip().upper()

    if record_type == "RUN":

        runs.append(
            record
        )


print("")

print(
    "RUN RECORD CHECK..."
)

print(
    f"Run records: "
    f"{len(runs)}"
)

for run in runs[:10]:

    run_id = (
        run.get(
            "Run ID",
            "",
        )
        or run.get(
            "Record ID",
            "",
        )
    )

    print(
        f"  {run_id} - "
        f"{run.get('Name', '')}"
    )


# ============================================================
# FINAL DATA SUMMARY
# ============================================================

print("")

print("=" * 70)

print(
    "MASTER DATA SUMMARY"
)

print("=" * 70)

print(
    f"Total records         : {len(records)}"
)

print(
    f"Catalogs              : {len(catalogs)}"
)

print(
    f"Products              : {len(products)}"
)

print(
    f"Requirements          : {len(requirements)}"
)

print(
    f"Fixtures              : {len(fixtures)}"
)

print(
    f"Moodboards            : {len(moodboards)}"
)

print(
    f"Recommendations       : {len(recommendations)}"
)

print(
    f"Designs               : {len(designs)}"
)

print(
    f"Runs                  : {len(runs)}"
)


# ============================================================
# FINAL
# ============================================================

print("")

print("=" * 70)

print(
    "GOOGLE SHEETS MASTER INTEGRATION TEST COMPLETE"
)

print("=" * 70)

print("")

print(
    "ALL AVAILABLE MASTER DATA CHECKS PASSED"
)

print("=" * 70)