"""
product_visualization_service.py

Production bridge:

MASTER PRODUCT
    ↓
Product lookup
    ↓
Exact product/cropped image resolution
    ↓
Tile visualization pipeline
    ↓
Moodboard-ready visualization result
"""

from pathlib import Path
from typing import Any, Dict, Optional

from app.google_master_loader import (
    load_master_records,
    find_product_by_id,
)

from app.tile_visualization_pipeline import (
    generate_tile_visualization,
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


# ============================================================
# MASTER LOADER
# ============================================================

def load_product_master(
    spreadsheet_id: str,
    sheet_name: str = "MASTER",
):
    """
    Load MASTER records from Google Sheets.
    """

    records = load_master_records(
        spreadsheet_id=spreadsheet_id,
        sheet_name=sheet_name,
    )

    return records


# ============================================================
# PRODUCT LOOKUP
# ============================================================

def get_product_for_visualization(
    records,
    product_id: str,
) -> Dict[str, Any]:
    """
    Find one PRODUCT record by Product ID.
    """

    product_id = str(
        product_id
    ).strip()

    if not product_id:
        raise ValueError(
            "product_id is required."
        )

    product = find_product_by_id(
        records,
        product_id,
    )

    if product is None:
        raise KeyError(
            f"Product not found in MASTER: "
            f"{product_id}"
        )

    return product


# ============================================================
# PRODUCT IMAGE RESOLUTION
# ============================================================

def resolve_product_image(
    product: Dict[str, Any],
) -> Path:
    """
    Resolve the exact local product image.

    Priority:
        1. image_path
        2. Image Path
        3. crop_path
        4. Crop Path
        5. local_path
        6. Local Path
        7. output/crops search by Product ID
    """

    candidate_fields = [
        "image_path",
        "Image Path",
        "crop_path",
        "Crop Path",
        "local_path",
        "Local Path",
    ]

    for field_name in candidate_fields:

        value = product.get(
            field_name,
            "",
        )

        if value is None:
            continue

        value = str(
            value
        ).strip()

        if not value:
            continue

        path = Path(
            value
        )

        if not path.is_absolute():

            path = (
                PROJECT_ROOT
                / path
            )

        if (
            path.exists()
            and path.is_file()
        ):
            return path.resolve()

    # --------------------------------------------------------
    # Fallback: output/crops
    # --------------------------------------------------------

    product_id = str(
        product.get(
            "Product ID",
            "",
        )
    ).strip()

    if not product_id:
        product_id = str(
            product.get(
                "Record ID",
                "",
            )
        ).strip()

    crops_root = (
        OUTPUT_ROOT
        / "crops"
    )

    if (
        product_id
        and crops_root.exists()
    ):

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

            if (
                path.suffix.lower()
                not in extensions
            ):
                continue

            if (
                product_id.upper()
                in path.stem.upper()
            ):
                return path.resolve()

    raise FileNotFoundError(
        "Product image could not be resolved.\n"
        f"Product ID: {product_id}\n"
        f"Searched fields: {candidate_fields}\n"
        f"Searched crop directory: {crops_root}"
    )


# ============================================================
# PRODUCT NAME
# ============================================================

def get_product_name(
    product: Dict[str, Any],
) -> str:
    """
    Resolve product display name.
    """

    name = str(
        product.get(
            "Name",
            "",
        )
    ).strip()

    if name:
        return name

    return str(
        product.get(
            "Product Name",
            "",
        )
    ).strip()


# ============================================================
# GENERATE VISUALIZATION
# ============================================================

def generate_product_visualization(
    spreadsheet_id: str,
    product_id: str,
    scene_image: Path,
    surface: str = "FLOOR",
    sheet_name: str = "MASTER",
) -> Dict[str, Any]:
    """
    Complete production bridge:

        MASTER
          ↓
        Product
          ↓
        Exact image
          ↓
        Tile visualization

    Gemini is called by the downstream visualization engine.
    """

    scene_image = resolve_scene_image(
        scene_image
    )

    # --------------------------------------------------------
    # LOAD MASTER
    # --------------------------------------------------------

    records = load_product_master(
        spreadsheet_id=spreadsheet_id,
        sheet_name=sheet_name,
    )

    if not records:
        raise RuntimeError(
            "MASTER returned no records."
        )

    # --------------------------------------------------------
    # PRODUCT
    # --------------------------------------------------------

    product = get_product_for_visualization(
        records,
        product_id,
    )

    # --------------------------------------------------------
    # IMAGE
    # --------------------------------------------------------

    tile_image = resolve_product_image(
        product
    )

    # --------------------------------------------------------
    # NAME
    # --------------------------------------------------------

    product_name = get_product_name(
        product
    )

    # --------------------------------------------------------
    # GENERATE
    # --------------------------------------------------------

    result = generate_tile_visualization(
        scene_image=scene_image,
        product_id=product_id,
        surface=surface,
        tile_image=tile_image,
        tile_name=product_name,
    )

    # --------------------------------------------------------
    # ATTACH MASTER METADATA
    # --------------------------------------------------------

    result["product_id"] = (
        product_id
    )

    result["product_name"] = (
        product_name
    )

    result["product_image"] = str(
        tile_image
    )

    result["product_record"] = product

    result["master_source"] = (
        "GOOGLE_SHEETS_MASTER"
    )

    return result