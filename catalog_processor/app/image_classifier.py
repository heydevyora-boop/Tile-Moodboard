import cv2
import numpy as np


def white_background_score(image):

    if image is None:
        return 0.0

    height, width = image.shape[:2]

    border = max(
        5,
        int(min(width, height) * 0.05)
    )

    top = image[:border, :]
    bottom = image[-border:, :]
    left = image[:, :border]
    right = image[:, -border:]

    border_pixels = np.concatenate([
        top.reshape(-1, 3),
        bottom.reshape(-1, 3),
        left.reshape(-1, 3),
        right.reshape(-1, 3)
    ])

    white_pixels = np.all(
        border_pixels >= 235,
        axis=1
    )

    return float(
        np.mean(white_pixels)
    )


def detect_object(image):

    if image is None:

        return {
            "object_area": 0.0,
            "centrality": 0.0,
            "rectangularity": 0.0,
            "bbox": None
        }

    gray = cv2.cvtColor(
        image,
        cv2.COLOR_BGR2GRAY
    )

    _, threshold = cv2.threshold(
        gray,
        240,
        255,
        cv2.THRESH_BINARY_INV
    )

    kernel = np.ones(
        (5, 5),
        np.uint8
    )

    threshold = cv2.morphologyEx(
        threshold,
        cv2.MORPH_OPEN,
        kernel
    )

    threshold = cv2.morphologyEx(
        threshold,
        cv2.MORPH_CLOSE,
        kernel
    )

    contours, _ = cv2.findContours(
        threshold,
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_SIMPLE
    )

    if not contours:

        return {
            "object_area": 0.0,
            "centrality": 0.0,
            "rectangularity": 0.0,
            "bbox": None
        }

    contour = max(
        contours,
        key=cv2.contourArea
    )

    area = cv2.contourArea(
        contour
    )

    height, width = image.shape[:2]

    total_area = width * height

    object_area = area / total_area

    x, y, w, h = cv2.boundingRect(
        contour
    )

    object_center_x = x + w / 2
    object_center_y = y + h / 2

    image_center_x = width / 2
    image_center_y = height / 2

    distance = (
        (
            (object_center_x - image_center_x) ** 2
            +
            (object_center_y - image_center_y) ** 2
        ) ** 0.5
    )

    max_distance = (
        (image_center_x ** 2 + image_center_y ** 2)
        ** 0.5
    )

    centrality = 1 - (
        distance / max_distance
    )

    bbox_area = w * h

    rectangularity = (
        area / bbox_area
        if bbox_area > 0
        else 0
    )

    return {
        "object_area": float(object_area),
        "centrality": float(centrality),
        "rectangularity": float(rectangularity),
        "bbox": [x, y, x + w, y + h]
    }


def calculate_cv_score(image_path):

    image = cv2.imread(
        str(image_path)
    )

    if image is None:

        return {
            "score": 0,
            "white_score": 0,
            "object_area": 0,
            "centrality": 0,
            "rectangularity": 0,
            "bbox": None
        }

    height, width = image.shape[:2]

    white_score = white_background_score(
        image
    )

    object_data = detect_object(
        image
    )

    score = 0

    # White background
    if white_score >= 0.80:
        score += 30
    elif white_score >= 0.60:
        score += 20
    elif white_score >= 0.40:
        score += 10

    # Object area
    object_area = object_data["object_area"]

    if 0.15 <= object_area <= 0.85:
        score += 25
    elif 0.08 <= object_area <= 0.90:
        score += 15

    # Centrality
    if object_data["centrality"] >= 0.80:
        score += 20
    elif object_data["centrality"] >= 0.60:
        score += 10

    # Rectangularity
    if object_data["rectangularity"] >= 0.60:
        score += 15
    elif object_data["rectangularity"] >= 0.40:
        score += 8

    # Resolution
    if min(width, height) >= 1000:
        score += 10
    elif min(width, height) >= 600:
        score += 5

    return {
        "score": score,
        "white_score": round(
            white_score,
            4
        ),
        "object_area": round(
            object_area,
            4
        ),
        "centrality": round(
            object_data["centrality"],
            4
        ),
        "rectangularity": round(
            object_data["rectangularity"],
            4
        ),
        "bbox": object_data["bbox"]
    }