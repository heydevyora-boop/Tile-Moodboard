from pathlib import Path
from typing import Any, Dict, Optional

from app.tile_application_engine import (
    apply_tile_to_scene,
)

from app.visualization_registry import (
    create_and_register_visualization,
)

from app.scene_image_resolver import resolve_scene_image


# ============================================================
# PROJECT PATHS
# ============================================================

PROJECT_ROOT = (
    Path(__file__)
    .resolve()
    .parent
    .parent
)

OUTPUT_ROOT = (
    PROJECT_ROOT
    / "output"
)

VISUALIZATION_ROOT = (
    OUTPUT_ROOT
    / "tile_visualizations"
)


# ============================================================
# FIND CROPPED TILE
# ============================================================

def find_cropped_tile(
    product_id: str,
) -> Path:

    product_id = str(
        product_id
    ).strip()

    if not product_id:
        raise ValueError(
            "product_id is required."
        )

    crops_root = (
        OUTPUT_ROOT
        / "crops"
    )

    if not crops_root.exists():
        raise FileNotFoundError(
            f"Crops directory not found: "
            f"{crops_root}"
        )

    extensions = {
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".bmp",
    }

    for path in crops_root.rglob("*"):

        if not path.is_file():
            continue

        if path.suffix.lower() not in extensions:
            continue

        if (
            product_id.upper()
            in path.stem.upper()
        ):
            return path.resolve()

    raise FileNotFoundError(
        "Cropped tile image not found for "
        f"Product ID: {product_id}"
    )


# ============================================================
# OUTPUT PATH
# ============================================================

def build_output_path(
    product_id: str,
    surface: str,
) -> Path:

    safe_product_id = (
        str(product_id)
        .strip()
        .replace("/", "_")
        .replace("\\", "_")
        .replace(" ", "_")
    )

    safe_surface = (
        str(surface)
        .strip()
        .lower()
    )

    output_dir = (
        VISUALIZATION_ROOT
    )

    output_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    return (
        output_dir
        / (
            f"{safe_product_id}_"
            f"{safe_surface}.png"
        )
    )


# ============================================================
# GENERATE TILE VISUALIZATION
# ============================================================

def generate_tile_visualization(
    scene_image: Path,
    product_id: str,
    surface: str = "FLOOR",
    tile_image: Optional[Path] = None,
    tile_name: str = "Selected Tile",
    scene_id: Optional[str] = None,
) -> Dict[str, Any]:

    scene_image = resolve_scene_image(
        scene_image
    )

    # --------------------------------------------------------
    # Resolve tile
    # --------------------------------------------------------

    if tile_image is None:

        tile_image = find_cropped_tile(
            product_id
        )

    else:

        tile_image = Path(
            tile_image
        )

    if not tile_image.exists():
        raise FileNotFoundError(
            f"Tile image not found: "
            f"{tile_image}"
        )

    # --------------------------------------------------------
    # Output
    # --------------------------------------------------------

    output_path = build_output_path(
        product_id=product_id,
        surface=surface,
    )

    # --------------------------------------------------------
    # Gemini visualization
    # --------------------------------------------------------

    result = apply_tile_to_scene(
        scene_image=scene_image,
        tile_image=tile_image,
        surface=surface,
        output_path=output_path,
        tile_product_id=product_id,
        tile_name=tile_name,
    )

    # --------------------------------------------------------
    # Validate generated result
    # --------------------------------------------------------

    applied_image = Path(
        result["image_path"]
    )

    if not applied_image.exists():
        raise RuntimeError(
            "Applied tile image was not created:\n"
            f"{applied_image}"
        )

    if applied_image.stat().st_size == 0:
        raise RuntimeError(
            "Applied tile image is empty:\n"
            f"{applied_image}"
        )

    # --------------------------------------------------------
    # Register visualization
    # --------------------------------------------------------

    registry_record = (
        create_and_register_visualization(
            scene_id=scene_id,
            product_id=product_id,
            product_name=tile_name,
            surface=surface,
            source_scene_image=str(
                scene_image
            ),
            tile_image=str(
                tile_image
            ),
            applied_image=str(
                applied_image
            ),
            model=result.get(
                "model",
                "",
            ),
            status="GENERATED",
        )
    )

    # --------------------------------------------------------
    # Return combined result
    # --------------------------------------------------------

    result["scene_id"] = (
        scene_id
    )

    result["product_id"] = (
        product_id
    )

    result["tile_image"] = str(
        tile_image
    )

    result["registry_record"] = (
        registry_record
    )

    result["visualization_id"] = (
        registry_record[
            "visualization_id"
        ]
    )

    result["registry_status"] = (
        registry_record[
            "status"
        ]
    )

    return result