from pathlib import Path
import cv2
import numpy as np


MIN_WIDTH = 250
MIN_HEIGHT = 250
MIN_PIXELS = 100_000
MIN_FILE_SIZE = 5_000

MAX_ASPECT_RATIO = 4.0
MIN_ASPECT_RATIO = 0.25

# Relative to an optional page/source size: reject obvious tiny fragments.
MIN_PAGE_AREA_FRACTION = 0.008

# Lightweight ink/graphic heuristic (no OCR). High binary density on a
# near-white field is typical of logos and text banners; alone it never
# rejects — it only reinforces an extreme-aspect or tiny-fragment reject.
GRAPHIC_INK_DENSITY_MIN = 0.04
GRAPHIC_INK_DENSITY_MAX = 0.35
GRAPHIC_BG_WHITENESS = 0.55


def extreme_aspect_ratio(width, height):
    """True when width/height is outside the conservative catalog band."""
    if width <= 0 or height <= 0:
        return True, "invalid_dimensions"
    aspect = width / height
    if aspect > MAX_ASPECT_RATIO:
        return True, f"too_wide (aspect {aspect:.2f})"
    if aspect < MIN_ASPECT_RATIO:
        return True, f"too_tall (aspect {aspect:.2f})"
    return False, ""


def looks_like_text_or_logo_graphic(image_bgr):
    """Cheap ink-on-paper detector for obvious logos/banners.

    Returns True only for confident graphic-like frames. A genuine tile
    (even a plain light one) usually fails this because its surface is
    continuous tone rather than sparse dark ink on a white field.
    """
    if image_bgr is None or image_bgr.size == 0:
        return False

    small = image_bgr
    height, width = small.shape[:2]
    longest = max(width, height)
    if longest > 256:
        scale = 256.0 / longest
        small = cv2.resize(
            small,
            (max(1, int(width * scale)), max(1, int(height * scale))),
            interpolation=cv2.INTER_AREA,
        )

    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    white_fraction = float(np.mean(gray >= 235))
    if white_fraction < GRAPHIC_BG_WHITENESS:
        return False

    _, binary = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)
    ink_density = float(np.mean(binary > 0))
    return GRAPHIC_INK_DENSITY_MIN <= ink_density <= GRAPHIC_INK_DENSITY_MAX


def early_reject_region(width, height, image_bgr=None, page_width=None,
                        page_height=None, region_area=None, page_area=None):
    """Conservative pre-Gemini reject for fragments that cannot be tiles.

    Aspect ratio always applies. Tiny page-relative size and a lightweight
    logo/banner ink check reinforce each other — neither alone rejects a
    mid-sized legitimate swatch.
    """
    extreme, aspect_reason = extreme_aspect_ratio(width, height)
    if extreme:
        return True, aspect_reason or "extreme_aspect_ratio"

    tiny_on_page = False
    if page_area and page_area > 0 and region_area is not None:
        if region_area / page_area < MIN_PAGE_AREA_FRACTION:
            tiny_on_page = True
    elif page_width and page_height and page_width > 0 and page_height > 0:
        page_area = float(page_width * page_height)
        region = float(width * height) if region_area is None else float(region_area)
        if region / page_area < MIN_PAGE_AREA_FRACTION:
            tiny_on_page = True

    graphic_like = bool(
        image_bgr is not None and looks_like_text_or_logo_graphic(image_bgr)
    )

    if tiny_on_page and graphic_like:
        return True, "tiny page fragment looks like logo/text graphic"

    aspect = width / float(height) if height else 0.0
    near_banner = aspect > 2.8 or aspect < (1.0 / 2.8)
    if near_banner and graphic_like:
        return True, "logo or text banner (ink-on-white + elongated)"

    return False, ""


def hard_filter(image_path, page_width=None, page_height=None):

    image_path = Path(image_path)

    result = {
        "passed": False,
        "reason": "",
        "width": 0,
        "height": 0,
        "aspect_ratio": 0.0
    }

    # Check whether file exists
    if not image_path.exists():

        result["reason"] = "file_not_found"

        return result

    # Check file size
    if image_path.stat().st_size < MIN_FILE_SIZE:

        result["reason"] = "file_too_small"

        return result

    # Read image
    image = cv2.imread(
        str(image_path)
    )

    if image is None:

        result["reason"] = "cannot_read_image"

        return result

    # Get dimensions
    height, width = image.shape[:2]

    result["width"] = width
    result["height"] = height

    # Minimum width
    if width < MIN_WIDTH:

        result["reason"] = "width_too_small"

        return result

    # Minimum height
    if height < MIN_HEIGHT:

        result["reason"] = "height_too_small"

        return result

    # Minimum total pixels
    if width * height < MIN_PIXELS:

        result["reason"] = "resolution_too_low"

        return result

    # Aspect ratio + conservative graphic / tiny-fragment checks.
    aspect_ratio = width / height
    result["aspect_ratio"] = aspect_ratio

    rejected, reason = early_reject_region(
        width,
        height,
        image_bgr=image,
        page_width=page_width,
        page_height=page_height,
    )
    if rejected:
        result["reason"] = reason
        return result

    # Everything passed
    result["passed"] = True
    result["reason"] = "passed"

    return result
