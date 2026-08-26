# ============================================================
# BATHROOM PRODUCT CLASSIFICATION
# ============================================================

BOOLEAN_VALUES = {
    "YES",
    "NO",
    "UNKNOWN",
}

FLOOR_WALL_VALUES = {
    "FLOOR",
    "WALL",
    "FLOOR + WALL",
    "UNKNOWN",
}


# ============================================================
# VALIDATION
# ============================================================

def validate_boolean(value):
    """
    Validate YES / NO / UNKNOWN values.
    """

    if value is None:
        return "UNKNOWN"

    value = str(value).strip().upper()

    if value == "":
        return "UNKNOWN"

    if value not in BOOLEAN_VALUES:
        raise ValueError(
            f"Invalid classification value: {value}. "
            f"Allowed values: YES, NO, UNKNOWN"
        )

    return value


def validate_floor_wall(value):
    """
    Validate FLOOR / WALL / FLOOR + WALL / UNKNOWN.
    """

    if value is None:
        return "UNKNOWN"

    value = str(value).strip().upper()

    if value == "":
        return "UNKNOWN"

    if value not in FLOOR_WALL_VALUES:
        raise ValueError(
            f"Invalid Floor / Wall value: {value}. "
            f"Allowed values: FLOOR, WALL, FLOOR + WALL, UNKNOWN"
        )

    return value


# ============================================================
# CLASSIFICATION
# ============================================================

def classify_bathroom_product(
    suitable_for_wall="UNKNOWN",
    suitable_for_floor="UNKNOWN",
    bathroom_wall="UNKNOWN",
    bathroom_floor="UNKNOWN",
    shower_area="UNKNOWN",
    highlight_suitable="UNKNOWN",
    floor_wall="UNKNOWN",
    source="MANUAL",
):
    """
    Create a validated bathroom classification.

    IMPORTANT:
    UNKNOWN is preserved as UNKNOWN.
    It is never converted to YES.
    """

    return {
        "suitable_for_wall": validate_boolean(
            suitable_for_wall
        ),

        "suitable_for_floor": validate_boolean(
            suitable_for_floor
        ),

        "bathroom_wall": validate_boolean(
            bathroom_wall
        ),

        "bathroom_floor": validate_boolean(
            bathroom_floor
        ),

        "shower_area": validate_boolean(
            shower_area
        ),

        "highlight_suitable": validate_boolean(
            highlight_suitable
        ),

        "floor_wall": validate_floor_wall(
            floor_wall
        ),

        "application_source": (
            str(source).strip().upper()
            if source
            else "MANUAL"
        ),
    }


# ============================================================
# HARD FILTER HELPERS
# ============================================================

def is_floor_compatible(product):
    """
    Used later by the filtering engine.

    Only YES is accepted as definitely suitable.
    UNKNOWN is NOT treated as YES.
    """

    return (
        product.get("Bathroom Floor")
        == "YES"
    )


def is_wall_compatible(product):
    """
    Only YES is accepted as definitely suitable.
    UNKNOWN is NOT treated as YES.
    """

    return (
        product.get("Bathroom Wall")
        == "YES"
    )


def is_shower_compatible(product):
    """
    Only YES is accepted as definitely suitable.
    UNKNOWN is NOT treated as YES.
    """

    return (
        product.get("Shower Area")
        == "YES"
    )


def is_highlight_compatible(product):
    """
    Only YES is accepted as definitely suitable.
    UNKNOWN is NOT treated as YES.
    """

    return (
        product.get("Highlight Suitable")
        == "YES"
    )


# ============================================================
# CLASSIFICATION SUMMARY
# ============================================================

def classification_summary(product):
    """
    Return a readable classification summary.
    """

    return {
        "Product ID": product.get(
            "Product ID",
            ""
        ),

        "Suitable for Wall": product.get(
            "Suitable for Wall",
            "UNKNOWN"
        ),

        "Suitable for Floor": product.get(
            "Suitable for Floor",
            "UNKNOWN"
        ),

        "Bathroom Wall": product.get(
            "Bathroom Wall",
            "UNKNOWN"
        ),

        "Bathroom Floor": product.get(
            "Bathroom Floor",
            "UNKNOWN"
        ),

        "Shower Area": product.get(
            "Shower Area",
            "UNKNOWN"
        ),

        "Highlight Suitable": product.get(
            "Highlight Suitable",
            "UNKNOWN"
        ),

        "Floor / Wall": product.get(
            "Floor / Wall",
            "UNKNOWN"
        ),

        "Application Source": product.get(
            "Application Source",
            "UNKNOWN"
        ),
    }