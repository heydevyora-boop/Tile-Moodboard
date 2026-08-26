from pathlib import Path

import cv2


def crop_from_bbox(
    image_path,
    bbox,
    output_path,
    margin_ratio=0.05
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

    # --------------------------------------------------------
    # Moderate HD processing
    # --------------------------------------------------------

    crop_height, crop_width = cropped.shape[:2]

    minimum_dimension = min(
        crop_width,
        crop_height
    )

    if minimum_dimension < 1200:

        scale = (
            1200 /
            minimum_dimension
        )

        new_width = int(
            crop_width * scale
        )

        new_height = int(
            crop_height * scale
        )

        cropped = cv2.resize(
            cropped,
            (
                new_width,
                new_height
            ),
            interpolation=cv2.INTER_LANCZOS4
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