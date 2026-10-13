from pathlib import Path
import os

import cv2
import numpy as np


# Standard presentation canvas for approved product crops.
# The canvas is square; the tile itself keeps its native aspect ratio.
OUTPUT_CANVAS_SIZE = int(os.getenv("TILE_OUTPUT_CANVAS_SIZE", "1024"))
NEUTRAL_BACKGROUND_BGR = (245, 245, 245)


def fit_to_output_canvas(
    image_bgr,
    canvas_size=OUTPUT_CANVAS_SIZE,
    background_bgr=NEUTRAL_BACKGROUND_BGR,
):
    """Place a crop on a square neutral canvas without distorting it.

    Preserves the complete tile and its original aspect ratio. Never
    stretches or squashes. Never upscales past the source resolution
    (avoids inventing detail from blurry/small sources). Downscales only
    when the crop is larger than the canvas, then centers with padding.
    """
    if image_bgr is None or image_bgr.size == 0:
        raise ValueError("Cannot fit an empty image onto the output canvas")

    height, width = image_bgr.shape[:2]
    if width < 1 or height < 1:
        raise ValueError("Cannot fit a zero-sized image onto the output canvas")

    canvas_size = max(1, int(canvas_size))
    scale = min(canvas_size / width, canvas_size / height, 1.0)
    new_width = max(1, int(round(width * scale)))
    new_height = max(1, int(round(height * scale)))

    if scale < 0.999:
        resized = cv2.resize(
            image_bgr,
            (new_width, new_height),
            interpolation=cv2.INTER_AREA,
        )
    else:
        resized = image_bgr

    canvas = np.full(
        (canvas_size, canvas_size, 3),
        background_bgr,
        dtype=np.uint8,
    )
    x0 = (canvas_size - new_width) // 2
    y0 = (canvas_size - new_height) // 2
    canvas[y0:y0 + new_height, x0:x0 + new_width] = resized
    return canvas


def crop_from_bbox(
    image_path,
    bbox,
    output_path,
    margin_ratio=0.05,
    canvas_size=OUTPUT_CANVAS_SIZE,
):

    image_path = Path(
        image_path
    )

    output_path = Path(
        output_path
    )

    image = cv2.imread(
        str(image_path)
    )

    if image is None:

        raise ValueError(
            f"Cannot read image: "
            f"{image_path}"
        )

    height, width = image.shape[:2]

    x1 = int(bbox["x1"])
    y1 = int(bbox["y1"])
    x2 = int(bbox["x2"])
    y2 = int(bbox["y2"])

    box_width = x2 - x1
    box_height = y2 - y1

    margin_x = int(
        box_width *
        margin_ratio
    )

    margin_y = int(
        box_height *
        margin_ratio
    )

    x1 = max(
        0,
        x1 - margin_x
    )

    y1 = max(
        0,
        y1 - margin_y
    )

    x2 = min(
        width,
        x2 + margin_x
    )

    y2 = min(
        height,
        y2 + margin_y
    )

    cropped = image[
        y1:y2,
        x1:x2
    ]

    if cropped.size == 0:

        raise ValueError(
            "Crop produced an empty image"
        )

    # Standard square presentation canvas. Tile aspect ratio preserved;
    # no upscale past source pixels (see fit_to_output_canvas).
    cropped = fit_to_output_canvas(
        cropped,
        canvas_size=canvas_size,
    )

    output_path.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    success = cv2.imwrite(
        str(output_path),
        cropped,
        [
            cv2.IMWRITE_JPEG_QUALITY,
            95
        ]
    )

    if not success:

        raise RuntimeError(
            f"Could not save image: "
            f"{output_path}"
        )

    return output_path
