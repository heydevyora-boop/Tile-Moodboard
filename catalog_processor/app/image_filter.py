from pathlib import Path
import cv2


MIN_WIDTH = 250
MIN_HEIGHT = 250
MIN_PIXELS = 100_000
MIN_FILE_SIZE = 5_000

MAX_ASPECT_RATIO = 4.0
MIN_ASPECT_RATIO = 0.25


def hard_filter(image_path):

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

    # Aspect ratio
    aspect_ratio = width / height

    result["aspect_ratio"] = aspect_ratio

    if aspect_ratio > MAX_ASPECT_RATIO:

        result["reason"] = "too_wide"

        return result

    if aspect_ratio < MIN_ASPECT_RATIO:

        result["reason"] = "too_tall"

        return result

    # Everything passed
    result["passed"] = True
    result["reason"] = "passed"

    return result