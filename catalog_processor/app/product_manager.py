from product_attributes import (
    resolve_finish,
    resolve_budget,
)

from google_services import (
    get_catalog_defaults,
    update_product_resolved_attributes,
)

def resolve_product(
    sheets_service,
    spreadsheet_id,
    product,
    row_number,
):

    catalog_id = product.get(
        "Catalog ID",
        ""
    )

    catalog_defaults = get_catalog_defaults(
        sheets_service,
        spreadsheet_id,
        catalog_id,
    )

    finish, finish_source = resolve_finish(
        product_override=product.get(
            "Finish Override",
            ""
        ),
        catalog_default=catalog_defaults.get(
            "finish",
            "UNKNOWN"
        ),
        extracted_finish=product.get(
            "Finish Extracted",
            ""
        ),
        ai_finish=product.get(
            "Finish AI",
            ""
        ),
    )

    budget, budget_source = resolve_budget(
        product_override=product.get(
            "Budget Override",
            ""
        ),
        catalog_default=catalog_defaults.get(
            "budget",
            "UNKNOWN"
        ),
    )

    update_product_resolved_attributes(
        sheets_service=sheets_service,
        spreadsheet_id=spreadsheet_id,
        row_number=row_number,
        resolved_finish=finish,
        finish_source=finish_source,
        resolved_budget=budget,
        budget_source=budget_source,
    )

    return {
        "product_id": product.get(
            "Product ID"
        ),
        "resolved_finish": finish,
        "finish_source": finish_source,
        "resolved_budget": budget,
        "budget_source": budget_source,
    }