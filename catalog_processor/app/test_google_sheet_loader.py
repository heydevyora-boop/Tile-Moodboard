from app.google_services import (
    get_sheets_service,
    read_sheet_records
)


# ============================================================
# GOOGLE SHEET MASTER LOADER
# ============================================================

def load_sheet(
    spreadsheet_id,
    sheet_name,
    start_column="A",
    end_column="ZZ",
    end_row=5000
):
    """
    Load any Google Sheet tab as a list of dictionaries.
    """

    sheets_service = get_sheets_service()

    records = read_sheet_records(
        sheets_service=sheets_service,
        spreadsheet_id=spreadsheet_id,
        sheet_name=sheet_name,
        start_column=start_column,
        end_column=end_column,
        start_row=1,
        end_row=end_row
    )

    return records


# ============================================================
# PRODUCTS
# ============================================================

def load_products(
    spreadsheet_id
):
    """
    Load PRODUCTS master data.
    """

    return load_sheet(
        spreadsheet_id=spreadsheet_id,
        sheet_name="PRODUCTS",
        start_column="A",
        end_column="AK"
    )


# ============================================================
# CATALOGS
# ============================================================

def load_catalogs(
    spreadsheet_id
):
    """
    Load CATALOGS master data.
    """

    return load_sheet(
        spreadsheet_id=spreadsheet_id,
        sheet_name="CATALOGS",
        start_column="A",
        end_column="J"
    )


# ============================================================
# BRANDS
# ============================================================

def load_brands(
    spreadsheet_id
):
    """
    Load BRANDS master data.
    """

    return load_sheet(
        spreadsheet_id=spreadsheet_id,
        sheet_name="BRANDS",
        start_column="A",
        end_column="C"
    )


# ============================================================
# SANITARY
# ============================================================

def load_sanitary(
    spreadsheet_id
):
    """
    Load SANITARY products.
    """

    return load_sheet(
        spreadsheet_id=spreadsheet_id,
        sheet_name="SANITARY",
        start_column="A",
        end_column="L"
    )


# ============================================================
# FAUCETS
# ============================================================

def load_faucets(
    spreadsheet_id
):
    """
    Load FAUCETS products.
    """

    return load_sheet(
        spreadsheet_id=spreadsheet_id,
        sheet_name="FAUCETS",
        start_column="A",
        end_column="K"
    )


# ============================================================
# BASINS
# ============================================================

def load_basins(
    spreadsheet_id
):
    """
    Load BASINS products.
    """

    return load_sheet(
        spreadsheet_id=spreadsheet_id,
        sheet_name="BASINS",
        start_column="A",
        end_column="L"
    )


# ============================================================
# WC
# ============================================================

def load_wc(
    spreadsheet_id
):
    """
    Load WC products.
    """

    return load_sheet(
        spreadsheet_id=spreadsheet_id,
        sheet_name="WC",
        start_column="A",
        end_column="L"
    )


# ============================================================
# FLUSH PLATES
# ============================================================

def load_flush_plates(
    spreadsheet_id
):
    """
    Load FLUSH_PLATES products.
    """

    return load_sheet(
        spreadsheet_id=spreadsheet_id,
        sheet_name="FLUSH_PLATES",
        start_column="A",
        end_column="K"
    )


# ============================================================
# SETTINGS
# ============================================================

def load_settings(
    spreadsheet_id
):
    """
    Load SETTINGS.
    """

    return load_sheet(
        spreadsheet_id=spreadsheet_id,
        sheet_name="SETTINGS",
        start_column="A",
        end_column="C"
    )


# ============================================================
# COMPLETE MASTER DATABASE
# ============================================================

def load_master_data(
    spreadsheet_id
):
    """
    Load the complete Google Sheets master database.
    """

    return {
        "products": load_products(
            spreadsheet_id
        ),

        "catalogs": load_catalogs(
            spreadsheet_id
        ),

        "brands": load_brands(
            spreadsheet_id
        ),

        "sanitary": load_sanitary(
            spreadsheet_id
        ),

        "faucets": load_faucets(
            spreadsheet_id
        ),

        "basins": load_basins(
            spreadsheet_id
        ),

        "wc": load_wc(
            spreadsheet_id
        ),

        "flush_plates": load_flush_plates(
            spreadsheet_id
        ),

        "settings": load_settings(
            spreadsheet_id
        )
    }


# ============================================================
# PRODUCT SUMMARY
# ============================================================

def print_product_summary(
    products
):
    print("=" * 70)
    print("GOOGLE SHEETS PRODUCT DATA")
    print("=" * 70)

    print(
        f"Total products: {len(products)}"
    )

    for index, product in enumerate(
        products[:10],
        start=1
    ):

        print("")
        print(f"Product {index}")

        print(
            "Product ID:",
            product.get(
                "Product ID",
                ""
            )
        )

        print(
            "Product Name:",
            product.get(
                "Product Name",
                ""
            )
        )

        print(
            "Brand:",
            product.get(
                "Brand",
                ""
            )
        )

        print(
            "Catalog:",
            product.get(
                "Catalog",
                ""
            )
        )

        print(
            "Finish:",
            product.get(
                "Finish",
                ""
            )
        )

        print(
            "Resolved Finish:",
            product.get(
                "Resolved Finish",
                ""
            )
        )

        print(
            "Budget Tier:",
            product.get(
                "Budget Tier",
                ""
            )
        )

        print(
            "Resolved Budget:",
            product.get(
                "Resolved Budget",
                ""
            )
        )

    print("")
    print("=" * 70)