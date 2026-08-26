# ============================================================
# GEMINI CLASSIFICATION VALIDATION
# ============================================================

from app.gemini_classifier import (
    StyleValue,
    ToneValue,
    PatternValue,
)


BOOLEAN_VALUES = {
    "YES",
    "NO",
    "UNKNOWN",
}

CONFIDENCE_VALUES = {
    "HIGH",
    "MEDIUM",
    "LOW",
}


def normalize(
    value,
):
    if value is None:
        return ""

    return str(
        value
    ).strip().upper()


def validate_boolean(
    value,
):
    value = normalize(
        value
    )

    if value not in BOOLEAN_VALUES:
        return "UNKNOWN"

    return value


def validate_classification(
    classification,
):
    """
    Final safety layer around Gemini output.

    Unknown/invalid values are converted to UNKNOWN.
    """

    if not classification:
        return None

    result = dict(
        classification
    )

    # --------------------------------------------------------
    # Boolean fields
    # --------------------------------------------------------

    result[
        "veining"
    ] = validate_boolean(
        result.get(
            "veining"
        )
    )

    result[
        "bathroom_wall"
    ] = validate_boolean(
        result.get(
            "bathroom_wall"
        )
    )

    result[
        "bathroom_floor"
    ] = validate_boolean(
        result.get(
            "bathroom_floor"
        )
    )

    result[
        "shower_area"
    ] = validate_boolean(
        result.get(
            "shower_area"
        )
    )

    # --------------------------------------------------------
    # Style
    # --------------------------------------------------------

    valid_styles = {
        "MODERN",
        "MINIMAL",
        "LUXURY",
        "NATURAL",
        "EARTHY",
        "CONTEMPORARY",
        "CLASSIC",
        "INDUSTRIAL",
        "UNKNOWN",
    }

    style = normalize(
        result.get(
            "style"
        )
    )

    if style not in valid_styles:
        style = "UNKNOWN"

    result[
        "style"
    ] = style

    # --------------------------------------------------------
    # Tone
    # --------------------------------------------------------

    valid_tones = {
        "LIGHT",
        "MEDIUM",
        "DARK",
        "WARM",
        "COOL",
        "NEUTRAL",
        "UNKNOWN",
    }

    tone = normalize(
        result.get(
            "tone"
        )
    )

    if tone not in valid_tones:
        tone = "UNKNOWN"

    result[
        "tone"
    ] = tone

    # --------------------------------------------------------
    # Pattern
    # --------------------------------------------------------

    valid_patterns = {
        "PLAIN",
        "VEINED",
        "MARBLED",
        "STONE",
        "CONCRETE",
        "WOOD",
        "GEOMETRIC",
        "ABSTRACT",
        "FLORAL",
        "TEXTURED",
        "UNKNOWN",
    }

    pattern = normalize(
        result.get(
            "pattern"
        )
    )

    if pattern not in valid_patterns:
        pattern = "UNKNOWN"

    result[
        "pattern"
    ] = pattern

    # --------------------------------------------------------
    # Contrast
    # --------------------------------------------------------

    valid_contrast = {
        "LOW",
        "MEDIUM",
        "HIGH",
        "UNKNOWN",
    }

    contrast = normalize(
        result.get(
            "contrast"
        )
    )

    if contrast not in valid_contrast:
        contrast = "UNKNOWN"

    result[
        "contrast"
    ] = contrast

    # --------------------------------------------------------
    # Confidence
    # --------------------------------------------------------

    confidence = normalize(
        result.get(
            "confidence"
        )
    )

    if confidence not in CONFIDENCE_VALUES:
        confidence = "LOW"

    result[
        "confidence"
    ] = confidence

    # --------------------------------------------------------
    # Color
    # --------------------------------------------------------

    color = result.get(
        "color"
    )

    if not color:
        color = "UNKNOWN"

    result[
        "color"
    ] = str(
        color
    ).strip()

    # --------------------------------------------------------
    # Reasoning
    # --------------------------------------------------------

    reasoning = result.get(
        "reasoning"
    )

    if not reasoning:
        reasoning = "UNKNOWN"

    result[
        "reasoning"
    ] = str(
        reasoning
    ).strip()

    return result