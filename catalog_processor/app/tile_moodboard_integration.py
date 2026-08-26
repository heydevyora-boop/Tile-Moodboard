"""
tile_moodboard_integration.py

Connects tile visualization output to the existing moodboard
pipeline.

Pipeline:

Bathroom Scene
    +
Selected Tile Product
    ↓
Tile Visualization Pipeline
    ↓
Applied Tile Image
    ↓
Moodboard Entry
"""

from pathlib import Path
from typing import Any, Dict, Optional
import json

from app.tile_visualization_pipeline import (
    generate_tile_visualization,
)


# ============================================================
# PATHS
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

MOODBOARD_ROOT = (
    OUTPUT_ROOT
    / "tile_moodboards"
)


# ============================================================
# MAIN INTEGRATION
# ============================================================

def create_tile_moodboard(
    scene_image: Path,
    product_id: str,
    tile_name: str,
    surface: str = "FLOOR",
) -> Dict[str, Any]:
    """
    Generate an applied-tile image and create the corresponding
    moodboard metadata.

    The generated applied image becomes the primary visual
    reference for the moodboard.
    """

    scene_image = Path(
        scene_image
    )

    if not scene_image.exists():
        raise FileNotFoundError(
            f"Scene image not found: {scene_image}"
        )

    if not product_id:
        raise ValueError(
            "product_id is required."
        )

    if not tile_name:
        raise ValueError(
            "tile_name is required."
        )

    # --------------------------------------------------------
    # Generate applied tile visualization
    # --------------------------------------------------------

    visualization = generate_tile_visualization(
        scene_image=scene_image,
        product_id=product_id,
        surface=surface,
        tile_name=tile_name,
    )

    # --------------------------------------------------------
    # Output directory
    # --------------------------------------------------------

    MOODBOARD_ROOT.mkdir(
        parents=True,
        exist_ok=True,
    )

    # --------------------------------------------------------
    # Build moodboard object
    # --------------------------------------------------------

    moodboard = {
        "status": "COMPLETED",

        "moodboard_type": (
            "APPLIED_TILE_VISUALIZATION"
        ),

        "product_id": product_id,

        "tile_name": tile_name,

        "surface": surface,

        "source_scene": str(
            scene_image
        ),

        "tile_reference": (
            visualization.get(
                "tile_image",
                "",
            )
        ),

        "applied_image": (
            visualization.get(
                "image_path",
                "",
            )
        ),

        "visualization_metadata": (
            visualization.get(
                "metadata_path",
                "",
            )
        ),
    }

    # --------------------------------------------------------
    # Save moodboard JSON
    # --------------------------------------------------------

    moodboard_path = (
        MOODBOARD_ROOT
        / (
            f"{product_id}_"
            f"{surface.lower()}_"
            f"moodboard.json"
        )
    )

    moodboard_path.write_text(
        json.dumps(
            moodboard,
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    moodboard["moodboard_path"] = str(
        moodboard_path
    )

    return moodboard