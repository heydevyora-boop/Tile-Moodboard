from pathlib import Path
from typing import Any, Dict, List


def get_product_image_path(
    product: Dict[str, Any]
) -> Path:
    """
    Resolve the local reference image for one locked product.
    """

    image_path = str(
        product.get(
            "image_path",
            ""
        )
    ).strip()

    if not image_path:
        raise FileNotFoundError(
            f"No image_path for product "
            f"{product.get('product_id', '')}"
        )

    path = Path(image_path).expanduser().resolve()

    if not path.exists():
        raise FileNotFoundError(
            f"Product reference image not found: {path}"
        )

    if not path.is_file():
        raise FileNotFoundError(
            f"Product reference path is not a file: {path}"
        )

    return path


def resolve_scene_reference_images(
    scene: Dict[str, Any]
) -> List[Path]:
    """
    Resolve all reference images from the locked scene.

    The scene remains the source of truth.
    """

    if scene.get("product_lock") is not True:
        raise ValueError(
            "Scene is not product locked."
        )

    products = scene.get(
        "products",
        []
    )

    if not products:
        raise ValueError(
            "Locked scene contains no products."
        )

    image_paths = []

    for product in products:

        path = get_product_image_path(
            product
        )

        image_paths.append(
            path
        )

    return image_paths