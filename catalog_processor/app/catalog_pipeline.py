from app.scene_angle_engine import save_scene_angles
from PIL import Image
import imagehash
from pathlib import Path
from app.scene_engine import create_scene

import csv
import json
import hashlib
import re
import shutil
import unicodedata
import os
import traceback
import inspect
import importlib
from datetime import datetime, timezone

import fitz
import cv2

from app.image_extractor import (
    extract_pdf_images
)

from app.image_classifier import (
    calculate_cv_score
)

# V9 page-level analysis is required for true unique-product grouping.
# Keep a safe fallback to the old single-image analysis.
try:
    from app.gemini_service import (
        analyze_product_image,
        analyze_product_page
    )
    HAS_PAGE_ANALYZER = True
except ImportError:
    from app.gemini_service import (
        analyze_product_image
    )
    analyze_product_page = None
    HAS_PAGE_ANALYZER = False

from app.image_validator import (
    validate_product_decision,
    validate_bbox
)

from app.image_processor import (
    crop_from_bbox
)

# Kept as a fallback for older projects. The new pipeline uploads
# directly into the Python-controlled Brand/Catalog/status folders.
try:
    from app.drive_sheets import append_product_row
except ImportError:
    append_product_row = None

# Google services are imported from the existing project helper.
# Your screenshot showed google_services.py at project root, so that
# location is preferred.
try:
    from google_services import (
        get_drive_service,
        get_sheets_service
    )
except ImportError:
    try:
        from app.google_services import (
            get_drive_service,
            get_sheets_service
        )
    except ImportError:
        get_drive_service = None
        get_sheets_service = None

try:
    from googleapiclient.http import (
        MediaFileUpload
    )
except ImportError:
    MediaFileUpload = None


# ============================================================
# GOOGLE SERVICE CACHE
# ============================================================
#
# IMPORTANT:
# _get_cached_drive_service() / _get_cached_sheets_service() may perform credential
# loading/authentication internally. Do NOT call them once per image.
#
# This pipeline keeps one Drive client and one Sheets client alive for
# the entire catalog-processing process.
#
# Result:
#   Google authentication -> once
#   Drive service         -> once
#   Sheets service        -> once
#   Hundreds of images    -> reuse the same clients
# ============================================================

_DRIVE_SERVICE_CACHE = None
_SHEETS_SERVICE_CACHE = None


def _get_cached_drive_service():
    global _DRIVE_SERVICE_CACHE

    if _DRIVE_SERVICE_CACHE is not None:
        return _DRIVE_SERVICE_CACHE

    if get_drive_service is None:
        raise RuntimeError(
            "google_services.py could not be imported. "
            "Google Drive service is unavailable."
        )

    print("Google Drive service: initializing once...")

    _DRIVE_SERVICE_CACHE = get_drive_service()

    if _DRIVE_SERVICE_CACHE is None:
        raise RuntimeError(
            "Google Drive service initialization returned None."
        )

    print("Google Drive service: READY")

    return _DRIVE_SERVICE_CACHE


def _get_cached_sheets_service():
    global _SHEETS_SERVICE_CACHE

    if _SHEETS_SERVICE_CACHE is not None:
        return _SHEETS_SERVICE_CACHE

    if get_sheets_service is None:
        raise RuntimeError(
            "google_services.py could not be imported. "
            "Google Sheets service is unavailable."
        )

    print("Google Sheets service: initializing once...")

    _SHEETS_SERVICE_CACHE = get_sheets_service()

    if _SHEETS_SERVICE_CACHE is None:
        raise RuntimeError(
            "Google Sheets service initialization returned None."
        )

    print("Google Sheets service: READY")

    return _SHEETS_SERVICE_CACHE


# ============================================================
# CONFIGURATION
# ============================================================

# IMPORTANT:
# There is NO image-size limit.
# There is NO aspect-ratio limit.
# OpenCV is INFORMATION ONLY and NEVER rejects an image.

PROJECT_ROOT = Path(__file__).resolve().parent.parent

OUTPUT_ROOT = PROJECT_ROOT / "output"

# Google Drive root folder:
# Put this in .env as:
# GOOGLE_DRIVE_ROOT_FOLDER_ID=your_root_folder_id
#
# The code also accepts DRIVE_ROOT_FOLDER_ID and ROOT_FOLDER_ID.
DRIVE_ROOT_FOLDER_ID = (
    os.getenv("GOOGLE_DRIVE_ROOT_FOLDER_ID")
    or os.getenv("DRIVE_ROOT_FOLDER_ID")
    or os.getenv("ROOT_FOLDER_ID")
)

# Google Sheet:
# GOOGLE_SPREADSHEET_ID=...
# GOOGLE_SHEET_NAME=Sheet1
SPREADSHEET_ID = (
    os.getenv("GOOGLE_SPREADSHEET_ID")
    or os.getenv("SPREADSHEET_ID")
)
SHEET_NAME = (
    os.getenv("GOOGLE_SHEET_NAME")
    or os.getenv("SHEET_NAME")
    or "Sheet1"
)

# If python-dotenv is installed, load .env values.
try:
    from dotenv import load_dotenv
    load_dotenv()

    DRIVE_ROOT_FOLDER_ID = (
        os.getenv("GOOGLE_DRIVE_ROOT_FOLDER_ID")
        or os.getenv("DRIVE_ROOT_FOLDER_ID")
        or os.getenv("ROOT_FOLDER_ID")
        or DRIVE_ROOT_FOLDER_ID
    )

    SPREADSHEET_ID = (
        os.getenv("GOOGLE_SPREADSHEET_ID")
        or os.getenv("SPREADSHEET_ID")
        or SPREADSHEET_ID
    )

    SHEET_NAME = (
        os.getenv("GOOGLE_SHEET_NAME")
        or os.getenv("SHEET_NAME")
        or SHEET_NAME
    )
except ImportError:
    pass


# Persistent folder-ID cache.
DRIVE_FOLDER_REGISTRY_FILE = (
    OUTPUT_ROOT / "drive_folder_registry.json"
)

# Local source-reference registry.
SOURCE_REFERENCE_REGISTRY_FILE = (
    OUTPUT_ROOT / "source_references.json"
)

# No duplicate product images should ever be uploaded to Drive.
# Product duplicates and visual duplicates are kept locally for audit,
# not uploaded into Rejected, because that would itself create duplicate
# product images in Drive.


# ============================================================
# STATUS VALUES
# ============================================================

STATUS_HARD_REJECTED = "HARD_REJECTED"
STATUS_GEMINI_PENDING = "GEMINI_PENDING"
STATUS_GEMINI_ANALYZING = "GEMINI_ANALYZING"
STATUS_GEMINI_APPROVED = "GEMINI_APPROVED"
STATUS_GEMINI_REJECTED = "GEMINI_REJECTED"
STATUS_REVIEW_REQUIRED = "REVIEW_REQUIRED"
STATUS_DRIVE_UPLOADED = "DRIVE_UPLOADED"
STATUS_SHEET_UPLOADED = "SHEET_UPLOADED"
STATUS_DUPLICATE_PRODUCT = "DUPLICATE_PRODUCT"
STATUS_DUPLICATE_TILE = "DUPLICATE_TILE"
STATUS_DUPLICATE_SOURCE = "DUPLICATE_SOURCE_IMAGE"
STATUS_FAILED = "FAILED"
STATUS_COMPLETE = "COMPLETE"


# ============================================================
# ALLOWED TILE TYPES
# ============================================================

ALLOWED_TILE_TYPES = {
    "TILE",
    "TILE_SAMPLE",
    "STONE_TILE",
    "MARBLE_TILE",
    "PORCELAIN_TILE",
    "CERAMIC_TILE",
    "SLAB",
}


# ============================================================
# PAGE TEXT
# ============================================================
# ============================================================
# PAGE TEXT
# ============================================================


def extract_page_texts(pdf_path):
    """
    Extract searchable text for every PDF page.

    The catalog processor uses this text as supporting context for
    Gemini product identification. It never determines whether an
    image is a product by itself.
    """
    pdf_path = Path(pdf_path)

    document = fitz.open(str(pdf_path))

    page_texts = {}

    try:
        for page_index in range(len(document)):
            page = document[page_index]
            page_texts[page_index + 1] = page.get_text(
                "text",
                sort=True
            )
    finally:
        document.close()

    return page_texts



# ============================================================
# VISUAL + PRODUCT-LEVEL DUPLICATE DETECTION
# ============================================================

# These registries live outside individual catalog folders.
# They survive future runs and compare tiles across ALL catalogs.
#
# IMPORTANT:
# - No image dimensions are used as a rejection rule.
# - No aspect ratio is used as a rejection rule.
# - OpenCV is never used for duplicate decisions.
# - Product identity is checked BEFORE cropping/uploading.
# - Visual fingerprints are checked AFTER the final crop.

# Keep the old registry for backward compatibility.
OLD_DUPLICATE_REGISTRY_FILE = (
    OUTPUT_ROOT /
    "tile_hash_registry.json"
)

# New registry contains several independent fingerprints.
DUPLICATE_REGISTRY_FILE = (
    OUTPUT_ROOT /
    "tile_fingerprint_registry_v2.json"
)

# One master product -> one primary image.
PRODUCT_REGISTRY_FILE = (
    OUTPUT_ROOT /
    "product_master_registry.json"
)

# Exact source-image registry. This catches the same extracted
# image appearing more than once in a catalog.
SOURCE_HASH_REGISTRY_FILE = (
    OUTPUT_ROOT /
    "source_image_registry.json"
)

# Conservative visual thresholds.
# We do NOT use a single pHash threshold because marble/stone
# textures can be naturally similar.
PHASH_THRESHOLD = 3
DHASH_THRESHOLD = 3
WHASH_THRESHOLD = 3


# Names that are too generic to safely identify one product.
# These do NOT cause rejection. They are simply not used as the
# sole product identity key.
GENERIC_PRODUCT_NAMES = {
    "tile",
    "tiles",
    "tile sample",
    "product",
    "product tile",
    "surface",
    "surface material",
    "surface sample",
    "marble",
    "porcelain",
    "ceramic",
    "stone",
    "stone tile",
    "marble tile",
    "porcelain tile",
    "ceramic tile",
    "collection",
    "collection tile",
    "collection sample",
    "archrock collection",
    "brillo collection",
    "brillo high gloss surface",
    "high gloss surface",
    "sample",
    "sample tile",
    "design",
    "unknown",
    "none",
}


def _load_json_file(file_path):
    """Safely load a JSON registry."""
    file_path = Path(file_path)

    if not file_path.exists():
        return {}

    try:
        with open(
            file_path,
            "r",
            encoding="utf-8"
        ) as file:
            data = json.load(file)

        return data if isinstance(data, dict) else {}

    except Exception as error:
        print(
            f"  Registry warning "
            f"({file_path.name}): {error}"
        )

    return {}


def _save_json_file(file_path, data):
    """Atomically save a JSON registry."""
    file_path = Path(file_path)

    file_path.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    temporary_file = file_path.with_suffix(".tmp")

    with open(
        temporary_file,
        "w",
        encoding="utf-8"
    ) as file:
        json.dump(
            data,
            file,
            indent=4,
            ensure_ascii=False
        )

    temporary_file.replace(file_path)


def normalize_product_text(value):
    """
    Normalize product/brand/code text for identity matching.

    This function is NOT used to classify images.
    """
    if value is None:
        return ""

    value = str(value).strip().lower()

    if not value:
        return ""

    value = unicodedata.normalize(
        "NFKD",
        value
    )

    value = "".join(
        character
        for character in value
        if not unicodedata.combining(character)
    )

    value = re.sub(
        r"[^a-z0-9]+",
        " ",
        value
    )

    value = re.sub(
        r"\s+",
        " ",
        value
    ).strip()

    return value


def is_specific_product_name(product_name):
    """
    Decide whether a product name is specific enough to identify
    one product.

    Example:
        'Statuario Scala' -> usable
        'ArchRock Collection' -> not usable
    """
    normalized = normalize_product_text(
        product_name
    )

    if not normalized:
        return False

    if normalized in GENERIC_PRODUCT_NAMES:
        return False

    generic_patterns = (
        " collection",
        " collection tile",
        " tile collection",
        " series",
        " range",
        " surface",
        " tile sample",
        " sample"
    )

    if any(
        normalized.endswith(pattern)
        for pattern in generic_patterns
    ):
        return False

    return len(normalized) >= 4


def build_identity_keys(
    brand,
    product_name,
    product_code,
    dimensions=None
):
    """
    Build identity keys in the required priority order.

    Priority:
        1. Product Code / SKU
        2. Brand + normalized Product Name
        3. Brand + normalized Product Name + Dimensions

    The matching function below is deliberately conservative when
    dimensions conflict, so similar product names are not blindly merged.
    """
    brand_value = normalize_product_text(brand)
    name_value = normalize_product_text(product_name)
    code_value = normalize_product_text(product_code)
    dimensions_value = normalize_product_text(dimensions)

    keys = []

    if code_value:
        keys.append(
            (
                "CODE",
                f"CODE|{brand_value}|{code_value}"
            )
        )

    if (
        brand_value
        and is_specific_product_name(product_name)
    ):
        keys.append(
            (
                "NAME",
                f"NAME|{brand_value}|{name_value}"
            )
        )

        if dimensions_value:
            keys.append(
                (
                    "NAME_DIMS",
                    (
                        f"NAME_DIMS|{brand_value}|"
                        f"{name_value}|{dimensions_value}"
                    )
                )
            )

    return keys


def build_product_identity_key(
    brand,
    product_name,
    product_code,
    dimensions=None
):
    """
    Backward-compatible helper.

    Returns the highest-priority stable identity key.
    """
    keys = build_identity_keys(
        brand,
        product_name,
        product_code,
        dimensions
    )

    if not keys:
        return None

    return keys[0][1]


def _normalized_dimensions(value):
    return normalize_product_text(value)


def _identity_metadata_dimensions(metadata):
    if not isinstance(metadata, dict):
        return ""

    return _normalized_dimensions(
        metadata.get("dimensions")
    )


def find_existing_product(
    brand,
    product_name,
    product_code,
    product_registry,
    dimensions=None
):
    """
    Product-level deduplication BEFORE cropping.

    Rules:
        1. Exact Product Code/SKU match -> duplicate product.
        2. Exact Brand + normalized Product Name match ->
           duplicate unless known dimensions conflict.
        3. Brand + Product Name + Dimensions match -> duplicate.
        4. Conflicting dimensions -> REVIEW_REQUIRED.
        5. No identity -> new/unknown product.

    No image crop is performed by this function.
    """
    keys = build_identity_keys(
        brand,
        product_name,
        product_code,
        dimensions
    )

    if not keys:
        return {
            "exists": False,
            "ambiguous": False,
            "identity_key": None,
            "matched_by": None,
            "metadata": None,
        }

    # --------------------------------------------------------
    # 1. Product code has absolute priority.
    # --------------------------------------------------------
    for key_type, key in keys:
        if key_type != "CODE":
            continue

        existing = product_registry.get(key)

        if existing:
            return {
                "exists": True,
                "ambiguous": False,
                "identity_key": key,
                "matched_by": "PRODUCT_CODE",
                "metadata": (
                    existing
                    if isinstance(existing, dict)
                    else {}
                ),
            }

    # --------------------------------------------------------
    # 2. Brand + exact normalized product name.
    # --------------------------------------------------------
    name_key = next(
        (
            key
            for key_type, key in keys
            if key_type == "NAME"
        ),
        None
    )

    name_existing = (
        product_registry.get(name_key)
        if name_key
        else None
    )

    if name_existing:
        existing_dimensions = (
            _identity_metadata_dimensions(
                name_existing
            )
        )

        current_dimensions = (
            _normalized_dimensions(dimensions)
        )

        # If both records have dimensions and they conflict,
        # do NOT merge them.
        if (
            existing_dimensions
            and current_dimensions
            and existing_dimensions != current_dimensions
        ):
            return {
                "exists": False,
                "ambiguous": True,
                "identity_key": None,
                "matched_by": "NAME_DIMENSION_CONFLICT",
                "metadata": (
                    name_existing
                    if isinstance(name_existing, dict)
                    else {}
                ),
            }

        return {
            "exists": True,
            "ambiguous": False,
            "identity_key": name_key,
            "matched_by": "BRAND_NAME",
            "metadata": (
                name_existing
                if isinstance(name_existing, dict)
                else {}
            ),
        }

    # --------------------------------------------------------
    # 3. Brand + Name + Dimensions.
    # --------------------------------------------------------
    name_dims_key = next(
        (
            key
            for key_type, key in keys
            if key_type == "NAME_DIMS"
        ),
        None
    )

    if name_dims_key:
        existing = product_registry.get(
            name_dims_key
        )

        if existing:
            return {
                "exists": True,
                "ambiguous": False,
                "identity_key": name_dims_key,
                "matched_by": "BRAND_NAME_DIMENSIONS",
                "metadata": (
                    existing
                    if isinstance(existing, dict)
                    else {}
                ),
            }

    return {
        "exists": False,
        "ambiguous": False,
        "identity_key": (
            keys[0][1]
            if keys
            else None
        ),
        "matched_by": None,
        "metadata": None,
    }



def register_product_master(
    identity_key,
    product_registry,
    metadata,
    identity_keys=None
):
    """
    Register one master product and its aliases.

    One product can have:
        CODE|brand|sku
        NAME|brand|product
        NAME_DIMS|brand|product|dimensions

    All aliases point to the SAME master metadata.
    """
    if not metadata:
        return

    aliases = []

    if identity_key:
        aliases.append(identity_key)

    if identity_keys:
        aliases.extend(
            key
            for key in identity_keys
            if key
        )

    # Remove duplicates while preserving order.
    aliases = list(
        dict.fromkeys(aliases)
    )

    for key in aliases:
        if not key:
            continue

        # Never overwrite an existing master.
        if key in product_registry:
            continue

        product_registry[key] = metadata

    save_product_registry(
        product_registry
    )


def add_product_source_reference(
    product_registry,
    identity_key,
    source_reference
):
    """
    Add a new catalog/page/image reference to an existing master product.

    This is the required:
        ONE MASTER PRODUCT
        +
        MULTIPLE SOURCE REFERENCES

    No image is cropped or uploaded here.
    """
    if not identity_key:
        return

    existing = product_registry.get(
        identity_key
    )

    if not isinstance(existing, dict):
        return

    sources = existing.setdefault(
        "sources",
        []
    )

    # Stable source uniqueness.
    source_key = (
        source_reference.get("processing_id")
        or
        (
            f"{source_reference.get('pdf_name')}|"
            f"{source_reference.get('page')}|"
            f"{source_reference.get('image_index')}"
        )
    )

    for item in sources:
        if (
            isinstance(item, dict)
            and item.get("processing_id")
            == source_key
        ):
            return

    source_copy = dict(
        source_reference
    )
    source_copy["processing_id"] = (
        source_key
    )

    sources.append(
        source_copy
    )

    save_product_registry(
        product_registry
    )


def load_duplicate_registry():
    """
    Load the new visual fingerprint registry.

    The old V6 pHash registry is also imported so tiles already
    accepted by earlier runs can still participate in duplicate
    detection.
    """
    registry = _load_json_file(
        DUPLICATE_REGISTRY_FILE
    )

    old_registry = _load_json_file(
        OLD_DUPLICATE_REGISTRY_FILE
    )

    if old_registry:
        for old_hash, metadata in old_registry.items():

            if old_hash in registry:
                continue

            registry[old_hash] = {
                "legacy_phash": old_hash,
                "phash": old_hash,
                "dhash": None,
                "whash": None,
                "sha256": None,
                "metadata": (
                    metadata
                    if isinstance(
                        metadata,
                        dict
                    )
                    else {}
                )
            }

    return registry


def save_duplicate_registry(
    hash_registry
):
    """Save the persistent visual fingerprint registry."""
    _save_json_file(
        DUPLICATE_REGISTRY_FILE,
        hash_registry
    )


def calculate_image_fingerprints(
    image_path
):
    """
    Generate multiple fingerprints for the FINAL CROPPED TILE.

    SHA256:
        exact byte-for-byte duplicate.

    pHash/dHash/wHash:
        visual duplicate after resize/compression/crop changes.

    Image dimensions and aspect ratio are NEVER used as rejection
    criteria.
    """
    try:

        image_path = Path(
            image_path
        )

        sha256 = hashlib.sha256(
            image_path.read_bytes()
        ).hexdigest()

        with Image.open(
            image_path
        ) as image:

            image = image.convert(
                "RGB"
            )

            return {
                "sha256": sha256,
                "phash": str(
                    imagehash.phash(
                        image
                    )
                ),
                "dhash": str(
                    imagehash.dhash(
                        image
                    )
                ),
                "whash": str(
                    imagehash.whash(
                        image
                    )
                )
            }

    except Exception as error:

        print(
            f"  Duplicate fingerprint error: "
            f"{error}"
        )

        return {
            "sha256": None,
            "phash": None,
            "dhash": None,
            "whash": None
        }


def calculate_image_hash(
    image_path
):
    """Backward-compatible pHash helper."""
    fingerprints = calculate_image_fingerprints(
        image_path
    )

    return fingerprints.get(
        "phash"
    )


def _hash_distance(
    first,
    second
):
    """Return perceptual hash distance or None."""
    if not first or not second:
        return None

    try:
        return (
            imagehash.hex_to_hash(first)
            -
            imagehash.hex_to_hash(second)
        )
    except Exception:
        return None


def is_duplicate_image(
    image_path,
    hash_registry,
    threshold=None
):
    """
    Compare the FINAL CROPPED TILE with registered tiles.

    Duplicate:
        - identical SHA256, OR
        - at least TWO independent perceptual hashes are close.

    Requiring two visual signals reduces false positives between
    different marble/stone products with similar patterns.
    """
    fingerprints = calculate_image_fingerprints(
        image_path
    )

    if not any(
        fingerprints.values()
    ):
        return {
            "duplicate": False,
            "fingerprints": fingerprints,
            "matched_key": None,
            "matched_hash": None,
            "distance": None,
            "matched_metadata": None,
            "match_reason": None
        }

    for registry_key, entry in (
        hash_registry.items()
    ):

        if not isinstance(
            entry,
            dict
        ):
            entry = {}

        metadata = entry.get(
            "metadata",
            entry
        )

        existing_sha256 = entry.get(
            "sha256"
        )

        existing_phash = entry.get(
            "phash"
        )

        existing_dhash = entry.get(
            "dhash"
        )

        existing_whash = entry.get(
            "whash"
        )

        # Old V6 registry used the dictionary key itself as pHash.
        if not existing_phash:
            existing_phash = (
                entry.get(
                    "legacy_phash"
                )
                or
                registry_key
            )

        # Exact duplicate.
        if (
            fingerprints.get("sha256")
            and
            existing_sha256
            and
            fingerprints["sha256"]
            == existing_sha256
        ):
            return {
                "duplicate": True,
                "fingerprints": fingerprints,
                "matched_key": registry_key,
                "matched_hash": existing_phash,
                "distance": 0,
                "matched_metadata": metadata,
                "match_reason": "SHA256_EXACT"
            }

        phash_distance = _hash_distance(
            fingerprints.get("phash"),
            existing_phash
        )

        # Backward compatibility:
        # the old registry contains only pHash. Use a stricter
        # pHash-only threshold for those legacy entries.
        if (
            existing_phash
            and not existing_dhash
            and not existing_whash
            and phash_distance is not None
            and phash_distance <= 2
        ):
            return {
                "duplicate": True,
                "fingerprints": fingerprints,
                "matched_key": registry_key,
                "matched_hash": existing_phash,
                "distance": phash_distance,
                "matched_metadata": metadata,
                "match_reason": "LEGACY_PHASH_MATCH"
            }

        dhash_distance = _hash_distance(
            fingerprints.get("dhash"),
            existing_dhash
        )

        whash_distance = _hash_distance(
            fingerprints.get("whash"),
            existing_whash
        )

        close_hashes = 0

        if (
            phash_distance is not None
            and
            phash_distance <= PHASH_THRESHOLD
        ):
            close_hashes += 1

        if (
            dhash_distance is not None
            and
            dhash_distance <= DHASH_THRESHOLD
        ):
            close_hashes += 1

        if (
            whash_distance is not None
            and
            whash_distance <= WHASH_THRESHOLD
        ):
            close_hashes += 1

        # IMPORTANT:
        # We need TWO independent visual signals.
        if close_hashes >= 2:

            usable_distances = [
                distance
                for distance in (
                    phash_distance,
                    dhash_distance,
                    whash_distance
                )
                if distance is not None
            ]

            return {
                "duplicate": True,
                "fingerprints": fingerprints,
                "matched_key": registry_key,
                "matched_hash": existing_phash,
                "distance": (
                    min(usable_distances)
                    if usable_distances
                    else None
                ),
                "matched_metadata": metadata,
                "match_reason":
                    "MULTI_HASH_VISUAL_MATCH"
            }

    return {
        "duplicate": False,
        "fingerprints": fingerprints,
        "matched_key": None,
        "matched_hash": None,
        "distance": None,
        "matched_metadata": None,
        "match_reason": None
    }


def register_unique_tile(
    fingerprints,
    hash_registry,
    metadata
):
    """
    Register a tile ONLY after Drive + Sheets succeed.
    """
    if not fingerprints:
        return

    phash = fingerprints.get(
        "phash"
    )

    if not phash:
        return

    hash_registry[
        phash
    ] = {
        "sha256":
            fingerprints.get(
                "sha256"
            ),
        "phash":
            phash,
        "dhash":
            fingerprints.get(
                "dhash"
            ),
        "whash":
            fingerprints.get(
                "whash"
            ),
        "metadata":
            metadata
    }

    save_duplicate_registry(
        hash_registry
    )


def load_product_registry():
    """Load the persistent one-product/one-primary-image registry."""
    data = _load_json_file(
        PRODUCT_REGISTRY_FILE
    )

    return (
        data
        if isinstance(
            data,
            dict
        )
        else {}
    )


def save_product_registry(
    product_registry
):
    """Save the persistent product master registry."""
    _save_json_file(
        PRODUCT_REGISTRY_FILE,
        product_registry
    )


def load_source_hash_registry():
    """Load exact source-image hashes."""
    data = _load_json_file(
        SOURCE_HASH_REGISTRY_FILE
    )

    return (
        data
        if isinstance(
            data,
            dict
        )
        else {}
    )


def save_source_hash_registry(
    source_registry
):
    """Save exact source-image hashes."""
    _save_json_file(
        SOURCE_HASH_REGISTRY_FILE,
        source_registry
    )


def calculate_source_sha256(
    image_path
):
    """Calculate exact SHA256 for an extracted source image."""
    try:
        return hashlib.sha256(
            Path(
                image_path
            ).read_bytes()
        ).hexdigest()
    except Exception as error:
        print(
            f"  Source hash error: {error}"
        )
        return None


def check_source_duplicate(
    image_path,
    source_registry
):
    """
    Detect an exact repeated extracted image BEFORE Gemini.

    This is only an optimization/safety layer. Product-level
    deduplication still happens after Gemini metadata is known.
    """
    source_hash = calculate_source_sha256(
        image_path
    )

    if not source_hash:
        return {
            "duplicate": False,
            "hash": None,
            "metadata": None
        }

    existing = source_registry.get(
        source_hash
    )

    if existing:
        return {
            "duplicate": True,
            "hash": source_hash,
            "metadata": (
                existing
                if isinstance(
                    existing,
                    dict
                )
                else {}
            )
        }

    return {
        "duplicate": False,
        "hash": source_hash,
        "metadata": None
    }


def register_source_image(
    source_hash,
    source_registry,
    metadata
):
    """Register an extracted source image after processing."""
    if not source_hash:
        return

    source_registry[
        source_hash
    ] = metadata

    save_source_hash_registry(
        source_registry
    )


# ============================================================
# CROP USING GEMINI BBOX
# ============================================================


# ============================================================
# GOOGLE DRIVE FOLDER MANAGEMENT
# ============================================================

def _resolve_drive_root_folder_id():
    """
    Resolve the Drive root folder ID.

    Priority:
        1. Environment/.env
        2. Existing drive_folders.py constants

    Gemini never controls this.
    """
    global DRIVE_ROOT_FOLDER_ID

    if DRIVE_ROOT_FOLDER_ID:
        return DRIVE_ROOT_FOLDER_ID

    for module_name in (
        "app.drive_folders",
        "drive_folders",
    ):
        try:
            module = importlib.import_module(
                module_name
            )

            for attribute in (
                "ROOT_FOLDER_ID",
                "DRIVE_ROOT_FOLDER_ID",
                "GOOGLE_DRIVE_ROOT_FOLDER_ID",
            ):
                value = getattr(
                    module,
                    attribute,
                    None
                )

                if value:
                    DRIVE_ROOT_FOLDER_ID = str(
                        value
                    )
                    return DRIVE_ROOT_FOLDER_ID

        except Exception:
            continue

    return None


def _escape_drive_query_value(value):
    return str(value).replace(
        "\\",
        "\\\\"
    ).replace(
        "'",
        "\\'"
    )


def _load_drive_folder_registry():
    data = _load_json_file(
        DRIVE_FOLDER_REGISTRY_FILE
    )

    return (
        data
        if isinstance(data, dict)
        else {}
    )


def _save_drive_folder_registry(
    registry
):
    _save_json_file(
        DRIVE_FOLDER_REGISTRY_FILE,
        registry
    )


def _find_or_create_drive_folder(
    drive_service,
    folder_name,
    parent_id
):
    """
    Find or create a folder directly inside ``parent_id``.

    IMPORTANT:
        The folder name is deliberately NOT placed in the Google Drive
        ``q`` query. This avoids HTTP 400 Invalid Value errors caused by
        special characters, quotes, backslashes, or other catalog/brand
        names. The API returns child folders and Python performs the exact
        name comparison safely.
    """

    if drive_service is None:
        raise RuntimeError(
            "Google Drive service is unavailable."
        )

    if not parent_id:
        raise ValueError(
            "Google Drive parent folder ID is required."
        )

    target_name = str(
        folder_name or ""
    ).strip()

    if not target_name:
        raise ValueError(
            "Google Drive folder name cannot be empty."
        )

    page_token = None

    while True:
        query = (
            "mimeType='application/vnd.google-apps.folder' "
            "and trashed=false "
            f"and '{parent_id}' in parents"
        )

        request = (
            drive_service.files()
            .list(
                q=query,
                spaces="drive",
                fields="nextPageToken,files(id,name,parents)",
                pageSize=100,
                pageToken=page_token
            )
        )

        response = request.execute()

        for folder in response.get("files", []):
            existing_name = str(
                folder.get("name", "")
            ).strip()

            if existing_name == target_name:
                return folder["id"]

        page_token = response.get(
            "nextPageToken"
        )

        if not page_token:
            break

    metadata = {
        "name": target_name,
        "mimeType": (
            "application/vnd.google-apps.folder"
        ),
        "parents": [parent_id],
    }

    folder = (
        drive_service.files()
        .create(
            body=metadata,
            fields="id,name,parents"
        )
        .execute()
    )

    folder_id = folder.get("id")

    if not folder_id:
        raise RuntimeError(
            f"Google Drive created folder '{target_name}' "
            "but returned no folder ID."
        )

    return folder_id


def ensure_drive_catalog_structure(
    brand_name,
    catalog_name
):
    """
    Create/reuse ONLY this Google Drive hierarchy:

        ROOT
          Brand
            Collection/Catalog
              image.webp
              image.webp
              ...

    IMPORTANT:
        No Approved, Review, Rejected or Source subfolders are
        created. Product images are uploaded directly into the
        collection/catalog folder.

    The old status-folder keys are returned as aliases to the
    catalog folder only for backward compatibility with older
    pipeline code. They are NOT real subfolders.
    """
    root_id = _resolve_drive_root_folder_id()

    if not root_id:
        raise RuntimeError(
            "Google Drive ROOT folder ID is not configured. "
            "Set GOOGLE_DRIVE_ROOT_FOLDER_ID in .env "
            "or define ROOT_FOLDER_ID in drive_folders.py."
        )

    if get_drive_service is None:
        raise RuntimeError(
            "google_services.py could not be imported. "
            "Google Drive service is unavailable."
        )

    drive_service = _get_cached_drive_service()
    registry = _load_drive_folder_registry()

    brand_key = normalize_product_text(brand_name)
    catalog_key = normalize_product_text(catalog_name)
    cache_key = f"{brand_key}|{catalog_key}"

    cached = registry.get(cache_key)

    # Reuse only if the cached brand/catalog folders still exist.
    brand_folder_id = None
    catalog_folder_id = None

    if isinstance(cached, dict):
        brand_folder_id = cached.get("brand_folder_id")
        catalog_folder_id = cached.get("catalog_folder_id")

    if not brand_folder_id:
        brand_folder_id = _find_or_create_drive_folder(
            drive_service,
            brand_name,
            root_id
        )

    if not catalog_folder_id:
        catalog_folder_id = _find_or_create_drive_folder(
            drive_service,
            catalog_name,
            brand_folder_id
        )

    # Compatibility aliases: all point to the collection folder.
    folder_data = {
        "brand_name": brand_name,
        "catalog_name": catalog_name,
        "root_folder_id": root_id,
        "brand_folder_id": brand_folder_id,
        "catalog_folder_id": catalog_folder_id,
        "approved_folder_id": catalog_folder_id,
        "review_folder_id": catalog_folder_id,
        "rejected_folder_id": catalog_folder_id,
        "source_folder_id": catalog_folder_id,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    registry[cache_key] = folder_data
    _save_drive_folder_registry(registry)

    return folder_data


def _remove_empty_legacy_drive_status_folders(
    brand_name,
    catalog_name
):
    """
    Remove old empty status folders created by previous versions.

    Only empty folders named Approved/Review/Rejected/Source are
    removed. Non-empty folders are NEVER deleted automatically.
    """
    if get_drive_service is None:
        return

    try:
        drive_service = _get_cached_drive_service()
        root_id = _resolve_drive_root_folder_id()
        if not root_id:
            return

        brand_id = _find_or_create_drive_folder(
            drive_service, brand_name, root_id
        )
        catalog_id = _find_or_create_drive_folder(
            drive_service, catalog_name, brand_id
        )

        legacy_names = {
            "Approved",
            "Review",
            "Rejected",
            "Source",
        }

        query = (
            "mimeType='application/vnd.google-apps.folder' "
            "and trashed=false "
            f"and '{catalog_id}' in parents"
        )

        response = (
            drive_service.files()
            .list(
                q=query,
                spaces="drive",
                fields="files(id,name)",
                pageSize=100
            )
            .execute()
        )

        for folder in response.get("files", []):
            if folder.get("name") not in legacy_names:
                continue

            folder_id = folder.get("id")
            if not folder_id:
                continue

            child_response = (
                drive_service.files()
                .list(
                    q=(
                        "trashed=false "
                        f"and '{folder_id}' in parents"
                    ),
                    spaces="drive",
                    fields="files(id)",
                    pageSize=1
                )
                .execute()
            )

            if not child_response.get("files"):
                drive_service.files().delete(
                    fileId=folder_id
                ).execute()
                print(
                    f"  Removed empty legacy Drive folder: {folder.get('name')}"
                )

    except Exception as error:
        print(
            f"  Legacy Drive folder cleanup warning: {error}"
        )


def _drive_upload_file(
    file_path,
    folder_id,
    drive_service=None,
    force_unique_name=False
):
    """
    Upload one file into an explicit Drive folder.

    The folder ID is supplied by Python. Product names are NEVER
    used as folder names here.
    """
    file_path = Path(
        file_path
    )

    if not file_path.exists():
        raise FileNotFoundError(
            f"Drive upload file not found: {file_path}"
        )

    if drive_service is None:
        if get_drive_service is None:
            raise RuntimeError(
                "Google Drive service unavailable."
            )
        drive_service = _get_cached_drive_service()

    if MediaFileUpload is None:
        raise RuntimeError(
            "googleapiclient is not installed. "
            "Install google-api-python-client."
        )

    file_name = file_path.name

    if force_unique_name:
        file_name = (
            f"{file_path.stem}_"
            f"{hashlib.sha1(str(file_path).encode()).hexdigest()[:8]}"
            f"{file_path.suffix}"
        )

    metadata = {
        "name": file_name,
        "parents": [folder_id],
    }

    media = MediaFileUpload(
        str(file_path),
        resumable=True
    )

    uploaded = (
        drive_service.files()
        .create(
            body=metadata,
            media_body=media,
            fields="id,name,webViewLink,parents"
        )
        .execute()
    )

    file_id = uploaded.get(
        "id"
    )

    url = (
        uploaded.get("webViewLink")
        or
        (
            f"https://drive.google.com/file/d/"
            f"{file_id}/view"
            if file_id
            else None
        )
    )

    return {
        "id": file_id,
        "name": uploaded.get(
            "name",
            file_name
        ),
        "url": url,
        "folder_id": folder_id,
    }


def _upload_catalog_source_manifest(
    source_references,
    source_folder_id,
    brand_name,
    catalog_name
):
    """
    Save source references locally only.

    No Source folder and no source manifest are created/uploaded to
    the catalog collection in Google Drive.
    """
    manifest_dir = OUTPUT_ROOT / "_source_manifests"
    manifest_dir.mkdir(parents=True, exist_ok=True)

    safe_brand = "".join(
        c if c.isalnum() else "_"
        for c in brand_name
    )
    safe_catalog = "".join(
        c if c.isalnum() else "_"
        for c in catalog_name
    )

    manifest_path = (
        manifest_dir /
        f"{safe_brand}__{safe_catalog}__source_references.json"
    )

    manifest = {
        "brand": brand_name,
        "catalog": catalog_name,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "references": source_references,
    }

    manifest_path.write_text(
        json.dumps(manifest, indent=4, ensure_ascii=False),
        encoding="utf-8"
    )

    print(
        f"  Source manifest saved locally: {manifest_path}"
    )

    return None


# ============================================================
# GOOGLE SHEETS
# ============================================================

SHEET_HEADERS = [
    "Processing ID",
    "Product ID",
    "Brand",
    "Tile Name",
    "Product Code",
    "Dimensions",
    "Catalog",
    "PDF Name",
    "Page",
    "Image Index",
    "Source Image",
    "Drive URL",
    "Gemini Status",
    "Confidence",
    "Final Status",
    "Reason",
    "Identity Key",
    "Image Type",
    "OpenCV Score",
    "Brand Folder ID",
    "Catalog Folder ID",
    "Approved Folder ID",
    "Review Folder ID",
    "Rejected Folder ID",
    "Source Folder ID",
    "Timestamp",
]


_SHEET_HEADERS_READY = False


def _append_sheet_record(
    record
):
    """
    Write every processed candidate to Google Sheets.

    If a direct spreadsheet ID is configured, the new full schema
    is used. For backward compatibility, the old append_product_row
    function is used when no spreadsheet ID is configured.
    """
    global _SHEET_HEADERS_READY

    if (
        SPREADSHEET_ID
        and get_sheets_service is not None
    ):
        sheets_service = _get_cached_sheets_service()

        range_name = (
            f"{SHEET_NAME}!A:Z"
        )

        if not _SHEET_HEADERS_READY:
            try:
                existing = (
                    sheets_service
                    .spreadsheets()
                    .values()
                    .get(
                        spreadsheetId=SPREADSHEET_ID,
                        range=f"{SHEET_NAME}!A:Z"
                    )
                    .execute()
                )

                values = existing.get(
                    "values",
                    []
                )

                if not values:
                    (
                        sheets_service
                        .spreadsheets()
                        .values()
                        .update(
                            spreadsheetId=SPREADSHEET_ID,
                            range=f"{SHEET_NAME}!A1:Z1",
                            valueInputOption="RAW",
                            body={
                                "values": [
                                    SHEET_HEADERS
                                ]
                            }
                        )
                        .execute()
                    )

                _SHEET_HEADERS_READY = True

            except Exception as error:
                print(
                    f"  Sheet header warning: {error}"
                )

        row = [
            record.get("processing_id"),
            record.get("product_id"),
            record.get("brand"),
            record.get("product_name"),
            record.get("product_code"),
            record.get("dimensions"),
            record.get("catalog_name"),
            record.get("pdf_name"),
            record.get("page"),
            record.get("image_index"),
            record.get("source_image"),
            record.get("drive_url"),
            record.get("gemini_status"),
            record.get("confidence"),
            record.get("status"),
            record.get("reason"),
            record.get("identity_key"),
            record.get("image_type"),
            record.get("cv_score"),
            record.get("brand_folder_id"),
            record.get("catalog_folder_id"),
            record.get("approved_folder_id"),
            record.get("review_folder_id"),
            record.get("rejected_folder_id"),
            record.get("source_folder_id"),
            datetime.now(
                timezone.utc
            ).isoformat(),
        ]

        (
            sheets_service
            .spreadsheets()
            .values()
            .append(
                spreadsheetId=SPREADSHEET_ID,
                range=range_name,
                valueInputOption="RAW",
                insertDataOption="INSERT_ROWS",
                body={
                    "values": [row]
                }
            )
            .execute()
        )

        return True

    # Backward compatibility with the existing drive_sheets.py.
    if append_product_row is not None:
        append_product_row(
            product_id=record.get(
                "product_id"
            ),
            pdf_name=record.get(
                "pdf_name"
            ),
            tile_name=record.get(
                "product_name"
            ),
            brand=record.get(
                "brand"
            ),
            page_number=record.get(
                "page"
            ),
            drive_url=record.get(
                "drive_url"
            ),
            confidence=record.get(
                "confidence",
                0
            ),
            status=record.get(
                "status"
            ),
        )

        return True

    raise RuntimeError(
        "Google Sheets is not configured. "
        "Set GOOGLE_SPREADSHEET_ID in .env "
        "or keep a working app.drive_sheets.append_product_row."
    )


# ============================================================
# COMMON RECORD HELPERS
# ============================================================

def _safe_id(value):
    value = str(
        value or ""
    ).strip()

    normalized = unicodedata.normalize(
        "NFKD",
        value
    )

    normalized = "".join(
        c
        for c in normalized
        if not unicodedata.combining(c)
    )

    safe = "".join(
        c if c.isalnum() else "_"
        for c in normalized
    )

    safe = re.sub(
        r"_+",
        "_",
        safe
    ).strip("_")

    return (
        safe.upper()
        or "UNKNOWN"
    )


def create_processing_id(
    brand_name,
    catalog_name,
    page_number,
    image_index
):
    """
    Permanent Python-owned processing ID.

    Gemini never creates or controls this value.
    """
    return (
        f"{_safe_id(brand_name)}_"
        f"{_safe_id(catalog_name)}_"
        f"P{int(page_number):04d}_"
        f"I{int(image_index):04d}"
    )


def _print_candidate_status(
    image_record,
    stage,
    message="",
    status=None
):
    """
    Compact terminal progress logger owned by the Python pipeline.

    Gemini never controls processing_id/image_index. The Python image
    record is the source of truth for all progress messages.
    """
    processing_id = image_record.get("processing_id", "UNKNOWN")
    page = image_record.get("page", "?")
    image_index = image_record.get("image_index", "?")

    line = (
        f"  [{processing_id}] "
        f"PAGE {page} / IMAGE {image_index} | {stage}"
    )

    if status:
        line += f" | STATUS={status}"

    if message:
        line += f" | {message}"

    print(line)


def _get_result_field(
    result,
    name,
    default=None
):
    if isinstance(
        result,
        dict
    ):
        return result.get(
            name,
            default
        )

    return getattr(
        result,
        name,
        default
    )


def _copy_for_local_status(
    image_path,
    directory,
    processing_id,
    suffix
):
    directory = Path(
        directory
    )

    directory.mkdir(
        parents=True,
        exist_ok=True
    )

    output_path = (
        directory /
        f"{processing_id}_{suffix}.jpg"
    )

    try:
        shutil.copy2(
            str(image_path),
            str(output_path)
        )
        return output_path
    except Exception as error:
        print(
            f"  Local status copy warning: {error}"
        )
        return None


def _move_to_local_duplicate(
    image_path,
    duplicate_dir,
    processing_id
):
    duplicate_dir = Path(
        duplicate_dir
    )

    duplicate_dir.mkdir(
        parents=True,
        exist_ok=True
    )

    destination = (
        duplicate_dir /
        f"{processing_id}_DUPLICATE.jpg"
    )

    try:
        shutil.move(
            str(image_path),
            str(destination)
        )
        return destination
    except Exception as error:
        print(
            f"  Duplicate move warning: {error}"
        )
        return None


def _load_json_list_file(
    file_path
):
    file_path = Path(
        file_path
    )

    if not file_path.exists():
        return []

    try:
        data = json.loads(
            file_path.read_text(
                encoding="utf-8"
            )
        )

        return (
            data
            if isinstance(
                data,
                list
            )
            else []
        )

    except Exception as error:
        print(
            f"  Source reference registry warning: {error}"
        )
        return []


def _append_source_reference(
    source_reference_registry,
    source_reference
):
    processing_id = (
        source_reference.get(
            "processing_id"
        )
    )

    if processing_id:
        for existing in source_reference_registry:
            if (
                isinstance(existing, dict)
                and existing.get(
                    "processing_id"
                )
                == processing_id
            ):
                return

    source_reference_registry.append(
        dict(source_reference)
    )

    # This registry is a JSON list, so do not use _save_json_file()
    # which intentionally accepts dictionaries only.
    path = Path(
        SOURCE_REFERENCE_REGISTRY_FILE
    )

    path.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    temporary = path.with_suffix(
        ".tmp"
    )

    temporary.write_text(
        json.dumps(
            source_reference_registry,
            indent=4,
            ensure_ascii=False
        ),
        encoding="utf-8"
    )

    temporary.replace(
        path
    )


def _product_id_from_identity(
    identity_key
):
    if not identity_key:
        return None

    return (
        "PROD-"
        +
        hashlib.sha1(
            identity_key.encode(
                "utf-8"
            )
        ).hexdigest()[:12].upper()
    )


def _merge_product_metadata(
    page_product,
    image_result
):
    """
    Page-level Gemini result supplies identity.
    Single-image Gemini result supplies visual classification/bbox.

    Python combines both. image_index/processing_id are never taken
    from Gemini.
    """
    page_product = (
        page_product
        if isinstance(
            page_product,
            dict
        )
        else {}
    )

    data = {
        "product_name":
            page_product.get(
                "product_name"
            )
            or
            _get_result_field(
                image_result,
                "product_name"
            ),

        "brand":
            page_product.get(
                "brand"
            )
            or
            _get_result_field(
                image_result,
                "brand"
            ),

        "product_code":
            page_product.get(
                "product_code"
            )
            or
            _get_result_field(
                image_result,
                "product_code"
            ),

        "dimensions":
            page_product.get(
                "dimensions"
            )
            or
            _get_result_field(
                image_result,
                "dimensions"
            ),

        "confidence":
            page_product.get(
                "confidence"
            )
            if page_product.get(
                "confidence"
            ) is not None
            else
            _get_result_field(
                image_result,
                "confidence",
                0
            ),

        "image_type":
            (
                str(
                    _get_result_field(
                        image_result,
                        "image_type",
                        page_product.get(
                            "image_type",
                            "UNKNOWN"
                        )
                    )
                    or "UNKNOWN"
                )
                .strip()
                .upper()
            ),

        "reason":
            (
                _get_result_field(
                    image_result,
                    "reason",
                    ""
                )
                or
                page_product.get(
                    "reason",
                    ""
                )
            ),

        "is_product_image":
            bool(
                _get_result_field(
                    image_result,
                    "is_product_image",
                    True
                )
            ),

        "decision":
            str(
                _get_result_field(
                    image_result,
                    "decision",
                    "REJECTED"
                )
                or "REJECTED"
            )
            .strip()
            .upper(),

        "product_count":
            _get_result_field(
                image_result,
                "product_count",
                1
            ),

        "product_bbox":
            _get_result_field(
                image_result,
                "product_bbox"
            ),

        "duplicate_image_indices":
            page_product.get(
                "duplicate_image_indices",
                []
            ) or [],
    }

    return data


def _is_approved_tile(
    analysis
):
    """
    Final Python-owned validation for tile product images.

    Gemini's decision field is not used as a hard rejection gate.
    A tile is accepted when Gemini identifies it as a product image,
    the image type is a configured tile type, and exactly one product
    is represented.
    """

    if not isinstance(analysis, dict):
        return False

    image_type = str(
        analysis.get("image_type", "")
        or ""
    ).strip().upper()

    is_product = bool(
        analysis.get("is_product_image", False)
    )

    product_count = analysis.get("product_count", 1)

    try:
        product_count = int(product_count)
    except (TypeError, ValueError):
        product_count = 0

    return (
        is_product
        and image_type in ALLOWED_TILE_TYPES
        and product_count == 1
    )


# ============================================================
# CROP
# ============================================================

def process_gemini_crop(
    image_path,
    bbox,
    selected_dir,
    processing_id
):
    image_path = Path(
        image_path
    )

    image = cv2.imread(
        str(image_path)
    )

    if image is None:
        return {
            "success": False,
            "reason":
                "Cannot read candidate image."
        }

    image_height, image_width = (
        image.shape[:2]
    )

    if not bbox:
        # A standalone image may itself already be the whole tile.
        bbox = {
            "x1": 0.0,
            "y1": 0.0,
            "x2": 1.0,
            "y2": 1.0
        }

    # Support dictionary.
    if isinstance(
        bbox,
        dict
    ):
        try:
            normalized_bbox = {
                "x1": float(
                    bbox.get(
                        "x1"
                    )
                ),
                "y1": float(
                    bbox.get(
                        "y1"
                    )
                ),
                "x2": float(
                    bbox.get(
                        "x2"
                    )
                ),
                "y2": float(
                    bbox.get(
                        "y2"
                    )
                ),
            }
        except (
            TypeError,
            ValueError
        ):
            return {
                "success": False,
                "reason":
                    "Invalid Gemini bounding box."
            }

    elif isinstance(
        bbox,
        (list, tuple)
    ) and len(bbox) == 4:
        try:
            values = [
                float(x)
                for x in bbox
            ]
        except (
            TypeError,
            ValueError
        ):
            return {
                "success": False,
                "reason":
                    "Invalid Gemini bounding box."
            }

        normalized_bbox = {
            "x1": values[0],
            "y1": values[1],
            "x2": values[2],
            "y2": values[3],
        }

    else:
        return {
            "success": False,
            "reason":
                "Unsupported Gemini bounding box format."
        }

    # Gemini returns normalized coordinates.
    if all(
        0.0 <= normalized_bbox[key] <= 1.0
        for key in (
            "x1",
            "y1",
            "x2",
            "y2"
        )
    ):
        pixel_bbox = {
            "x1":
                normalized_bbox["x1"]
                * image_width,

            "y1":
                normalized_bbox["y1"]
                * image_height,

            "x2":
                normalized_bbox["x2"]
                * image_width,

            "y2":
                normalized_bbox["y2"]
                * image_height,
        }
    else:
        pixel_bbox = normalized_bbox

    validation = validate_bbox(
        pixel_bbox,
        image_width,
        image_height
    )

    if not validation["valid"]:
        return {
            "success": False,
            "reason":
                validation["reason"]
        }

    valid_bbox = validation[
        "bbox"
    ]

    selected_dir = Path(
        selected_dir
    )

    selected_dir.mkdir(
        parents=True,
        exist_ok=True
    )

    output_path = (
        selected_dir /
        f"{processing_id}_product.jpg"
    )

    try:
        crop_from_bbox(
            image_path,
            valid_bbox,
            output_path
        )
    except Exception as error:
        return {
            "success": False,
            "reason":
                f"Crop failed: {error}"
        }

    if not output_path.exists():
        return {
            "success": False,
            "reason":
                "Crop function did not create output file."
        }

    return {
        "success": True,
        "output_path":
            str(output_path),
        "bbox":
            valid_bbox
    }


# ============================================================
# PRODUCT PROCESSING
# ============================================================

def _build_result_base(
    image_record,
    hierarchy,
    directories,
    folder_ids,
    cv_score=None
):
    return {
        "processing_id":
            image_record.get(
                "processing_id"
            ),

        "image":
            Path(
                image_record["path"]
            ).name,

        "source_image":
            str(
                image_record["path"]
            ),

        "page":
            image_record.get(
                "page"
            ),

        "image_index":
            image_record.get(
                "image_index"
            ),

        "brand":
            hierarchy.get(
                "brand_name"
            ),

        "catalog_name":
            hierarchy.get(
                "catalog_name"
            ),

        "pdf_name":
            hierarchy.get(
                "pdf_name"
            ),

        "cv_score":
            cv_score,

        "drive_url":
            None,

        "brand_folder_id":
            folder_ids.get(
                "brand_folder_id"
            ),

        "catalog_folder_id":
            folder_ids.get(
                "catalog_folder_id"
            ),

        "approved_folder_id":
            folder_ids.get(
                "approved_folder_id"
            ),

        "review_folder_id":
            folder_ids.get(
                "review_folder_id"
            ),

        "rejected_folder_id":
            folder_ids.get(
                "rejected_folder_id"
            ),

        "source_folder_id":
            folder_ids.get(
                "source_folder_id"
            ),

        "timestamp":
            datetime.now(
                timezone.utc
            ).isoformat(),
    }


def _save_and_sheet(
    record
):
    """
    Every candidate gets a sheet status record.
    A sheet failure changes the final status to FAILED but does
    not hide the local result.
    """
    try:
        _append_sheet_record(
            record
        )

        record["sheet_status"] = (
            STATUS_SHEET_UPLOADED
        )

    except Exception as error:
        record["sheet_status"] = (
            "SHEET_FAILED"
        )
        record["sheet_error"] = str(
            error
        )

        if record.get(
            "status"
        ) not in (
            STATUS_DUPLICATE_PRODUCT,
            STATUS_DUPLICATE_TILE,
            STATUS_DUPLICATE_SOURCE,
        ):
            record["status"] = (
                STATUS_FAILED
            )

        print(
            f"  Google Sheets ERROR: {error}"
        )

    return record


def process_primary_product(
    image_record,
    page_product,
    page_text,
    hierarchy,
    directories,
    folder_ids,
    hash_registry,
    product_registry,
    source_registry,
    source_reference_registry,
    drive_service
):
    """
    Process ONE UNIQUE PRIMARY PRODUCT.

    Order is intentionally:

    Gemini page grouping
        ->
    primary product identity
        ->
    existing product check
        ->
    NO CROP if duplicate
        ->
    crop only for NEW product
        ->
    SHA256 + pHash + dHash + wHash
        ->
    Drive upload
        ->
    Sheets
        ->
    register master
    """
    image_path = Path(
        image_record["path"]
    )

    processing_id = image_record[
        "processing_id"
    ]

    page_number = image_record[
        "page"
    ]

    _print_candidate_status(
        image_record,
        "START",
        "Unique primary candidate"
    )

    base_record = _build_result_base(
        image_record,
        hierarchy,
        directories,
        folder_ids
    )

    print()
    print(
        f"  UNIQUE PRIMARY: "
        f"{processing_id}"
    )

    # --------------------------------------------------------
    # OpenCV is information only.
    # --------------------------------------------------------
    _print_candidate_status(
        image_record,
        "OPENCV",
        "Calculating informational CV score..."
    )

    try:
        cv_result = calculate_cv_score(
            image_path
        )

        cv_score = cv_result.get(
            "score"
        )
    except Exception as error:
        print(
            f"  OpenCV error: {error}"
        )
        cv_score = None

    base_record["cv_score"] = (
        cv_score
    )

    # --------------------------------------------------------
    # SINGLE-IMAGE GEMINI:
    # Needed for final visual classification + bbox.
    # --------------------------------------------------------
    _print_candidate_status(
        image_record,
        "GEMINI",
        "ANALYZING primary image..."
    )

    try:
        image_result = (
            analyze_product_image(
                image_path,
                page_text
            )
        )
    except Exception as error:
        print(
            f"  Gemini ERROR: {error}"
        )

        _print_candidate_status(
            image_record,
            "GEMINI",
            f"ERROR: {error}",
            STATUS_FAILED
        )

        review_copy = (
            _copy_for_local_status(
                image_path,
                directories["review"],
                processing_id,
                "GEMINI_FAILED"
            )
        )

        record = {
            **base_record,
            "gemini_status":
                STATUS_FAILED,
            "confidence":
                0,
            "status":
                STATUS_REVIEW_REQUIRED,
            "reason":
                f"Gemini error: {error}",
            "review_copy":
                str(review_copy)
                if review_copy
                else None,
        }

        return _save_and_sheet(
            record
        )

    analysis = _merge_product_metadata(
        page_product,
        image_result
    )

    product_name = analysis.get(
        "product_name"
    )

    brand = (
        analysis.get("brand")
        or hierarchy.get(
            "brand_name"
        )
    )

    product_code = analysis.get(
        "product_code"
    )

    dimensions = analysis.get(
        "dimensions"
    )

    confidence = analysis.get(
        "confidence",
        0
    )

    image_type = analysis.get(
        "image_type",
        "UNKNOWN"
    )

    base_record.update({
        "product_name":
            product_name,
        "brand":
            brand,
        "product_code":
            product_code,
        "dimensions":
            dimensions,
        "confidence":
            confidence,
        "image_type":
            image_type,
        "gemini_status":
            STATUS_GEMINI_ANALYZING,
        "gemini_decision":
            analysis.get(
                "decision"
            ),
        "product_count":
            analysis.get(
                "product_count"
            ),
    })

    print(
        f"  Product: {product_name}"
    )
    print(
        f"  Brand: {brand}"
    )
    print(
        f"  Code: {product_code}"
    )
    print(
        f"  Dimensions: {dimensions}"
    )
    print(
        f"  Image type: {image_type}"
    )
    print(
        f"  Confidence: {confidence}"
    )

    # --------------------------------------------------------
    # HARD TILE SAFETY
    # --------------------------------------------------------
    if not _is_approved_tile(
        analysis
    ):
        reason = (
            analysis.get(
                "reason"
            )
            or
            "Gemini did not approve this image as one standalone tile."
        )

        _print_candidate_status(
            image_record,
            "REJECTED",
            reason,
            STATUS_GEMINI_REJECTED
        )

        rejected_copy = (
            _copy_for_local_status(
                image_path,
                directories["rejected"],
                processing_id,
                "REJECTED"
            )
        )

        record = {
            **base_record,
            "gemini_status":
                STATUS_GEMINI_REJECTED,
            "confidence":
                confidence,
            "status":
                STATUS_GEMINI_REJECTED,
            "reason":
                reason,
            "rejected_copy":
                str(rejected_copy)
                if rejected_copy
                else None,
        }

        return _save_and_sheet(
            record
        )

    # --------------------------------------------------------
    # PRODUCT IDENTITY CHECK — BEFORE CROP
    # --------------------------------------------------------
    _print_candidate_status(
        image_record,
        "PRODUCT IDENTITY",
        f"Checking existing master | code={product_code or 'NONE'} | name={product_name or 'UNKNOWN'}"
    )

    identity_match = (
        find_existing_product(
            brand,
            product_name,
            product_code,
            product_registry,
            dimensions
        )
    )

    identity_key = (
        identity_match.get(
            "identity_key"
        )
    )

    base_record["identity_key"] = (
        identity_key
    )

    if identity_match.get(
        "ambiguous"
    ):
        _print_candidate_status(
            image_record,
            "REVIEW REQUIRED",
            "Product identity/dimensions conflict - NO CROP / NO UPLOAD",
            STATUS_REVIEW_REQUIRED
        )

        existing_metadata = (
            identity_match.get(
                "metadata"
            )
            or {}
        )

        review_copy = (
            _copy_for_local_status(
                image_path,
                directories["review"],
                processing_id,
                "IDENTITY_CONFLICT"
            )
        )

        record = {
            **base_record,
            "product_id":
                existing_metadata.get(
                    "product_id"
                ),
            "drive_url":
                existing_metadata.get(
                    "drive_url"
                ),
            "status":
                STATUS_REVIEW_REQUIRED,
            "reason":
                (
                    "Brand + product name matched an existing "
                    "product but dimensions conflict. "
                    "The candidate was NOT cropped or uploaded."
                ),
            "review_copy":
                str(review_copy)
                if review_copy
                else None,
        }

        return _save_and_sheet(
            record
        )

    if identity_match.get(
        "exists"
    ):
        existing = (
            identity_match.get(
                "metadata"
            )
            or {}
        )

        existing_product_id = (
            existing.get(
                "product_id"
            )
        )

        existing_drive_url = (
            existing.get(
                "drive_url"
            )
        )

        _print_candidate_status(
            image_record,
            "DUPLICATE PRODUCT",
            f"Existing master={existing_product_id or 'UNKNOWN'} | matched_by={identity_match.get('matched_by')}",
            STATUS_DUPLICATE_PRODUCT
        )

        print(
            "  NO CROP"
        )
        print(
            "  NO NEW DRIVE IMAGE"
        )

        source_reference = {
            "processing_id":
                processing_id,
            "brand":
                brand,
            "catalog":
                hierarchy.get(
                    "catalog_name"
                ),
            "pdf_name":
                hierarchy.get(
                    "pdf_name"
                ),
            "page":
                page_number,
            "image_index":
                image_record.get(
                    "image_index"
                ),
            "source_image":
                str(image_path),
            "product_id":
                existing_product_id,
            "product_name":
                product_name,
            "product_code":
                product_code,
            "dimensions":
                dimensions,
            "primary_drive_url":
                existing_drive_url,
            "reference_status":
                STATUS_DUPLICATE_PRODUCT,
        }

        add_product_source_reference(
            product_registry,
            identity_key,
            source_reference
        )

        _append_source_reference(
            source_reference_registry,
            source_reference
        )

        record = {
            **base_record,
            "product_id":
                existing_product_id,
            "drive_url":
                existing_drive_url,
            "status":
                STATUS_DUPLICATE_PRODUCT,
            "reason":
                (
                    "Existing master product found before crop. "
                    "No new crop and no new Drive image created. "
                    "Only a source reference was added."
                ),
        }

        return _save_and_sheet(
            record
        )

    # --------------------------------------------------------
    # NEW PRODUCT:
    # ONLY NOW IS CROPPING ALLOWED.
    # --------------------------------------------------------
    _print_candidate_status(
        image_record,
        "NEW PRODUCT",
        "No existing master found - cropping is now allowed"
    )

    print(
        "  Product identity: NEW"
    )
    print(
        "  Cropping is now allowed."
    )

    bbox = analysis.get(
        "product_bbox"
    )

    _print_candidate_status(
        image_record,
        "CROPPING",
        "Creating primary product image..."
    )

    crop_result = process_gemini_crop(
        image_path,
        bbox,
        directories["approved"],
        processing_id
    )

    if not crop_result.get(
        "success"
    ):
        _print_candidate_status(
            image_record,
            "CROP FAILED",
            crop_result.get("reason", "Unknown crop error"),
            STATUS_REVIEW_REQUIRED
        )

        review_copy = (
            _copy_for_local_status(
                image_path,
                directories["review"],
                processing_id,
                "CROP_FAILED"
            )
        )

        record = {
            **base_record,
            "status":
                STATUS_REVIEW_REQUIRED,
            "reason":
                crop_result.get(
                    "reason"
                ),
            "review_copy":
                str(review_copy)
                if review_copy
                else None,
        }

        return _save_and_sheet(
            record
        )

    final_image = Path(
        crop_result["output_path"]
    )

    _print_candidate_status(
        image_record,
        "CROP COMPLETE",
        final_image.name
    )

    print(
        f"  Cropped: {final_image.name}"
    )

    # --------------------------------------------------------
    # SECONDARY HASH SAFETY LAYER
    # --------------------------------------------------------
    print(
        "  Multi-hash duplicate check..."
    )

    duplicate_result = (
        is_duplicate_image(
            final_image,
            hash_registry
        )
    )

    fingerprints = (
        duplicate_result.get(
            "fingerprints"
        )
        or {}
    )

    _print_candidate_status(
        image_record,
        "HASH CHECK",
        (
            f"SHA256={str(fingerprints.get('sha256') or '')[:12]}... | "
            f"pHash={fingerprints.get('phash')} | "
            f"dHash={fingerprints.get('dhash')} | "
            f"wHash={fingerprints.get('whash')}"
        )
    )

    if duplicate_result.get(
        "duplicate"
    ):
        duplicate_copy = (
            _move_to_local_duplicate(
                final_image,
                directories["duplicates"],
                processing_id
            )
        )

        matched_metadata = (
            duplicate_result.get(
                "matched_metadata"
            )
            or {}
        )

        _print_candidate_status(
            image_record,
            "VISUAL DUPLICATE",
            (
                f"{duplicate_result.get('match_reason')} | "
                "NO DRIVE UPLOAD"
            ),
            STATUS_DUPLICATE_TILE
        )

        print(
            "  VISUAL DUPLICATE: "
            "NO DRIVE UPLOAD"
        )

        source_reference = {
            "processing_id":
                processing_id,
            "brand":
                brand,
            "catalog":
                hierarchy.get(
                    "catalog_name"
                ),
            "pdf_name":
                hierarchy.get(
                    "pdf_name"
                ),
            "page":
                page_number,
            "image_index":
                image_record.get(
                    "image_index"
                ),
            "source_image":
                str(image_path),
            "product_id":
                matched_metadata.get(
                    "product_id"
                ),
            "product_name":
                product_name,
            "product_code":
                product_code,
            "duplicate_match_reason":
                duplicate_result.get(
                    "match_reason"
                ),
            "duplicate_distance":
                duplicate_result.get(
                    "distance"
                ),
            "reference_status":
                STATUS_DUPLICATE_TILE,
        }

        _append_source_reference(
            source_reference_registry,
            source_reference
        )

        register_source_image(
            image_record.get(
                "source_hash"
            ),
            source_registry,
            {
                **source_reference,
                "status":
                    STATUS_DUPLICATE_TILE,
            }
        )

        record = {
            **base_record,
            "product_id":
                matched_metadata.get(
                    "product_id"
                ),
            "drive_url":
                matched_metadata.get(
                    "drive_url"
                ),
            "duplicate_hash":
                fingerprints.get(
                    "phash"
                ),
            "duplicate_sha256":
                fingerprints.get(
                    "sha256"
                ),
            "duplicate_dhash":
                fingerprints.get(
                    "dhash"
                ),
            "duplicate_whash":
                fingerprints.get(
                    "whash"
                ),
            "matched_product":
                matched_metadata.get(
                    "product_name"
                ),
            "matched_product_id":
                matched_metadata.get(
                    "product_id"
                ),
            "matched_catalog":
                matched_metadata.get(
                    "pdf_name"
                ),
            "matched_page":
                matched_metadata.get(
                    "page"
                ),
            "duplicate_distance":
                duplicate_result.get(
                    "distance"
                ),
            "duplicate_match_reason":
                duplicate_result.get(
                    "match_reason"
                ),
            "status":
                STATUS_DUPLICATE_TILE,
            "reason":
                (
                    "A visually duplicate product image already "
                    "exists. Candidate was not uploaded to Drive."
                ),
            "duplicate_copy":
                str(duplicate_copy)
                if duplicate_copy
                else None,
        }

        return _save_and_sheet(
            record
        )

    # --------------------------------------------------------
    # CREATE MASTER PRODUCT ID
    # --------------------------------------------------------
    if not identity_key:
        # No reliable textual identity. A visual-only product can
        # still be a valid new master because the visual hash now
        # protects it from exact/near visual duplicates.
        fallback_identity = (
            "SOURCE|"
            f"{normalize_product_text(brand)}|"
            f"{normalize_product_text(product_name)}|"
            f"{hierarchy.get('catalog_name')}|"
            f"P{page_number}|"
            f"I{image_record.get('image_index')}"
        )

        identity_key = fallback_identity

    product_id = (
        _product_id_from_identity(
            identity_key
        )
    )

    # --------------------------------------------------------
    # DRIVE UPLOAD
    # --------------------------------------------------------
    _print_candidate_status(
        image_record,
        "APPROVED",
        "Unique product + unique image. Preparing Drive upload.",
        STATUS_GEMINI_APPROVED
    )

    print(
        "  Google Drive: UPLOADING APPROVED IMAGE..."
    )

    _print_candidate_status(
        image_record,
        "DRIVE",
        "UPLOADING..."
    )

    try:
        drive_result = (
            _drive_upload_file(
                final_image,
                folder_ids[
                    "approved_folder_id"
                ],
                drive_service=drive_service
            )
        )

    except Exception as error:
        print(
            f"  Drive ERROR: {error}"
        )

        _print_candidate_status(
            image_record,
            "DRIVE",
            f"UPLOAD FAILED: {error}",
            STATUS_FAILED
        )

        record = {
            **base_record,
            "product_id":
                product_id,
            "status":
                STATUS_FAILED,
            "reason":
                f"Drive upload failed: {error}",
            "final_image":
                str(final_image),
        }

        return _save_and_sheet(
            record
        )

    drive_url = (
        drive_result.get(
            "url"
        )
    )

    _print_candidate_status(
        image_record,
        "DRIVE",
        f"UPLOAD COMPLETE | {drive_result.get('name')}",
        STATUS_DRIVE_UPLOADED
    )

    print(
        f"  Drive URL: {drive_url}"
    )

    # --------------------------------------------------------
    # MASTER METADATA
    # --------------------------------------------------------
    identity_keys = build_identity_keys(
        brand,
        product_name,
        product_code,
        dimensions
    )

    source_reference = {
        "processing_id":
            processing_id,
        "brand":
            brand,
        "catalog":
            hierarchy.get(
                "catalog_name"
            ),
        "pdf_name":
            hierarchy.get(
                "pdf_name"
            ),
        "page":
            page_number,
        "image_index":
            image_record.get(
                "image_index"
            ),
        "source_image":
            str(image_path),
        "product_id":
            product_id,
        "product_name":
            product_name,
        "product_code":
            product_code,
        "dimensions":
            dimensions,
        "primary":
            True,
        "drive_url":
            drive_url,
    }

    master_metadata = {
        "product_id":
            product_id,
        "product_name":
            product_name,
        "brand":
            brand,
        "product_code":
            product_code,
        "dimensions":
            dimensions,
        "pdf_name":
            hierarchy.get(
                "pdf_name"
            ),
        "catalog_name":
            hierarchy.get(
                "catalog_name"
            ),
        "page":
            page_number,
        "image_index":
            image_record.get(
                "image_index"
            ),
        "processing_id":
            processing_id,
        "drive_url":
            drive_url,
        "final_image":
            str(final_image),
        "primary":
            True,
        "status":
            STATUS_DRIVE_UPLOADED,
        "sources": [
            source_reference
        ],
    }

    # --------------------------------------------------------
    # REGISTER MASTER BEFORE SHEETS
    #
    # This prevents a crash between Drive and Sheets from causing
    # another crop/upload on the next run.
    # --------------------------------------------------------
    register_product_master(
        identity_key,
        product_registry,
        master_metadata,
        identity_keys=(
            [key for _, key in identity_keys]
        )
    )

    register_unique_tile(
        fingerprints,
        hash_registry,
        {
            "product_id":
                product_id,
            "product_name":
                product_name,
            "brand":
                brand,
            "product_code":
                product_code,
            "dimensions":
                dimensions,
            "pdf_name":
                hierarchy.get(
                    "pdf_name"
                ),
            "catalog_name":
                hierarchy.get(
                    "catalog_name"
                ),
            "page":
                page_number,
            "image_index":
                image_record.get(
                    "image_index"
                ),
            "processing_id":
                processing_id,
            "drive_url":
                drive_url,
            "final_image":
                str(final_image),
        }
    )

    # --------------------------------------------------------
    # SHEETS
    # --------------------------------------------------------
    record = {
        **base_record,
        "product_id":
            product_id,
        "product_name":
            product_name,
        "brand":
            brand,
        "product_code":
            product_code,
        "dimensions":
            dimensions,
        "confidence":
            confidence,
        "image_type":
            image_type,
        "identity_key":
            identity_key,
        "drive_url":
            drive_url,
        "final_image":
            str(final_image),
        "duplicate_hash":
            fingerprints.get(
                "phash"
            ),
        "duplicate_sha256":
            fingerprints.get(
                "sha256"
            ),
        "duplicate_dhash":
            fingerprints.get(
                "dhash"
            ),
        "duplicate_whash":
            fingerprints.get(
                "whash"
            ),
        "gemini_status":
            STATUS_GEMINI_APPROVED,
        "status":
            STATUS_DRIVE_UPLOADED,
        "reason":
            (
                "New unique standalone tile product. "
                "Primary image created and uploaded."
            ),
    }

    try:
        _append_sheet_record(
            record
        )

        record["status"] = (
            STATUS_COMPLETE
        )
        record["sheet_status"] = (
            STATUS_SHEET_UPLOADED
        )

        _print_candidate_status(
            image_record,
            "GOOGLE SHEETS",
            "Record uploaded successfully",
            STATUS_SHEET_UPLOADED
        )

        # Update registry state after successful Sheets write.
        master = product_registry.get(
            identity_key
        )

        if isinstance(
            master,
            dict
        ):
            master["status"] = (
                STATUS_COMPLETE
            )
            master["sheet_status"] = (
                STATUS_SHEET_UPLOADED
            )

            save_product_registry(
                product_registry
            )

        register_source_image(
            image_record.get(
                "source_hash"
            ),
            source_registry,
            {
                **source_reference,
                "status":
                    STATUS_COMPLETE,
            }
        )

        _append_source_reference(
            source_reference_registry,
            source_reference
        )

    except Exception as error:
        print(
            f"  Sheets ERROR: {error}"
        )

        record["status"] = (
            STATUS_DRIVE_UPLOADED
        )
        record["reason"] = (
            f"Drive uploaded successfully, "
            f"but Sheets write failed: {error}"
        )

    _print_candidate_status(
        image_record,
        "COMPLETE",
        f"Product={product_name or 'UNKNOWN'}",
        record.get("status")
    )

    print(
        f"  FINAL STATUS: {record['status']}"
    )

    return record


# ============================================================
# PAGE-LEVEL GEMINI UNIQUE PRODUCT PROCESSING
# ============================================================

def _normalise_page_analysis(
    page_analysis
):
    if not isinstance(
        page_analysis,
        dict
    ):
        return {
            "products": [],
            "rejected_image_indices": [],
            "review_image_indices": [],
        }

    products = (
        page_analysis.get(
            "products",
            []
        )
        or []
    )

    rejected = (
        page_analysis.get(
            "rejected_image_indices",
            []
        )
        or []
    )

    review = (
        page_analysis.get(
            "review_image_indices",
            []
        )
        or []
    )

    def _ints(values):
        result = []

        for value in values:
            try:
                result.append(
                    int(value)
                )
            except (
                TypeError,
                ValueError
            ):
                continue

        return result

    return {
        "products":
            [
                item
                for item in products
                if isinstance(
                    item,
                    dict
                )
            ],
        "rejected_image_indices":
            _ints(rejected),
        "review_image_indices":
            _ints(review),
    }


def _page_product_for_index(
    products,
    image_index
):
    for product in products:
        try:
            primary_index = int(
                product.get(
                    "primary_image_index"
                )
            )
        except (
            TypeError,
            ValueError
        ):
            continue

        if primary_index == int(
            image_index
        ):
            return product

    return None


def _product_for_duplicate_index(
    products,
    image_index
):
    for product in products:
        duplicates = (
            product.get(
                "duplicate_image_indices",
                []
            )
            or []
        )

        try:
            duplicate_set = {
                int(x)
                for x in duplicates
            }
        except (
            TypeError,
            ValueError
        ):
            duplicate_set = set()

        if int(image_index) in duplicate_set:
            return product

    return None


def _save_page_rejected_image(
    image_record,
    hierarchy,
    directories,
    folder_ids,
    drive_service,
    reason,
    status=STATUS_GEMINI_REJECTED
):
    """
    Record a rejected candidate locally only.

    Rejected candidates are NEVER uploaded to the collection folder.
    """
    image_path = Path(image_record["path"])
    processing_id = image_record["processing_id"]

    _print_candidate_status(
        image_record,
        "REJECTED",
        reason,
        status
    )

    copy_path = _copy_for_local_status(
        image_path,
        directories["rejected"],
        processing_id,
        status
    )

    record = _build_result_base(
        image_record, hierarchy, directories, folder_ids
    )

    record.update({
        "gemini_status": STATUS_GEMINI_REJECTED,
        "status": status,
        "reason": reason,
        "rejected_copy": str(copy_path) if copy_path else None,
        "rejected_drive_url": None,
    })

    return _save_and_sheet(record)


def _save_page_review_image(
    image_record,
    hierarchy,
    directories,
    folder_ids,
    drive_service,
    reason
):
    """
    Record a review candidate locally only.

    Review candidates are NEVER uploaded to the collection folder.
    """
    image_path = Path(image_record["path"])
    processing_id = image_record["processing_id"]

    _print_candidate_status(
        image_record,
        "REVIEW REQUIRED",
        reason,
        STATUS_REVIEW_REQUIRED
    )

    copy_path = _copy_for_local_status(
        image_path,
        directories["review"],
        processing_id,
        "REVIEW"
    )

    record = _build_result_base(
        image_record, hierarchy, directories, folder_ids
    )

    record.update({
        "gemini_status": STATUS_GEMINI_ANALYZING,
        "status": STATUS_REVIEW_REQUIRED,
        "reason": reason,
        "review_copy": str(copy_path) if copy_path else None,
        "review_drive_url": None,
    })

    return _save_and_sheet(record)


def _save_page_duplicate_reference(
    image_record,
    page_product,
    hierarchy,
    directories,
    folder_ids,
    product_registry,
    source_registry,
    source_reference_registry
):
    """
    Duplicate representations identified by Gemini are NEVER cropped.

    They are also NOT uploaded to Drive.
    Only the source reference is recorded.
    """
    image_index = image_record[
        "image_index"
    ]

    product_name = (
        page_product.get(
            "product_name"
        )
    )

    brand = (
        page_product.get(
            "brand"
        )
        or
        hierarchy.get(
            "brand_name"
        )
    )

    product_code = (
        page_product.get(
            "product_code"
        )
    )

    dimensions = (
        page_product.get(
            "dimensions"
        )
    )

    match = find_existing_product(
        brand,
        product_name,
        product_code,
        product_registry,
        dimensions
    )

    existing = (
        match.get(
            "metadata"
        )
        or {}
    )

    identity_key = (
        match.get(
            "identity_key"
        )
    )

    source_reference = {
        "processing_id":
            image_record.get(
                "processing_id"
            ),
        "brand":
            brand,
        "catalog":
            hierarchy.get(
                "catalog_name"
            ),
        "pdf_name":
            hierarchy.get(
                "pdf_name"
            ),
        "page":
            image_record.get(
                "page"
            ),
        "image_index":
            image_index,
        "source_image":
            str(
                image_record["path"]
            ),
        "product_id":
            existing.get(
                "product_id"
            ),
        "product_name":
            product_name,
        "product_code":
            product_code,
        "dimensions":
            dimensions,
        "reference_status":
            STATUS_DUPLICATE_PRODUCT,
    }

    # If the master was found, add the source to it.
    if identity_key and match.get(
        "exists"
    ):
        add_product_source_reference(
            product_registry,
            identity_key,
            source_reference
        )

    _append_source_reference(
        source_reference_registry,
        source_reference
    )

    source_hash = image_record.get(
        "source_hash"
    )

    if source_hash:
        register_source_image(
            source_hash,
            source_registry,
            {
                **source_reference,
                "status":
                    STATUS_DUPLICATE_PRODUCT,
            }
        )

    record = _build_result_base(
        image_record,
        hierarchy,
        directories,
        folder_ids
    )

    record.update({
        "product_id":
            existing.get(
                "product_id"
            ),
        "product_name":
            product_name,
        "brand":
            brand,
        "product_code":
            product_code,
        "dimensions":
            dimensions,
        "drive_url":
            existing.get(
                "drive_url"
            ),
        "identity_key":
            identity_key,
        "gemini_status":
            STATUS_GEMINI_APPROVED,
        "status":
            STATUS_DUPLICATE_PRODUCT,
        "reason":
            (
                "Gemini identified this image as another "
                "representation of an existing product. "
                "No crop and no Drive image created."
            ),
    })

    return _save_and_sheet(
        record
    )


def process_page_group(
    page_number,
    page_images,
    page_text,
    hierarchy,
    directories,
    folder_ids,
    hash_registry,
    product_registry,
    source_registry,
    source_reference_registry,
    drive_service
):
    """
    Analyze a page as a group so Gemini can explicitly identify
    unique products and duplicate/secondary representations.
    """
    print()
    print(
        "=" * 60
    )
    print(
        f"PAGE {page_number}: "
        f"{len(page_images)} candidate images"
    )
    print(
        "=" * 60
    )

    # --------------------------------------------------------
    # PAGE-LEVEL GEMINI
    # --------------------------------------------------------
    page_analysis = None

    if HAS_PAGE_ANALYZER and analyze_product_page:
        try:
            print(
                "  Gemini page analysis: ANALYZING UNIQUE PRODUCTS..."
            )
            print(
                f"  PAGE {page_number}: "
                f"sending {len(page_images)} candidate images to Gemini"
            )

            page_analysis = (
                analyze_product_page(
                    page_images,
                    page_text
                )
            )

        except Exception as error:
            print(
                f"  Page-level Gemini failed: {error}"
            )
            page_analysis = None

    # --------------------------------------------------------
    # FALLBACK:
    # Analyze each image independently.
    # Product master + hashes still prevent Drive duplicates.
    # --------------------------------------------------------
    if page_analysis is None:
        results = []

        for image_record in page_images:
            try:
                result = process_primary_product(
                    image_record,
                    {},
                    page_text,
                    hierarchy,
                    directories,
                    folder_ids,
                    hash_registry,
                    product_registry,
                    source_registry,
                    source_reference_registry,
                    drive_service
                )

                results.append(
                    result
                )

            except Exception as error:
                print(
                    f"  Candidate ERROR: {error}"
                )

                results.append({
                    **_build_result_base(
                        image_record,
                        hierarchy,
                        directories,
                        folder_ids
                    ),
                    "status":
                        STATUS_FAILED,
                    "reason":
                        str(error),
                })

        return results

    page_data = _normalise_page_analysis(
        page_analysis
    )

    products = page_data[
        "products"
    ]

    print(
        f"  Gemini unique products: {len(products)}"
    )

    for product_number, product in enumerate(products, start=1):
        print(
            f"    Product {product_number}: "
            f"{product.get('product_name') or 'UNKNOWN'} | "
            f"code={product.get('product_code') or 'NONE'} | "
            f"primary_image_index={product.get('primary_image_index')} | "
            f"duplicates={product.get('duplicate_image_indices') or []} | "
            f"confidence={product.get('confidence', 0)}"
        )

    rejected_indices = set(
        page_data[
            "rejected_image_indices"
        ]
    )

    review_indices = set(
        page_data[
            "review_image_indices"
        ]
    )

    # Python-owned image index -> record.
    record_by_index = {
        int(
            record["image_index"]
        ):
            record
        for record in page_images
    }

    # --------------------------------------------------------
    # Gemini should return ONE primary per unique product.
    # --------------------------------------------------------
    primary_indices = set()
    duplicate_indices = set()

    for product in products:
        try:
            primary_index = int(
                product.get(
                    "primary_image_index"
                )
            )
        except (
            TypeError,
            ValueError
        ):
            continue

        if primary_index not in record_by_index:
            review_indices.add(
                primary_index
            )
            continue

        if primary_index in primary_indices:
            # Two Gemini products cannot own the same primary image.
            review_indices.add(
                primary_index
            )
            continue

        primary_indices.add(
            primary_index
        )

        duplicates = (
            product.get(
                "duplicate_image_indices",
                []
            )
            or []
        )

        for duplicate_index in duplicates:
            try:
                duplicate_index = int(
                    duplicate_index
                )
            except (
                TypeError,
                ValueError
            ):
                continue

            if (
                duplicate_index in record_by_index
                and duplicate_index != primary_index
            ):
                duplicate_indices.add(
                    duplicate_index
                )

    # Resolve conflicting Gemini assignments conservatively.
    # Explicit rejection wins, then review, then duplicate, then primary.
    review_indices -= rejected_indices
    duplicate_indices -= (
        rejected_indices
        |
        review_indices
    )

    # Duplicate images must never also be treated as new primaries.
    primary_indices -= (
        duplicate_indices
        |
        rejected_indices
        |
        review_indices
    )

    # --------------------------------------------------------
    # Process Gemini rejected images.
    # --------------------------------------------------------
    results = []

    for image_index in sorted(
        rejected_indices
    ):
        record = record_by_index.get(
            image_index
        )

        if not record:
            continue

        results.append(
            _save_page_rejected_image(
                record,
                hierarchy,
                directories,
                folder_ids,
                drive_service,
                "Gemini page analysis rejected this image."
            )
        )

    # --------------------------------------------------------
    # Process Gemini review images.
    # --------------------------------------------------------
    for image_index in sorted(
        review_indices
    ):
        if image_index in primary_indices:
            continue

        if image_index in duplicate_indices:
            continue

        record = record_by_index.get(
            image_index
        )

        if not record:
            continue

        results.append(
            _save_page_review_image(
                record,
                hierarchy,
                directories,
                folder_ids,
                drive_service,
                "Gemini could not confidently assign this image "
                "to a unique standalone product."
            )
        )

    # --------------------------------------------------------
    # Process UNIQUE primary images FIRST.
    #
    # This guarantees that when a page contains:
    #   image 2 = primary
    #   image 3 = duplicate of image 2
    #
    # the master product is already available when image 3 is
    # recorded as a source reference.
    # --------------------------------------------------------
    primary_result_by_index = {}

    for product in products:
        try:
            primary_index = int(
                product.get(
                    "primary_image_index"
                )
            )
        except (
            TypeError,
            ValueError
        ):
            continue

        if primary_index not in primary_indices:
            continue

        record = record_by_index.get(
            primary_index
        )

        if not record:
            continue

        try:
            primary_result = process_primary_product(
                record,
                product,
                page_text,
                hierarchy,
                directories,
                folder_ids,
                hash_registry,
                product_registry,
                source_registry,
                source_reference_registry,
                drive_service
            )

        except Exception as error:
            # One product must never stop the remaining products on the page.
            print(
                f"  Candidate ERROR | "
                f"{record.get('processing_id', 'UNKNOWN')} | {error}"
            )

            traceback.print_exc()

            primary_result = {
                **_build_result_base(
                    record,
                    hierarchy,
                    directories,
                    folder_ids
                ),
                "gemini_status": STATUS_GEMINI_APPROVED,
                "status": STATUS_FAILED,
                "reason": (
                    f"Primary product processing failed: {error}"
                ),
            }

            primary_result = _save_and_sheet(
                primary_result
            )

        primary_result_by_index[
            primary_index
        ] = primary_result

        results.append(
            primary_result
        )

    # --------------------------------------------------------
    # Process duplicate/secondary representations AFTER primaries.
    #
    # These images are NEVER cropped and NEVER uploaded.
    # --------------------------------------------------------
    for image_index in sorted(
        duplicate_indices
    ):
        record = record_by_index.get(
            image_index
        )

        if not record:
            continue

        page_product = (
            _product_for_duplicate_index(
                products,
                image_index
            )
            or {}
        )

        results.append(
            _save_page_duplicate_reference(
                record,
                page_product,
                hierarchy,
                directories,
                folder_ids,
                product_registry,
                source_registry,
                source_reference_registry
            )
        )

    # --------------------------------------------------------
    # Anything Gemini did not classify is NOT silently ignored.
    # --------------------------------------------------------
    handled_indices = (
        rejected_indices
        |
        review_indices
        |
        duplicate_indices
        |
        primary_indices
    )

    for image_index, record in sorted(
        record_by_index.items()
    ):
        if image_index in handled_indices:
            continue

        results.append(
            _save_page_review_image(
                record,
                hierarchy,
                directories,
                folder_ids,
                drive_service,
                (
                    "Gemini returned no product assignment for "
                    "this candidate image."
                )
            )
        )

    return results


# ============================================================
# REPORT
# ============================================================

def save_report(
    results,
    output_dir
):
    output_dir = Path(
        output_dir
    )

    output_dir.mkdir(
        parents=True,
        exist_ok=True
    )

    json_path = (
        output_dir /
        "catalog_report.json"
    )

    csv_path = (
        output_dir /
        "catalog_report.csv"
    )

    json_path.write_text(
        json.dumps(
            results,
            indent=4,
            ensure_ascii=False
        ),
        encoding="utf-8"
    )

    fields = [
        "processing_id",
        "image",
        "source_image",
        "page",
        "image_index",
        "product_id",
        "product_name",
        "brand",
        "product_code",
        "dimensions",
        "catalog_name",
        "pdf_name",
        "product_count",
        "identity_key",
        "source_hash",
        "duplicate_hash",
        "duplicate_sha256",
        "duplicate_dhash",
        "duplicate_whash",
        "matched_hash",
        "duplicate_distance",
        "duplicate_match_reason",
        "matched_product",
        "matched_product_id",
        "matched_catalog",
        "matched_page",
        "drive_url",
        "rejected_drive_url",
        "review_drive_url",
        "final_image",
        "cv_score",
        "gemini_status",
        "gemini_decision",
        "confidence",
        "image_type",
        "decision",
        "status",
        "reason",
        "review_copy",
        "rejected_copy",
        "duplicate_copy",
        "brand_folder_id",
        "catalog_folder_id",
        "approved_folder_id",
        "review_folder_id",
        "rejected_folder_id",
        "source_folder_id",
        "timestamp",
    ]

    with open(
        csv_path,
        "w",
        newline="",
        encoding="utf-8-sig"
    ) as file:
        writer = csv.DictWriter(
            file,
            fieldnames=fields,
            extrasaction="ignore"
        )

        writer.writeheader()
        writer.writerows(
            results
        )

    return (
        json_path,
        csv_path
    )


# ============================================================
# SOURCE HIERARCHY
# ============================================================

def get_source_hierarchy(
    pdf_path
):
    """
    Pen Drive is the source of truth.

    Example:
        E:\\ArchRock\\Brillo Collection.pdf

    becomes:
        Brand   = ArchRock
        Catalog = Brillo Collection
        PDF     = Brillo Collection.pdf
    """
    pdf_path = Path(
        pdf_path
    )

    brand_name = (
        pdf_path.parent.name.strip()
    )

    pdf_name = (
        pdf_path.name
    )

    catalog_name = (
        pdf_path.stem.strip()
    )

    if not brand_name:
        brand_name = "Unknown Brand"

    if not catalog_name:
        catalog_name = "Unknown Catalog"

    return {
        "brand_name":
            brand_name,
        "catalog_name":
            catalog_name,
        "pdf_name":
            pdf_name,
    }


# ============================================================
# LOCKED SCENE INTEGRATION
# ============================================================

def build_locked_scene(
    results,
    brand_name,
    catalog_name
):
    """
    Build one locked scene from successfully processed master products.

    Scene creation happens ONLY after the catalog has finished processing.
    Product IDs are owned by the catalog pipeline and are never generated
    or changed by the scene layer.
    """

    if not isinstance(results, list):
        return None

    products_by_id = {}

    for result in results:
        if not isinstance(result, dict):
            continue

        # Only successfully completed primary products enter the scene.
        if result.get("status") != STATUS_COMPLETE:
            continue

        product_id = str(
            result.get("product_id") or ""
        ).strip()

        if not product_id:
            continue

        # First successful record is the authoritative product record.
        if product_id in products_by_id:
            continue

        products_by_id[product_id] = {
            "product_id": product_id,
            "product_name": str(
                result.get("product_name") or ""
            ).strip(),
            "brand": str(
                result.get("brand") or brand_name or ""
            ).strip(),
            "product_code": str(
                result.get("product_code") or ""
            ).strip(),
            "dimensions": str(
                result.get("dimensions") or ""
            ).strip(),
            "drive_url": str(
                result.get("drive_url") or ""
            ).strip(),
        }

    products = list(products_by_id.values())

    if not products:
        print()
        print("No completed master products available for scene creation.")
        return None

    products.sort(
        key=lambda item: item["product_id"]
    )

    scene = create_scene(
        brand=brand_name,
        catalog=catalog_name,
        products=products,
        scene_type="BATHROOM",
    )

    return scene


def save_locked_scene(
    scene,
    catalog_output
):
    """Save the locked scene locally for the next angle-generation stage."""

    if scene is None:
        return None

    scene_directory = Path(catalog_output) / "_scene"
    scene_directory.mkdir(
        parents=True,
        exist_ok=True
    )

    scene_path = scene_directory / "scene.json"

    scene_data = {
        "scene_id": scene.scene_id,
        "scene_type": scene.scene_type,
        "created_at": scene.created_at,
        "product_lock": True,
        "products": [
            {
                "product_id": product.product_id,
                "product_name": product.product_name,
                "brand": product.brand,
                "product_code": product.product_code,
                "dimensions": product.dimensions,
                "drive_url": product.drive_url,
            }
            for product in scene.products
        ],
    }

    scene_path.write_text(
        json.dumps(
            scene_data,
            indent=4,
            ensure_ascii=False,
            default=str
        ),
        encoding="utf-8"
    )

    return scene_path


# ============================================================
# COMPLETE CATALOG PROCESSOR
# ============================================================

def process_catalog(
    pdf_path,
    output_root="output"
):
    pdf_path = Path(
        pdf_path
    )

    if not pdf_path.exists():
        raise FileNotFoundError(
            f"PDF not found: {pdf_path}"
        )

    hierarchy = get_source_hierarchy(
        pdf_path
    )

    brand_name = hierarchy[
        "brand_name"
    ]

    catalog_name = hierarchy[
        "catalog_name"
    ]

    # --------------------------------------------------------
    # Persistent registries
    # --------------------------------------------------------
    hash_registry = (
        load_duplicate_registry()
    )

    product_registry = (
        load_product_registry()
    )

    source_registry = (
        load_source_hash_registry()
    )

    source_reference_registry = (
        _load_json_list_file(
            SOURCE_REFERENCE_REGISTRY_FILE
        )
    )

    print(
        f"Visual duplicate registry entries: "
        f"{len(hash_registry)}"
    )

    print(
        f"Product master entries: "
        f"{len(product_registry)}"
    )

    print(
        f"Source image registry entries: "
        f"{len(source_registry)}"
    )

    # --------------------------------------------------------
    # Local output hierarchy.
    # Approved product images go directly inside the catalog
    # folder. Temporary/review/duplicate artifacts live outside
    # that collection folder so the collection contains images only.
    # --------------------------------------------------------
    catalog_output = (
        Path(output_root)
        / _safe_id(brand_name)
        / _safe_id(catalog_name)
    )

    processing_output = (
        Path(output_root)
        / "_processing"
        / _safe_id(brand_name)
        / _safe_id(catalog_name)
    )

    extracted_dir = processing_output / "extracted"
    review_dir = processing_output / "review"
    rejected_dir = processing_output / "rejected"
    duplicates_dir = processing_output / "duplicates"
    approved_dir = catalog_output

    for directory in (
        catalog_output,
        extracted_dir,
        review_dir,
        rejected_dir,
        duplicates_dir
    ):
        directory.mkdir(parents=True, exist_ok=True)

    directories = {
        "root":
            catalog_output,
        "extracted":
            extracted_dir,
        "approved":
            approved_dir,
        "selected":
            approved_dir,
        "review":
            review_dir,
        "rejected":
            rejected_dir,
        "duplicates":
            duplicates_dir,
    }

    print()
    print("=" * 80)
    print(
        "VERSION 9 - UNIQUE PRODUCT MASTER + "
        "PAGE-LEVEL GEMINI + MULTI-HASH DEDUPLICATION + LIVE STATUS"
    )
    print("=" * 80)

    print(
        f"Brand   : {brand_name}"
    )

    print(
        f"Catalog : {catalog_name}"
    )

    print(
        f"PDF     : {pdf_path.name}"
    )

    # --------------------------------------------------------
    # DRIVE STRUCTURE
    # --------------------------------------------------------
    print()
    print(
        "Preparing Google Drive hierarchy..."
    )

    folder_ids = (
        ensure_drive_catalog_structure(
            brand_name,
            catalog_name
        )
    )

    print(
        f"  Brand folder ID   : "
        f"{folder_ids['brand_folder_id']}"
    )

    print(
        f"  Catalog folder ID : "
        f"{folder_ids['catalog_folder_id']}"
    )

    print(
        f"  Image destination : collection folder directly"
    )

    # Clean up empty legacy folders created by older pipeline versions.
    # Non-empty legacy folders are left untouched for safety.
    _remove_empty_legacy_drive_status_folders(
        brand_name,
        catalog_name
    )

    drive_service = (
        _get_cached_drive_service()
        if get_drive_service is not None
        else None
    )

    # --------------------------------------------------------
    # PAGE TEXT
    # --------------------------------------------------------
    print()
    print(
        "Extracting page text..."
    )

    page_texts = extract_page_texts(
        pdf_path
    )

    # --------------------------------------------------------
    # IMAGE EXTRACTION
    # --------------------------------------------------------
    print()
    print(
        "Extracting embedded images..."
    )

    images = extract_pdf_images(
        pdf_path,
        extracted_dir
    )

    print(
        f"Images extracted: {len(images)}"
    )

    # --------------------------------------------------------
    # PYTHON OWNS ALL IMAGE IDs
    # --------------------------------------------------------
    catalog_images = []
    results = []

    for index, image_record in enumerate(
        images,
        start=1
    ):
        page_number = int(
            image_record.get(
                "page",
                1
            )
        )

        image_index = (
            image_record.get(
                "image_index"
            )
        )

        try:
            image_index = int(
                image_index
            )
        except (
            TypeError,
            ValueError
        ):
            image_index = index

        processing_id = (
            create_processing_id(
                brand_name,
                catalog_name,
                page_number,
                image_index
            )
        )

        image_record["image_index"] = (
            image_index
        )

        image_record["processing_id"] = (
            processing_id
        )

        image_path = Path(
            image_record["path"]
        )

        # ----------------------------------------------------
        # Readability check.
        # ----------------------------------------------------
        image = cv2.imread(
            str(image_path)
        )

        if image is None:
            _print_candidate_status(
                image_record,
                "HARD REJECTED",
                "Image cannot be decoded",
                STATUS_HARD_REJECTED
            )

            result = {
                **_build_result_base(
                    image_record,
                    hierarchy,
                    directories,
                    folder_ids
                ),
                "gemini_status":
                    "NOT_RUN",
                "status":
                    STATUS_HARD_REJECTED,
                "reason":
                    "Image cannot be decoded.",
            }

            # Cannot upload an unreadable file to Drive.
            try:
                _append_sheet_record(
                    result
                )
            except Exception:
                pass

            results.append(
                result
            )

            # Do not add an unreadable source to the successful
            # source registry.
            catalog_images.append({
                **image_record,
                "skip":
                    True,
                "source_hash":
                    None,
            })

            continue

        # ----------------------------------------------------
        # Exact source hash is ONLY a pre-Gemini optimization.
        # Product-level dedupe remains authoritative.
        # ----------------------------------------------------
        source_duplicate = (
            check_source_duplicate(
                image_path,
                source_registry
            )
        )

        source_hash = (
            source_duplicate.get(
                "hash"
            )
        )

        image_record["source_hash"] = (
            source_hash
        )

        if source_duplicate.get(
            "duplicate"
        ):
            _print_candidate_status(
                image_record,
                "SOURCE DUPLICATE",
                "Exact extracted source already processed - Gemini/CROP/DRIVE skipped",
                STATUS_DUPLICATE_SOURCE
            )

            matched_source = (
                source_duplicate.get(
                    "metadata"
                )
                or {}
            )

            result = {
                **_build_result_base(
                    image_record,
                    hierarchy,
                    directories,
                    folder_ids
                ),
                "product_id":
                    matched_source.get(
                        "product_id"
                    ),
                "drive_url":
                    matched_source.get(
                        "drive_url"
                    ),
                "gemini_status":
                    "NOT_RUN",
                "status":
                    STATUS_DUPLICATE_SOURCE,
                "reason":
                    (
                        "Exact extracted source image was already "
                        "processed. Gemini/crop/Drive upload skipped."
                    ),
            }

            results_note = result

            try:
                _append_sheet_record(
                    results_note
                )
            except Exception as error:
                print(
                    f"  Sheet source-duplicate warning: {error}"
                )

            results.append(
                results_note
            )

            catalog_images.append({
                **image_record,
                "skip":
                    True,
                "source_duplicate_result":
                    source_duplicate,
            })

            continue

        catalog_images.append(
            image_record
        )

    # --------------------------------------------------------
    # Group remaining images by PDF page.
    # --------------------------------------------------------
    pages = {}

    for image_record in catalog_images:
        if image_record.get(
            "skip"
        ):
            continue

        pages.setdefault(
            int(
                image_record["page"]
            ),
            []
        ).append(
            image_record
        )

    # --------------------------------------------------------
    # Process page-by-page so Gemini can identify unique products.
    # --------------------------------------------------------
    for page_number in sorted(
        pages
    ):
        page_images = sorted(
            pages[page_number],
            key=lambda item: int(
                item["image_index"]
            )
        )

        page_text = page_texts.get(
            page_number,
            ""
        )

        try:
            page_results = (
                process_page_group(
                    page_number,
                    page_images,
                    page_text,
                    hierarchy,
                    directories,
                    folder_ids,
                    hash_registry,
                    product_registry,
                    source_registry,
                    source_reference_registry,
                    drive_service
                )
            )

            results.extend(
                page_results
            )

        except Exception as error:
            print()
            print(
                f"  PAGE {page_number} ERROR: {error}"
            )

            # Do not silently lose candidates.
            for image_record in page_images:
                result = {
                    **_build_result_base(
                        image_record,
                        hierarchy,
                        directories,
                        folder_ids
                    ),
                    "status":
                        STATUS_FAILED,
                    "reason":
                        (
                            f"Page processing failed: "
                            f"{error}"
                        ),
                }

                results.append(
                    _save_and_sheet(
                        result
                    )
                )

    # --------------------------------------------------------
    # LOCKED SCENE
    # --------------------------------------------------------
    # At this point every page has finished processing. The scene is
    # therefore built from the final successful master-product records.
    # Duplicate/review/rejected/failed records are deliberately excluded.
    scene = None
    scene_path = None

    try:
        scene = build_locked_scene(
            results,
            brand_name,
            catalog_name
        )

        if scene is not None:
            scene_path = save_locked_scene(
                scene,
                catalog_output
            )

            # ----------------------------------------------------
            # SCENE ANGLES
            # ----------------------------------------------------
            # The scene product list is already locked. The angle
            # engine receives that same scene and creates the
            # FRONT / LEFT / RIGHT / WIDE / CLOSE_UP specifications.
            # It does not select, remove, or replace products.
            scene_angles_path = None

            try:
                scene_angles_path = save_scene_angles(
                    scene,
                    Path(catalog_output) / "_scene"
                )

                print()
                print(
                    "SCENE ANGLES CREATED"
                )
                print(
                    f"Scene angles file : {scene_angles_path}"
                )

            except Exception as angle_error:
                print()
                print(
                    f"SCENE ANGLE GENERATION WARNING: "
                    f"{angle_error}"
                )
                traceback.print_exc()

            print()
            print("=" * 80)
            print("LOCKED SCENE CREATED")
            print("=" * 80)
            print(
                f"SCENE_ID          : {scene.scene_id}"
            )
            print(
                f"Scene type        : {scene.scene_type}"
            )
            print(
                f"Locked products   : {len(scene.products)}"
            )
            print(
                f"Scene file        : {scene_path}"
            )
            print(
                f"Scene angles file : {scene_angles_path}"
            )

            for product in scene.products:
                print(
                    f"  - {product.product_id} | "
                    f"{product.product_name}"
                )

            # Add the stable SCENE_ID to the successful records so the
            # report can connect each master product to its scene.
            for result in results:
                if not isinstance(result, dict):
                    continue

                if result.get("status") == STATUS_COMPLETE:
                    product_id = str(
                        result.get("product_id") or ""
                    ).strip()

                    if any(
                        product.product_id == product_id
                        for product in scene.products
                    ):
                        result["scene_id"] = scene.scene_id
                        result["scene_type"] = scene.scene_type
                        result["product_lock"] = True

        else:
            print()
            print(
                "No locked scene created because there are no "
                "completed master products."
            )

    except Exception as error:
        print()
        print(
            f"LOCKED SCENE CREATION FAILED: {error}"
        )
        traceback.print_exc()

        # Scene failure must NOT invalidate already completed
        # product processing. The catalog results remain intact.

    # --------------------------------------------------------
    # Write source manifest.
    # --------------------------------------------------------
    try:
        manifest_result = (
            _upload_catalog_source_manifest(
                [
                    reference
                    for reference in
                    source_reference_registry
                    if (
                        reference.get(
                            "catalog"
                        )
                        == catalog_name
                        and
                        reference.get(
                            "brand"
                        )
                        == brand_name
                    )
                ],
                folder_ids[
                    "source_folder_id"
                ],
                brand_name,
                catalog_name
            )
        )

        if manifest_result:
            print(
                "Source reference manifest uploaded."
            )
    except Exception as error:
        print(
            f"Source manifest warning: {error}"
        )

    # --------------------------------------------------------
    # REPORT
    # --------------------------------------------------------
    json_path, csv_path = (
        save_report(
            results,
            catalog_output
        )
    )

    # --------------------------------------------------------
    # SUMMARY
    # --------------------------------------------------------
    approved = sum(
        1
        for r in results
        if r.get(
            "status"
        )
        == STATUS_COMPLETE
    )

    review = sum(
        1
        for r in results
        if r.get(
            "status"
        )
        == STATUS_REVIEW_REQUIRED
    )

    rejected = sum(
        1
        for r in results
        if r.get(
            "status"
        )
        in (
            STATUS_GEMINI_REJECTED,
            STATUS_HARD_REJECTED
        )
    )

    duplicate_products = sum(
        1
        for r in results
        if r.get(
            "status"
        )
        == STATUS_DUPLICATE_PRODUCT
    )

    duplicate_tiles = sum(
        1
        for r in results
        if r.get(
            "status"
        )
        == STATUS_DUPLICATE_TILE
    )

    source_duplicates = sum(
        1
        for r in results
        if r.get(
            "status"
        )
        == STATUS_DUPLICATE_SOURCE
    )

    failed = sum(
        1
        for r in results
        if r.get(
            "status"
        )
        == STATUS_FAILED
    )

    print()
    if scene is not None:
        print(
            f"Locked scene ID       : {scene.scene_id}"
        )
        print(
            f"Locked scene products : {len(scene.products)}"
        )
        print(
            f"Locked scene file     : {scene_path}"
        )
    else:
        print(
            "Locked scene          : NOT CREATED"
        )

    print()
    print("=" * 80)
    print(
        "CATALOG PROCESSING COMPLETE"
    )
    print("=" * 80)

    print(
        f"Total extracted images : "
        f"{len(images)}"
    )

    print(
        f"Master products created: "
        f"{approved}"
    )

    print(
        f"Review required        : "
        f"{review}"
    )

    print(
        f"Rejected               : "
        f"{rejected}"
    )

    print(
        f"Duplicate products     : "
        f"{duplicate_products}"
    )

    print(
        f"Visual duplicate tiles : "
        f"{duplicate_tiles}"
    )

    print(
        f"Exact source duplicates: "
        f"{source_duplicates}"
    )

    print(
        f"Failed                 : "
        f"{failed}"
    )

    print()
    print(
        "Drive structure:"
    )

    print(
        f"  {brand_name}/"
    )

    print(
        f"    {catalog_name}/"
    )

    print(
        "      *.jpg / *.jpeg / *.png / *.webp"
    )

    print()
    print(
        f"JSON report: {json_path}"
    )

    print(
        f"CSV report : {csv_path}"
    )

    print(
        f"Local output: {catalog_output}"
    )

    print()
    print(
        "IMPORTANT: DUPLICATE_PRODUCT and DUPLICATE_TILE "
        "images are NOT uploaded to Drive."
    )
    print(
        "Rejected/review/duplicate working copies are stored ONLY "
        "under output/_processing/<brand>/<catalog>/."
    )
    print(
        "Google Drive contains ONLY approved primary product images "
        "inside Brand/Catalog."
    )

    return results
