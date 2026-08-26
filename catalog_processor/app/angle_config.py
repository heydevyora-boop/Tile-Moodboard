# ============================================================
# ANGLE CONFIGURATION
# ============================================================
#
# Defines the supported camera views for an existing
# locked bathroom scene.
#
# IMPORTANT:
#
# Angle generation does NOT change:
#   - Products
#   - Tiles
#   - Basin
#   - Faucet
#   - WC
#   - Shower
#   - Partition
#   - Layout
#   - Colors
#   - Finishes
#
# It changes ONLY:
#   - Camera position
#   - Camera angle
#   - Framing
#   - Field of view
#
# ============================================================


# ============================================================
# SUPPORTED ANGLES
# ============================================================

SUPPORTED_ANGLES = {
    "FRONT",
    "LEFT",
    "RIGHT",
    "WIDE",
    "SHOWER_CLOSEUP",
}


# ============================================================
# ANGLE CONFIGURATION
# ============================================================

ANGLE_CONFIG = {

    # --------------------------------------------------------
    # FRONT VIEW
    # --------------------------------------------------------

    "FRONT": {

        "name": "Front View",

        "camera_position": (
            "Centered directly in front "
            "of the bathroom"
        ),

        "camera_angle": (
            "Straight-on architectural view"
        ),

        "framing": (
            "Balanced composition showing "
            "the main bathroom layout"
        ),

        "field_of_view": (
            "Medium field of view"
        ),

        "prompt_instruction": (
            "Show the exact same bathroom "
            "from a centered front-facing "
            "camera position."
        ),
    },


    # --------------------------------------------------------
    # LEFT VIEW
    # --------------------------------------------------------

    "LEFT": {

        "name": "Left Angle",

        "camera_position": (
            "Camera positioned toward the "
            "left side of the bathroom"
        ),

        "camera_angle": (
            "Three-quarter left perspective"
        ),

        "framing": (
            "Show the same bathroom while "
            "revealing the left-side depth"
        ),

        "field_of_view": (
            "Medium field of view"
        ),

        "prompt_instruction": (
            "Show the exact same bathroom "
            "from a three-quarter left camera "
            "position."
        ),
    },


    # --------------------------------------------------------
    # RIGHT VIEW
    # --------------------------------------------------------

    "RIGHT": {

        "name": "Right Angle",

        "camera_position": (
            "Camera positioned toward the "
            "right side of the bathroom"
        ),

        "camera_angle": (
            "Three-quarter right perspective"
        ),

        "framing": (
            "Show the same bathroom while "
            "revealing the right-side depth"
        ),

        "field_of_view": (
            "Medium field of view"
        ),

        "prompt_instruction": (
            "Show the exact same bathroom "
            "from a three-quarter right camera "
            "position."
        ),
    },


    # --------------------------------------------------------
    # WIDE VIEW
    # --------------------------------------------------------

    "WIDE": {

        "name": "Wide View",

        "camera_position": (
            "Camera positioned farther back "
            "from the bathroom"
        ),

        "camera_angle": (
            "Wide architectural perspective"
        ),

        "framing": (
            "Show the complete bathroom "
            "and surrounding spatial context"
        ),

        "field_of_view": (
            "Wide field of view"
        ),

        "prompt_instruction": (
            "Show the exact same bathroom "
            "from a wider camera position "
            "with more spatial context."
        ),
    },


    # --------------------------------------------------------
    # SHOWER CLOSE-UP
    # --------------------------------------------------------

    "SHOWER_CLOSEUP": {

        "name": "Shower Close-up",

        "camera_position": (
            "Camera positioned near the "
            "shower area"
        ),

        "camera_angle": (
            "Close architectural detail view"
        ),

        "framing": (
            "Focus on the shower area while "
            "preserving the exact existing "
            "materials and fixtures"
        ),

        "field_of_view": (
            "Narrow field of view"
        ),

        "prompt_instruction": (
            "Show the exact same bathroom "
            "with a close-up view focused "
            "on the existing shower area."
        ),
    },
}


# ============================================================
# NORMALIZE ANGLE
# ============================================================

def normalize_angle(angle):
    """
    Convert an angle into the canonical format.

    Examples:

        front
        Front
        FRONT
        front view

    become:

        FRONT
    """

    if not isinstance(angle, str):
        return ""

    value = angle.strip().upper()

    aliases = {

        "FRONT": "FRONT",
        "FRONT VIEW": "FRONT",

        "LEFT": "LEFT",
        "LEFT ANGLE": "LEFT",
        "LEFT VIEW": "LEFT",

        "RIGHT": "RIGHT",
        "RIGHT ANGLE": "RIGHT",
        "RIGHT VIEW": "RIGHT",

        "WIDE": "WIDE",
        "WIDE VIEW": "WIDE",

        "SHOWER": "SHOWER_CLOSEUP",
        "SHOWER CLOSEUP": "SHOWER_CLOSEUP",
        "SHOWER CLOSE-UP": "SHOWER_CLOSEUP",
        "SHOWER CLOSE UP": "SHOWER_CLOSEUP",
        "SHOWER_CLOSEUP": "SHOWER_CLOSEUP",
    }

    return aliases.get(
        value,
        ""
    )


# ============================================================
# CHECK ANGLE
# ============================================================

def is_supported_angle(angle):
    """
    Return True if the supplied angle is supported.
    """

    normalized = normalize_angle(
        angle
    )

    return normalized in SUPPORTED_ANGLES


# ============================================================
# GET ANGLE CONFIG
# ============================================================

def get_angle_config(angle):
    """
    Return configuration for a supported angle.

    Raises ValueError if the angle is invalid.
    """

    normalized = normalize_angle(
        angle
    )

    if normalized not in SUPPORTED_ANGLES:
        raise ValueError(
            f"Unsupported angle: {angle}"
        )

    return ANGLE_CONFIG[
        normalized
    ]


# ============================================================
# GET ALL ANGLES
# ============================================================

def get_supported_angles():
    """
    Return the supported angles in UI order.
    """

    return [
        "FRONT",
        "LEFT",
        "RIGHT",
        "WIDE",
        "SHOWER_CLOSEUP",
    ]