# ============================================================
# BATHROOM REQUIREMENTS
# ============================================================

from dataclasses import dataclass, asdict
from typing import Optional


# ============================================================
# CONTROLLED VALUES
# ============================================================

BUDGET_VALUES = {
    "BUDGET FRIENDLY",
    "MID RANGE",
    "HIGH RANGE",
    "ANY",
}

FINISH_VALUES = {
    "MATTE",
    "GLOSS",
    "HIGH GLOSS",
    "SATIN",
    "LAPPATO",
    "POLISHED",
    "TEXTURED",
    "STRUCTURED",
    "ANY",
}

FLOOR_SIZE_VALUES = {
    "2X2",
    "2X4",
    "4X4",
    "6X4",
    "ANY",
    "CUSTOM",
}

WALL_SIZE_VALUES = {
    "2X2",
    "2X4",
    "4X4",
    "6X4",
    "ANY",
    "CUSTOM",
}

YES_NO_VALUES = {
    "YES",
    "NO",
}

WALL_REQUIREMENT_VALUES = {
    "REQUIRED",
    "NOT REQUIRED",
}

HIGHLIGHT_VALUES = {
    "REQUIRED",
    "NOT REQUIRED",
}

SHOWER_TYPE_VALUES = {
    "SEPARATE",
    "OPEN",
    "GLASS PARTITION",
    "OTHER",
    "NONE",
}

STYLE_VALUES = {
    "LUXURY",
    "MODERN",
    "MINIMAL",
    "NATURAL",
    "EARTHY",
    "CONTEMPORARY",
    "ANY",
}


# ============================================================
# NORMALIZATION
# ============================================================

def normalize(value):
    """
    Convert user input into a consistent format.
    """

    if value is None:
        return ""

    value = str(value).strip().upper()

    return value


# ============================================================
# VALIDATION HELPERS
# ============================================================

def validate_value(
    value,
    allowed_values,
    field_name,
    default="ANY",
):
    """
    Validate a controlled value.
    """

    value = normalize(value)

    if value == "":
        return default

    if value not in allowed_values:
        raise ValueError(
            f"Invalid {field_name}: '{value}'. "
            f"Allowed values: "
            f"{', '.join(sorted(allowed_values))}"
        )

    return value


def validate_yes_no(
    value,
    field_name,
    default="NO",
):
    return validate_value(
        value=value,
        allowed_values=YES_NO_VALUES,
        field_name=field_name,
        default=default,
    )


# ============================================================
# BATHROOM REQUIREMENT MODEL
# ============================================================

@dataclass
class BathroomRequirements:

    # --------------------------------------------------------
    # SPACE
    # --------------------------------------------------------

    space: str = "BATHROOM"

    # --------------------------------------------------------
    # BUDGET
    # --------------------------------------------------------

    budget: str = "ANY"

    # --------------------------------------------------------
    # FLOOR
    # --------------------------------------------------------

    floor_required: str = "YES"
    floor_size: str = "ANY"
    floor_size_custom: Optional[str] = None
    floor_finish: str = "ANY"

    # --------------------------------------------------------
    # WALL
    # --------------------------------------------------------

    wall_requirement: str = "NOT REQUIRED"
    wall_size: str = "ANY"
    wall_size_custom: Optional[str] = None
    wall_finish: str = "ANY"

    # --------------------------------------------------------
    # HIGHLIGHT
    # --------------------------------------------------------

    highlight_requirement: str = "NOT REQUIRED"

    # --------------------------------------------------------
    # SHOWER
    # --------------------------------------------------------

    shower_required: str = "NO"
    shower_type: str = "NONE"
    shower_highlight_required: str = "NO"

    # --------------------------------------------------------
    # STYLE
    # --------------------------------------------------------

    style: str = "ANY"

    # --------------------------------------------------------
    # EXTRA NOTES
    # --------------------------------------------------------

    notes: str = ""


# ============================================================
# VALIDATE BATHROOM REQUIREMENTS
# ============================================================

def validate_bathroom_requirements(
    requirements: BathroomRequirements,
):
    """
    Validate the complete bathroom requirement object.
    """

    requirements.space = "BATHROOM"

    requirements.budget = validate_value(
        requirements.budget,
        BUDGET_VALUES,
        "budget",
    )

    requirements.floor_required = validate_yes_no(
        requirements.floor_required,
        "floor_required",
        default="YES",
    )

    requirements.floor_size = validate_value(
        requirements.floor_size,
        FLOOR_SIZE_VALUES,
        "floor_size",
    )

    requirements.floor_finish = validate_value(
        requirements.floor_finish,
        FINISH_VALUES,
        "floor_finish",
    )

    requirements.wall_requirement = validate_value(
        requirements.wall_requirement,
        WALL_REQUIREMENT_VALUES,
        "wall_requirement",
        default="NOT REQUIRED",
    )

    requirements.wall_size = validate_value(
        requirements.wall_size,
        WALL_SIZE_VALUES,
        "wall_size",
    )

    requirements.wall_finish = validate_value(
        requirements.wall_finish,
        FINISH_VALUES,
        "wall_finish",
    )

    requirements.highlight_requirement = validate_value(
        requirements.highlight_requirement,
        HIGHLIGHT_VALUES,
        "highlight_requirement",
        default="NOT REQUIRED",
    )

    requirements.shower_required = validate_yes_no(
        requirements.shower_required,
        "shower_required",
        default="NO",
    )

    requirements.shower_type = validate_value(
        requirements.shower_type,
        SHOWER_TYPE_VALUES,
        "shower_type",
        default="NONE",
    )

    requirements.shower_highlight_required = validate_yes_no(
        requirements.shower_highlight_required,
        "shower_highlight_required",
        default="NO",
    )

    requirements.style = validate_value(
        requirements.style,
        STYLE_VALUES,
        "style",
    )

    # --------------------------------------------------------
    # LOGICAL VALIDATION
    # --------------------------------------------------------

    if requirements.floor_size == "CUSTOM":

        if not requirements.floor_size_custom:
            raise ValueError(
                "floor_size_custom is required "
                "when floor_size is CUSTOM."
            )

    if requirements.wall_size == "CUSTOM":

        if not requirements.wall_size_custom:
            raise ValueError(
                "wall_size_custom is required "
                "when wall_size is CUSTOM."
            )

    if requirements.wall_requirement == "NOT REQUIRED":

        # Wall-specific preferences should not accidentally
        # become hard requirements.
        requirements.wall_size = "ANY"
        requirements.wall_size_custom = None
        requirements.wall_finish = "ANY"

    if requirements.shower_required == "NO":

        requirements.shower_type = "NONE"
        requirements.shower_highlight_required = "NO"

    if requirements.shower_required == "YES":

        if requirements.shower_type == "NONE":
            raise ValueError(
                "shower_type is required when "
                "shower_required is YES."
            )

    return requirements


# ============================================================
# CREATE REQUIREMENTS
# ============================================================

def create_bathroom_requirements(
    budget="ANY",

    floor_required="YES",
    floor_size="ANY",
    floor_size_custom=None,
    floor_finish="ANY",

    wall_requirement="NOT REQUIRED",
    wall_size="ANY",
    wall_size_custom=None,
    wall_finish="ANY",

    highlight_requirement="NOT REQUIRED",

    shower_required="NO",
    shower_type="NONE",
    shower_highlight_required="NO",

    style="ANY",

    notes="",
):
    """
    Create and validate bathroom requirements.
    """

    requirements = BathroomRequirements(

        budget=budget,

        floor_required=floor_required,
        floor_size=floor_size,
        floor_size_custom=floor_size_custom,
        floor_finish=floor_finish,

        wall_requirement=wall_requirement,
        wall_size=wall_size,
        wall_size_custom=wall_size_custom,
        wall_finish=wall_finish,

        highlight_requirement=highlight_requirement,

        shower_required=shower_required,
        shower_type=shower_type,
        shower_highlight_required=(
            shower_highlight_required
        ),

        style=style,

        notes=notes,
    )

    return validate_bathroom_requirements(
        requirements
    )


# ============================================================
# CONVERT TO DICTIONARY
# ============================================================

def requirements_to_dict(
    requirements: BathroomRequirements,
):
    """
    Convert requirements to a JSON-friendly dictionary.
    """

    return asdict(requirements)