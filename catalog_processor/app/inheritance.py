from typing import Dict, Any


# ============================================================
# ALLOWED VALUES
# ============================================================

ALLOWED_FINISHES = {
    "MATTE",
    "GLOSS",
    "HIGH GLOSS",
    "SATIN",
    "LAPPATO",
    "POLISHED",
    "TEXTURED",
    "STRUCTURED",
    "UNKNOWN",
}

ALLOWED_BUDGETS = {
    "BUDGET FRIENDLY",
    "MID RANGE",
    "HIGH RANGE",
    "UNKNOWN",
}


# ============================================================
# NORMALIZATION
# ============================================================

def normalize_finish(value: Any) -> str:

    if value is None:
        return "UNKNOWN"

    value = str(value).strip().upper()

    if not value:
        return "UNKNOWN"

    if value in ALLOWED_FINISHES:
        return value

    return "UNKNOWN"


def normalize_budget(value: Any) -> str:

    if value is None:
        return "UNKNOWN"

    value = str(value).strip().upper()

    if not value:
        return "UNKNOWN"

    if value in ALLOWED_BUDGETS:
        return value

    return "UNKNOWN"


# ============================================================
# FINISH INHERITANCE
# ============================================================

def resolve_finish(
    product_finish,
    catalog_finish,
    extracted_finish=None,
    ai_finish=None,
):
    """
    Finish priority:

    1. Product manual override
    2. Catalog manual default
    3. Extracted catalog value
    4. AI inference
    5. UNKNOWN
    """

    product_finish = normalize_finish(
        product_finish
    )

    catalog_finish = normalize_finish(
        catalog_finish
    )

    extracted_finish = normalize_finish(
        extracted_finish
    )

    ai_finish = normalize_finish(
        ai_finish
    )

    # --------------------------------------------------------
    # 1. PRODUCT OVERRIDE
    # --------------------------------------------------------

    if product_finish != "UNKNOWN":

        return {
            "value": product_finish,
            "source": "PRODUCT_OVERRIDE",
        }

    # --------------------------------------------------------
    # 2. CATALOG DEFAULT
    # --------------------------------------------------------

    if catalog_finish != "UNKNOWN":

        return {
            "value": catalog_finish,
            "source": "CATALOG_DEFAULT",
        }

    # --------------------------------------------------------
    # 3. EXTRACTED VALUE
    # --------------------------------------------------------

    if extracted_finish != "UNKNOWN":

        return {
            "value": extracted_finish,
            "source": "EXTRACTED",
        }

    # --------------------------------------------------------
    # 4. AI VALUE
    # --------------------------------------------------------

    if ai_finish != "UNKNOWN":

        return {
            "value": ai_finish,
            "source": "AI",
        }

    # --------------------------------------------------------
    # 5. UNKNOWN
    # --------------------------------------------------------

    return {
        "value": "UNKNOWN",
        "source": "UNKNOWN",
    }


# ============================================================
# BUDGET INHERITANCE
# ============================================================

def resolve_budget(
    product_budget,
    catalog_budget,
    extracted_budget=None,
    ai_budget=None,
):
    """
    Budget priority:

    1. Product manual override
    2. Catalog manual default
    3. Extracted value
    4. AI inference
    5. UNKNOWN
    """

    product_budget = normalize_budget(
        product_budget
    )

    catalog_budget = normalize_budget(
        catalog_budget
    )

    extracted_budget = normalize_budget(
        extracted_budget
    )

    ai_budget = normalize_budget(
        ai_budget
    )

    # --------------------------------------------------------
    # 1. PRODUCT OVERRIDE
    # --------------------------------------------------------

    if product_budget != "UNKNOWN":

        return {
            "value": product_budget,
            "source": "PRODUCT_OVERRIDE",
        }

    # --------------------------------------------------------
    # 2. CATALOG DEFAULT
    # --------------------------------------------------------

    if catalog_budget != "UNKNOWN":

        return {
            "value": catalog_budget,
            "source": "CATALOG_DEFAULT",
        }

    # --------------------------------------------------------
    # 3. EXTRACTED VALUE
    # --------------------------------------------------------

    if extracted_budget != "UNKNOWN":

        return {
            "value": extracted_budget,
            "source": "EXTRACTED",
        }

    # --------------------------------------------------------
    # 4. AI VALUE
    # --------------------------------------------------------

    if ai_budget != "UNKNOWN":

        return {
            "value": ai_budget,
            "source": "AI",
        }

    # --------------------------------------------------------
    # 5. UNKNOWN
    # --------------------------------------------------------

    return {
        "value": "UNKNOWN",
        "source": "UNKNOWN",
    }


# ============================================================
# RESOLVE ONE PRODUCT
# ============================================================

def resolve_product(
    product: Dict[str, Any],
    catalog: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Resolve inherited Product Master values.

    Product values have priority over catalog defaults.
    """

    resolved = dict(product)

    # --------------------------------------------------------
    # FINISH
    # --------------------------------------------------------

    finish_result = resolve_finish(

        product_finish=product.get(
            "Finish"
        ),

        catalog_finish=catalog.get(
            "Default Finish"
        ),

        extracted_finish=product.get(
            "Extracted Finish"
        ),

        ai_finish=product.get(
            "AI Finish"
        ),
    )

    resolved["Resolved Finish"] = (
        finish_result["value"]
    )

    resolved["Resolved Finish Source"] = (
        finish_result["source"]
    )

    # --------------------------------------------------------
    # BUDGET
    # --------------------------------------------------------

    budget_result = resolve_budget(

        product_budget=product.get(
            "Budget Tier"
        ),

        catalog_budget=catalog.get(
            "Default Budget"
        ),

        extracted_budget=product.get(
            "Extracted Budget"
        ),

        ai_budget=product.get(
            "AI Budget"
        ),
    )

    resolved["Resolved Budget"] = (
        budget_result["value"]
    )

    resolved["Resolved Budget Source"] = (
        budget_result["source"]
    )

    return resolved


# ============================================================
# RESOLVE ALL PRODUCTS
# ============================================================

def resolve_products(
    products,
    catalogs,
):
    """
    Resolve all products against their catalogs.

    products:
        List of Product Master rows.

    catalogs:
        Dictionary keyed by Catalog name.
    """

    resolved_products = []

    for product in products:

        catalog_name = str(
            product.get(
                "Catalog",
                ""
            )
        ).strip()

        catalog = catalogs.get(
            catalog_name,
            {}
        )

        resolved_product = resolve_product(
            product,
            catalog
        )

        resolved_products.append(
            resolved_product
        )

    return resolved_products


# ============================================================
# TEST
# ============================================================

if __name__ == "__main__":

    catalog = {
        "Default Finish": "MATTE",
        "Default Budget": "MID RANGE",
    }

    product_without_override = {
        "Product ID": "PROD-TEST-001",
        "Catalog": "Test Catalog",
        "Finish": "",
        "Budget Tier": "",
    }

    product_with_override = {
        "Product ID": "PROD-TEST-002",
        "Catalog": "Test Catalog",
        "Finish": "GLOSS",
        "Budget Tier": "HIGH RANGE",
    }

    print("")
    print("=" * 60)
    print("INHERITANCE TEST")
    print("=" * 60)

    # --------------------------------------------------------
    # PRODUCT 1
    # --------------------------------------------------------

    print("")
    print("PRODUCT 1 - NO OVERRIDE")

    result_1 = resolve_product(
        product_without_override,
        catalog
    )

    print(
        "Resolved Finish:",
        result_1["Resolved Finish"]
    )

    print(
        "Finish Source:",
        result_1["Resolved Finish Source"]
    )

    print(
        "Resolved Budget:",
        result_1["Resolved Budget"]
    )

    print(
        "Budget Source:",
        result_1["Resolved Budget Source"]
    )

    # --------------------------------------------------------
    # PRODUCT 2
    # --------------------------------------------------------

    print("")
    print("PRODUCT 2 - WITH OVERRIDE")

    result_2 = resolve_product(
        product_with_override,
        catalog
    )

    print(
        "Resolved Finish:",
        result_2["Resolved Finish"]
    )

    print(
        "Finish Source:",
        result_2["Resolved Finish Source"]
    )

    print(
        "Resolved Budget:",
        result_2["Resolved Budget"]
    )

    print(
        "Budget Source:",
        result_2["Resolved Budget Source"]
    )

    # --------------------------------------------------------
    # COMPLETE
    # --------------------------------------------------------

    print("")
    print("=" * 60)
    print("INHERITANCE TEST COMPLETE")
    print("=" * 60)