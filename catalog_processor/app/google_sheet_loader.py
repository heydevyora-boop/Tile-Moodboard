from app.google_services import (
    get_sheets_service,
    read_sheet_records
)


def load_products_from_google_sheet(
    spreadsheet_id,
    sheet_name="MASTER"
):
    """
    Load product master data from Google Sheets.
    """

    sheets_service = get_sheets_service()

    products = read_sheet_records(
        sheets_service=sheets_service,
        spreadsheet_id=spreadsheet_id,
        sheet_name=sheet_name,
        start_column="A",
        end_column="M"
    )

    return products


def print_product_summary(products):

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
            "ID:",
            product.get("Product ID", "")
        )

        print(
            "Name:",
            product.get("Product Name", "")
        )

        print(
            "Category:",
            product.get("Category", "")
        )

        print(
            "Style:",
            product.get("Style", "")
        )

        print(
            "Budget:",
            product.get("Budget", "")
        )

    print("")
    print("=" * 70)