import re

from app.google_services import (
    get_sheets_service,
    read_sheet_records,
)


# ============================================================
# GOOGLE MASTER LOADER
# ============================================================
# This module loads the complete MASTER Google Sheet and
# provides helper functions for each Record Type.
#
# MASTER contains:
# CATALOG
# PRODUCT
# REQUIREMENT
# FIXTURE
# MOODBOARD
# RECOMMENDATION
# DESIGN
# RUN
# ============================================================


# ============================================================
# CONFIGURATION
# ============================================================

DEFAULT_SHEET_NAME = "MASTER"

DEFAULT_START_COLUMN = "A"
DEFAULT_END_COLUMN = "ZZ"
DEFAULT_END_ROW = 5000


VALID_RECORD_TYPES = {
    "CATALOG",
    "PRODUCT",
    "REQUIREMENT",
    "FIXTURE",
    "MOODBOARD",
    "RECOMMENDATION",
    "DESIGN",
    "RUN",
}


# ============================================================
# INTERNAL HELPERS
# ============================================================

def _clean_value(value):
    """
    Convert a value into a clean string.

    None becomes an empty string.
    """
    if value is None:
        return ""

    return str(value).strip()


def _is_product_id(value):
    """
    Return True when a value looks like a PRODUCT ID.

    Example:
        PROD-2ADD67FACF9E
        PROD-DAECC6686001
        PROD-932CDB10CB60
    """
    value = _clean_value(value).upper()

    return (
        value.startswith("PROD-")
        and len(value) > 5
    )


def _is_product_record_reference(value):
    """
    Return True when a value looks like a malformed product
    record reference such as: P0007-I002, P0008-I000, etc.

    Some MASTER rows contain a catalog/product reference in the
    Record Type column instead of the literal value PRODUCT.
    These rows are normalized into PRODUCT records.
    """
    value = _clean_value(value).upper()

    if not value:
        return False

    return bool(re.search(r"-P\d{4}-I\d{3,}$", value))


def _is_completely_empty_record(record):
    """
    Return True when a Google Sheets row contains no data.
    """

    if not isinstance(record, dict):
        return True

    for value in record.values():

        if value is None:
            continue

        if str(value).strip():
            return False

    return True


def _normalize_master_record(record):
    """
    Normalize one MASTER record.

    This protects the pipeline against malformed rows where
    PRODUCT IDs have accidentally been placed in Record Type.

    Supported repairs:

    1. Record Type = PROD-XXXX
       -> Record Type = PRODUCT

    2. Record Type = PROD-XXXX and Record ID empty
       -> Record ID = PROD-XXXX

    3. Record Type contains a product reference ending in
       -P####-I### (for example P0007-I002)
       -> Record Type = PRODUCT
       -> Product ID = the original reference when empty
       -> Record ID = the original reference when empty

    4. Record Type empty but Product ID contains a recognized
       product identifier/reference
       -> Record Type = PRODUCT
       -> Record ID = Product ID when Record ID is empty

    5. Record Type = PRODUCT and Record ID empty
       -> Recover Record ID from Product ID.

    6. Record Type / Record ID are stripped of whitespace.
    """

    if not isinstance(record, dict):
        return record

    normalized = dict(record)

    record_type = _clean_value(
        normalized.get("Record Type", "")
    )

    record_id = _clean_value(
        normalized.get("Record ID", "")
    )

    product_id = _clean_value(
        normalized.get("Product ID", "")
    )

    # --------------------------------------------------------
    # Normalize core fields
    # --------------------------------------------------------

    normalized["Record Type"] = record_type.upper()
    normalized["Record ID"] = record_id

    # --------------------------------------------------------
    # CASE 1
    #
    # Record Type accidentally contains a PRODUCT ID.
    #
    # Example:
    #
    # Record Type = PROD-2ADD67FACF9E
    #
    # Correct:
    #
    # Record Type = PRODUCT
    # Record ID   = PROD-2ADD67FACF9E
    # --------------------------------------------------------

    if _is_product_id(record_type):

        normalized["Record Type"] = "PRODUCT"

        if not record_id:
            normalized["Record ID"] = record_type

        # If Product ID is empty, preserve the recovered ID.
        if not product_id:
            normalized["Product ID"] = record_type

        return normalized

    # --------------------------------------------------------
    # CASE 1B
    #
    # Some MASTER rows contain a product reference such as:
    #
    #   EXOTICA VIBRANT BUILDCON CATALOGUE NEW-P0007-I002
    #   800X2400MM BRILLO COLLECTION-P0008-I000
    #
    # These are product rows, not new Record Types.
    # --------------------------------------------------------

    if _is_product_record_reference(record_type):

        normalized["Record Type"] = "PRODUCT"

        if not record_id:
            normalized["Record ID"] = record_type

        if not product_id:
            normalized["Product ID"] = record_type

        return normalized

    # --------------------------------------------------------
    # CASE 2
    #
    # Record Type is empty but Product ID exists.
    #
    # This handles product rows where Record Type was not
    # populated correctly.
    # --------------------------------------------------------

    if (
        not record_type
        and (
            _is_product_id(product_id)
            or _is_product_record_reference(product_id)
        )
    ):

        normalized["Record Type"] = "PRODUCT"

        if not record_id:
            normalized["Record ID"] = product_id

        return normalized

    # --------------------------------------------------------
    # CASE 3
    #
    # Record Type is PRODUCT and Product ID exists but
    # Record ID is empty.
    #
    # Recover Record ID from Product ID.
    # --------------------------------------------------------

    if (
        normalized["Record Type"] == "PRODUCT"
        and not record_id
        and (
            _is_product_id(product_id)
            or _is_product_record_reference(product_id)
        )
    ):
        normalized["Record ID"] = product_id

    return normalized


def _normalize_master_records(records):
    """
    Normalize MASTER records.

    Completely empty rows are discarded.

    Rows that can be confidently classified as canonical
    MASTER records are retained.

    Rows with no usable Record Type are ignored instead of
    being inserted into the application dataset.
    """

    if not records:
        return []

    normalized_records = []

    for record in records:

        if not isinstance(record, dict):
            continue

        if _is_completely_empty_record(record):
            continue

        normalized = _normalize_master_record(record)

        if not _is_canonical_master_record(normalized):
            continue

        normalized_records.append(normalized)

    return normalized_records


# ============================================================
# BASIC SHEET LOADER
# ============================================================

def load_sheet(
    spreadsheet_id,
    sheet_name,
    start_column=DEFAULT_START_COLUMN,
    end_column=DEFAULT_END_COLUMN,
    end_row=DEFAULT_END_ROW,
):
    """
    Load any Google Sheet tab as a list of dictionaries.

    The first row is treated as the header row.
    """

    if not spreadsheet_id:
        raise ValueError(
            "spreadsheet_id is required."
        )

    if not sheet_name:
        raise ValueError(
            "sheet_name is required."
        )

    sheets_service = get_sheets_service()

    records = read_sheet_records(
        sheets_service=sheets_service,
        spreadsheet_id=spreadsheet_id,
        sheet_name=sheet_name,
        start_column=start_column,
        end_column=end_column,
        start_row=1,
        end_row=end_row,
    )

    if records is None:
        return []

    return records


# ============================================================
# LOAD MASTER RECORDS
# ============================================================

def load_master_records(
    spreadsheet_id,
    sheet_name=DEFAULT_SHEET_NAME,
):
    """
    Load the complete MASTER Google Sheet.

    Returns:
        list[dict]

    The MASTER records are normalized before being returned.
    """

    records = load_sheet(
        spreadsheet_id=spreadsheet_id,
        sheet_name=sheet_name,
        start_column="A",
        end_column="ZZ",
        end_row=5000,
    )

    return _normalize_master_records(records)


# ============================================================
# GROUP MASTER RECORDS
# ============================================================

def group_master_records(records):
    """
    Group MASTER records according to Record Type.

    Example:

    {
        "CATALOG": [...],
        "PRODUCT": [...],
        "REQUIREMENT": [...],
        "FIXTURE": [...],
        "MOODBOARD": [...],
        "RECOMMENDATION": [...],
        "DESIGN": [...],
        "RUN": [...]
    }
    """

    groups = {}

    if not records:
        return groups

    for record in records:

        if not isinstance(record, dict):
            continue

        record_type = str(
            record.get("Record Type", "")
        ).strip().upper()

        if not record_type:
            continue

        if record_type not in groups:
            groups[record_type] = []

        groups[record_type].append(record)

    return groups


# ============================================================
# GENERIC RECORD TYPE FILTER
# ============================================================

def get_records_by_type(
    records,
    record_type,
):
    """
    Return all records matching a Record Type.
    """

    if not records:
        return []

    target_type = str(
        record_type
    ).strip().upper()

    return [
        record
        for record in records
        if str(
            record.get("Record Type", "")
        ).strip().upper() == target_type
    ]


def _is_canonical_master_record(record):
    """
    Return True only for records that can be used by the
    application as a canonical MASTER record.
    """

    if not isinstance(record, dict):
        return False

    record_type = _clean_value(
        record.get("Record Type", "")
    ).upper()

    record_id = _clean_value(
        record.get("Record ID", "")
    )

    return (
        record_type in VALID_RECORD_TYPES
        and bool(record_id)
    )

# ============================================================
# CATALOGS
# ============================================================

def get_catalogs(records):
    """
    Return CATALOG records.
    """

    return get_records_by_type(
        records,
        "CATALOG",
    )


# ============================================================
# PRODUCTS
# ============================================================

def get_products(records):
    """
    Return PRODUCT records.
    """

    return get_records_by_type(
        records,
        "PRODUCT",
    )


# ============================================================
# REQUIREMENTS
# ============================================================

def get_requirements(records):
    """
    Return REQUIREMENT records.
    """

    return get_records_by_type(
        records,
        "REQUIREMENT",
    )


# ============================================================
# FIXTURES
# ============================================================

def get_fixtures(records):
    """
    Return FIXTURE records.
    """

    return get_records_by_type(
        records,
        "FIXTURE",
    )


# ============================================================
# MOODBOARDS
# ============================================================

def get_moodboards(records):
    """
    Return MOODBOARD records.
    """

    return get_records_by_type(
        records,
        "MOODBOARD",
    )


# ============================================================
# RECOMMENDATIONS
# ============================================================

def get_recommendations(records):
    """
    Return RECOMMENDATION records.
    """

    return get_records_by_type(
        records,
        "RECOMMENDATION",
    )


# ============================================================
# DESIGNS
# ============================================================

def get_designs(records):
    """
    Return DESIGN records.
    """

    return get_records_by_type(
        records,
        "DESIGN",
    )


# ============================================================
# RUNS
# ============================================================

def get_runs(records):
    """
    Return RUN records.
    """

    return get_records_by_type(
        records,
        "RUN"
    )


# ============================================================
# FIND RECORD BY ID
# ============================================================

def find_record_by_id(
    records,
    record_id,
):
    """
    Find a record using Record ID.

    Example:
        find_record_by_id(records, "CAT001")
    """

    if not records:
        return None

    target_id = str(
        record_id
    ).strip()

    if not target_id:
        return None

    for record in records:

        if not isinstance(record, dict):
            continue

        current_id = str(
            record.get("Record ID", "")
        ).strip()

        if current_id == target_id:
            return record

    return None


# ============================================================
# FIND PRODUCT BY PRODUCT ID
# ============================================================

def find_product_by_id(
    records,
    product_id,
):
    """
    Find a PRODUCT record using Product ID.
    """

    if not records:
        return None

    target_id = str(
        product_id
    ).strip()

    if not target_id:
        return None

    for record in get_products(records):

        current_id = str(
            record.get("Product ID", "")
        ).strip()

        if current_id == target_id:
            return record

        # Fallback to Record ID.
        current_record_id = str(
            record.get("Record ID", "")
        ).strip()

        if current_record_id == target_id:
            return record

    return None


# ============================================================
# FIND CATALOG BY CATALOG ID
# ============================================================

def find_catalog_by_id(
    records,
    catalog_id,
):
    """
    Find a CATALOG record using Catalog ID.
    """

    if not records:
        return None

    target_id = str(
        catalog_id
    ).strip()

    if not target_id:
        return None

    for record in get_catalogs(records):

        current_id = str(
            record.get("Catalog ID", "")
        ).strip()

        if current_id == target_id:
            return record

        current_record_id = str(
            record.get("Record ID", "")
        ).strip()

        if current_record_id == target_id:
            return record

    return None


# ============================================================
# VALIDATION
# ============================================================

def validate_master_records(records):
    """
    Validate canonical MASTER records.
    """

    errors = []

    if not isinstance(records, list):
        return [
            "MASTER records must be a list."
        ]

    for index, record in enumerate(
        records,
        start=2,
    ):

        if not isinstance(record, dict):
            errors.append(
                f"Row {index}: Record is not a dictionary."
            )
            continue

        record_type = _clean_value(
            record.get("Record Type", "")
        ).upper()

        record_id = _clean_value(
            record.get("Record ID", "")
        )

        if not record_type:
            errors.append(
                f"Row {index}: Record Type is empty."
            )
            continue

        if not record_id:
            errors.append(
                f"Row {index}: Record ID is empty."
            )
            continue

        if record_type not in VALID_RECORD_TYPES:
            errors.append(
                f"Row {index}: Unknown Record Type "
                f"'{record_type}'."
            )

    return errors

# ============================================================
# MASTER SUMMARY
# ============================================================

def get_master_summary(records):
    """
    Return a summary dictionary for MASTER data.
    """

    groups = group_master_records(records)

    return {
        "total_records": len(records or []),

        "catalogs": len(
            groups.get("CATALOG", [])
        ),

        "products": len(
            groups.get("PRODUCT", [])
        ),

        "requirements": len(
            groups.get("REQUIREMENT", [])
        ),

        "fixtures": len(
            groups.get("FIXTURE", [])
        ),

        "moodboards": len(
            groups.get("MOODBOARD", [])
        ),

        "recommendations": len(
            groups.get("RECOMMENDATION", [])
        ),

        "designs": len(
            groups.get("DESIGN", [])
        ),

        "runs": len(
            groups.get("RUN", [])
        ),
    }


# ============================================================
# PRINT MASTER SUMMARY
# ============================================================

def print_master_summary(records):
    """
    Print a readable MASTER summary.
    """

    summary = get_master_summary(records)

    print("")
    print("=" * 70)
    print("GOOGLE SHEETS MASTER DATABASE")
    print("=" * 70)

    print(
        f"Total records: "
        f"{summary['total_records']}"
    )

    print(
        f"CATALOGS: "
        f"{summary['catalogs']}"
    )

    print(
        f"PRODUCTS: "
        f"{summary['products']}"
    )

    print(
        f"REQUIREMENTS: "
        f"{summary['requirements']}"
    )

    print(
        f"FIXTURES: "
        f"{summary['fixtures']}"
    )

    print(
        f"MOODBOARDS: "
        f"{summary['moodboards']}"
    )

    print(
        f"RECOMMENDATIONS: "
        f"{summary['recommendations']}"
    )

    print(
        f"DESIGNS: "
        f"{summary['designs']}"
    )

    print(
        f"RUNS: "
        f"{summary['runs']}"
    )

    print("=" * 70)


# ============================================================
# PRINT PRODUCT SUMMARY
# ============================================================

def print_product_summary(
    products,
):
    """
    Print the first 10 PRODUCT records.
    """

    print("")
    print("=" * 70)
    print("GOOGLE SHEETS PRODUCT DATA")
    print("=" * 70)

    print(
        f"Total products: {len(products or [])}"
    )

    for index, product in enumerate(
        products[:10],
        start=1,
    ):

        print("")
        print(f"Product {index}")

        print(
            "Product ID:",
            product.get(
                "Product ID",
                "",
            ),
        )

        # MASTER uses "Name".
        # Support "Product Name" as fallback.

        product_name = product.get(
            "Name",
            "",
        )

        if not str(product_name).strip():

            product_name = product.get(
                "Product Name",
                "",
            )

        print(
            "Product Name:",
            product_name,
        )

        print(
            "Brand:",
            product.get(
                "Brand",
                "",
            ),
        )

        print(
            "Catalog:",
            product.get(
                "Catalog",
                "",
            ),
        )

        print(
            "Category:",
            product.get(
                "Category",
                "",
            ),
        )

        print(
            "Subcategory:",
            product.get(
                "Subcategory",
                "",
            ),
        )

        print(
            "Style:",
            product.get(
                "Style",
                "",
            ),
        )

        print(
            "Color:",
            product.get(
                "Color",
                "",
            ),
        )

        print(
            "Tone:",
            product.get(
                "Tone",
                "",
            ),
        )

        print(
            "Material:",
            product.get(
                "Material",
                "",
            ),
        )

        print(
            "Finish:",
            product.get(
                "Finish",
                "",
            ),
        )

        print(
            "Budget:",
            product.get(
                "Budget",
                "",
            ),
        )

        print(
            "Budget Tier:",
            product.get(
                "Budget Tier",
                "",
            ),
        )

        print(
            "Product Source:",
            product.get(
                "Product Source",
                "",
            ),
        )

        print(
            "Source File:",
            product.get(
                "Source File",
                "",
            ),
        )

        print(
            "Source Page:",
            product.get(
                "Source Page",
                "",
            ),
        )

        print(
            "Image URL:",
            product.get(
                "Image URL",
                "",
            ),
        )

        print(
            "Active:",
            product.get(
                "Active",
                "",
            ),
        )

    print("")
    print("=" * 70)


# ============================================================
# MASTER DATABASE LOADER
# ============================================================

def load_master_data(
    spreadsheet_id,
):
    """
    Load the complete MASTER database.

    Unlike the old implementation, this reads the
    MASTER tab as one unified data source.
    """

    records = load_master_records(
        spreadsheet_id=spreadsheet_id,
        sheet_name=DEFAULT_SHEET_NAME,
    )

    return {
        "records": records,

        "catalogs": get_catalogs(
            records
        ),

        "products": get_products(
            records
        ),

        "requirements": get_requirements(
            records
        ),

        "fixtures": get_fixtures(
            records
        ),

        "moodboards": get_moodboards(
            records
        ),

        "recommendations": get_recommendations(
            records
        ),

        "designs": get_designs(
            records
        ),

        "runs": get_runs(
            records
        ),
    }


# ============================================================
# COMPATIBILITY ALIAS
# ============================================================

def load_products_from_google_sheet(
    spreadsheet_id,
    sheet_name=DEFAULT_SHEET_NAME,
):
    """
    Compatibility function for the older loader.

    If sheet_name is MASTER:
        returns all normalized MASTER records.

    If sheet_name is PRODUCTS:
        returns records from PRODUCTS.
    """

    records = load_sheet(
        spreadsheet_id=spreadsheet_id,
        sheet_name=sheet_name,
        start_column="A",
        end_column="ZZ",
        end_row=5000,
    )

    # MASTER requires normalization.
    if str(sheet_name).strip().upper() == "MASTER":
        return _normalize_master_records(records)

    return records


# ============================================================
# END
# ============================================================