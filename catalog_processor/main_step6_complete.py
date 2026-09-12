


import os
import re
import csv
import hashlib
import mimetypes
import tempfile
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

from fastapi import APIRouter, FastAPI
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

    # OUTPUT_DIR ("output", relative to cwd) is fine for the local/Docker
    # pendrive flow but is read-only on Vercel's serverless filesystem
    # outside of /tmp. These are transient per-request scratch files
    # (downloaded, then read back once during this same request), so the
    # OS temp dir is safe here without touching OUTPUT_DIR's other, real
    # local-output usages elsewhere in this file.
    scene_inputs_dir = Path(tempfile.gettempdir()) / "casa-scene-inputs"
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

        # Best-effort: a missing/unreachable fallback image must never fail
        # the whole visualization request -- it just means the
        # MASTER-sheet-missing case below raises its own original error.
        #
        # This value is a PRODUCT image (Tile.imageUrl), not a scene image.
        # Catalog images live in a private Drive folder, and
        # resolve_scene_image fetches over plain unauthenticated HTTP --
        # which Drive answers with an HTML login page for a private file.
        # It therefore raised every time here, was swallowed below, and
        # left no fallback at all, so the MASTER-missing product still
        # failed. _download_remote_product_image authenticates through the
        # Drive API first, so prefer it for remote URLs and keep
        # resolve_scene_image for the inputs it already handled (local
        # paths, data URLs, raw base64) and as a second chance.
        fallback_image_path = None
        raw_fallback_image = (request.fallback_image_url or "").strip()

        if raw_fallback_image:

            fallback_resolvers = []

            if raw_fallback_image.lower().startswith(
                ("http://", "https://")
            ):
                from app.product_visualization_service import (
                    _download_remote_product_image,
                )

                fallback_resolvers.append(
                    _download_remote_product_image
                )

            fallback_resolvers.append(resolve_scene_image)

            fallback_errors = []

            for resolve_fallback in fallback_resolvers:
                try:
                    fallback_image_path = str(
                        resolve_fallback(raw_fallback_image)
                    )
                    break
                except Exception as fallback_error:
                    fallback_image_path = None
                    fallback_errors.append(
                        f"{getattr(resolve_fallback, '__name__', 'resolver')}"
                        f": {fallback_error}"
                    )

            # Swallowing every failure silently is what made this so hard
            # to diagnose: the request went on to fail with the generic
            # "does not exist in MASTER" message, giving no hint that a
            # fallback had been attempted at all, let alone why it failed.
            if fallback_image_path is None:
                print(
                    "  [visualization] fallback product image unusable for "
                    f"{raw_fallback_image!r} -- "
                    + " | ".join(fallback_errors)
                )

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
# /pyapi PREFIX COMPATIBILITY
# ============================================================
# Vercel forwards requests under /pyapi/* to this ASGI app, but regular
# Serverless Functions still receive the original, unrewritten request
# path, so the bare routes above never match in production. Register the
# same handlers under /pyapi as well (no duplicated logic) so both the
# bare paths (local/Docker) and the /pyapi-prefixed paths (Vercel) work.
pyapi_router = APIRouter(prefix="/pyapi")
pyapi_router.add_api_route("/health", health, methods=["GET"])
pyapi_router.add_api_route(
    "/internal/visualizations", internal_visualization, methods=["POST"]
)
app.include_router(pyapi_router)


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


# ---------------------------------------------------------------------------
# Tile-only semantic validation + product aspect-ratio correction
#
# classify_image_content() above is a cheap, purely statistical pre-filter
# (see its docstring) -- it is blind to a tonally uniform lifestyle photo. A
# beige kitchen (slab worktop, matching cabinetry and splashback) measures a
# colour spread around 0.008, BELOW the range real product photos measure
# at, so no threshold on that signal can catch it without also rejecting
# genuine tiles. The already-approved fix for that -- a Gemini vision gate
# that judges what the image actually DEPICTS, plus a pure (no upscale, no
# synthesis) crop to the product's real physical aspect ratio -- already
# exists in this exact package: app/gemini_service.analyze_product_image and
# app/image_validator.validate_product_decision/validate_bbox, built for
# app/catalog_pipeline.py's separate entry point. This reuses those exact
# functions rather than standing up a second Gemini prompt/schema; only the
# aspect-ratio piece is new below, since no such correction exists anywhere
# in catalog_processor yet (only in the separate backend/python/ service).
#
# Deliberately NOT imported at module level: app.gemini_service raises
# RuntimeError at import time when GEMINI_API_KEY is absent, and THIS file
# is also the FastAPI visualization service's entry point (see
# `if __name__ == "__main__"` at the bottom) -- a top-level import here
# would make that service fail to even start without a key. Loaded once per
# catalog (not per image) inside extract_images_from_pdf instead.
# ---------------------------------------------------------------------------

# Scoped ONLY to pick the correction crop's target ratio -- never written to
# MASTER, the Tile table, or any product metadata field. The authoritative
# Dimensions value is still produced entirely by the existing, untouched
# classification pass; this is a purely internal, throwaway signal, same
# technique as the approved backend/python/extract.py implementation.
SIZE_TEXT_PATTERN = re.compile(r'(\d{2,4})\s*[xX×]\s*(\d{2,4})\s*(mm|cm)?', re.IGNORECASE)

MAX_LABEL_DISTANCE_PT = 260  # generous enough for a title above / spec line below a photo


def detect_nearby_size_text(text):
    """First WIDTHxHEIGHT match in nearby page text, or None."""
    match = SIZE_TEXT_PATTERN.search(text)
    if not match:
        return None
    return f"{match.group(1)}x{match.group(2)}"


def get_page_text_spans(page):
    """Text spans with their bounding boxes, in reading order.

    Span-level, not PyMuPDF's own block/line grouping -- block grouping
    merges same-row captions that are far apart horizontally (e.g. a
    "Decor" label under the left tile and a "Base" label under the right
    tile), which would let one image's nearby size text bleed into another
    image's crop decision on the same page.
    """
    spans = []
    for block in page.get_text('dict').get('blocks', []):
        if block.get('type') != 0:  # 0 = text block, 1 = image block
            continue
        for line in block.get('lines', []):
            for span in line.get('spans', []):
                text = span.get('text', '').strip()
                if text:
                    spans.append({'bbox': tuple(span['bbox']), 'text': text})
    return spans


def text_near_image(image_rect, text_spans, max_distance=MAX_LABEL_DISTANCE_PT):
    """Text spans near an image's rect, closest first -- a caption directly
    above/below the image ranks ahead of one merely nearby but off to the
    side, matching how catalog layouts actually caption a photo."""
    if not image_rect:
        return []
    ix0, iy0, ix1, iy1 = image_rect
    scored = []
    for span in text_spans:
        bx0, by0, bx1, by1 = span['bbox']
        if by0 >= iy1:
            vgap = by0 - iy1
        elif by1 <= iy0:
            vgap = iy0 - by1
        else:
            vgap = 0
        if vgap > max_distance:
            continue
        horizontally_aligned = min(bx1, ix1) - max(bx0, ix0) > 0
        scored.append((vgap, 0 if horizontally_aligned else 1, span))
    scored.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in scored]


def parse_product_aspect_ratio(size_text):
    """"NNNxNNN" -> width/height ratio, or None.

    Never guesses: a candidate with no nearby size text, or unparseable
    text, is left at whatever proportion it was extracted at rather than
    having a ratio invented for it.
    """
    if not size_text:
        return None
    match = re.match(r'^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)', size_text, re.IGNORECASE)
    if not match:
        return None
    width, height = float(match.group(1)), float(match.group(2))
    if width <= 0 or height <= 0:
        return None
    return width / height


# A source image's pixel ratio within this fraction of the product's real
# ratio is treated as already correct, avoiding a crop that would only ever
# shave a stray pixel off one edge for no benefit.
ASPECT_RATIO_TOLERANCE = 0.02


def crop_image_to_aspect_ratio(image, target_ratio):
    """Centre-crops a PIL Image to `target_ratio` (width/height), keeping
    every pixel of whichever dimension is already correct and trimming only
    the minimum needed from the other.

    Pure pixel selection: never scales, stretches, pads or generates
    content, so texture/colour/pattern/finish inside the kept region is
    byte-identical to the source. Returns the image unchanged when it
    already matches (within ASPECT_RATIO_TOLERANCE) or the ratio is
    unusable.

    Mirrors backend/python/extract.py's crop_to_aspect_ratio (the already-
    approved UI-upload-path implementation) rather than importing it:
    backend/python/ and catalog_processor/ are separate deployable services
    with disjoint dependencies and no shared module path.
    """
    if not target_ratio or target_ratio <= 0:
        return image

    width, height = image.size
    if width < 2 or height < 2:
        return image

    current_ratio = width / height
    if abs(current_ratio - target_ratio) / target_ratio <= ASPECT_RATIO_TOLERANCE:
        return image

    if current_ratio > target_ratio:
        # Wider than the product's true shape -- narrow the width only,
        # keep every row of height.
        new_width = min(width, max(1, round(height * target_ratio)))
        x0 = (width - new_width) // 2
        box = (x0, 0, x0 + new_width, height)
    else:
        # Taller than the product's true shape -- shorten the height only,
        # keep every column of width.
        new_height = min(height, max(1, round(width / target_ratio)))
        y0 = (height - new_height) // 2
        box = (0, y0, width, y0 + new_height)

    if box[2] - box[0] < 1 or box[3] - box[1] < 1:
        return image

    return image.crop(box)


# A bbox side smaller than this fraction of the frame is treated as
# degenerate (guards against a sliver crop from a malformed/tiny bbox).
MIN_BBOX_FRACTION = 0.10


def crop_image_to_validated_bbox(image, bbox):
    """Pure crop to a validate_bbox()-style pixel-space {x1,y1,x2,y2} dict.

    Deliberately does NOT call app.image_processor.crop_from_bbox: that
    helper upscales any crop whose short side is below 1200px
    (cv2.resize), which synthesises pixels not present in the source --
    exactly what this task must not do. This selects existing pixels only,
    same posture as crop_image_to_aspect_ratio above.
    """
    width, height = image.size
    x1 = max(0, min(width, round(bbox['x1'])))
    y1 = max(0, min(height, round(bbox['y1'])))
    x2 = max(0, min(width, round(bbox['x2'])))
    y2 = max(0, min(height, round(bbox['y2'])))

    if x2 - x1 < width * MIN_BBOX_FRACTION or y2 - y1 < height * MIN_BBOX_FRACTION:
        return image  # degenerate box -- keep the validated full frame instead

    if x1 <= 0 and y1 <= 0 and x2 >= width and y2 >= height:
        return image  # already full-frame, nothing to trim

    return image.crop((x1, y1, x2, y2))


def load_semantic_tile_validator():
    """Lazily imports the approved Gemini tile-vs-room validator.

    Returns (analyze_product_image, validate_product_decision, validate_bbox)
    or None when unavailable (no GEMINI_API_KEY, import failure) -- see the
    module note above for why this cannot be a top-level import here.
    """
    try:
        from app.gemini_service import analyze_product_image
        from app.image_validator import validate_product_decision, validate_bbox
        return analyze_product_image, validate_product_decision, validate_bbox
    except Exception as exc:  # noqa: BLE001 -- a missing key raises RuntimeError, not ImportError
        print(f"  [tile-validation] Semantic validation unavailable: {exc}")
        return None


def validate_and_correct_tile_image(output_path, image_rect, text_spans, semantic_validator):
    """Gates and corrects ONE already-saved candidate image in place.

    Returns (approved, reason). On rejection the caller deletes output_path
    and skips this candidate -- the fail-closed posture already approved
    for the UI-upload path: a candidate that cannot be positively confirmed
    as the real product is never kept, including when validation itself
    could not run (missing key, API error, quota, unreadable response).
    "Could not confirm" and "confirmed not a tile" are treated identically,
    because a wrong/lifestyle image reaching Drive/MASTER is worse than a
    missing one.
    """
    if semantic_validator is None:
        return False, 'semantic validation unavailable (GEMINI_API_KEY not configured) -- needs review'

    analyze_product_image, validate_product_decision, validate_bbox = semantic_validator

    nearby_text = '\n'.join(span['text'] for span in text_near_image(image_rect, text_spans)[:8])

    try:
        gemini_result = analyze_product_image(str(output_path), page_text=nearby_text)
    except Exception as exc:  # noqa: BLE001 -- never fail open, see docstring
        return False, f'Gemini validation failed ({exc}) -- needs review'

    # cv_score is accepted by validate_product_decision for signature
    # compatibility with its other caller (catalog_pipeline.py) but is not
    # read by its current decision logic (image_type + is_product_image
    # only) -- so it is not computed here. calculate_cv_score() reads the
    # file with OpenCV, whose build in this environment has no WebP
    # support (these candidates are saved as .webp), so calling it would
    # only add a silent-failure risk for a value that is discarded anyway.
    decision = validate_product_decision(None, gemini_result)
    if decision.get('decision') != 'APPROVED':
        return False, decision.get('reason') or 'not approved as a standalone tile product'

    with Image.open(output_path) as opened:
        opened.load()
        image = opened.convert('RGB') if opened.mode not in ('RGB', 'RGBA') else opened

        if gemini_result.product_bbox:
            bbox_check = validate_bbox(gemini_result.product_bbox, image.width, image.height)
            if bbox_check.get('valid'):
                image = crop_image_to_validated_bbox(image, bbox_check['bbox'])

        target_ratio = parse_product_aspect_ratio(detect_nearby_size_text(nearby_text))
        if target_ratio:
            image = crop_image_to_aspect_ratio(image, target_ratio)

        image.save(output_path, 'WEBP', quality=IMAGE_QUALITY, method=6)

    return True, decision.get('reason') or ''


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
    semantic_rejections = 0

    # Loaded once per PDF, not per image/page -- see the note on
    # load_semantic_tile_validator(). None means validation could not be
    # set up at all (e.g. no GEMINI_API_KEY); every candidate in this run
    # then fails closed via validate_and_correct_tile_image's own check.
    semantic_validator = load_semantic_tile_validator()
    if semantic_validator is None:
        print(
            "  [tile-validation] WARNING -- semantic tile validation is OFF for this "
            "catalog. Every extracted candidate will be rejected until GEMINI_API_KEY "
            "is configured (statistical filtering alone cannot reliably tell a tile "
            "from a lifestyle/room photo)."
        )

    for page_number, page in enumerate(
        document,
        start=1,
    ):

        # Cached once per page: get_page_text_spans() re-reads the whole
        # page's text layout, so computing it once and reusing it for every
        # image on the page (rather than once per image) avoids repeating
        # that work for a page with several tiles on it.
        text_spans = get_page_text_spans(page)

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

                    # Last gate, and the only one that judges what the
                    # image actually DEPICTS rather than how its pixels are
                    # statistically distributed (classify_image_content
                    # above) -- see validate_and_correct_tile_image. Also
                    # applies the product aspect-ratio correction in place
                    # on the same saved file when approved.
                    approved, validation_reason = validate_and_correct_tile_image(
                        output_path, image_rect, text_spans, semantic_validator,
                    )
                    if not approved:
                        semantic_rejections += 1
                        output_path.unlink(missing_ok=True)
                        print(
                            f"  [tile-validation] SKIPPED page {page_number} "
                            f"image {image_counter}: {validation_reason}"
                        )
                        continue

                    # validate_and_correct_tile_image may have cropped the
                    # saved file (bbox and/or aspect-ratio correction), so
                    # the recorded width/height must reflect the FINAL
                    # saved pixels, not the pre-crop ones above.
                    with Image.open(output_path) as corrected:
                        width, height = corrected.size

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
        f"duplicate(s), {room_photos_skipped} room/lifestyle photo(s) (statistical), "
        f"and {semantic_rejections} rejected by tile-only validation"
    )

    if semantic_validator is None and not extracted_images and semantic_rejections > 0:
        print(
            "  [tile-validation] ERROR -- every candidate was rejected because semantic "
            "validation is unavailable. Configure GEMINI_API_KEY before assuming this "
            "catalog has no tiles."
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
    sync_failed_count = 0

    for image in images:

        product_id = make_product_id(
            brand,
            catalog,
            image["image_index"],
        )

        # Duplicate identity: path+filename ALONE (the previous behaviour)
        # means a re-run of the same PDF always skips every image, even
        # when what was actually saved for that page/slot has changed --
        # e.g. re-extracting after the tile-only validation/aspect-ratio
        # fix above now saves a different, better crop for the same
        # filename. Folding in a SHA-256 of the SAVED image's own bytes
        # fixes that: an unchanged image still hashes identically (still
        # skipped, no wasted re-upload); a changed/improved image for the
        # same page/slot hashes differently and is treated as new below --
        # re-uploaded, re-synced, and made available to the backend. Old
        # processed_files rows, old Drive files and old MASTER rows are
        # never touched or deleted by this -- it only changes what KEY a
        # run computes going forward.
        try:
            image_content_hash = hashlib.sha256(
                Path(image["path"]).read_bytes()
            ).hexdigest()
        except OSError:
            # The saved file is unexpectedly missing -- fall back to the
            # old path-only identity rather than crashing the whole run.
            image_content_hash = "unreadable"

        file_hash = (
            f"{pdf_path.resolve()}::"
            f"{image['filename']}::"
            f"{image_content_hash}"
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
        synced = sync_master_product_to_backend(
            product_code=product_id,
            brand=brand,
            image_url=drive_url,
        )

        # Same rule the sheet write above follows, for the same reason: a
        # product that did NOT reach its destination must not be recorded
        # as processed. sync_master_product_to_backend returns None for
        # every failure mode -- no INTERNAL_SYNC_API_KEY configured, an
        # unreachable BACKEND_SYNC_URL, a non-2xx response -- and marking
        # those as done strands the product permanently: already_processed()
        # skips it on every later run, so it can never reach the Tile table
        # even once the sync is configured correctly, and the mood board
        # never sees it. Leaving it unmarked costs a repeat Drive upload on
        # the next run (the MASTER row itself is already protected by
        # append_unique_row) and is the only thing that lets the product
        # arrive at all.
        if synced is None:
            sync_failed_count += 1

            print(
                f"BACKEND SYNC FAILED for {product_id} "
                f"(image in Drive, MASTER row written, Tile row NOT "
                f"created, will retry next run)"
            )

            continue

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

    print(
        f"Backend sync fail: {sync_failed_count}"
    )

    # A run where every product reached Drive and MASTER but none reached
    # Postgres otherwise looks like a complete success -- the mood board
    # simply never shows the new tiles, with nothing in the output saying
    # why. Called out explicitly instead.
    if sync_failed_count and not uploaded_count:
        print("")
        print(
            "ERROR -- no product from this catalog reached the backend Tile "
            "table, so none of them can appear in a mood board. Check that "
            "INTERNAL_SYNC_API_KEY is set (it is blank by default) and that "
            "BACKEND_SYNC_URL points at the deployed backend rather than the "
            "default localhost:5000."
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