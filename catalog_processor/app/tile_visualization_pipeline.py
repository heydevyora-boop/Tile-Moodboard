import re
import uuid
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
    angle: Optional[str] = None,
) -> Path:
    """
    Builds a unique output path per generation.

    Previously this was just f"{product_id}_{surface}.png" -- identical
    for every angle of the same tile/surface, so generating "Front" then
    "Left" for the same product silently overwrote the exact same file on
    disk. Since Node serves a visualization's image straight from this
    local path (not a copy), that meant a URL already handed back to the
    frontend for "Front" would start showing "Left"'s image the moment
    "Left" was generated -- on top of (now-fixed separately) the angle
    never even reaching the Gemini prompt. Including the angle here plus
    a short random suffix (so regenerating the SAME angle again doesn't
    also clobber the previous result) makes every generated image its own
    file.
    """

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

    safe_angle = re.sub(
        r"[^a-z0-9]+", "-", str(angle or "").strip().lower()
    ).strip("-")

    unique_suffix = uuid.uuid4().hex[:8]

    output_dir = (
        VISUALIZATION_ROOT
    )

    output_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    name_parts = [safe_product_id, safe_surface]
    if safe_angle:
        name_parts.append(safe_angle)
    name_parts.append(unique_suffix)

    return (
        output_dir
        / (
            "_".join(name_parts)
            + ".png"
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
    angle: Optional[str] = None,
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
        angle=angle,
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
        angle=angle,
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