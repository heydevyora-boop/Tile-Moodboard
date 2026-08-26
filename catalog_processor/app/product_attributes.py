FINISH_VALUES = [
    "MATTE",
    "GLOSS",
    "HIGH GLOSS",
    "SATIN",
    "LAPPATO",
    "POLISHED",
    "TEXTURED",
    "STRUCTURED",
    "UNKNOWN",
]

BUDGET_VALUES = [
    "BUDGET FRIENDLY",
    "MID RANGE",
    "HIGH RANGE",
    "UNKNOWN",
]


def validate_finish(value):
    if not value:
        return "UNKNOWN"

    value = value.strip().upper()

    if value not in FINISH_VALUES:
        raise ValueError(
            f"Invalid finish: {value}"
        )

    return value


def validate_budget(value):
    if not value:
        return "UNKNOWN"

    value = value.strip().upper()

    if value not in BUDGET_VALUES:
        raise ValueError(
            f"Invalid budget: {value}"
        )

    return value


def resolve_finish(
    product_override="",
    catalog_default="",
    extracted_finish="",
    ai_finish="",
):
    """
    Priority:

    1. Product Override
    2. Catalog Default
    3. Extracted Value
    4. AI
    5. UNKNOWN
    """

    values = [
        ("PRODUCT_OVERRIDE", product_override),
        ("MANUAL_CATALOG", catalog_default),
        ("EXTRACTED", extracted_finish),
        ("AI", ai_finish),
    ]

    for source, value in values:

        if value:
            value = validate_finish(value)

            if value != "UNKNOWN":
                return value, source

    return "UNKNOWN", "UNKNOWN"


def resolve_budget(
    product_override="",
    catalog_default="",
):
    """
    Priority:

    1. Product Override
    2. Catalog Default
    3. UNKNOWN
    """

    if product_override:
        value = validate_budget(product_override)

        if value != "UNKNOWN":
            return value, "PRODUCT_OVERRIDE"

    if catalog_default:
        value = validate_budget(catalog_default)

        if value != "UNKNOWN":
            return value, "MANUAL_CATALOG"

    return "UNKNOWN", "UNKNOWN"