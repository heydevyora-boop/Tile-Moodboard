from pathlib import Path
import os

import cv2
import numpy as np


# Longest side of an approved product image, in pixels.
OUTPUT_CANVAS_SIZE = int(os.getenv("TILE_OUTPUT_CANVAS_SIZE", "1024"))
NEUTRAL_BACKGROUND_BGR = (245, 245, 245)

# Whether to letterbox the product onto a SQUARE canvas.
#
# Off. The output is the tile and nothing else: a 1:2 panel comes out
# 512x1024, not 1024x1024 with 256px of filler down each side. Padding
# was added to make every file the same shape, but a tile image with a
# wide blank border around it is not what a product photo looks like,
# and the blank is not part of the product.
#
# Set TILE_OUTPUT_PAD_TO_SQUARE=1 to restore the square letterbox.
PAD_TO_SQUARE = os.getenv(
    "TILE_OUTPUT_PAD_TO_SQUARE", "0",
).strip().lower() in ("1", "true", "yes", "on")

# How far a crop smaller than the canvas may be enlarged to fill it.
#
# Refusing to enlarge at all left a valid product stranded: a 300x300
# swatch occupied 29% of a 1024 canvas and read as a tiny island in grey,
# which is the "not a standard product image" complaint. Enlarging without
# a limit is the opposite error -- a 120px thumbnail blown up 8x is a
# blurry invention. 3x keeps real detail (a 341px crop reaches the full
# canvas) and nothing below that is worth presenting as a product photo.
MAX_CANVAS_UPSCALE = 3.0


def fit_to_output_canvas(
    image_bgr,
    canvas_size=OUTPUT_CANVAS_SIZE,
    background_bgr=NEUTRAL_BACKGROUND_BGR,
    pad_to_square=None,
):
    """Scale a crop to the standard output size without distorting it.

    Preserves the complete tile and its original aspect ratio. Never
    stretches or squashes, and never crops: every source pixel survives.
    Scales so the LONGEST side reaches `canvas_size` -- down without
    limit, up only as far as MAX_CANVAS_UPSCALE.

    By default the result is the tile alone, so a 1:2 panel comes back
    512x1024. With pad_to_square (or TILE_OUTPUT_PAD_TO_SQUARE=1) it is
    centred on a square neutral canvas instead.
    """
    if pad_to_square is None:
        pad_to_square = PAD_TO_SQUARE

    if image_bgr is None or image_bgr.size == 0:
        raise ValueError("Cannot fit an empty image onto the output canvas")

    height, width = image_bgr.shape[:2]
    if width < 1 or height < 1:
        raise ValueError("Cannot fit a zero-sized image onto the output canvas")

    canvas_size = max(1, int(canvas_size))
    scale = min(
        canvas_size / width, canvas_size / height, MAX_CANVAS_UPSCALE,
    )
    new_width = max(1, int(round(width * scale)))
    new_height = max(1, int(round(height * scale)))

    if scale < 0.999:
        resized = cv2.resize(
            image_bgr,
            (new_width, new_height),
            interpolation=cv2.INTER_AREA,
        )
    elif scale > 1.001:
        # Enlarging: INTER_AREA is a decimation filter and smears here.
        # Lanczos keeps the moulded edges and grout lines crisp, which is
        # the whole point of presenting the product larger.
        resized = cv2.resize(
            image_bgr,
            (new_width, new_height),
            interpolation=cv2.INTER_LANCZOS4,
        )
    else:
        resized = image_bgr

    if not pad_to_square:
        # The product, and nothing around it.
        return resized

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
