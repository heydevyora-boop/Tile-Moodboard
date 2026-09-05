


import os
import re
import csv
import hashlib
import mimetypes
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

import fitz
from PIL import Image
from dotenv import load_dotenv

try:
    from googleapiclient.http import MediaIoBaseDownload
except ImportError:
    MediaIoBaseDownload = None

from fastapi import FastAPI
from pydantic import BaseModel, Field
from typing import Optional
import uvicorn

from app.visualization_api import (
    create_visualization,
)

from app.database import (
    initialize_database,
    already_processed,
    mark_processed,
)

from app.google_services import (
    get_drive_service,
    get_sheets_service,
    ensure_master_workbook,
    get_or_create_folder,
    upload_file,
    append_brand,
    append_catalog,
    append_product,
)

from app.backend_sync import (
    sync_master_product_to_backend,
)


# ============================================================
# FASTAPI APPLICATION
# ============================================================

app = FastAPI(
    title="Casa de Aurum AI Service",
    version="1.0.0",
)


# ============================================================
# HEALTH CHECK
# ============================================================

@app.get("/health")
def health():
    return {
        "success": True,
        "status": "OK",
        "service": "casa-de-aurum-ai",
        "version": "1.0.0",
    }


# ============================================================
# INTERNAL VISUALIZATION REQUEST
# ============================================================

class InternalVisualizationRequest(BaseModel):
    """
    Request sent internally by the Node.js backend.

    The bathroom image may be either:

    - a local filesystem path accessible to this Python service, or
    - an HTTP/HTTPS URL, including a Google Drive image URL.

    Remote images are downloaded to output/scene_inputs before the
    visualization pipeline is called. This keeps the existing
    visualization business layer path-based and unchanged.
    """

    product_id: str = Field(
        min_length=1
    )

    surface: str = Field(
        min_length=1
    )

    # Optional: empty/omitted means "generate a bathroom scene
    # instead of fetching one." A required min_length=1 field here
    # would reject that request outright with a 422 before the
    # handler ever runs.
    scene_image_path: str = ""

    scene_image_url: Optional[str] = None

    scene_image_mode: Optional[str] = None

    generate_random_scene: Optional[bool] = None

    spreadsheet_id: Optional[str] = None

    sheet_name: str = "MASTER"

    scene_id: Optional[str] = None

    theme: Optional[str] = None

    requirements: Optional[dict] = None

    # Real reference image for this product from the Node backend's own
    # Postgres record (Tile.imageUrl) -- used as a safety net when the
    # MASTER sheet has no row, or no resolvable image, for this
    # product_id, so Gemini still gets sent a real tile photo instead of
    # a fabricated placeholder swatch. Local path or HTTP(S) URL.
    fallback_image_url: Optional[str] = None


# ============================================================
# SCENE IMAGE RESOLUTION
# ============================================================

def _extract_google_drive_file_id(value: str) -> Optional[str]:
    """Extract a Google Drive file ID from common Drive URL formats."""

    try:
        parsed = urlparse(value)
    except Exception:
        return None

    host = parsed.netloc.lower()
    if "drive.google.com" not in host and "drive.usercontent.google.com" not in host:
        return None

    query = parse_qs(parsed.query)
    if query.get("id"):
        return query["id"][0].strip() or None

    parts = [part for part in parsed.path.split("/") if part]
    for marker in ("d", "file", "folders"):
        if marker in parts:
            index = parts.index(marker)
            if index + 1 < len(parts):
                candidate = parts[index + 1].strip()
                if candidate:
                    return candidate

    # /uc/<file-id> style URLs, if supplied.
    if "uc" in parts:
        index = parts.index("uc")
        if index + 1 < len(parts):
            candidate = parts[index + 1].strip()
            if candidate:
                return candidate

    return None


def _build_remote_download_url(source: str) -> str:
    """Build a downloadable URL, normalizing common Google Drive URLs."""

    drive_file_id = _extract_google_drive_file_id(source)
    if drive_file_id:
        return (
            "https://drive.google.com/uc?export=download&id="
            f"{drive_file_id}"
        )

    return source


def _is_placeholder_scene_reference(value: str) -> bool:
    """
    Return True for a scene value that is metadata, not a real
    image — a bare scene ID like "SEED_feminine_01", or that same
    ID wrapped in a Drive URL by seeded reference-image data, e.g.
    "https://drive.google.com/uc?id=SEED_feminine_01". Neither is
    a real Drive file, so downloading either always 404s. The id=
    (or /d/<id>/) segment is unwrapped first so the wrapping URL
    doesn't hide the placeholder prefix from the check below.
    """

    text = str(value or "").strip()
    if not text:
        return False

    drive_file_id = _extract_google_drive_file_id(text)
    candidate = drive_file_id if drive_file_id else text

    if re.search(r"\.(png|jpe?g|webp|bmp)$", candidate, re.IGNORECASE):
        return False

    return bool(
        re.match(
            r"^(SEED_|feminine_|masculine_|bathroom-|scene-|AI_RANDOM_BATHROOM)",
            candidate,
            re.IGNORECASE,
        )
    )


def _validate_downloaded_image(data: bytes, source: str) -> str:
    """Validate image bytes with Pillow and return a safe extension."""

    if not data:
        raise ValueError(f"Downloaded scene image is empty: {source}")

    try:
        with Image.open(BytesIO(data)) as image:
            image.verify()
            image_format = (image.format or "").upper()
    except Exception as exc:
        raise ValueError(
            "The remote scene image did not contain a valid image file. "
            f"Source: {source}. The URL may be private, expired, or not an image. "
            f"Details: {exc}"
        ) from exc

    extensions = {
        "JPEG": ".jpg",
        "JPG": ".jpg",
        "PNG": ".png",
        "WEBP": ".webp",
        "BMP": ".bmp",
        "GIF": ".gif",
        "TIFF": ".tiff",
    }
    return extensions.get(image_format, ".img")


def _download_drive_file_authenticated(file_id: str, destination: Path) -> bool:
    """Download a Drive file using the project's authenticated Drive client."""
    if not file_id or MediaIoBaseDownload is None:
        return False

    try:
        drive = get_drive_service()
        request = drive.files().get(
            fileId=file_id,
            alt="media",
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        with open(destination, "wb") as handle:
            downloader = MediaIoBaseDownload(handle, request)
            done = False
            while not done:
                _, done = downloader.next_chunk()
        return destination.exists() and destination.stat().st_size > 0
    except Exception:
        return False


def _download_scene_image(source: str, scene_id: Optional[str] = None) -> Path:
    """Download a remote scene image and return its local path."""

    source = str(source).strip()
    if not source:
        raise ValueError("scene_image_path is required.")

    scene_inputs_dir = OUTPUT_DIR / "scene_inputs"
    scene_inputs_dir.mkdir(parents=True, exist_ok=True)

    source_hash = hashlib.sha256(source.encode("utf-8")).hexdigest()[:16]
    safe_scene_id = re.sub(
        r"[^A-Za-z0-9_-]+",
        "_",
        str(scene_id or "scene").strip(),
    ).strip("_") or "scene"

    drive_file_id = _extract_google_drive_file_id(source)
    if drive_file_id:
        authenticated_path = scene_inputs_dir / f"{safe_scene_id}_{source_hash}.drive"
        if _download_drive_file_authenticated(drive_file_id, authenticated_path):
            data = authenticated_path.read_bytes()
            extension = _validate_downloaded_image(data, source)
            final_path = authenticated_path.with_suffix(extension)
            authenticated_path.replace(final_path)
            return final_path.resolve()

    # First try the source exactly as supplied. For Google Drive URLs we
    # normalize to the download endpoint so a /file/d/.../view URL also works.
    download_url = _build_remote_download_url(source)

    request = Request(
        download_url,
        headers={
            "User-Agent": "CasaDeAurum-AI-Service/1.0",
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
    )

    try:
        with urlopen(request, timeout=30) as response:
            content = response.read()
            content_type = (response.headers.get("Content-Type") or "").lower()
    except HTTPError as exc:
        raise RuntimeError(
            f"Unable to download scene image (HTTP {exc.code}): {source}. "
            "If this is a Google Drive image, make sure the file is shared "
            "with the required access or publicly accessible."
        ) from exc
    except URLError as exc:
        raise RuntimeError(
            f"Unable to download scene image: {source}. "
            f"Network error: {exc.reason}"
        ) from exc
    except Exception as exc:
        raise RuntimeError(
            f"Unable to download scene image: {source}. {exc}"
        ) from exc

    # Google Drive can sometimes return an HTML confirmation/login page instead
    # of the actual image. Pillow validation below turns that into a clear error.
    extension = _validate_downloaded_image(content, source)

    # Prefer the detected image type over a misleading URL extension.
    if extension == ".img":
        guessed = mimetypes.guess_extension(content_type.split(";", 1)[0].strip())
        extension = guessed or ".img"

    local_path = (
        scene_inputs_dir
        / f"{safe_scene_id}_{source_hash}{extension}"
    )
    local_path.write_bytes(content)

    return local_path.resolve()


def resolve_scene_image(
    source: str,
    scene_id: Optional[str] = None,
) -> Path:
    """Resolve a local path or download an HTTP/Google Drive scene image."""

    source = str(source).strip().replace("\\", "/")
    parsed = urlparse(source)

    if parsed.scheme in {"http", "https"}:
        return _download_scene_image(source, scene_id=scene_id)

    # Support file:// URLs as well as normal Windows/Linux paths.
    if parsed.scheme == "file":
        source = parsed.path

    local_path = Path(source).expanduser()
    if not local_path.is_absolute():
        local_path = (Path.cwd() / local_path).resolve()
    else:
        local_path = local_path.resolve()

    if not local_path.exists():
        raise FileNotFoundError(
            f"Scene image not found: {local_path}. "
            "If the frontend sends a Google Drive URL, send the full HTTP/HTTPS URL."
        )

    if not local_path.is_file():
        raise ValueError(
            f"Scene image is not a file: {local_path}"
        )

    return local_path


# ============================================================
# INTERNAL NODE -> PYTHON VISUALIZATION ENDPOINT
# ============================================================

@app.post("/internal/visualizations")
def internal_visualization(
    request: InternalVisualizationRequest,
):
    """
    Internal visualization entry point for the Node backend.

    It delegates all business logic to the already-tested
    visualization service.

    IMPORTANT:
    This endpoint should remain private in production.
    The Node/Express backend is the public application API.
    """

    try:

        spreadsheet_id = (
            (request.spreadsheet_id or "").strip()
            or GOOGLE_SHEET_ID
        )

        if not spreadsheet_id:
            return {
                "success": False,
                "status": "FAILED",
                "error": {
                    "type": "ConfigurationError",
                    "message": (
                        "GOOGLE_SHEET_ID is not configured "
                        "and spreadsheet_id was not supplied."
                    ),
                },
            }

        # Empty scene_image_path, an explicit random-scene request, or a
        # placeholder scene reference (a bare ID like SEED_feminine_01,
        # or that same ID wrapped in a Drive URL by seeded reference-image
        # data) all mean: generate a bathroom scene instead of fetching
        # one. None of those are real, fetchable images, and attempting
        # to download them here always ends in a 404 straight from
        # Google Drive. Skip this file's own resolve_scene_image (which
        # only downloads/reads a path and cannot generate a scene) and
        # let create_visualization's own scene resolver handle it.
        raw_scene_image = (
            request.scene_image_path
            or request.scene_image_url
            or ""
        ).strip()

        wants_random_scene = (
            not raw_scene_image
            or request.generate_random_scene is True
            or (request.scene_image_mode or "").strip().lower() == "random"
            or _is_placeholder_scene_reference(raw_scene_image)
        )

        scene_image = (
            ""
            if wants_random_scene
            else resolve_scene_image(
                raw_scene_image,
                scene_id=request.scene_id,
            )
        )

        # Best-effort: a missing/unreachable fallback image should never
        # fail the whole visualization request -- it just means the
        # MASTER-sheet-missing case below falls through to the
        # synthetic placeholder swatch, same as before this existed.
        fallback_image_path = None
        raw_fallback_image = (request.fallback_image_url or "").strip()
        if raw_fallback_image:
            try:
                fallback_image_path = str(
                    resolve_scene_image(raw_fallback_image)
                )
            except Exception:
                fallback_image_path = None

        result = create_visualization(
            {
                "spreadsheet_id": spreadsheet_id,
                "sheet_name": (
                    request.sheet_name.strip()
                    or "MASTER"
                ),
                "product_id": request.product_id.strip(),
                "scene_image": scene_image,
                "scene_image_mode": (
                    "random" if wants_random_scene else "reference"
                ),
                "generate_random_scene": wants_random_scene,
                "surface": request.surface.strip().upper(),
                "scene_id": request.scene_id,
                "theme": request.theme,
                "requirements": request.requirements or {},
                "fallback_image_path": fallback_image_path,
            }
        )

        if not isinstance(
            result,
            dict,
        ):
            return {
                "success": False,
                "status": "FAILED",
                "error": {
                    "type": "InvalidResult",
                    "message": (
                        "Visualization service returned "
                        "an invalid response."
                    ),
                },
            }

        return result

    except Exception as error:

        return {
            "success": False,
            "status": "FAILED",
            "error": {
                "type": type(error).__name__,
                "message": str(error),
            },
        }


# ============================================================
# ENVIRONMENT
# ============================================================

script_dir = Path(__file__).parent.absolute()
env_path = script_dir / ".env"
load_dotenv(dotenv_path=str(env_path))

# Debug: verify .env was loaded
if env_path.exists():
    print(f"✓ Loaded .env from: {env_path}")
else:
    print(f"✗ .env file not found at: {env_path}")


# ============================================================
# CONFIGURATION
# ============================================================

OUTPUT_DIR = Path("output")

IMAGE_QUALITY = 85
MIN_IMAGE_WIDTH = 200
MIN_IMAGE_HEIGHT = 200

GOOGLE_SHEET_ID = os.getenv(
    "GOOGLE_SHEET_ID",
    "",
).strip()

GOOGLE_SHEET_NAME = os.getenv(
    "GOOGLE_SHEET_NAME",
    "PRODUCTS",
).strip()

GOOGLE_DRIVE_ROOT_FOLDER_ID = os.getenv(
    "GOOGLE_DRIVE_ROOT_FOLDER_ID",
    "",
).strip()


# Controlled values used by the master sheet.
UNKNOWN = "UNKNOWN"
DEFAULT_FINISH = UNKNOWN
DEFAULT_BUDGET = UNKNOWN


# ============================================================
# GENERAL HELPERS
# ============================================================

def create_directory(path):
    path.mkdir(
        parents=True,
        exist_ok=True,
    )


def normalize_name(value):
    """
    Convert a folder/file name into a clean display value.
    """

    if value is None:
        return ""

    value = str(value).strip()
    value = re.sub(
        r"\s+",
        " ",
        value,
    )

    return value


def sanitize_id_part(value):
    """
    Make a stable ID-safe string.
    """

    value = normalize_name(
        value
    ).upper()

    value = re.sub(
        r"[^A-Z0-9]+",
        "-",
        value,
    )

    value = value.strip("-")

    return value or "UNKNOWN"


def make_product_id(
    brand,
    catalog,
    image_index,
):
    """
    Stable Product ID for extracted product images.

    Example:
    ARCHROCK-ADOBE-COLLECTION-0001
    """

    return (
        f"{sanitize_id_part(brand)}-"
        f"{sanitize_id_part(catalog)}-"
        f"{int(image_index):04d}"
    )


def get_brand_from_pdf(pdf_path):
    """
    Expected structure:

    E:\\
      Brand Folder\\
        Catalog.pdf

    The PDF's immediate parent folder is treated as Brand.
    """

    parent = pdf_path.parent

    if (
        parent == Path(pdf_path.anchor)
        or not parent.name
    ):
        return UNKNOWN

    return normalize_name(
        parent.name
    )


def get_catalog_from_pdf(pdf_path):
    """
    PDF filename without extension = Catalog.
    """

    return normalize_name(
        pdf_path.stem
    )


# ============================================================
# PDF DISCOVERY
# ============================================================

def find_pdfs(source_directory):
    """
    Collect real catalog PDFs from the pen drive.

    Files whose name starts with "._" are macOS AppleDouble
    sidecars: when a Mac copies a file onto a FAT32/exFAT pen
    drive it writes a small companion "._Name.pdf" holding
    resource-fork metadata. They end in ".pdf" but contain no
    PDF, so fitz.open() throws "Failed to open file ... as type
    pdf" on every one of them and that whole catalog is reported
    FAILED. They are skipped here, along with other dot-hidden
    files, so only genuine catalogs are processed.
    """

    pdf_files = []
    skipped_sidecars = 0

    for root, dirs, files in os.walk(
        source_directory
    ):
        for file in files:

            if not file.lower().endswith(".pdf"):
                continue

            if file.startswith("._"):
                skipped_sidecars += 1
                continue

            if file.startswith("."):
                continue

            pdf_files.append(
                Path(root) / file
            )

    if skipped_sidecars:
        print(
            f"Ignored {skipped_sidecars} macOS sidecar file(s) "
            "(._*.pdf) -- these are not real PDFs."
        )

    return sorted(pdf_files)


# ============================================================
# PDF TEXT EXTRACTION
# ============================================================

def extract_text_from_pdf(pdf_path):
    document = fitz.open(
        pdf_path
    )

    pages = []

    for page_number, page in enumerate(
        document,
        start=1,
    ):
        pages.append(
            {
                "page": page_number,
                "text": page.get_text(),
            }
        )

    document.close()

    return pages


# ============================================================
# IMAGE EXTRACTION
# ============================================================

def render_image_crop(page, rect, dpi=300):
    """Rasterizes exactly what's visibly printed inside `rect` on the page
    -- the real tile swatch as the catalog shows it -- rather than the raw
    embedded PDF image resource.

    Catalog PDFs routinely reuse one embedded image resource (a shared
    texture sheet, a background pattern) across several different swatch
    boxes, positioning/clipping different portions of it per box via the
    page's content stream. Extracting the raw resource ignores that
    positioning entirely, so two visually different tiles that happen to
    share an underlying image resource extract as the exact same bytes.
    Rendering the page itself at this rect sidesteps that.
    """
    zoom = dpi / 72
    matrix = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=matrix, clip=fitz.Rect(rect), alpha=False)
    return pix.tobytes("png"), pix.width, pix.height


# ---------------------------------------------------------------------------
# Room/lifestyle photo rejection and page-furniture (badge/logo) exclusion.
#
# Ported from backend/python/extract.py, where these thresholds were
# calibrated against a real 139-page tile catalog (not synthetic artwork).
# Two prior attempts at this exact classification failed against real data
# in opposite directions -- judging by page geometry alone discarded almost
# every real product on a one-product-per-page catalog, and thresholds
# tuned on hand-drawn tile artwork rejected 89% of real photographed tiles
# (which carry natural shadow/reflection variance clean artwork doesn't).
# These values sit clear of that entire real-photo range. Do not lower them
# without re-measuring against real extracted images first.
# ---------------------------------------------------------------------------

BANNER_ASPECT_RATIO = 4.5
PAGE_DOMINANT_FRACTION = 0.85

ROOM_COLOUR_VARIATION = 0.10
ROOM_COLOUR_VARIATION_STRONG = 0.20
ROOM_BRIGHTNESS_VARIATION = 0.30

REPEATING_TEMPLATE_MIN_PAGES = 5
REPEATING_TEMPLATE_BUCKET_PT = 2.0


def measure_image_content(image_bytes):
    """Region-level uniformity statistics used to tell a flat tile surface
    apart from a photograph of a room. A tile -- however busy or colourful
    its pattern -- repeats the same handful of colours everywhere on the
    swatch; a room photo is assembled from unrelated regions (a white
    basin, a green plant, daylight through a window, a dark corner).
    Returns None if the image can't be read -- callers treat that as "no
    opinion" and keep the image, since a false reject silently loses a
    real product.
    """
    try:
        import numpy as np

        with Image.open(BytesIO(image_bytes)) as source:
            source = source.convert("RGB")
            source.thumbnail((256, 256))
            pixels = np.asarray(source, dtype=np.float32) / 255.0
    except Exception:  # noqa: BLE001
        return None

    if pixels.ndim != 3 or min(pixels.shape[:2]) < 16:
        return None

    cells = 8
    height, width = pixels.shape[:2]
    cell_h, cell_w = height // cells, width // cells
    if cell_h < 1 or cell_w < 1:
        return None

    trimmed = pixels[: cell_h * cells, : cell_w * cells, :]
    region_colours = trimmed.reshape(cells, cell_h, cells, cell_w, 3).mean(axis=(1, 3))

    region_luma = region_colours.mean(axis=2)
    brightness_variation = float(region_luma.std())

    chromaticity = region_colours / (region_luma[:, :, None] + 1e-6)
    colour_variation = float(chromaticity.reshape(-1, 3).std(axis=0).mean())

    return {
        "colour_variation": colour_variation,
        "brightness_variation": brightness_variation,
    }


def classify_image_content(image_bytes, image_rect, page_rect):
    """Decide whether a rendered placement is a room/lifestyle photo rather
    than a tile surface. Returns (is_room_photo, reason).

    Errs deliberately towards keeping images: a false reject loses a real
    product from the catalog silently; a false keep leaves an obvious room
    photo for staff to delete during review.
    """
    if image_rect:
        ix0, iy0, ix1, iy1 = image_rect
        width, height = ix1 - ix0, iy1 - iy0
        if width > 0 and height > 0:
            aspect_ratio = max(width, height) / min(width, height)
            if aspect_ratio > BANNER_ASPECT_RATIO:
                return True, f"banner/rule strip (aspect ratio {aspect_ratio:.1f}:1)"

    metrics = measure_image_content(image_bytes)
    if metrics is None:
        return False, ""

    colour_variation = metrics["colour_variation"]
    brightness_variation = metrics["brightness_variation"]

    page_area = page_rect.width * page_rect.height
    covers_page = False
    if image_rect and page_area > 0:
        ix0, iy0, ix1, iy1 = image_rect
        covers_page = ((ix1 - ix0) * (iy1 - iy0)) / page_area > PAGE_DOMINANT_FRACTION

    measured = f"colour spread {colour_variation:.4f}, lighting spread {brightness_variation:.4f}"

    if colour_variation > ROOM_COLOUR_VARIATION_STRONG:
        return True, f"reads as a room/lifestyle photo (clearly unrelated colours; {measured})"

    if colour_variation > ROOM_COLOUR_VARIATION and (
        covers_page or brightness_variation > ROOM_BRIGHTNESS_VARIATION
    ):
        return True, f"reads as a room/lifestyle photo (varied colours and lighting; {measured})"

    return False, measured


def find_repeating_template_rects(document):
    """Pre-scans every page's image placements and returns bucketed
    positions that recur across many pages while always rendering to the
    SAME pixels -- a stamped badge, letterhead graphic, or repeated
    background, not a product.

    Position alone is not enough: catalogs commonly lay products out on a
    fixed grid, so a real product slot also recurs at the same coordinates
    page after page. What distinguishes a badge from a grid slot is that a
    badge renders identically every time; a slot shows a different photo.

    This checks the RENDERED CONTENT (a hash of the actual pixels at that
    position), not the underlying PDF xref. An earlier version compared
    xrefs instead, on the assumption that a repeated graphic is always
    embedded once and referenced many times -- true for some PDF authoring
    tools, but not guaranteed: the same visual content can end up stored as
    several distinct-but-pixel-identical embedded objects, which a
    metadata-only, no-render pre-scan cannot tell apart from genuinely
    different photos. Hashing the actual rendered crop closes that gap at
    the cost of doing the rendering work twice (once here, once in the main
    pass) -- worth it since the alternative is uploading the same junk
    graphic to Drive once per page it appears on.
    """
    position_pages = {}
    position_hashes = {}

    for page_number in range(document.page_count):
        page = document[page_number]
        for image_info in page.get_images(full=True):
            xref = image_info[0]
            try:
                rects = page.get_image_rects(xref)
            except Exception:  # noqa: BLE001
                continue
            for rect in rects:
                bucket = tuple(round(c / REPEATING_TEMPLATE_BUCKET_PT) for c in rect)
                try:
                    image_bytes, _width, _height = render_image_crop(page, rect, dpi=72)
                except Exception:  # noqa: BLE001
                    continue
                content_hash = hashlib.sha256(image_bytes).hexdigest()
                position_pages.setdefault(bucket, set()).add(page_number)
                position_hashes.setdefault(bucket, set()).add(content_hash)

    return {
        bucket
        for bucket, pages in position_pages.items()
        if len(pages) >= REPEATING_TEMPLATE_MIN_PAGES and len(position_hashes[bucket]) == 1
    }


def extract_images_from_pdf(
    pdf_path,
    output_directory,
):
    document = fitz.open(
        pdf_path
    )

    template_rects = find_repeating_template_rects(document)
    if template_rects:
        print(
            f"Found {len(template_rects)} page-template position(s) (logo/badge stamped "
            f"across {REPEATING_TEMPLATE_MIN_PAGES}+ pages) -- excluding those"
        )

    extracted_images = []
    image_counter = 0
    seen_hashes = set()
    duplicates_skipped = 0
    room_photos_skipped = 0

    for page_number, page in enumerate(
        document,
        start=1,
    ):

        for image_info in page.get_images(
            full=True
        ):

            xref = image_info[0]

            try:
                rects = page.get_image_rects(xref)
            except Exception:  # noqa: BLE001
                rects = []

            # Every on-page placement is its own candidate, not just the
            # first -- a shared texture sheet can be clipped differently
            # per box. Falls back to a single "no known position"
            # placement when the PDF gives us no rects at all.
            placements = rects if rects else [None]

            for image_rect in placements:

                if image_rect:
                    bucket = tuple(round(c / REPEATING_TEMPLATE_BUCKET_PT) for c in image_rect)
                    if bucket in template_rects:
                        continue

                try:

                    if image_rect:
                        image_bytes, width, height = render_image_crop(page, image_rect)
                    else:
                        image_data = document.extract_image(xref)
                        image_bytes = image_data["image"]
                        with Image.open(BytesIO(image_bytes)) as probe:
                            width, height = probe.size

                    # Ignore tiny icons/logos.
                    if (
                        width < MIN_IMAGE_WIDTH
                        or height < MIN_IMAGE_HEIGHT
                    ):
                        continue

                    is_room_photo, _reason = classify_image_content(
                        image_bytes, image_rect, page.rect
                    )
                    if is_room_photo:
                        room_photos_skipped += 1
                        continue

                    # Real duplicate detection -- an exact byte hash of the
                    # rendered crop catches the same photo appearing more
                    # than once (a repeated section banner, a product shown
                    # twice) without being fooled by similar-but-different
                    # products. The filename-based check further down
                    # (already_processed) cannot do this: it's keyed on a
                    # per-page/per-index filename that is unique by
                    # construction, so it never actually catches a repeat
                    # within a single run.
                    image_hash = hashlib.sha256(image_bytes).hexdigest()
                    if image_hash in seen_hashes:
                        duplicates_skipped += 1
                        continue
                    seen_hashes.add(image_hash)

                    image = Image.open(
                        BytesIO(
                            image_bytes
                        )
                    )

                    if image.mode not in (
                        "RGB",
                        "RGBA",
                    ):
                        image = image.convert(
                            "RGB"
                        )

                    image_counter += 1

                    output_filename = (
                        f"{pdf_path.stem}"
                        f"_page_{page_number}"
                        f"_image_{image_counter}"
                        f".webp"
                    )

                    output_path = (
                        output_directory
                        / output_filename
                    )

                    image.save(
                        output_path,
                        "WEBP",
                        quality=IMAGE_QUALITY,
                        method=6,
                    )

                    extracted_images.append(
                        {
                            "page": page_number,
                            "image_index": image_counter,
                            "filename": output_filename,
                            "path": str(
                                output_path
                            ),
                            "width": width,
                            "height": height,
                        }
                    )

                except Exception as exc:

                    print(
                        "Image extraction failed in "
                        f"{pdf_path.name}: {exc}"
                    )

    document.close()

    print(
        f"Extracted {len(extracted_images)} image(s), skipped {duplicates_skipped} "
        f"duplicate(s) and {room_photos_skipped} room/lifestyle photo(s)"
    )

    return extracted_images


# ============================================================
# SINGLE PDF PROCESSING
# ============================================================

def process_pdf(
    pdf_path,
    catalog_output_directory,
    drive_service,
    sheets_service,
):
    print("")
    print("=" * 70)
    print(
        f"Processing catalog: {pdf_path.name}"
    )
    print("=" * 70)

    brand = get_brand_from_pdf(
        pdf_path
    )

    catalog = get_catalog_from_pdf(
        pdf_path
    )

    print(
        f"Brand   : {brand}"
    )

    print(
        f"Catalog : {catalog}"
    )

    create_directory(
        catalog_output_directory
    )

    images_directory = (
        catalog_output_directory
        / "images"
    )

    create_directory(
        images_directory
    )

    # --------------------------------------------------------
    # 1. Extract PDF text
    # --------------------------------------------------------

    pages = extract_text_from_pdf(
        pdf_path
    )

    text_file = (
        catalog_output_directory
        / "text.txt"
    )

    with open(
        text_file,
        "w",
        encoding="utf-8",
    ) as f:

        for page in pages:

            f.write(
                f"\n===== PAGE "
                f"{page['page']} =====\n"
            )

            f.write(
                page["text"]
            )

    # --------------------------------------------------------
    # 2. Extract images
    # --------------------------------------------------------

    images = extract_images_from_pdf(
        pdf_path,
        images_directory,
    )

    # --------------------------------------------------------
    # 3. Save image information locally
    # --------------------------------------------------------

    image_csv = (
        catalog_output_directory
        / "images.csv"
    )

    with open(
        image_csv,
        "w",
        newline="",
        encoding="utf-8",
    ) as f:

        writer = csv.writer(f)

        writer.writerow(
            [
                "page",
                "image_index",
                "filename",
                "width",
                "height",
            ]
        )

        for image in images:

            writer.writerow(
                [
                    image["page"],
                    image["image_index"],
                    image["filename"],
                    image["width"],
                    image["height"],
                ]
            )

    # --------------------------------------------------------
    # 4. Create/find Brand folder in Google Drive
    # --------------------------------------------------------

    brand_folder_id = (
        get_or_create_folder(
            drive_service,
            brand,
            parent_id=(
                GOOGLE_DRIVE_ROOT_FOLDER_ID
                or None
            ),
        )
    )

    # --------------------------------------------------------
    # 5. Create/find Catalog folder inside Brand
    # --------------------------------------------------------

    catalog_folder_id = (
        get_or_create_folder(
            drive_service,
            catalog,
            parent_id=brand_folder_id,
        )
    )

    # --------------------------------------------------------
    # 6. Register Brand and Catalog
    # --------------------------------------------------------

    brand_id = (
        f"BRAND-{sanitize_id_part(brand)}"
    )

    catalog_id = (
        f"CAT-"
        f"{sanitize_id_part(brand)}-"
        f"{sanitize_id_part(catalog)}"
    )

    append_brand(
        sheets_service=sheets_service,
        spreadsheet_id=GOOGLE_SHEET_ID,
        brand_id=brand_id,
        brand_name=brand,
        parent_folder=brand_folder_id,
    )

    append_catalog(
        sheets_service=sheets_service,
        spreadsheet_id=GOOGLE_SHEET_ID,
        catalog_id=catalog_id,
        brand_id=brand_id,
        brand_name=brand,
        catalog_name=catalog,
        pdf_name=pdf_path.name,
    )

    # --------------------------------------------------------
    # 7. Upload each extracted image and add Product row
    # --------------------------------------------------------

    uploaded_count = 0
    skipped_count = 0
    sheet_failed_count = 0

    for image in images:

        product_id = make_product_id(
            brand,
            catalog,
            image["image_index"],
        )

        # Use the image path as the duplicate identity.
        file_hash = (
            f"{pdf_path.resolve()}::"
            f"{image['filename']}"
        )

        if already_processed(
            file_hash
        ):

            print(
                "SKIP already processed: "
                f"{image['filename']}"
            )

            skipped_count += 1
            continue

        print(
            f"Uploading "
            f"{image['image_index']}/"
            f"{len(images)}: "
            f"{image['filename']}"
        )

        uploaded = upload_file(
            drive_service,
            image["path"],
            catalog_folder_id,
        )

        drive_url = uploaded.get(
            "webViewLink",
            "",
        )

        # Product data intentionally remains
        # unclassified at this extraction stage.
        #
        # A failed sheet write must not abort the whole catalog, and
        # must not be marked processed: the local skip database is
        # what makes a later re-run pass over this image entirely, so
        # marking a row that never reached MASTER would strand it
        # forever -- the image visible in Drive, the product missing
        # from the sheet, and no way to notice.
        try:

            append_product(
                sheets_service=sheets_service,
                spreadsheet_id=GOOGLE_SHEET_ID,
                product_id=product_id,
                brand_id=brand_id,
                brand=brand,
                catalog_id=catalog_id,
                catalog=catalog,
                pdf_name=pdf_path.name,
                product_name="",
                sku="",
                page=image["page"],
                image_index=image["image_index"],
                drive_url=drive_url,
                image_filename=image["filename"],
            )

        except Exception as exc:

            sheet_failed_count += 1

            print(
                f"SHEET WRITE FAILED for {product_id} "
                f"(image stays in Drive, row NOT written, "
                f"will retry next run): {exc}"
            )

            continue

        # The MASTER row exists now. Mirror it into the Node backend's
        # Tile table so this product is actually selectable when
        # combinations are generated -- that generator reads only from
        # Postgres, never from Sheets/Drive, so a product that stops here
        # would be visible in MASTER but unusable in a mood board.
        #
        # Deliberately best-effort and AFTER the sheet write: it must
        # never abort a catalog whose row and image already landed.
        sync_master_product_to_backend(
            product_code=product_id,
            brand=brand,
            image_url=drive_url,
        )

        mark_processed(
            file_hash=file_hash,
            filename=image["filename"],
        )

        uploaded_count += 1

    print("")

    print(
        f"Images extracted : {len(images)}"
    )

    print(
        f"Images uploaded  : {uploaded_count}"
    )

    print(
        f"Images skipped   : {skipped_count}"
    )

    print(
        f"Sheet failures   : {sheet_failed_count}"
    )

    return {
        "brand": brand,
        "catalog": catalog,
        "pdf": pdf_path.name,
        "pages": len(pages),
        "images": len(images),
        "uploaded": uploaded_count,
        "skipped": skipped_count,
        "sheet_failed": sheet_failed_count,
    }


# ============================================================
# PEN DRIVE PROCESSING
# ============================================================

def process_drive(
    drive_path,
):
    """
    Main entry point used by usb_agent.py.
    """

    drive_path = Path(
        drive_path
    )

    if not drive_path.exists():

        raise FileNotFoundError(
            f"Drive not found: {drive_path}"
        )

    if not GOOGLE_SHEET_ID:

        raise RuntimeError(
            "GOOGLE_SHEET_ID is missing "
            "from .env"
        )

    if not GOOGLE_DRIVE_ROOT_FOLDER_ID:

        raise RuntimeError(
            "GOOGLE_DRIVE_ROOT_FOLDER_ID is missing from .env. "
            "Create a Google Drive folder for catalog uploads, "
            "copy its ID from the URL (https://drive.google.com/drive/folders/[ID]), "
            "and add it to .env as GOOGLE_DRIVE_ROOT_FOLDER_ID=[ID]"
        )

    print("")
    print("=" * 70)
    print(
        "CATALOG PRODUCT MASTER PIPELINE"
    )
    print("=" * 70)

    print(
        f"Pen Drive : {drive_path}"
    )

    print(
        f"Sheet ID  : {GOOGLE_SHEET_ID}"
    )

    # --------------------------------------------------------
    # Initialize local duplicate database
    # --------------------------------------------------------

    initialize_database()

    # --------------------------------------------------------
    # Connect to Google
    # --------------------------------------------------------

    print("")
    print(
        "Connecting to Google Drive "
        "and Google Sheets..."
    )

    drive_service = get_drive_service()

    sheets_service = (
        get_sheets_service()
    )

    # --------------------------------------------------------
    # Ensure master workbook tabs and headers exist
    # --------------------------------------------------------

    ensure_master_workbook(
        sheets_service=sheets_service,
        spreadsheet_id=GOOGLE_SHEET_ID,
    )

    # --------------------------------------------------------
    # Find PDFs
    # --------------------------------------------------------

    pdfs = find_pdfs(
        drive_path
    )

    print(
        f"Found {len(pdfs)} PDF file(s)."
    )

    if not pdfs:

        print(
            "No PDF catalogs found."
        )

        return

    create_directory(
        OUTPUT_DIR
    )

    results = []

    # --------------------------------------------------------
    # Process every PDF
    # --------------------------------------------------------

    for pdf in pdfs:

        catalog_dir = (
            OUTPUT_DIR
            / pdf.stem
        )

        try:

            result = process_pdf(
                pdf_path=pdf,
                catalog_output_directory=(
                    catalog_dir
                ),
                drive_service=drive_service,
                sheets_service=sheets_service,
            )

            results.append(
                result
            )

        except Exception as exc:

            print("")

            print(
                f"FAILED: {pdf.name}"
            )

            print(
                f"Reason: {exc}"
            )

    # --------------------------------------------------------
    # Local master CSV for backup/debugging
    # --------------------------------------------------------

    master_csv = (
        OUTPUT_DIR
        / "catalogs.csv"
    )

    with open(
        master_csv,
        "w",
        newline="",
        encoding="utf-8",
    ) as f:

        writer = csv.writer(f)

        writer.writerow(
            [
                "brand",
                "catalog",
                "pdf",
                "pages",
                "images",
                "uploaded",
                "skipped",
            ]
        )

        for result in results:

            writer.writerow(
                [
                    result["brand"],
                    result["catalog"],
                    result["pdf"],
                    result["pages"],
                    result["images"],
                    result["uploaded"],
                    result["skipped"],
                ]
            )

    print("")
    print("=" * 70)
    print(
        "PRODUCT MASTER PIPELINE COMPLETE"
    )
    print("=" * 70)

    print(
        f"Catalogs processed : {len(results)}"
    )

    print(
        f"Local output       : "
        f"{OUTPUT_DIR.resolve()}"
    )

    print("")

    total_sheet_failures = sum(
        result.get("sheet_failed", 0)
        for result in results
    )

    total_rows_written = sum(
        result.get("uploaded", 0)
        for result in results
    )

    print(
        f"Product rows written to MASTER : "
        f"{total_rows_written}"
    )

    if total_sheet_failures:
        print(
            f"Product rows that FAILED to write : "
            f"{total_sheet_failures}"
        )

    print("")

    print(
        "Google Sheet tabs updated:"
    )

    print("  BRANDS")
    print("  CATALOGS")
    # Extracted products go to the MASTER tab
    # (google_services.PRODUCT_SHEET_NAME), never a "PRODUCTS" tab --
    # no such tab exists, and looking for one is why the sheet can
    # appear empty even on a successful run.
    print("  MASTER")
    print("  SANITARY")
    print("  FAUCETS")
    print("  BASINS")
    print("  WC")
    print("  FLUSH_PLATES")
    print("  SETTINGS")


# ============================================================
# APPLICATION ENTRY POINT
# ============================================================
#
# IMPORTANT:
# - Running this file directly starts the FastAPI AI service.
# - The Node.js backend should call:
#       POST http://127.0.0.1:8000/internal/visualizations
# - The catalog / pen-drive pipeline is still available with:
#       python main_step6_complete.py --pipeline
#
# This prevents "python main_step6_complete.py" from accidentally
# running the pen-drive pipeline instead of starting the AI API.
# ============================================================

if __name__ == "__main__":
    import sys

    if "--pipeline" in sys.argv:
        drive = input(
            "Enter pen drive path "
            "(example E:\): "
        ).strip().strip('"').strip("'")

        process_drive(drive)

    else:
        print("")
        print("=" * 70)
        print("CASA DE AURUM AI SERVICE")
        print("=" * 70)
        print("FastAPI endpoint : http://127.0.0.1:8000")
        print("Swagger docs     : http://127.0.0.1:8000/docs")
        print("Health check     : http://127.0.0.1:8000/health")
        print("Visualization    : POST /internal/visualizations")
        print("")
        print("Starting Uvicorn...")
        print("=" * 70)

        uvicorn.run(
            app,
            host="127.0.0.1",
            port=int(os.getenv("AI_SERVICE_PORT", "8000")),
            reload=False,
        )