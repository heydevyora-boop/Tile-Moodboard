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

IMPORTANT:
- The requested Product ID is authoritative.
- Only the exact product image may be sent to Gemini.
- No synthetic placeholder is allowed.
- No different product may be substituted.
- The Drive URL stored in MASTER is the image URL synced from
  the catalog extraction / Postgres Tile.imageUrl flow.
"""

import hashlib
import re

import requests

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
    Find one exact PRODUCT record by Product ID.

    The Product ID is authoritative.
    No fuzzy matching or product-name matching is performed.
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

DRIVE_FILE_ID_PATTERN = re.compile(
    r'/d/([a-zA-Z0-9_-]{10,})|[?&]id=([a-zA-Z0-9_-]{10,})'
)

REMOTE_IMAGE_CACHE_DIR = (
    OUTPUT_ROOT
    / "remote_image_cache"
)


def _extract_drive_file_id(
    url: str,
) -> Optional[str]:
    """
    Extract a Google Drive file ID from a Drive URL.
    """

    match = DRIVE_FILE_ID_PATTERN.search(
        url
    )

    if not match:
        return None

    return (
        match.group(1)
        or match.group(2)
    )


def _download_via_drive_api(
    file_id: str,
    cache_key: str,
) -> Path:
    """
    Download the exact image from Google Drive using the
    authenticated Drive service.

    This is the preferred path because catalog images may not
    be publicly accessible.
    """

    from io import BytesIO

    from googleapiclient.http import (
        MediaIoBaseDownload,
    )

    from app.google_services import (
        get_drive_service,
    )

    drive_service = get_drive_service()

    metadata = (
        drive_service
        .files()
        .get(
            fileId=file_id,
            fields="mimeType,name",
        )
        .execute()
    )

    mime_type = (
        metadata.get(
            "mimeType",
            "",
        )
        or ""
    )

    extension = ".jpg"

    if "png" in mime_type:
        extension = ".png"

    elif "webp" in mime_type:
        extension = ".webp"

    request = (
        drive_service
        .files()
        .get_media(
            fileId=file_id
        )
    )

    buffer = BytesIO()

    downloader = MediaIoBaseDownload(
        buffer,
        request,
    )

    done = False

    while not done:
        _, done = downloader.next_chunk()

    REMOTE_IMAGE_CACHE_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    cached_path = (
        REMOTE_IMAGE_CACHE_DIR
        / f"{cache_key}{extension}"
    )

    cached_path.write_bytes(
        buffer.getvalue()
    )

    return cached_path.resolve()


def _download_remote_product_image(
    url: str,
) -> Path:
    """
    Download the exact product reference image from a
    Drive/HTTP URL and cache it locally.

    Gemini receives the resulting local image file.

    Resolution order:

        1. Authenticated Google Drive API
        2. Direct HTTP request

    No placeholder is generated.
    """

    REMOTE_IMAGE_CACHE_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    cache_key = hashlib.sha256(
        url.encode("utf-8")
    ).hexdigest()[:24]

    cached_existing = sorted(
        REMOTE_IMAGE_CACHE_DIR.glob(
            f"{cache_key}.*"
        )
    )

    if cached_existing:
        return cached_existing[0].resolve()

    file_id = _extract_drive_file_id(
        url
    )

    # --------------------------------------------------------
    # PRIMARY:
    # Authenticated Google Drive API
    # --------------------------------------------------------

    if file_id:

        try:

            return _download_via_drive_api(
                file_id,
                cache_key,
            )

        except Exception:
            # Continue to HTTP fallback.
            pass

    # --------------------------------------------------------
    # SECONDARY:
    # Direct HTTP download
    # --------------------------------------------------------

    fetch_url = url

    if file_id:

        fetch_url = (
            "https://drive.google.com/"
            f"uc?export=download&id={file_id}"
        )

    response = requests.get(
        fetch_url,
        timeout=30,
    )

    response.raise_for_status()

    content_type = (
        response
        .headers
        .get(
            "Content-Type",
            "",
        )
    )

    if "text/html" in content_type.lower():

        raise FileNotFoundError(
            "Drive URL did not return an image. "
            "Google returned an HTML preview/login page instead.\n"
            f"URL: {url}"
        )

    extension = ".jpg"

    if "png" in content_type.lower():
        extension = ".png"

    elif "webp" in content_type.lower():
        extension = ".webp"

    elif "jpeg" in content_type.lower():
        extension = ".jpg"

    cached_path = (
        REMOTE_IMAGE_CACHE_DIR
        / f"{cache_key}{extension}"
    )

    cached_path.write_bytes(
        response.content
    )

    return cached_path.resolve()


# ============================================================
# PRODUCT IMAGE RESOLUTION
# ============================================================

def resolve_product_image(
    product: Dict[str, Any],
) -> Path:
    """
    Resolve the exact product image.

    Priority:

        1. image_path
        2. Image Path
        3. crop_path
        4. Crop Path
        5. local_path
        6. Local Path
        7. Drive URL / Image URL
        8. output/crops search by exact Product ID

    IMPORTANT:

    There is NO synthetic placeholder fallback.

    If the exact product image cannot be found,
    visualization is stopped.
    """

    candidate_fields = [
        "image_path",
        "Image Path",
        "crop_path",
        "Crop Path",
        "local_path",
        "Local Path",
    ]

    # --------------------------------------------------------
    # 1. LOCAL IMAGE / CROP PATHS
    # --------------------------------------------------------

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
    # 2. DRIVE URL / IMAGE URL
    #
    # This is the important path for the current catalog
    # extraction flow.
    #
    # The image URL stored in MASTER corresponds to the
    # real catalog image that was synced from Tile.imageUrl.
    # --------------------------------------------------------

    url_candidate_fields = [
        "Drive URL",
        "Drive Url",
        "drive_url",
        "Image URL",
        "Image Url",
        "image_url",
    ]

    for field_name in url_candidate_fields:

        value = str(
            product.get(
                field_name,
                "",
            )
            or ""
        ).strip()

        if not value:
            continue

        if not re.match(
            r"^https?://",
            value,
            re.IGNORECASE,
        ):
            continue

        try:

            return _download_remote_product_image(
                value
            )

        except Exception as error:

            # Do not silently switch to another product.
            # Continue checking other image fields belonging
            # to THIS SAME product only.

            last_error = error

            continue

    # --------------------------------------------------------
    # 3. EXACT PRODUCT ID CROP SEARCH
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

            # Exact Product ID containment check.
            #
            # This does NOT select another product based on
            # product name or similarity.

            if (
                product_id.upper()
                in path.stem.upper()
            ):

                return path.resolve()

    # --------------------------------------------------------
    # 4. NOTHING FOUND
    # --------------------------------------------------------

    drive_url = (
        product.get("Drive URL")
        or product.get("Drive Url")
        or product.get("drive_url")
        or product.get("Image URL")
        or product.get("Image Url")
        or product.get("image_url")
        or ""
    )

    raise FileNotFoundError(
        "EXACT PRODUCT IMAGE COULD NOT BE RESOLVED.\n\n"
        f"Product ID: {product_id}\n"
        f"Drive/Image URL: {drive_url or '(missing)'}\n\n"
        "Visualization cancelled.\n"
        "The system will NOT use a placeholder, "
        "a different product, or a generated texture."
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
# POSTGRES FALLBACK IMAGE
# ============================================================

def _usable_fallback_image(
    fallback_image_path: Optional[Path],
) -> Optional[Path]:
    """
    Return the caller-supplied fallback image only when it is a real,
    readable file on disk.

    This is NOT a placeholder and NOT a different product: the Node
    route passes Tile.imageUrl for the very product that was requested
    (see ai_visualization.routes.ts), which is the same extracted
    catalog image the MASTER row would have pointed at via its Drive
    URL. It is only reached for products that have no MASTER row.

    Anything unusable resolves to None so the caller falls back to the
    original hard failure rather than proceeding with a broken image.
    """

    if not fallback_image_path:
        return None

    candidate = Path(
        fallback_image_path
    )

    if (
        not candidate.exists()
        or not candidate.is_file()
    ):
        return None

    return candidate.resolve()


# ============================================================
# GENERATE VISUALIZATION
# ============================================================

def generate_product_visualization(
    spreadsheet_id: str,
    product_id: str,
    scene_image: Path,
    surface: str = "FLOOR",
    sheet_name: str = "MASTER",
    fallback_image_path: Optional[Path] = None,
    angle: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Complete production bridge:

        MASTER
          ↓
        Exact Product ID
          ↓
        Exact product image
          ↓
        Gemini visualization
          ↓
        Moodboard-ready result

    IMPORTANT:

    fallback_image_path is never a substitute for a DIFFERENT
    product, and never a synthetic placeholder swatch. It is the
    requested product's own extracted catalog image, passed in by
    the caller (Tile.imageUrl).

    It is used only when MASTER cannot supply that product's image
    -- either the product has no MASTER row at all (UI-uploaded
    catalogs never write to the sheet) or its MASTER Drive image is
    unreachable.

    With no usable fallback, the request still fails rather than
    inventing an image.
    """

    # --------------------------------------------------------
    # RESOLVE SCENE
    # --------------------------------------------------------

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
    # NORMALIZE PRODUCT ID
    # --------------------------------------------------------

    requested_product_id = str(
        product_id
    ).strip()

    if not requested_product_id:

        raise ValueError(
            "product_id is required."
        )

    # --------------------------------------------------------
    # EXACT PRODUCT LOOKUP
    # --------------------------------------------------------

    # A tile can legitimately exist in Postgres with no MASTER row:
    # only the pen-drive extraction path writes to the MASTER sheet,
    # while UI-uploaded catalogs insert straight into Postgres via
    # catalogExtractor.service.ts. Failing closed there made every
    # UI-uploaded tile unrenderable. The Node route already sends this
    # product's own Tile.imageUrl for exactly that case, so use it
    # rather than cancelling. A different product is still never
    # substituted, and no synthetic swatch is ever generated.
    resolved_fallback = _usable_fallback_image(
        fallback_image_path
    )

    try:

        product = get_product_for_visualization(
            records,
            requested_product_id,
        )

    except KeyError as error:

        if resolved_fallback is None:

            raise KeyError(
                f"Product '{requested_product_id}' does not exist "
                "in MASTER.\n\n"
                "Visualization cancelled.\n"
                "The application will NOT use a different product, "
                "Postgres fallback image, or generated placeholder."
            ) from error

        product = None

    # --------------------------------------------------------
    # VERIFY MASTER PRODUCT ID
    # --------------------------------------------------------

    if product is None:

        # No MASTER row for this product. The image used below is this
        # same product's own extracted catalog image, supplied by the
        # caller, so there is nothing to cross-check against MASTER.
        tile_image = resolved_fallback

    else:

        master_product_id = str(
            product.get(
                "Product ID",
                "",
            )
        ).strip()

        if not master_product_id:

            master_product_id = str(
                product.get(
                    "Record ID",
                    "",
                )
            ).strip()

        if (
            master_product_id.upper()
            != requested_product_id.upper()
        ):

            raise ValueError(
                "PRODUCT ID MISMATCH.\n\n"
                f"Requested: {requested_product_id}\n"
                f"MASTER: {master_product_id or '(missing)'}\n\n"
                "Visualization cancelled."
            )

        # ----------------------------------------------------
        # RESOLVE EXACT PRODUCT IMAGE
        # ----------------------------------------------------

        try:

            tile_image = resolve_product_image(
                product
            )

        except FileNotFoundError as error:

            # The MASTER row exists but its Drive image is unreachable.
            # The caller's copy of this same product's catalog image is
            # still the correct image, so prefer it over cancelling.
            if resolved_fallback is None:

                raise FileNotFoundError(
                    f"MASTER product '{requested_product_id}' exists, "
                    "but its exact catalog image could not be resolved.\n\n"
                    "The system will NOT substitute another product, "
                    "Postgres fallback image, or synthetic placeholder.\n\n"
                    f"{error}"
                ) from error

            tile_image = resolved_fallback

    # --------------------------------------------------------
    # VERIFY IMAGE FILE
    # --------------------------------------------------------

    if (
        not tile_image.exists()
        or not tile_image.is_file()
    ):

        raise FileNotFoundError(
            "Resolved product image does not exist as a file.\n"
            f"Product ID: {requested_product_id}\n"
            f"Image: {tile_image}\n\n"
            "Visualization cancelled."
        )

    used_fallback_image = (
        resolved_fallback is not None
        and tile_image == resolved_fallback
    )

    # --------------------------------------------------------
    # PRODUCT NAME
    # --------------------------------------------------------

    product_name = (
        get_product_name(product)
        if product is not None
        else ""
    )

    if not product_name:

        product_name = requested_product_id

    # --------------------------------------------------------
    # GENERATE
    # --------------------------------------------------------

    result = generate_tile_visualization(
        scene_image=scene_image,
        product_id=requested_product_id,
        surface=surface,
        tile_image=tile_image,
        tile_name=product_name,
        angle=angle,
    )

    # --------------------------------------------------------
    # ATTACH METADATA
    # --------------------------------------------------------

    result["product_id"] = (
        requested_product_id
    )

    result["product_name"] = (
        product_name
    )

    result["product_image"] = str(
        tile_image
    )

    result["product_record"] = (
        product
    )

    result["master_source"] = (
        "GOOGLE_SHEETS_MASTER"
        if product is not None
        else "POSTGRES_TILE"
    )

    # Still the exact catalog image for the requested product -- only the
    # route it was resolved through differs.
    result["image_source"] = (
        "EXACT_CATALOG_PRODUCT_IMAGE_VIA_POSTGRES"
        if used_fallback_image
        else "EXACT_CATALOG_PRODUCT_IMAGE"
    )

    result["placeholder_used"] = (
        False
    )

    return result