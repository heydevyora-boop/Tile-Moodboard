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

import re

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
# SYNTHETIC PRODUCT FALLBACK
# ============================================================
#
# A product_id with no matching MASTER row is not always a real
# error: local/demo tiles carry a real productCode in Postgres, but
# it was never synced into the live MASTER sheet because no catalog
# upload ran for them (that's the only process that writes rows into
# MASTER). Rather than failing the whole visualization request in
# that case, generate a neutral placeholder swatch locally -- same
# idea as the random-bathroom-scene fallback -- so staff still get a
# usable preview instead of a hard error.

def _build_synthetic_product(
    product_id: str,
) -> Dict[str, Any]:
    """Placeholder MASTER-shaped record for a product_id with no real row."""

    display_name = (
        str(product_id)
        .strip()
        .replace("_", " ")
        .replace("-", " ")
        .title()
        or "Untitled Tile"
    )

    return {
        "Product ID": str(product_id).strip(),
        "Record ID": str(product_id).strip(),
        "Name": display_name,
        "synthetic": True,
    }


def _generate_synthetic_product_swatch(
    product_id: str,
) -> Path:
    """
    Draw a neutral tile-grid placeholder image for a product with no
    resolvable catalog image. Cached by product_id so repeat requests
    for the same tile reuse the same file instead of regenerating it.
    """

    try:
        from PIL import Image, ImageDraw
    except ImportError as error:
        raise FileNotFoundError(
            "Product image could not be resolved and Pillow is not "
            "installed to generate a placeholder swatch."
        ) from error

    safe_id = (
        re.sub(
            r"[^A-Za-z0-9_-]+",
            "_",
            str(product_id).strip(),
        )
        or "tile"
    )

    swatch_dir = (
        OUTPUT_ROOT
        / "tile_swatches"
    )

    swatch_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    output_path = (
        swatch_dir
        / f"{safe_id}.png"
    )

    if output_path.exists():
        return output_path.resolve()

    size = 600
    tile = 150
    grout = 6

    image = Image.new(
        "RGB",
        (size, size),
        "#d8d2c4",
    )
    draw = ImageDraw.Draw(image)

    for y in range(0, size, tile):
        for x in range(0, size, tile):
            draw.rectangle(
                [
                    x + grout,
                    y + grout,
                    x + tile - grout,
                    y + tile - grout,
                ],
                fill="#e6e0d2",
                outline="#b7ae9a",
                width=2,
            )

    output_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )
    image.save(output_path, format="PNG")
    return output_path.resolve()


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
    # Falls back to a synthetic placeholder (see above) when the
    # product_id has no MASTER row, or the row exists but has no
    # resolvable image -- either way, that's a data gap, not a
    # reason to fail the whole visualization request.

    master_source = "GOOGLE_SHEETS_MASTER"

    try:
        product = get_product_for_visualization(
            records,
            product_id,
        )

        tile_image = resolve_product_image(
            product
        )

        product_name = get_product_name(
            product
        )

    except (KeyError, FileNotFoundError):

        product = _build_synthetic_product(
            product_id
        )

        tile_image = _generate_synthetic_product_swatch(
            product_id
        )

        product_name = product["Name"]

        master_source = "SYNTHETIC_LOCAL_PLACEHOLDER"

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
        master_source
    )

    return result