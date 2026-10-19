


import os
import re
import sys
import contextlib
import csv
import json
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

# ============================================================
# TERMINAL OUTPUT
#
# Two channels, because a catalog run has two audiences.
#
# NORMAL (default) shows what was extracted: company, product, image,
# upload, and a final tally. Everything else -- per-candidate geometry,
# classification internals, region trails, the model's own diagnostics --
# is developer material and is suppressed.
#
# DEBUG (CATALOG_DEBUG=1) restores all of it, unchanged.
#
# The suppression is done at the boundary rather than at the ~200 print
# sites, so no extraction logic is touched to achieve it. Lines that
# look like errors are passed through even in NORMAL mode: a quiet run
# must still be a truthful one.
# ============================================================

CATALOG_DEBUG = os.getenv("CATALOG_DEBUG", "").strip().lower() in (
    "1", "true", "yes", "on",
)

# TILE-ONLY CATALOG MODE.
#
# The catalogs fed to this pipeline are prepared upstream so that their
# pages carry nothing but product surfaces -- no rooms, no lifestyle
# photography, no people, no fittings, no marketing layouts, no logos,
# no specification pages. That preparation is a CONTRACT, and it changes
# which way the pipeline should fail.
#
# Against a raw manufacturer catalog the expensive mistake is a false
# ACCEPT: one bathroom photo reaching Drive is worse than one tile
# missed, so the semantic gates were built to reject on doubt. Against a
# pre-filtered catalog that same posture is simply wrong. There is no
# bathroom photo to keep out, so every rejection it produces is a
# product lost, and "Gemini called this ARTWORK" stops being evidence of
# anything -- the source has already answered the question the gate is
# asking.
#
# Soft classifier mislabels on an otherwise clean swatch may be overridden
# so a false "ARTWORK"/"OTHER" name does not delete a real tile. Hard
# evidence still rejects: architecture/frames, room scenes, furniture,
# hardware, windows, non-tile materials, low tile fraction, and multi-
# product frames (which are split, not saved whole). Geometry/size/save
# failures also still reject.
#
# Off by CATALOG_TILE_ONLY=0 for a mixed or unprepared catalog, which
# restores every semantic gate exactly as it was.
TILE_ONLY_CATALOG = os.getenv("CATALOG_TILE_ONLY", "1").strip().lower() in (
    "1", "true", "yes", "on",
)

# Substrings that mark a line as actionable rather than diagnostic.
# Matched case-insensitively against each suppressed line.
ERROR_MARKERS = (
    "error", "failed", "failure", "cannot", "could not", "unable",
    "traceback", "exception", "denied", "missing", "unavailable",
    "quota", "rate limit", "not configured", "skipped:", "warning",
    "\u274c",
)


class _QuietStream:
    """Drops diagnostic stdout, lets anything error-shaped through.

    Line-buffered: text is accumulated until a newline so a marker is
    matched against the whole line rather than whichever fragment
    happened to arrive in one write() call.
    """

    def __init__(self, destination):
        self._destination = destination
        self._pending = ""

    def write(self, text):
        self._pending += text
        while "\n" in self._pending:
            line, self._pending = self._pending.split("\n", 1)
            if any(marker in line.lower() for marker in ERROR_MARKERS):
                self._destination.write(line + "\n")
        return len(text)

    def flush(self):
        self._destination.flush()

    def __getattr__(self, name):
        return getattr(self._destination, name)


@contextlib.contextmanager
def quiet_stage():
    """Suppresses diagnostic output for the duration of a stage."""
    if CATALOG_DEBUG:
        yield
        return

    real = sys.stdout
    sys.stdout = _QuietStream(real)
    try:
        yield
    finally:
        sys.stdout.flush()
        sys.stdout = real


def emit(message=""):
    """Writes a user-facing line, bypassing any active suppression.

    Uses the process's original stdout so the clean hierarchy survives
    inside quiet_stage(), which is where extraction -- and therefore
    every per-tile line -- actually runs.
    """
    stream = sys.__stdout__ or sys.stdout
    stream.write(f"{message}\n")
    stream.flush()


def diag(message=""):
    """Writes a per-candidate diagnostic line. DEBUG runs only.

    These lines were already meant to be developer-only -- they went
    through print() and relied on quiet_stage() to swallow them. That
    worked until one of them said "cutting it up CANNOT make it a
    tile": "cannot" is in ERROR_MARKERS, so a perfectly ordinary
    decision line was mistaken for an error and printed twelve times on
    a single page. Saying "this is a diagnostic" outright is not
    subject to the wording of the sentence.
    """
    if CATALOG_DEBUG:
        print(message)



try:
    from googleapiclient.http import MediaIoBaseDownload
except ImportError:
    MediaIoBaseDownload = None

from fastapi import APIRouter, FastAPI
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional
import uvicorn

from app.visualization_api import (
    create_visualization,
)

from app.database import (
    initialize_database,
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
    preflight_internal_sync,
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

    # The rest of the mood-board combination: the highlight, accent and
    # any other selected material, each as
    # {role, image_url|image_path, product_id, name}. Optional, so every
    # existing single-tile caller is unaffected; when present, every
    # entry is resolved to a local image below and sent to the generator
    # alongside the base, which is what stops a three-material board
    # rendering as a one-material bathroom.
    materials: Optional[List[Dict[str, Any]]] = None

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
        def resolve_product_image(raw_image, label):
            """A product image (not a scene) -> a local path, or None.

            Lifted out of the fallback block below unchanged so the
            mood-board materials can use exactly the same resolution,
            including the Drive authentication step -- a highlight tile
            lives in the same private folder the base does, and a second,
            simpler resolver here would fail on every one of them.
            """
            raw_image = str(raw_image or "").strip()
            if not raw_image:
                return None

            resolvers = []

            if raw_image.lower().startswith(("http://", "https://")):
                from app.product_visualization_service import (
                    _download_remote_product_image,
                )
                resolvers.append(_download_remote_product_image)

            resolvers.append(resolve_scene_image)

            errors = []

            for resolve in resolvers:
                try:
                    return str(resolve(raw_image))
                except Exception as error:
                    errors.append(
                        f"{getattr(resolve, '__name__', 'resolver')}: {error}"
                    )

            # Swallowing every failure silently is what made this so hard
            # to diagnose: the request went on to fail with the generic
            # "does not exist in MASTER" message, giving no hint that a
            # fallback had been attempted at all, let alone why it failed.
            print(
                f"  [visualization] {label} image unusable for "
                f"{raw_image!r} -- " + " | ".join(errors)
            )
            return None

        fallback_image_path = resolve_product_image(
            request.fallback_image_url, "fallback product",
        )

        # EVERY SELECTED MATERIAL, RESOLVED.
        #
        # An entry whose image cannot be fetched is dropped here with a
        # named reason rather than passed on as a promise the generator
        # cannot keep -- but it is the only thing dropped: the rest of
        # the combination still renders.
        resolved_materials = []

        for material in (request.materials or []):
            if not isinstance(material, dict):
                continue

            role = str(material.get("role") or "").strip().lower()

            image_path = resolve_product_image(
                material.get("image_url") or material.get("image_path"),
                f"{role or 'material'} product",
            )

            if image_path is None:
                continue

            resolved_materials.append({
                "role": role,
                "image_path": image_path,
                "product_id": str(material.get("product_id") or "").strip(),
                "name": str(material.get("name") or "").strip(),
                "size": str(material.get("size") or "").strip(),
                "finish": str(material.get("finish") or "").strip(),
            })

        if request.materials:
            print(
                f"  [visualization] combination: "
                f"{len(resolved_materials)}/{len(request.materials)} "
                f"material(s) resolved -- "
                + ", ".join(
                    m["role"] or "?" for m in resolved_materials
                )
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
                "materials": resolved_materials or None,
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

OUTPUT_DIR = Path(
    os.getenv("CATALOG_OUTPUT_ROOT")
    or "output"
)

IMAGE_QUALITY = 85
# WHAT COUNTS AS TOO SMALL TO BE A PRODUCT.
#
# These used to be a flat "both sides >= 200px", which quietly deleted
# narrow products: a 75x300mm subway tile is a long thin rectangle, and
# its embedded image is routinely under 200px on the short side while
# being far bigger than any icon overall. Those candidates vanished
# before anything counted or logged them, which is why a catalog could
# come back with far fewer tiles than it visibly contains.
#
# A real product is big in at least one direction AND has real area. An
# icon or a bullet is small in BOTH directions, so it still goes.
MIN_IMAGE_LONG_SIDE = 200
MIN_IMAGE_SHORT_SIDE = 64
MIN_IMAGE_AREA = 150 * 150

# Kept so existing callers and tests that import these names still work.
MIN_IMAGE_WIDTH = 200
MIN_IMAGE_HEIGHT = 200


def is_too_small_for_a_product(width, height):
    """True when a candidate is too small to be a catalog product."""
    if width <= 0 or height <= 0:
        return True
    return (
        max(width, height) < MIN_IMAGE_LONG_SIDE
        or min(width, height) < MIN_IMAGE_SHORT_SIDE
        or (width * height) < MIN_IMAGE_AREA
    )

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


def size_folder_name(raw_size):
    """Drive folder name for a tile's printed size.

    The hierarchy a catalog is actually browsed by is company, then
    catalog, then size -- "show me the 600x1200s" is the question a
    showroom asks, and a flat folder of 200 files cannot answer it.
    Brand and catalog folders already existed; this is the third level.

    The size here is whatever was read off the page next to the product
    (detect_nearby_size_text), so it arrives in whatever form the
    catalog printed it: "600X1200", "600 x 1200 mm", "60x120cm". They
    are folded to one spelling so the same size does not become three
    folders. A product whose page printed no size is NOT guessed at --
    it goes to a named folder of its own, where it is findable and
    obviously unclassified, rather than into a plausible-looking wrong
    one.
    """
    text = str(raw_size or "").strip().upper()
    if not text:
        return "SIZE-NOT-LISTED"

    match = SIZE_TEXT_PATTERN.search(text)
    if not match:
        cleaned = re.sub(r"[^A-Z0-9]+", "-", text).strip("-")
        return cleaned or "SIZE-NOT-LISTED"

    width, height, unit = match.group(1), match.group(2), match.group(3)
    unit = (unit or "MM").upper()
    return f"{width}X{height}{unit}"


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


# DPI for the whole-page render used by the fallback below. Deliberately
# lower than render_image_crop's 300: this rasterizes an ENTIRE page
# rather than one swatch box, and the regions cut out of it are a fraction
# of it. At 200 DPI an A4 page is ~1654x2339, so a surface covering a
# third of the page still yields roughly 550x780 -- comfortably past the
# minimum side, without holding a 300 DPI full-page bitmap per page.
PAGE_RENDER_DPI = 200


def page_has_visual_content(page):
    """True when a page has anything a tile could be drawn with.

    The page-render fallback costs one Gemini call, so it must not fire on
    pages that are purely text -- an index, a price list, a foreword. A
    page with no embedded images AND no vector drawings cannot be showing
    a tile, whatever else is on it.
    """
    try:
        if page.get_images(full=True):
            return True
    except Exception:  # noqa: BLE001
        return True  # can't tell -- let the fallback decide

    try:
        return bool(page.get_drawings())
    except Exception:  # noqa: BLE001
        return True


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

BANNER_ASPECT_RATIO = 4.0
PAGE_DOMINANT_FRACTION = 0.85
# Match app.image_filter: reject width/height outside [0.25, 4.0].
MAX_CANDIDATE_ASPECT_RATIO = 4.0
MIN_CANDIDATE_ASPECT_RATIO = 0.25
# Tiny fragment relative to the page (paired with other signals, not alone).
MIN_PAGE_REGION_FRACTION = 0.008

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


def early_reject_candidate(width, height, image_bytes=None, image_rect=None,
                           page_rect=None):
    """Conservative pre-Gemini reject; delegates to app.image_filter."""
    decoded = None
    if image_bytes:
        try:
            import cv2
            import numpy as _np

            arr = _np.frombuffer(image_bytes, dtype=_np.uint8)
            decoded = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        except Exception:  # noqa: BLE001 -- filter is optional
            decoded = None

    region_area = None
    page_area = None
    if image_rect is not None and page_rect is not None:
        ix0, iy0, ix1, iy1 = image_rect
        region_area = max(0.0, (ix1 - ix0) * (iy1 - iy0))
        page_area = float(page_rect.width * page_rect.height)

    try:
        from app.image_filter import early_reject_region
    except Exception:  # noqa: BLE001
        # Fallback: aspect only, matching MAX/MIN_CANDIDATE_ASPECT_RATIO.
        if width <= 0 or height <= 0:
            return True, "invalid dimensions"
        aspect = width / float(height)
        if aspect > MAX_CANDIDATE_ASPECT_RATIO:
            return True, f"too_wide (aspect {aspect:.2f})"
        if aspect < MIN_CANDIDATE_ASPECT_RATIO:
            return True, f"too_tall (aspect {aspect:.2f})"
        return False, ""

    return early_reject_region(
        width, height,
        image_bgr=decoded,
        region_area=region_area,
        page_area=page_area,
    )

# ---------------------------------------------------------------------------
# Early hard filters -- conservative, pre-Gemini rejection.
#
# classify_image_content() above never fully rejects a candidate; it only
# chooses which search path to take (a room photo may still hide a tiled
# wall, so it goes to region-mining instead of being judged whole). These
# two filters are different: pure solid-colour graphics and blocks of
# printed text have NO tile surface anywhere inside them, so there is
# nothing a region search could recover, and the candidate is dropped
# before either a whole-image or a region-mining Gemini call is spent on
# it.
#
# Both are deliberately conservative, in the same spirit as
# classify_image_content's own stated posture: a false reject here
# silently loses a real product, so each threshold was set against
# measured values for genuine (if plain) photographed tiles -- including
# a two-tone geometric mosaic and a fine small-repeat pattern, the two
# shapes closest to "looks like a solid colour" or "looks like text" --
# and left with a wide, empirically-checked margin on the side that
# protects a real product. Not calibrated against a real catalog; tune
# against real extraction output if either proves too strict or too
# loose, but only by moving further AWAY from a real tile's measured
# range, never by splitting the difference.
# ---------------------------------------------------------------------------

# A genuine flat colour fill (a highlighter-style annotation bar, a solid
# graphic rectangle) measured pixel_std 0.00002-0.00007 across several
# colours. The plainest, most evenly lit SYNTHETIC "photograph" tested --
# unrealistically clean, far cleaner than real sensor noise -- still
# measured 0.0032 and up. 0.0005 sits roughly 7x above the flat-fill
# ceiling and 6x below that photographic floor.
FLAT_GRAPHIC_MAX_PIXEL_STD = 0.0005

# Edge density was 0.0 for every flat fill AND for several genuinely
# smooth real tiles (no grout, no pattern) alike, so on its own this
# cannot tell them apart -- pixel_std above does the real work. Kept as a
# second, independent requirement anyway (defence in depth: both signals
# must agree), generous enough that it is never the limiting factor.
FLAT_GRAPHIC_MAX_EDGE_DENSITY = 0.002


def measure_image_flatness(image_bytes):
    """Whole-frame colour variation and edge density. Returns None if the
    image can't be read -- callers treat that as "no opinion" and keep
    the image.

    Deliberately NOT the region-grid average measure_image_content()
    uses: a flat vector fill and a photographed tile can read the same
    at THAT scale (both look visually uniform once averaged into 8x8
    blocks). What actually separates them is per-pixel noise, which a
    real photograph always carries and a flat fill does not -- so this
    measures variation across every pixel instead.
    """
    try:
        import cv2
        import numpy as np

        with Image.open(BytesIO(image_bytes)) as source:
            source = source.convert("RGB")
            source.thumbnail((256, 256))
            rgb = np.asarray(source, dtype=np.uint8)
    except Exception:  # noqa: BLE001
        return None

    if rgb.ndim != 3 or min(rgb.shape[:2]) < 16:
        return None

    pixels = rgb.astype(np.float32) / 255.0
    pixel_std = float(pixels.reshape(-1, 3).std(axis=0).mean())

    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(gray, 50, 150)
    edge_density = float(np.mean(edges > 0))

    return {"pixel_std": pixel_std, "edge_density": edge_density}


def is_flat_graphic_image(image_bytes):
    """True when `image_bytes` is an almost perfectly solid colour block
    -- a highlighter-style annotation bar or a flat vector-drawn graphic
    -- rather than a photograph of a product. Returns (reject, reason).

    Conservative on purpose: BOTH signals must independently read as
    "nothing here". Requiring agreement, rather than either alone, is
    what keeps a genuinely plain, flatly-lit tile (which can still trip
    one signal in isolation) from being rejected.
    """
    metrics = measure_image_flatness(image_bytes)
    if metrics is None:
        return False, ""

    if (
        metrics["pixel_std"] <= FLAT_GRAPHIC_MAX_PIXEL_STD
        and metrics["edge_density"] <= FLAT_GRAPHIC_MAX_EDGE_DENSITY
    ):
        return True, (
            f"reads as a solid colour bar/graphic, not a photographed "
            f"product (pixel variation {metrics['pixel_std']:.5f}, "
            f"edge density {metrics['edge_density']:.4f})"
        )

    return False, ""


# Printed body text measured ink_fraction 0.02-0.06 across a dense
# paragraph, a sparse price list and a ruled spec table. Every
# photographed tile tested -- plain, grouted, marble, a two-tone
# geometric mosaic, a fine small-repeat pattern -- measured 0.40 and up:
# Otsu splits photographic sensor noise roughly in half, however little
# noise there visibly is, which keeps this gap wide and reliable. 0.20
# sits more than 3x above the text ceiling and more than 2x below the
# lowest tile measured.
#
# Component SIZE/AREA was tried and dropped: the same sensor noise that
# inflates ink_fraction on a plain tile also scatters it into hundreds of
# tiny specks, so a photographed tile's "small marks" area overlapped a
# sparse text block's. ink_fraction alone showed no such overlap across
# every case tested, so it carries this filter; component count is kept
# only as a sanity floor, not a discriminator.
TEXT_MIN_INK_FRACTION = 0.01
TEXT_MAX_INK_FRACTION = 0.20
TEXT_MIN_SMALL_COMPONENTS = 50

# A connected component taller than this fraction of the frame is a
# design element (a pattern tile, a large logo), not a single glyph.
TEXT_CHAR_MAX_HEIGHT_FRACTION = 0.05

# Resize ceiling for the connected-components pass below: large enough
# to keep character-scale structure legible, small enough to stay cheap
# per candidate (this runs before every Gemini call, not just once).
TEXT_ANALYSIS_MAX_SIDE = 900


def measure_text_likeness(image_bytes):
    """Ink coverage and small-mark count, used to recognise a block of
    printed text. Returns None if the image can't be read -- callers
    treat that as "no opinion" and keep the image.
    """
    try:
        import cv2
        import numpy as np

        with Image.open(BytesIO(image_bytes)) as source:
            source = source.convert("L")
            longest_side = max(source.size)
            if longest_side > TEXT_ANALYSIS_MAX_SIDE:
                scale = TEXT_ANALYSIS_MAX_SIDE / longest_side
                source = source.resize((
                    max(1, round(source.width * scale)),
                    max(1, round(source.height * scale)),
                ))
            gray = np.asarray(source, dtype=np.uint8)
    except Exception:  # noqa: BLE001
        return None

    if gray.ndim != 2 or min(gray.shape) < 16:
        return None

    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Orient so "foreground" (255) is the MINORITY class -- printed text
    # is sparse ink on a dominant background, whichever way Otsu happened
    # to assign black/white.
    ink_fraction = float(np.mean(binary == 255))
    if ink_fraction > 0.5:
        binary = 255 - binary
        ink_fraction = 1.0 - ink_fraction

    num_labels, _labels, stats, _centroids = cv2.connectedComponentsWithStats(
        binary, connectivity=8,
    )
    # Component 0 is the background label.
    heights = stats[1:, cv2.CC_STAT_HEIGHT]
    char_max_height = max(3, round(gray.shape[0] * TEXT_CHAR_MAX_HEIGHT_FRACTION))
    small_mask = (heights > 0) & (heights <= char_max_height)

    return {
        "ink_fraction": ink_fraction,
        "small_component_count": int(np.count_nonzero(small_mask)),
    }


def is_mostly_text_image(image_bytes):
    """True when `image_bytes` is almost entirely printed text -- a
    scanned/rendered paragraph, price list or spec table saved as a
    picture -- rather than a product photograph. Returns (reject, reason).

    Conservative on purpose: ink_fraction has to land inside the band
    real printed text measured, not merely be "present", and there has
    to be real small-mark structure behind it (not one caption word).
    """
    metrics = measure_text_likeness(image_bytes)
    if metrics is None:
        return False, ""

    looks_like_text = (
        metrics["small_component_count"] >= TEXT_MIN_SMALL_COMPONENTS
        and TEXT_MIN_INK_FRACTION <= metrics["ink_fraction"] <= TEXT_MAX_INK_FRACTION
    )

    if not looks_like_text:
        return False, ""

    return True, (
        f"reads as a block of printed text, not a product photograph "
        f"({metrics['small_component_count']} small marks, "
        f"{metrics['ink_fraction']:.1%} ink coverage)"
    )


# CUTTING A FRAME UP IS OFF.
#
# The splitter exists to rescue a quad that merged two products: cut
# it along the seam and judge each side. Every version of that has
# eventually cut a real tile instead -- the seam splitter at a panel's
# moulding, the gutter finder at a panel's own pale border -- and the
# catalog owner's requirement is not "cut well", it is "one whole tile
# per image, never a piece of one".
#
# So no frame is cut. A frame that holds more than one product is
# refused instead, which loses it rather than publishing half a tile
# or a picture of two. With quads now snapped to the product they sit
# on (grow_to_whole_product), a merged quad is the exception rather
# than the rule, and on the run that prompted this every piece the
# splitter produced was a duplicate of a tile already extracted.
#
# Set this True to put the splitter back. Everything it needs is still
# here and still tested; only this gate stands in front of it.
SPLIT_MERGED_FRAMES = False


# The same product, found again on a LATER page.
#
# Tighter than the within-page CONTENT_SIGNATURE_MAX_DIFFERENCE (0.03) on
# purpose. Measured in app/tile_region_extractor.py: one tile pushed
# through both rasterization paths differs by 0.001-0.002, while two
# siblings of a single range (a base tile and its highlighter, the pair a
# catalog prints side by side) measure about 0.011 apart. 0.005 sits
# between the two, so a genuine repeat merges and two real products never
# do -- a false merge here deletes a product from the catalog, which is
# the worse error of the two.
CATALOG_DUPLICATE_MAX_DIFFERENCE = 0.005


def classify_hard_reject(image_bytes):
    """Either early filter firing. Returns (reject, reason)."""
    reject, reason = is_flat_graphic_image(image_bytes)
    if reject:
        return True, reason
    return is_mostly_text_image(image_bytes)


# A real catalog sells elongated products at their true shape -- a strip,
# listello or border tile, or a wood-look plank, can legitimately be a
# narrow rectangle (app/image_validator.py's DECORATIVE_PRODUCT_MATERIALS
# names STRIP/STRIP_TILE and LISTELLO/LISTELLO_TILE as real products, and
# even a 1200x200mm plank photographed at its own proportions is 6:1).
# This threshold sits well above that: it only catches the kind of
# fragment the reported failure actually described -- a sliver of
# furniture leg, a decorative page rule, or a mis-clipped edge of a larger
# graphic -- which run far thinner than any genuine catalog product shot.
# MIN_IMAGE_WIDTH/MIN_IMAGE_HEIGHT above already floor each side on its
# own, but neither one looks at the other, so a 200x2000px sliver passes
# both floors individually while still being nothing a camera was ever
# pointed at a product to produce.
THIN_STRIP_MAX_ASPECT_RATIO = 8.0


def is_thin_strip_image(width, height):
    """True when the raw pixel dimensions are an extreme sliver -- a
    furniture leg, a decorative rule, or a clipping fragment -- rather
    than a photographed product. Dimension-only, so it is cheap enough
    to run before any pixel decode. Returns (reject, reason).
    """
    if width <= 0 or height <= 0:
        return False, ""

    ratio = max(width, height) / min(width, height)
    if ratio > THIN_STRIP_MAX_ASPECT_RATIO:
        return True, (
            f"{width}x{height}px is an extreme {ratio:.1f}:1 sliver, not "
            f"a photographed product"
        )
    return False, ""


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

# Picks the correction crop's target ratio, and is also reported upward as
# the product's detected size so the synced Tile row is not left with a NULL
# size (an unclassified tile scores far below a classified one when mood
# board candidates are ranked). Never written to MASTER: the authoritative
# Dimensions value there is still produced entirely by the existing,
# untouched classification pass. Same technique as the approved
# backend/python/extract.py implementation.
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

# The least of a product the aspect correction may leave behind. Trimming
# a slight mismatch is the job; removing a tenth of the product means the
# label does not describe this picture, and the picture is the evidence
# that was actually measured. See the call site in
# validate_and_correct_tile_image.
MAX_ASPECT_CORRECTION_LOSS = 0.90


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


# A PRODUCT BOX MAY REMOVE BACKGROUND. IT MAY NOT CUT THE PRODUCT.
#
# crop_image_to_validated_bbox cuts to whatever box the classifier
# returned, and the only guard was MIN_BBOX_FRACTION, which asks merely
# that the box not be a sliver. A box keeping the middle 70% of a
# highlighter passes that easily -- and a highlighter's decorative top
# and bottom bands ARE the product, so the saved tile lost both ends.
# That is what "upper border and lower border are being removed" was.
#
# The classifier's box cannot be trusted to know where a product ends:
# the comment above this call site already says the classifier
# routinely cannot even recognise a bare swatch. So the pixels decide
# instead. For every side the box trims, two things must hold of the
# band being discarded:
#
#   * it is FLAT -- a page background, not surface detail; and
#   * there is a real EDGE where the cut falls -- what is being thrown
#     away does not look like what is being kept.
#
# Measured on this repo's own single_catalog pages (a moulded panel, a
# floral panel, a plain cream tile) plus a synthetic highlighter, each
# on pale and dark pages at image noise sigma 0..5:
#
#   legitimate trims (box tight on the product, page around it)
#       edge contrast  13.0 .. 349.0      band std  0.00 .. 2.71
#   trims that cut into the product (centre 70/85/92/96/98%, insets)
#       edge contrast   0.1 ..  22.9      band std  1.36 .. 23.2
#
# Neither statistic separates them alone -- a near-white tile on a white
# page has almost no edge, and a plain tile's interior is as flat as any
# background. Together they do: 36/36 legitimate trims allowed and 0/28
# product cuts allowed, over the whole plateau contrast 2..12 with band
# std 4..6. The thresholds sit inside it, the nearest failure being
# contrast 13 (legitimate trims start being refused) and band std 7 (a
# product cut slips through).
BBOX_TRIM_EDGE_CONTRAST_MIN = 8.0
BBOX_TRIM_BAND_FLATNESS_MAX = 5.0

# Thickness of the strips compared either side of a cut, as a fraction
# of the image's shorter side. Two pixels minimum: one row is noise.
BBOX_TRIM_BAND_FRACTION = 0.01


def bbox_trim_only_removes_background(image, bbox):
    """Is this product box trimming background, or cutting the product?

    Returns (True, "") when every side the box trims discards flat
    background across a real edge, and (False, reason) when any trimmed
    side cuts through continuous material -- in which case the caller
    keeps the whole validated frame, because losing some background
    beats losing the product's own border.

    A box that trims nothing is allowed trivially. Failing to measure
    (an unreadable band, a degenerate box) is allowed too: this guard
    exists to stop a specific, measured kind of damage, not to become a
    new way to lose images.
    """
    import numpy as np

    try:
        frame = np.asarray(image.convert("RGB"), dtype=np.float32)
    except Exception:  # noqa: BLE001 -- never fail a save over a check
        return True, ""

    if frame.ndim != 3 or frame.size == 0:
        return True, ""

    height, width = frame.shape[:2]
    x1 = max(0, min(width, int(round(bbox["x1"]))))
    y1 = max(0, min(height, int(round(bbox["y1"]))))
    x2 = max(0, min(width, int(round(bbox["x2"]))))
    y2 = max(0, min(height, int(round(bbox["y2"]))))

    if x2 - x1 < 2 or y2 - y1 < 2:
        return True, ""

    thickness = max(2, int(round(min(height, width) * BBOX_TRIM_BAND_FRACTION)))

    sides = (
        ("top", frame[max(0, y1 - thickness):y1, x1:x2],
         frame[y1:y1 + thickness, x1:x2], y1 > 0),
        ("bottom", frame[y2:min(height, y2 + thickness), x1:x2],
         frame[y2 - thickness:y2, x1:x2], y2 < height),
        ("left", frame[y1:y2, max(0, x1 - thickness):x1],
         frame[y1:y2, x1:x1 + thickness], x1 > 0),
        ("right", frame[y1:y2, x2:min(width, x2 + thickness)],
         frame[y1:y2, x2 - thickness:x2], x2 < width),
    )

    for name, discarded, kept, trimmed in sides:
        if not trimmed or discarded.size == 0 or kept.size == 0:
            continue

        contrast = float(np.linalg.norm(
            discarded.reshape(-1, 3).mean(axis=0)
            - kept.reshape(-1, 3).mean(axis=0)
        ))
        flatness = float(discarded.reshape(-1, 3).mean(axis=1).std())

        if flatness > BBOX_TRIM_BAND_FLATNESS_MAX:
            return False, (
                f"the {name} band it would discard has detail in it "
                f"(variation {flatness:.1f}, above "
                f"{BBOX_TRIM_BAND_FLATNESS_MAX:.0f}) -- that is product "
                f"surface, not page background"
            )
        if contrast < BBOX_TRIM_EDGE_CONTRAST_MIN:
            return False, (
                f"there is no edge at the {name} cut (contrast "
                f"{contrast:.1f}, below "
                f"{BBOX_TRIM_EDGE_CONTRAST_MIN:.0f}) -- the box cuts "
                f"through continuous surface"
            )

    return True, ""


def crop_image_to_validated_bbox(image, bbox):
    """Pure crop to a validate_bbox()-style pixel-space {x1,y1,x2,y2} dict.

    Deliberately does NOT call app.image_processor.crop_from_bbox during
    validation: that helper also letterboxes onto the output canvas, which
    must happen AFTER purity judging (padding would lower tile_fraction).
    This selects existing pixels only, same posture as
    crop_image_to_aspect_ratio above.
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


def present_tile_on_canvas(image_path):
    """Rewrite an approved tile onto the standard square output canvas.

    Preserves aspect ratio; never upscales past source pixels. Applied
    only after approval so purity/Gemini still judge the raw crop.
    Returns True when the file was rewritten, False on skip/failure.
    """
    try:
        import cv2
        from app.image_processor import fit_to_output_canvas
    except Exception:  # noqa: BLE001
        return False

    path = Path(image_path)
    try:
        with Image.open(path) as opened:
            opened.load()
            rgb = opened.convert("RGB")
            bgr = cv2.cvtColor(
                __import__("numpy").asarray(rgb),
                cv2.COLOR_RGB2BGR,
            )
        presented = fit_to_output_canvas(bgr)
        Image.fromarray(
            cv2.cvtColor(presented, cv2.COLOR_BGR2RGB)
        ).save(path, "WEBP", quality=IMAGE_QUALITY, method=6)
        return True
    except Exception as exc:  # noqa: BLE001 -- presentation must not kill accept
        print(f"  [canvas] could not standardize {path.name}: {exc}")
        return False


# Buckets a validator rejection reason into one of the operator-facing
# categories, purely for the end-of-catalog report. Ordered most specific
# first: an "installed in a bathroom" reason should read as an installation,
# not as a room photo. Never changes a decision -- only how it is described.
REJECTION_CATEGORIES = (
    ("installed wall/floor scene", (
        "installed", "installation", "wall scene", "floor scene",
        "mounted", "applied to", "in situ",
    )),
    ("bathroom/room/lifestyle image", (
        "bathroom", "kitchen", "bedroom", "living", "room interior",
        "lifestyle", "interior", "restaurant", "cafe", "architectural",
        "render", "scene",
    )),
    ("sanitaryware/fitting, not a tile", (
        "basin", "toilet", "wc", "urinal", "bathtub", "shower", "faucet",
        "tap", "mixer", "sanitaryware", "mirror", "fitting", "accessory",
    )),
    ("furniture", ("furniture", "sofa", "cabinet", "table", "chair")),
    ("decorative artwork/mosaic", (
        "artwork", "mosaic", "decorative", "mural",
    )),
    ("human/face", ("human", "face", "person", "people", "model")),
    ("multiple products in one image", (
        "multiple", "more than one", "several products", "product_count",
        "collage", "mix & match", "catalog page", "page layout",
    )),
    ("logo/text/marketing graphic", (
        "logo", "banner", "advertisement", "text graphic", "graphic",
        "brand mark", "colour chart", "color chart", "palette",
    )),
    ("validation could not run", (
        "gemini_api_key", "validation unavailable", "validation failed",
        "needs review", "quota",
    )),
)


def categorize_rejection(reason):
    """Maps a free-text rejection reason onto a short operator-facing label.

    Two rules, both learned from real misreports:

    Matches on WORD boundaries, not raw substrings. Short keywords like
    "wc", "tap" and "model" otherwise hit inside ordinary words -- a real
    run reported a promotional banner as sanitaryware because "showcasing"
    contains "wc". Multi-word keywords are still matched as phrases.

    Picks the category with the MOST matches rather than the first one in
    declaration order. These reasons routinely carry several signals at
    once, and first-match-wins let one incidental word outvote the actual
    subject -- "mosaic artwork depicting a human face mounted as a mural"
    was reported as an installed wall scene purely because of "mounted".
    Ties fall back to declaration order, so the outcome stays predictable.
    """
    lowered = str(reason or "").lower()
    words = set(re.findall(r"[a-z0-9_&]+", lowered))

    best_label = None
    best_score = 0

    for label, keywords in REJECTION_CATEGORIES:
        score = 0
        for keyword in keywords:
            if " " in keyword or "&" in keyword:
                if keyword in lowered:
                    score += 1
            elif keyword in words:
                score += 1

        if score > best_score:
            best_label = label
            best_score = score

    return best_label or "not a standalone tile"


def load_tile_region_miner():
    """Lazily imports the region detector + geometry extractor.

    Returns (detect_tile_regions, extract_tile_region) or None. None means
    region mining is simply skipped and every image keeps its whole-image
    verdict, so this feature can never break an existing run.
    """
    try:
        from app.gemini_service import detect_tile_regions
        from app.tile_region_extractor import extract_tile_region
        return detect_tile_regions, extract_tile_region
    except Exception as exc:  # noqa: BLE001 -- cv2/key/import failures all land here
        print(f"  [tile-region] Region mining unavailable: {exc}")
        return None


# Whole-image rejection categories worth re-examining for tile surfaces.
# A page of room photography plausibly contains a real tiled wall; a logo,
# a price list or a basin does not, and re-running those through the
# detector would only spend API calls to rediscover that.
LEGACY_REGION_MINEABLE_CATEGORIES = frozenset({
    "installed wall/floor scene",
    "bathroom/room/lifestyle image",
    "multiple products in one image",
    "not a standalone tile",
})

# Categories that must never be rescued by the "keep it whole" fallback
# below, even when region-mining finds nothing to cut out of them.
#
# That fallback exists for a genuine blind spot: an embedded image the
# whole-image classifier rejected for a reason that does not mean "no
# product here" (OTHER, unclassifiable, a dim or odd-angle shot), where a
# region search finding nothing just confirms the frame IS the product.
#
# These two categories are not that case -- they are a confident,
# specific verdict that the whole frame is NOT one tile product, and a
# region search finding nothing recoverable inside a logo or a multi-tile
# layout page does not mean "so the logo itself is the product"; it means
# there was no tile-shaped surface in it to find. Rescuing it anyway is
# exactly how a brand logo and a captioned multi-product grid reached
# Drive/MASTER as if each were a single standalone tile.
KEEP_WHOLE_BLOCKED_CATEGORIES = frozenset({
    "logo/text/marketing graphic",
    "multiple products in one image",
})


def crop_signature(image_bgr):
    """Fingerprints a crop so the same physical tile is not extracted twice.

    A page is searched by two routes -- its embedded images, and a
    render of the page itself -- and a tile can be visible to both. The
    two routes never produce byte-identical pixels for the same tile
    (one is the raw embedded raster, the other is cut from a
    re-rendered page and perspective-rectified), so an EXACT hash here
    would never recognise the second sighting as the first tile again --
    which is exactly how the same tile ended up uploaded twice once the
    page render started searching every page rather than only empty
    ones.

    Delegates to the perceptual signature used for region-level dedup
    (see app.tile_region_extractor.content_signature), so "the same
    tile" means the same thing everywhere in the pipeline. Compare
    results with signature_already_seen(), not `==` or `in` on a set --
    two signatures for the same tile are close, not identical.
    """
    from app.tile_region_extractor import content_signature

    return content_signature(image_bgr)


def page_box_for_region(image_rect, source_width, source_height, region_box):
    """Maps a region's box from source pixels into PAGE coordinates.

    This is what lets the two search routes talk about the same tile.
    They see different images of it -- one the PDF's embedded raster,
    one a re-render of the whole page -- at different scales, different
    origins and different crops, so a box in one means nothing in the
    other. Both, however, know exactly where their image sits on the
    page, so both can name the same tile by the area of the PAGE it
    occupies, and that name is identical whichever route found it.

    Returns (x0, y0, x1, y1) in page points, or None when the caller
    could not supply the placement (then appearance is the fallback).
    """
    if image_rect is None or not source_width or not source_height:
        return None

    try:
        left, top, right, bottom = (float(value) for value in image_rect)
    except (TypeError, ValueError):
        return None

    span_x = right - left
    span_y = bottom - top
    if span_x <= 0 or span_y <= 0:
        return None

    x0, y0, x1, y1 = region_box
    return (
        left + (x0 / source_width) * span_x,
        top + (y0 / source_height) * span_y,
        left + (x1 / source_width) * span_x,
        top + (y1 / source_height) * span_y,
    )


def signature_already_seen(seen_signatures, signature, source_key=None,
                           page_box=None):
    """True when `signature` is a re-sighting of a tile already extracted.

    `seen_signatures` is a growing list (not a set: near-duplicate
    signatures are compared, not hashed for exact equality) shared
    across every search of one page, so a tile found via its embedded
    image and again via the page render is recognised as one tile.

    Entries are (source_key, signature, page_box) triples, and neither
    of the first two halves of that is decoration.

    source_key stops this being asked the wrong question. Within ONE
    source image, three tiles laid out side by side are three distinct
    regions of it and coordinates already decide what is the same
    surface (deduplicate_regions' job). Comparing a candidate with its
    own neighbours on appearance is what collapsed a whole sheet: on a
    real catalog the closest pair of DIFFERENT products measured 0.0108
    apart, well inside the 0.03 that means "same tile".

    page_box settles it across sources. The same catalog's same tile,
    seen by the embedded route and by the page render, measured 0.0021
    to 0.0297 apart -- a range that OVERLAPS the one above, so no
    appearance threshold can separate "the same tile again" from "its
    plain sibling". Page geometry can, exactly: two routes that found
    the same tile are describing the same area of the page, and a
    tile's neighbours do not overlap it at all.

    So geometry decides whenever both sides have it, and appearance is
    the fallback for a caller that cannot supply placement. Entries
    stored as a bare signature, or as a (source, signature) pair, are
    still honoured.

    One pairing does NOT get that appearance fallback: two different
    EMBEDDED images on the same page, neither with a usable placement
    rect. A base tile and its highlighter are routinely embedded as two
    separate PDF image resources -- not two regions of one image, which
    source_key already protects above -- and PyMuPDF does not always
    expose a placement rect for an embedded image (inline images,
    certain content-stream constructs). When that happens for either
    side, there is no page geometry to confirm OR rule out a match, and
    the docstring's own measurements say appearance cannot be trusted
    here: same-range siblings measured closer together (0.0108) than
    the same tile re-rasterized by the two routes (0.0021-0.0297). So
    without geometry this pairing is left undecided rather than settled
    by a signal already shown to be unsafe for it, and the candidate is
    kept. The one thing this gives up -- a tile embedded twice on one
    page as two separate resources, with neither exposing a placement
    rect -- is a narrow, cosmetic case (an extra listing, not a lost
    one), and is still caught whenever either copy's rect IS available,
    by the exact-byte hash upstream, or by its own true repeat elsewhere
    on a route that does carry geometry.

    This does not apply to an embedded image compared against a page
    RENDER: the render is always keyed with the page's own full-page
    rect (see the page-render call site), so that side of a true
    cross-route repeat normally has page geometry even when the
    embedded side does not, and still resolves either through that
    geometry or, failing that, through the appearance fallback the
    cross-route case was built for.
    """
    from app.tile_region_extractor import (
        PAGE_BOX_OVERLAP_LIMIT,
        box_iou,
        signatures_match,
    )

    candidate_source_type = (
        source_key.split(":", 1)[0] if source_key else None
    )

    for entry in seen_signatures:
        entry_source, existing, entry_box = None, entry, None
        if isinstance(entry, tuple) and 2 <= len(entry) <= 3 and (
            entry[1] is None or isinstance(entry[1], tuple)
        ):
            entry_source = entry[0]
            existing = entry[1]
            entry_box = entry[2] if len(entry) == 3 else None

        # Same source image: coordinates decide, not appearance.
        if source_key is not None and entry_source == source_key:
            continue

        if page_box is not None and entry_box is not None:
            # Both sides can name the area of the page they cover, so
            # the question is answerable exactly and appearance does not
            # get a vote -- in either direction.
            if box_iou(page_box, entry_box) >= PAGE_BOX_OVERLAP_LIMIT:
                return True
            continue

        # Two separate embedded-image sources, neither with a placement
        # rect to settle it: do not let appearance call this a
        # duplicate. See the docstring above.
        entry_source_type = (
            entry_source.split(":", 1)[0] if entry_source else None
        )
        if (
            candidate_source_type == "embedded-image"
            and entry_source_type == "embedded-image"
        ):
            continue

        if signatures_match(signature, existing):
            return True

    return False


def mine_tile_regions(
    output_path,
    page_number,
    image_counter,
    text_spans,
    image_rect,
    semantic_validator,
    region_miner,
    output_directory,
    source_type="embedded-image",
    trace=None,
    seen_signatures=None,
    catalog_signatures=None,
):
    """Recovers tile-only swatches from an image rejected as a whole.

    A bathroom photo is not a tile product, but the tiled wall inside it
    is a real tile whose pattern the catalog is selling. This locates
    those surfaces, flattens and de-occludes each one (see
    app/tile_region_extractor), then puts every resulting swatch back
    through the SAME strict validator the whole image just failed.

    That second pass is the safety net and the reason this cannot quietly
    reintroduce room photos: a crop that still looks like a room fails it
    exactly as the original did. Only a crop that independently reads as a
    tile product survives.

    Returns (accepted, deferred) -- each a list of (path, reason,
    metadata). Deferred swatches are ones no classifier got to see (Gemini
    quota/rate limit): their files are kept for a later run but they are
    NOT catalog entries, so the caller must not publish them.
    """
    import cv2  # local: only needed when mining actually runs

    from app.tile_region_extractor import (
        MAX_BLANK_PAGE_FRACTION,
        MAX_PAGE_SOURCE_COVERAGE,
        blank_page_fraction,
        draw_region_overlay,
        MIN_CLEAN_PIXELS,
        MIN_OUTPUT_SIDE_PX,
        REGION_MAX_ASPECT_RATIO,
        deduplicate_regions,
        quad_bounds,
        signatures_match,
        split_at_background_gutters,
        split_tile_designs,
    )

    try:
        from app.image_validator import describe_contaminants
    except Exception:  # noqa: BLE001 -- logging helper only, never fatal
        def describe_contaminants(_observation):
            return []

    detect_tile_regions, extract_tile_region = region_miner

    # Every exit from here to the candidate loop used to be silent, and
    # they do NOT mean the same thing. "The detector looked and there is
    # no tile on this page" and "the detector never ran" produce
    # identical output -- nothing at all -- so a run cannot be read to
    # tell a missed tile from an unexamined page. Each now says which
    # it was.
    where = f"page {page_number} image {image_counter}"

    try:
        with Image.open(output_path) as probe:
            width, height = probe.size
    except Exception as exc:  # noqa: BLE001
        print(f"  [tile-region] {where}: NOT SEARCHED -- the image could "
              f"not be opened ({exc})")
        return [], []

    try:
        regions = detect_tile_regions(str(output_path), width, height)
    except Exception as exc:  # noqa: BLE001 -- never break extraction over this
        print(f"  [tile-region] {where}: NOT SEARCHED -- detection failed "
              f"({exc})")
        return [], [(
            output_path,
            f"region detection did not run -- {exc}",
            {"undetected": True},
        )]

    if not regions:
        try:
            from app.gemini_service import is_quota_exhausted
            quota_gone = is_quota_exhausted()
        except Exception:  # noqa: BLE001
            quota_gone = False

        if quota_gone:
            # The decisive case, and the one that reads as "no tile
            # here" when it is nothing of the sort. Once the quota flag
            # trips, _generate_content_safe returns None before making
            # any request, detect_tile_regions turns that into [], and
            # every page afterwards looks exactly like a page with no
            # tile on it. A run of consecutive empty pages is far more
            # likely to be this than a catalog that stopped showing
            # tiles halfway through.
            print(f"  [tile-region] {where}: NOT SEARCHED -- Gemini quota "
                  f"is exhausted, so region detection never ran. This page "
                  f"has NOT been judged and is NOT 'no tile found'.")
            print(f"    preserved for a later run rather than dropped")
            # Handed back as deferred for the same reason an unclassified
            # image is: nothing looked at it, so "no tile here" is not a
            # finding anyone made. Dropping it silently is what lost
            # whole pages of a catalog to a dead quota.
            return [], [(
                output_path,
                "region detection did not run -- Gemini quota exhausted",
                {"undetected": True},
            )]

        print(f"  [tile-region] {where}: searched, and the detector "
              f"reported no tiled surface in it")
        return [], []

    # Fixed here, BEFORE deduplication reassigns `regions`. Every later
    # tally is measured against this number, so that what the detector
    # found and what the run accounted for can be compared at all.
    detected_count = len(regions)

    print(f"  [tile-region] page {page_number} image {image_counter}: "
          f"{detected_count} candidate tile surface(s)")
    print(f"  [tile-region] page {page_number}: detected {detected_count} "
          f"candidate region(s)")

    # Loaded BEFORE deduplication so the dedup step can verify overlap
    # candidates against their actual pixels, not just their geometry --
    # see the note on deduplicate_regions for why geometry alone drops
    # genuinely distinct, merely-adjacent tiles.
    image_bgr = cv2.imread(str(output_path), cv2.IMREAD_COLOR)
    if image_bgr is None:
        # Reached only after the detector found surfaces, so this is
        # tile that was located and then lost to a decode failure --
        # worth saying loudly rather than dropping.
        print(f"  [tile-region] {where}: {len(regions)} surface(s) were "
              f"found but OpenCV could not decode {output_path.name} to "
              f"crop them")
        return [], []

    # One surface reported five times costs five rectifications, five
    # saves and five classifications, and yields five copies of the same
    # tile. Collapse them before any of that is spent -- but only when
    # they are actually the same surface, not merely close together.
    regions, duplicate_regions = deduplicate_regions(regions, image_bgr=image_bgr)

    # EVERY DETECTED CANDIDATE GETS A FINAL STATUS.
    #
    # A candidate used to be able to leave this function without one. The
    # surfaces dropped by deduplicate_regions were removed from `regions`
    # before the loop ever saw them, and the closing tally then computed
    # "rejected" as a subtraction from the SHORTENED list -- so a page
    # could detect nine products, report on however many survived dedup,
    # and the difference simply evaporated. The one question worth asking
    # of a run that missed a product ("which stage lost it?") had no
    # answer for exactly the candidates most likely to have been lost.
    #
    # Now each outcome is recorded as it happens and the totals are
    # reconciled against detected_count at the end, where a mismatch is
    # printed rather than hidden.
    outcomes = {
        "ACCEPTED": [], "REJECTED": [], "DUPLICATE": [],
        "FAILED": [], "DEFERRED": [],
    }

    def record(status, label, detail):
        """Files one candidate's final status for the closing reconciliation."""
        outcomes[status].append(f"{label}: {detail}")

    for duplicate, duplicates_index in duplicate_regions:
        print(f"    CANDIDATE -- {duplicate['surface']} "
              f"({duplicate['confidence']:.2f}) overlaps candidate "
              f"{duplicates_index}; same surface, dropped")
        record("DUPLICATE", f"{duplicate['surface']} detection",
               f"same surface as candidate {duplicates_index}")

    if duplicate_regions:
        print(f"  [tile-region] {len(regions)} distinct surface(s) after "
              f"removing {len(duplicate_regions)} duplicate detection(s)")

    source_height, source_width = image_bgr.shape[:2]
    source_area = float(source_width * source_height)

    accepted = []
    deferred = []
    # Shared across every search of ONE page when the caller supplies a
    # set, so a tile found in an embedded image is not extracted again
    # from the page render.
    if seen_signatures is None:
        seen_signatures = []
    # Identifies the image these candidates were cut from, so that
    # cross-source duplicate detection can tell "the same tile seen
    # again by the other route" from "the tile next to it on the same
    # sheet". See signature_already_seen.
    source_key = f"{source_type}:{output_path.name}"
    overlay_boxes = []

    for index, region in enumerate(regions, start=1):
        label = f"page {page_number} image {image_counter} region {index}"

        def note(final, **extra):
            """Records this candidate's full decision trail for the report."""
            if trace is None:
                return
            entry = {
                "page": page_number,
                "source_type": source_type,
                "source_image": output_path.name,
                "candidate": index,
                "surface": region["surface"],
                "detector_confidence": round(region["confidence"], 3),
                "coordinate_space": region.get("coordinate_space"),
                "occluder_boxes": len(region["occluders"]),
                "candidate_size": [region_width, region_height],
                # Recorded so a run can be audited for it, never applied.
                "source_relative_area": round(relative_area, 5),
                "final": final,
            }
            entry.update(extra)
            trace.append(entry)

        region_box = quad_bounds(region["quad"])
        region_width = region_box[2] - region_box[0]
        region_height = region_box[3] - region_box[1]
        relative_area = (
            (region_width * region_height) / source_area if source_area else 0.0
        )

        print(f"    CANDIDATE -- {label}")
        diag(f"      source             : page {page_number} image "
              f"{image_counter} ({source_type})")
        diag(f"      detected surface   : {region['surface']}")
        diag(f"      detector confidence: {region['confidence']:.2f}")
        diag(f"      candidate size     : {region_width}x{region_height}px")
        # Printed, never enforced. A small sample on a big sheet is a
        # real product; this figure is here to be read, not to reject.
        diag(f"      source-relative    : {relative_area:.2%} of the image "
              f"(signal only, not a gate)")
        diag(f"      coordinate space   : {region.get('coordinate_space', '?')}")
        diag(f"      occluder box(es)   : {len(region['occluders'])}")

        # A rendered page is a COMPOSITION -- margins, headings, text,
        # usually several elements -- so a candidate spanning all of it
        # is a detection failure and must never become the output. An
        # embedded image is already one element off the page, where a
        # full-frame candidate is the right answer for a standalone
        # product shot, so no limit is imposed there.
        crop, info = extract_tile_region(
            image_bgr, region["quad"], region["occluders"],
            max_source_coverage=(
                MAX_PAGE_SOURCE_COVERAGE
                if source_type == "rendered-page" else None
            ),
        )

        diag(f"      [TILE-REGION] source={source_type}:{output_path.name}")
        diag(f"      [TILE-REGION] bbox={info.get('bbox')}")
        diag(f"      [TILE-REGION] width={region_width} height={region_height}")
        diag(f"      [TILE-REGION] coverage="
              f"{info.get('source_coverage', 0.0):.1%}")
        diag(f"      [TILE-REGION] candidate_type={region['surface']}")
        overlay_boxes.append((index, region_box, crop is not None))

        # Both geometries are printed on every failure: a candidate that
        # dies here died between "the detector saw a surface" and "there
        # are pixels to crop", and only the before/after shows which.
        if crop is None:
            diag(f"      geometry in        : {info.get('quad_in')}")
            diag(f"      geometry normalized: {info.get('quad_normalized', 'n/a')}")
            diag(f"      geometry           : REJECTED -- {info['reason']} "
                  f"[stage={info['stage']}]")
            diag(f"      [TILE-REGION] decision=REJECT")
            diag(f"      [TILE-REGION] reason={info['reason']}")
            diag(f"      FINAL              : REJECTED")
            note(
                "REJECTED",
                geometry_in=info.get("quad_in"),
                geometry_normalized=info.get("quad_normalized"),
                geometry_stage=info["stage"],
                geometry_reason=info["reason"],
            )
            record("REJECTED", f"candidate {index}",
                   f"{info['reason']} [stage={info['stage']}]")
            continue

        if info.get("surface_source") == "bbox-fallback":
            diag(f"      geometry           : perspective rectification "
                  f"unavailable -- using the region's bounding rectangle")
        if info.get("normalize_note"):
            diag(f"      geometry repair    : {info['normalize_note']}")

        # The same tile seen twice by two different routes -- once in an
        # embedded raster, once in the page render -- must not be synced
        # twice. Matched against tiles ALREADY EXTRACTED from OTHER
        # sources on this page; see signature_already_seen.
        #
        # Two things here are load-bearing, and both were wrong before:
        #
        #  1. source_key. Without it this compared a candidate against
        #     its own neighbours on the same sheet, so three tiles from
        #     one range -- one palette, one texture -- collapsed into one
        #     "duplicate" and two products were lost.
        #
        #  2. WHEN the signature is recorded. It used to be recorded
        #     here, before the candidate had been judged, so a candidate
        #     that was then REJECTED still occupied the page: every later
        #     sighting of a similar tile matched a swatch that was never
        #     saved. That is the "0 accepted + 1 rejected + 2 duplicate"
        #     page -- one rejection took the whole page down with it, and
        #     the page render afterwards found three duplicates of
        #     nothing. A signature is now recorded only where a tile is
        #     actually ACCEPTED, so only a real output can mask another.
        signature = crop_signature(crop)
        page_box = page_box_for_region(
            image_rect, source_width, source_height, region_box,
        )
        if signature_already_seen(
            seen_signatures, signature, source_key, page_box,
        ):
            diag(f"      geometry           : extracted, but this tile was "
                  f"already extracted from another source on this page")
            diag(f"      FINAL              : DUPLICATE")
            note("DUPLICATE", geometry_stage="duplicate",
                 geometry_reason="already extracted from another source")
            record("DUPLICATE", f"candidate {index}",
                   "already extracted from another source on this page")
            continue

        crop_width, crop_height = info["crop_size"]
        diag(f"      geometry           : OK -- {crop_width}x{crop_height}px, "
              f"{info['clean_area_fraction']:.0%} of the rectified surface "
              f"is unobstructed")

        region_path = (
            output_directory
            / f"{output_path.stem}_region_{index}.webp"
        )

        try:
            Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)).save(
                region_path, "WEBP", quality=IMAGE_QUALITY, method=6,
            )
        except Exception as exc:  # noqa: BLE001
            # A technical failure, not a judgement. Kept in its own
            # bucket so a run that lost products to a disk or encoder
            # problem does not read as a run that rejected them.
            diag(f"      FINAL              : FAILED -- could not save ({exc})")
            note("FAILED", geometry_stage="save", geometry_reason=str(exc))
            record("FAILED", f"candidate {index}", f"could not be saved ({exc})")
            continue

        # The strict gate -- and the one that actually decides ACCEPT vs
        # REJECT. It re-classifies the SAVED CROP FILE from scratch: this
        # call receives region_path, so whatever verdict the whole source
        # image got earlier is not visible to it and cannot leak in.
        status, reason, metadata = validate_and_correct_tile_image(
            region_path, image_rect, text_spans, semantic_validator,
            purity_is_authoritative=True,
        )

        region_type = metadata.get('image_type', '?')
        region_confidence = metadata.get('confidence')
        confidence_text = (
            f"{region_confidence:.2f}" if isinstance(region_confidence, (int, float))
            else "?"
        )
        diag(f"      region classification: {region_type} "
              f"(confidence {confidence_text})")

        # What the purity verifier actually saw inside the finished crop.
        # Printed for every candidate, accepted or not, because "why did
        # this one survive" needs the same evidence as "why did that one
        # die" -- and an accepted swatch with text in it is exactly the
        # failure that went unnoticed before.
        observation = metadata.get('purity') or {}
        if observation:
            def flag(key):
                return 'YES' if observation.get(key) else 'no'

            diag(f"      material           : {observation.get('material', '?')}")
            diag(f"      tile fraction      : "
                  f"{observation.get('tile_fraction', 0.0):.0%} of the candidate")
            diag(f"      person detected    : {flag('contains_person')}")
            diag(f"      text detected      : {flag('contains_text')}")
            diag(f"      logo detected      : {flag('contains_logo')}")
            diag(f"      objects detected   : "
                  f"{', '.join(describe_contaminants(observation)) or 'none'}")
            diag(f"      reads as a scene   : {flag('is_scene')}")
        else:
            diag(f"      purity             : not measured")

        diag(f"      masking applied    : "
              f"{'YES' if region['occluders'] else 'no'}")
        diag(f"      perspective corr.  : "
              f"{'YES' if info.get('surface_source') == 'rectified' else 'no'}")

        geometry_fields = {
            "geometry_in": info.get("quad_in"),
            "geometry_normalized": info.get("quad_normalized"),
            "geometry_stage": info["stage"],
            "surface_source": info.get("surface_source"),
            "crop_size": list(info["crop_size"]),
            "clean_area_fraction": info.get("clean_area_fraction"),
            "region_type": region_type,
            "region_confidence": region_confidence,
        }

        # ------------------------------------------------------
        # THE TILE-ONLY CONTRACT.
        #
        # Soft mislabels on a clean swatch may be overridden so a false
        # material name does not delete a real tile. Hard evidence of
        # architecture, rooms, furniture/hardware, windows, or other
        # non-tile materials is still honored -- otherwise frame and
        # interior catalogs upload junk as Tile rows.
        # Multi-product frames are split below, never saved whole.
        # ------------------------------------------------------
        if TILE_ONLY_CATALOG and status != VALIDATION_APPROVED:
            observed_purity = metadata.get('purity') or {}
            try:
                reported_designs = int(
                    observed_purity.get('distinct_tile_designs', 1)
                )
            except (TypeError, ValueError):
                reported_designs = 1

            # A verdict of "this is a printed/drawn graphic, not a
            # photograph of a physical surface" (RULE 0 of
            # assess_tile_purity) is not a disputable material label --
            # it is the purity verifier's answer to "is there a physical
            # product in front of the camera at all", and a logo, banner
            # or text graphic is exactly the case it exists to catch.
            # The contract below exists to stop an unreliable MATERIAL
            # NAME (ARCHITECTURE, WOOD, OTHER, ...) from deleting a real,
            # photographed tile it merely misnamed -- it was never meant
            # to rescue something that was never a physical surface in
            # the first place. Missing purity is not itself proof of a
            # graphic; the shared helper separately requires an actual
            # purity observation before overriding a rejection.
            is_printed_graphic = (
                bool(observed_purity)
                and not observed_purity.get('physical_surface', True)
            )

            from app.image_validator import tile_only_may_force_accept

            if (
                not is_printed_graphic
                and not (status == VALIDATION_IMPURE and reported_designs > 1)
                and tile_only_may_force_accept(
                    status, metadata, impure_status=VALIDATION_IMPURE
                )
            ):
                diag(f"      tile-only contract : soft reject overridden "
                      f"-- accepting despite '{status}: {reason}'")
                reason = (
                    f"accepted on the tile-only catalog contract "
                    f"(classifier said: {reason})"
                )
                status = VALIDATION_APPROVED
            else:
                diag(f"      tile-only contract : hard non-tile evidence "
                      f"kept -- not overriding '{status}: {reason}'")

        if status == VALIDATION_DEFERRED:
            # Nothing classified this crop, so it is neither a tile nor
            # not-a-tile yet. Hand it to the caller as deferred: the file
            # survives for a later run, but it does not enter the catalog.
            diag(f"      region validation  : DEFERRED -- {reason}")
            diag(f"      FINAL              : DEFERRED (awaiting validation)")
            note("DEFERRED", validation="DEFERRED", validation_reason=reason,
                 **geometry_fields)
            record("DEFERRED", f"candidate {index}", reason)
            deferred.append((region_path, reason, metadata))
            continue

        # TWO QUESTIONS, NOT ONE.
        #
        # distinct_tile_designs asks how many DESIGNS are visible, and
        # the prompt tells the model outright that "one tile repeated
        # across the whole frame is 1, however many individual units
        # you can count". That is the right answer to that question --
        # and it meant a wall of six identical panels was never split,
        # because the split gate only ever asked about designs.
        #
        # separate_pieces asks the question the catalog actually needs:
        # how many pieces could you pick up one at a time. Six identical
        # panels are 1 design and 6 pieces.
        #
        # Absent reads as 1, so a verifier that does not answer it
        # leaves behaviour exactly as it was.
        purity_now = metadata.get('purity') or {}
        designs = purity_now.get('distinct_tile_designs', 1)
        try:
            designs = int(designs)
        except (TypeError, ValueError):
            designs = 1

        # The page showing straight through the crop is its own evidence
        # that more than one product is in it, and it does not need the
        # classifier to agree: a band of bare page between two tiles is
        # geometry, not opinion. Checked first, because this is the case
        # that was reaching Drive as one image of two tiles with a white
        # stripe down the middle.
        try:
            pieces_seen = int(purity_now.get('separate_pieces', 1) or 1)
        except (TypeError, ValueError):
            pieces_seen = 1

        gutter_pieces = split_at_background_gutters(crop)

        # CUTTING SOMETHING UP MUST NOT LAUNDER A VERDICT OF "NOT A TILE".
        #
        # Splitting exists for one case: several products butted together
        # in one frame. It runs on whatever reaches it, though, and a
        # hard non-tile verdict reaches it too -- a view of a room, a
        # photographed building, a printed graphic, an arch. Those get
        # cut apart and their pieces judged individually, and a piece of
        # a flat facade or a tiled wall in a room photograph reads as a
        # clean surface, so the refusal on the whole image is undone by
        # the very act of dividing it.
        #
        # Contamination and multiple designs still split: a towel lying
        # on a tile, or three products in a row, are exactly what
        # isolating a piece is for.
        from app.image_validator import purity_is_hard_non_tile

        beyond_repair = purity_is_hard_non_tile(
            metadata.get('purity'), metadata.get('purity_state'),
        )
        if beyond_repair:
            gutter_pieces = []
            if status != VALIDATION_APPROVED:
                diag(f"      split              : not splitting -- "
                      f"'{reason}' is a verdict on the thing itself, and "
                      f"cutting it up cannot make it a tile")

        # ONE PRODUCT IS NEVER CUT UP, WHATEVER SEAMS ITS PATTERN SHOWS.
        #
        # split_tile_designs looks for seams, and a framed panel with a
        # vine up it has plenty: across the real 41-page Mozart catalog
        # it carved 32 of 109 whole products into quarters. The page
        # knows better than the pattern does -- a product is one
        # connected region on it -- so when the crop sits on a single
        # such region, the seam splitter is not consulted at all.
        #
        # Bare page running THROUGH the crop still splits it. That is
        # geometry rather than opinion, and it is how two products that
        # physically touch on the page are still told apart.
        from app.tile_region_extractor import crop_is_one_product

        single_product, single_note = crop_is_one_product(
            image_bgr, region_box,
        )
        if single_product and not gutter_pieces and designs > 1:
            diag(f"      split              : not splitting -- "
                  f"{single_note}")

        if pieces_seen > 1:
            diag(f"      pieces reported    : the model counts "
                  f"{pieces_seen} separate piece(s) here")

        # WHY A PIECE COUNT IS NOT ALLOWED TO DRIVE THE SEAM SPLITTER.
        #
        # It was, briefly, and it cut real products in half. A Mozart
        # panel -- one tile, printed with a moulded border around a vine
        # design -- came out of Drive as region_4_2: the inner design
        # with its border sliced off. Measured on that exact panel, the
        # strongest seam in it scores 23.95 against a SPLIT_MIN_STEP of
        # 22.0. It is a border, not a join, and it clears the bar by
        # less than two points.
        #
        # crop_is_one_product is what stands between that panel and the
        # splitter, and letting the count past it was the mistake. The
        # count is a real observation -- the model was asked how many
        # pieces it can see -- but "there is more than one piece here"
        # does not say WHERE the join is, and split_tile_designs has to
        # guess. A guess restrained by the page is the whole reason that
        # function stopped carving patterned products into quarters,
        # which it had done to 32 of 109.
        #
        # Nor did the count deliver what it was added for. A wall of
        # eight identical panels is ONE design, so max_pieces below
        # resolves to 2: the wall was cut into two images of four panels
        # each, not eight of one. It never produced one tile per image.
        #
        # So the count never splits anything. It does refuse -- see
        # multi_product below, where "more than one piece here" is
        # answered by refusing the frame rather than by guessing a cut
        # through it.
        #
        # beyond_repair still blocks everything: cutting a non-tile up
        # cannot make it a tile.
        split_for_designs = (status == VALIDATION_IMPURE and designs > 1
                             and not single_product)

        would_split = gutter_pieces or (split_for_designs
                                        and not beyond_repair)

        # THE COUNT REFUSES. IT STILL DOES NOT CUT.
        #
        # Reported but never acted on, because the only thing it had
        # been wired to was the seam splitter -- and a count says there
        # is more than one piece here, never WHERE the join is, so the
        # splitter had to guess and guessed through a panel's moulding.
        #
        # Refusing needs no such guess. "Four tiles laid up as a wall"
        # is not a swatch of any one of them whatever the joins look
        # like, and the one thing this frame must not do is become a
        # Tile row showing four products.
        #
        # The count is trustworthy for this question in a way it was
        # not for the other one: the prompt tells the model that
        # printed pattern is never pieces and to answer 1 when unsure,
        # both pinned in one_piece_per_image_checks. The one frame it
        # read as 2 pieces that looked like a single panel -- the vine
        # tile -- was a quad sitting 70px off its product, holding a
        # strip of the neighbour. The count was right about the pixels
        # it was shown; the quad was wrong, and grow_to_whole_product
        # now snaps it.
        multi_product = would_split or pieces_seen > 1

        if multi_product and not SPLIT_MERGED_FRAMES:
            # More than one product in this frame, and cutting is off.
            # Saving it whole would give one Tile row a picture of its
            # neighbours, so it is refused and said out loud -- a
            # product lost here is lost visibly, not silently.
            if gutter_pieces:
                found = (f"bare page runs through it, "
                         f"{len(gutter_pieces)} separate tile(s) in it")
            elif pieces_seen > 1:
                found = (f"the model counts {pieces_seen} separate "
                         f"piece(s) in it")
            else:
                found = f"{designs} different designs in it"
            region_path.unlink(missing_ok=True)
            emit(f"      more than one product in this frame ({found}) "
                 f"-- refused rather than cut")
            note("REJECTED",
                 geometry_reason=f"more than one product in the frame: "
                                 f"{found}",
                 **geometry_fields)
            record("REJECTED", f"candidate {index}",
                   f"more than one product in the frame: {found} "
                   f"-- cutting is off (SPLIT_MERGED_FRAMES)")
            continue

        if would_split:
            # Several products butted together in one frame. Saving it
            # whole would give one Tile row a picture of its neighbours;
            # rejecting it would throw away every product in it. Cut it
            # along the seams and judge each piece on its own.
            pieces = gutter_pieces or split_tile_designs(
                crop, max_pieces=max(2, min(designs, 4)),
            )
            if gutter_pieces:
                diag(f"      gutter             : bare page runs through "
                      f"this crop -- {len(pieces)} products in it, cutting "
                      f"them apart")

            if pieces:
                # Operator-visible on purpose. "Two tiles arrived in one
                # image" is a complaint this pipeline has had before, so
                # the run should say out loud when it found two and cut
                # them apart -- one line, and only when it actually
                # happens.
                # SAY WHAT HAPPENED, NOT WHAT THE MODEL COUNTED.
                #
                # This printed `designs`, which is the number of
                # distinct DESIGNS, so two tiles of the same design
                # with page between them produced "1 products in one
                # frame -- cut into 2 piece(s)". Read plainly that says
                # one tile was cut in half, which is the one thing this
                # pipeline must never do, and it was reported as a bug
                # on a run where the split had been entirely correct.
                if gutter_pieces:
                    emit(f"      bare page runs through this frame -- "
                         f"{len(pieces)} separate tile(s) in it, cut "
                         f"apart, each judged separately")
                else:
                    emit(f"      {designs} different designs in one frame "
                         f"-- cut into {len(pieces)} piece(s), each "
                         f"judged separately")
                region_path.unlink(missing_ok=True)

                # A split candidate is still ONE detected candidate, so
                # it gets ONE status in the reconciliation below -- taken
                # from what its pieces actually produced, with the piece
                # counts spelled out so the tally cannot hide a product
                # that was cut out and then lost.
                pieces_accepted = 0
                pieces_deferred = 0
                pieces_rejected = 0
                pieces_failed = 0

                for piece_index, (px1, py1, px2, py2) in enumerate(pieces, start=1):
                    piece = crop[py1:py2, px1:px2]
                    piece_height, piece_width = piece.shape[:2]
                    piece_label = f"{index}.{piece_index}"

                    if (min(piece_width, piece_height) < MIN_OUTPUT_SIDE_PX
                            or piece_width * piece_height < MIN_CLEAN_PIXELS):
                        diag(f"      piece {piece_label}          : "
                              f"{piece_width}x{piece_height}px -- too small to "
                              f"be a swatch, dropped")
                        note("REJECTED", piece=piece_label,
                             validation="FAIL",
                             validation_reason="split piece below size floor",
                             **geometry_fields)
                        pieces_rejected += 1
                        continue

                    # Same sliver bar the whole region is held to. A
                    # split cuts ACROSS a region, so it is the one place
                    # that can manufacture a ribbon out of a perfectly
                    # square candidate -- the piece gate checked each
                    # side and the area, and a long thin strip passes
                    # both.
                    piece_aspect = (
                        max(piece_width, piece_height)
                        / min(piece_width, piece_height)
                    )
                    if piece_aspect > REGION_MAX_ASPECT_RATIO:
                        diag(f"      piece {piece_label}          : "
                              f"{piece_width}x{piece_height}px is an extreme "
                              f"{piece_aspect:.1f}:1 sliver, dropped")
                        note("REJECTED", piece=piece_label,
                             validation="FAIL",
                             validation_reason="split piece is a sliver",
                             **geometry_fields)
                        pieces_rejected += 1
                        continue

                    # Same blank-page bar the whole region is held
                    # to, and for the same reason the sliver bar is
                    # repeated here: a split cuts ACROSS a region, so a
                    # crop that was mostly product can yield a piece
                    # that is mostly paper. The region gate ran before
                    # the cut and cannot see that piece.
                    piece_blank = blank_page_fraction(piece)
                    if piece_blank > MAX_BLANK_PAGE_FRACTION:
                        diag(f"      piece {piece_label}          : "
                              f"{piece_blank:.0%} of it is blank page, "
                              f"dropped")
                        note("REJECTED", piece=piece_label,
                             validation="FAIL",
                             validation_reason=(
                                 f"split piece is {piece_blank:.0%} "
                                 f"blank page"),
                             **geometry_fields)
                        pieces_rejected += 1
                        continue

                    piece_path = (
                        output_directory
                        / f"{output_path.stem}_region_{index}_{piece_index}.webp"
                    )

                    try:
                        Image.fromarray(
                            cv2.cvtColor(piece, cv2.COLOR_BGR2RGB)
                        ).save(piece_path, "WEBP", quality=IMAGE_QUALITY, method=6)
                    except Exception as exc:  # noqa: BLE001
                        diag(f"      piece {piece_label}          : could not "
                              f"save ({exc})")
                        note("FAILED", piece=piece_label,
                             validation_reason=f"could not save ({exc})",
                             **geometry_fields)
                        pieces_failed += 1
                        continue

                    piece_status, piece_reason, piece_metadata = (
                        validate_and_correct_tile_image(
                            piece_path, image_rect, text_spans,
                            semantic_validator, purity_is_authoritative=True,
                        )
                    )

                    piece_purity = piece_metadata.get('purity') or {}
                    diag(f"      piece {piece_label}          : "
                          f"{piece_width}x{piece_height}px  "
                          f"material={piece_purity.get('material', '?')}  "
                          f"tile={piece_purity.get('tile_fraction', 0.0):.0%}")

                    piece_is_printed_graphic = (
                        bool(piece_purity)
                        and not piece_purity.get('physical_surface', True)
                    )

                    if (
                        TILE_ONLY_CATALOG
                        and piece_status != VALIDATION_APPROVED
                        and not piece_is_printed_graphic
                    ):
                        from app.image_validator import tile_only_may_force_accept

                        # Already cut apart, so the one verdict worth
                        # acting on no longer applies -- see the
                        # tile-only contract above. A piece the purity
                        # verifier says is not a photographed physical
                        # surface at all (a caption, a footer strip, a
                        # logo corner caught inside the split) is not
                        # rescued by that contract either, for the same
                        # reason the whole-candidate version above is not.
                        if tile_only_may_force_accept(
                            piece_status, piece_metadata,
                            impure_status=VALIDATION_IMPURE,
                        ):
                            piece_reason = (
                                f"accepted on the tile-only catalog contract "
                                f"(classifier said: {piece_reason})"
                            )
                            piece_status = VALIDATION_APPROVED

                    if piece_status == VALIDATION_DEFERRED:
                        diag(f"        -> DEFERRED -- {piece_reason}")
                        note("DEFERRED", piece=piece_label,
                             validation="DEFERRED",
                             validation_reason=piece_reason, **geometry_fields)
                        deferred.append((piece_path, piece_reason, piece_metadata))
                        pieces_deferred += 1
                        continue

                    if piece_status != VALIDATION_APPROVED:
                        piece_path.unlink(missing_ok=True)
                        diag(f"        -> REJECTED -- {piece_reason}")
                        note("REJECTED", piece=piece_label, validation="FAIL",
                             validation_reason=piece_reason, **geometry_fields)
                        pieces_rejected += 1
                        continue

                    diag(f"        -> ACCEPTED -> {piece_path.name}")
                    note("ACCEPTED", piece=piece_label, validation="PASS",
                         validation_reason=piece_reason,
                         image_path=str(piece_path),
                         product_name=piece_metadata.get("product_name", ""),
                         **geometry_fields)
                    seen_signatures.append(
                        (source_key, crop_signature(piece), page_box)
                    )
                    accepted.append((piece_path, piece_reason, piece_metadata))
                    pieces_accepted += 1

                split_detail = (
                    (f"bare page ran through this frame -- "
                     if gutter_pieces else
                     f"{designs} different designs in one frame -- ")
                    + f"split into {len(pieces)} piece(s): "
                    f"{pieces_accepted} accepted, {pieces_deferred} deferred, "
                    f"{pieces_rejected} rejected, {pieces_failed} failed"
                )
                if pieces_accepted:
                    record("ACCEPTED", f"candidate {index}", split_detail)
                elif pieces_deferred:
                    record("DEFERRED", f"candidate {index}", split_detail)
                elif pieces_failed and not pieces_rejected:
                    # Every piece died on a technical fault, so nothing
                    # here judged this candidate.
                    record("FAILED", f"candidate {index}", split_detail)
                else:
                    record("REJECTED", f"candidate {index}", split_detail)

                continue

            diag(f"      region validation  : {designs} designs reported, but "
                  f"no clear seam between them -- cannot split")

        if status != VALIDATION_APPROVED:
            # A crop that is STILL contaminated has already had its one
            # chance at isolation -- this IS the isolated result. Mining
            # it again would just re-cut the same pixels, so it is
            # dropped here, which is what "reject that specific candidate
            # rather than producing a bad image" means in practice.
            region_path.unlink(missing_ok=True)
            if status == VALIDATION_IMPURE:
                diag(f"      region validation  : FAIL -- could not be "
                      f"isolated cleanly: {reason}")
            else:
                diag(f"      region validation  : FAIL -- {reason}")
            diag(f"      FINAL              : REJECTED")
            # The material the model actually named, on the REJECTED
            # note as well as the accepted one.
            #
            # It was recorded only on acceptance, which is backwards:
            # when a product survives, the word that let it through is
            # of no interest, and when a product is LOST the word that
            # killed it is the only thing worth knowing. A catalog of
            # decorative frames meeting a rule whose vocabulary
            # includes FRAME, ARCHWAY and ORNAMENTAL_FRAME is exactly
            # the case that cannot be diagnosed without it -- the
            # report could say "a landmark clad in tile" forty times
            # and never say which word the model had chosen.
            note("REJECTED", validation="FAIL", validation_reason=reason,
                 purity_state=metadata.get("purity_state"),
                 material=(metadata.get("purity") or {}).get("material"),
                 tile_fraction=(metadata.get("purity") or {}).get(
                     "tile_fraction"),
                 **geometry_fields)
            record("REJECTED", f"candidate {index}", reason)
            continue

        diag(f"      region validation  : PASS -- {reason}")
        # THE SAME PRODUCT, ONE PAGE LATER.
        #
        # seen_signatures is rebuilt per PAGE, so it cannot see a product
        # already extracted from an earlier one, and a range photographed
        # on two pages reached Drive twice. Geometry cannot help across
        # pages -- catalogs lay products out on a fixed grid, so the same
        # box on page 7 and page 8 is two DIFFERENT products -- so this
        # compares appearance only, and at a much tighter tolerance than
        # the within-page test: the same tile re-rasterized measures
        # 0.001-0.002 apart, while two siblings of one range measure
        # ~0.011, so CATALOG_DUPLICATE_MAX_DIFFERENCE sits between them
        # and merges only a near-identical repeat.
        if catalog_signatures is not None and signature is not None:
            twin = next(
                (name for name, other in catalog_signatures
                 if signatures_match(
                     signature, other,
                     max_difference_fraction=CATALOG_DUPLICATE_MAX_DIFFERENCE,
                 )),
                None,
            )
            if twin is not None:
                diag(f"      duplicate          : already extracted earlier "
                      f"in this catalog as {twin}")
                diag(f"      FINAL              : DUPLICATE")
                region_path.unlink(missing_ok=True)
                note("DUPLICATE", geometry_stage="catalog-duplicate",
                     geometry_reason=f"same product as {twin}")
                record("DUPLICATE", f"candidate {index}",
                       f"already extracted as {twin}")
                continue
            catalog_signatures.append((region_path.name, signature))

        diag(f"      FINAL              : ACCEPTED -> {region_path.name}")
        diag(f"      [tile-region] candidate {index} -> accepted")

        note("ACCEPTED", validation="PASS", validation_reason=reason,
             image_path=str(region_path),
             product_name=metadata.get("product_name", ""),
             purity_state=metadata.get("purity_state"),
             material=(metadata.get("purity") or {}).get("material"),
             tile_fraction=(metadata.get("purity") or {}).get("tile_fraction"),
             **geometry_fields)

        seen_signatures.append((source_key, signature, page_box))
        record("ACCEPTED", f"candidate {index}", reason)
        accepted.append((region_path, reason, metadata))

    # ------------------------------------------------------------
    # CANDIDATE RECONCILIATION
    #
    # Every surface the detector found is accounted for by name, and the
    # totals are added back up against it. The old line derived
    # "rejected" by subtracting from the post-dedup list, which is the
    # one arithmetic that can never disagree with itself -- it reported a
    # balanced page no matter how many candidates had gone missing on the
    # way. This adds the statuses that were actually recorded, so when
    # they do not come to the number detected, the run says so instead of
    # quietly reporting a smaller catalog.
    # ------------------------------------------------------------
    accounted = sum(len(entries) for entries in outcomes.values())

    # The equation goes through emit() rather than print(), which is what
    # makes it survive quiet_stage() and appear in an ordinary run --
    # accounting nobody sees is not accounting. The per-candidate reasons
    # underneath it are diagnostics and stay behind CATALOG_DEBUG, so the
    # normal terminal gets one line per page instead of a wall.
    # One readable line per source, and the accepted images by name.
    #
    # The old line printed all five buckets whether or not they had
    # anything in them -- "0 accepted + 12 rejected + 0 already
    # extracted + 0 failed + 0 deferred" -- so the number that matters
    # was buried among four zeroes, and the images that WERE accepted
    # were never named outside a debug run. Empty buckets say nothing
    # and are left out; the equation itself is preserved in the report
    # and in DEBUG.
    accepted_entries = outcomes["ACCEPTED"]
    rest = [
        (len(outcomes["REJECTED"]), "rejected"),
        (len(outcomes["DUPLICATE"]), "already extracted"),
        (len(outcomes["FAILED"]), "failed"),
        (len(outcomes["DEFERRED"]), "deferred, will retry"),
    ]
    detail = ", ".join(f"{count} {word}" for count, word in rest if count)
    detail = f" -- {detail}" if detail else ""

    if accepted_entries:
        # Deliberately NOT listing the accepted candidates by name
        # here: each one gets its own "Tile n -> uploaded -> brand /
        # catalog / size / file" line a moment later, and printing the
        # same tile twice under two different names is how this
        # terminal became unreadable in the first place.
        emit(f"      ACCEPTED {len(accepted_entries)} of {detected_count} "
             f"candidate(s){detail}")
    elif len(outcomes["DUPLICATE"]) == detected_count and detected_count:
        # The other route finding the same products is the dedup
        # working. Saying "no tile accepted" about it reads like a
        # failure, and it is the opposite of one.
        emit(f"      {detected_count} candidate(s), all already "
             f"extracted from this page by the other route")
    else:
        emit(f"      no tile accepted out of {detected_count} "
             f"candidate(s){detail}")

    diag(f"      [{source_type}] {detected_count} detected = "
          f"{len(outcomes['ACCEPTED'])} accepted + "
          f"{len(outcomes['REJECTED'])} rejected + "
          f"{len(outcomes['DUPLICATE'])} already extracted + "
          f"{len(outcomes['FAILED'])} failed + "
          f"{len(outcomes['DEFERRED'])} deferred")

    for status in ("ACCEPTED", "REJECTED", "DUPLICATE", "FAILED", "DEFERRED"):
        for entry in outcomes[status]:
            diag(f"    [tile-region] {status:<9} {entry}")

    # A technical fault is the one status that must reach the operator
    # whatever the verbosity: a product lost to a broken encoder looks
    # exactly like a catalog with fewer products in it, and only this
    # line tells them apart.
    for entry in outcomes["FAILED"]:
        emit(f"      FAILED -- {entry}")

    if accounted != detected_count:
        # Loud on purpose, and always. This is the failure the accounting
        # exists to catch: a detected product that reached no final
        # status at all.
        emit(f"      ACCOUNTING MISMATCH -- {detected_count} candidate(s) "
             f"detected but {accounted} accounted for; "
             f"{detected_count - accounted} left this page with no "
             f"final status")
        print(f"  [tile-region] ACCOUNTING MISMATCH on page {page_number}: "
              f"{detected_count} detected, {accounted} accounted for")

    debug_directory = os.getenv("TILE_REGION_DEBUG_DIR", "").strip()
    if debug_directory and overlay_boxes:
        written = draw_region_overlay(
            image_bgr, overlay_boxes,
            Path(debug_directory) / f"{output_path.stem}_regions.png",
        )
        if written is not None:
            print(f"  [TILE-REGION] overlay written: {written}")

    return accepted, deferred


# Where images that could not be validated are kept. A sibling of the
# extracted-images directory rather than a mix-in, so nothing downstream
# that globs the images folder can mistake an unvalidated candidate for an
# accepted tile. Mirrors catalog_pipeline.py's directories["review"].
DEFERRED_DIRECTORY_NAME = "review_required"


def defer_for_revalidation(
    source_path, page_number, image_index, reason, metadata,
    output_directory, deferred_records,
):
    """Preserves one unvalidated image and records how to revalidate it.

    Called when Gemini could not classify a candidate. The file is MOVED
    out of the extraction folder into review_required/ -- moved, not
    copied, so the same image cannot be picked up as an accepted tile by
    anything scanning the images directory, and not deleted, because a
    quota error is not evidence about the image.

    The manifest entry carries what a later run needs to finish the job:
    which PDF page and image slot it came from, why it was deferred, and
    whatever the classifier managed to report before giving up.

    Returns the new path, or None if the file could not be preserved.
    """
    review_directory = output_directory / DEFERRED_DIRECTORY_NAME
    review_directory.mkdir(parents=True, exist_ok=True)

    destination = review_directory / source_path.name

    try:
        # replace() rather than rename(): a re-run that defers the same
        # page/slot again should overwrite its earlier copy, not fail.
        source_path.replace(destination)
    except OSError as exc:
        print(f"  [deferred] could not preserve {source_path.name}: {exc}")
        return None

    deferred_records.append(
        {
            "filename": destination.name,
            "path": str(destination),
            "page": page_number,
            "image_index": image_index,
            "status": VALIDATION_DEFERRED,
            "reason": reason,
            "classifier_type": metadata.get("image_type", ""),
            "classifier_confidence": metadata.get("confidence", 0.0),
            "product_name": metadata.get("product_name", ""),
            "size": metadata.get("size", ""),
        }
    )

    return destination


def notify_tile(on_tile, record):
    """Hands one finished tile straight to the caller's persistence step.

    This is what makes the run incremental: the tile is uploaded and
    recorded now, not after the whole catalog has been read, so work
    already done survives a crash later in the PDF.

    A persistence failure must never abort extraction -- the remaining
    pages still deserve to be searched -- so it is reported and the run
    continues. The tile stays in the returned list either way, and
    nothing was marked processed, so a re-run retries it.
    """
    if on_tile is None:
        return

    try:
        on_tile(record)
    except Exception as exc:  # noqa: BLE001 -- see docstring
        print(
            f"  [persist] immediate upload/record failed for "
            f"{record.get('filename', '?')}: {exc}"
        )


def append_recovered_regions(
    recovered, extracted_images, page_number, image_counter, on_tile=None,
):
    """Records validated region swatches as extraction results.

    Every path that can recover a swatch -- a rejected embedded image, a
    statistically-flagged room photo, a rendered page -- produces the same
    (path, reason, metadata) triples and must turn them into the same
    record shape, so they share this rather than each keeping their own
    copy of it.

    Returns the updated image_counter.
    """
    for region_path, _reason, region_metadata in recovered:
        image_counter += 1

        present_tile_on_canvas(region_path)

        with Image.open(region_path) as region_image:
            region_width, region_height = region_image.size

        record = {
            "path": str(region_path),
            "filename": region_path.name,
            "page": page_number,
            "image_index": image_counter,
            "width": region_width,
            "height": region_height,
            "product_name": region_metadata.get("product_name", ""),
            "size": region_metadata.get("size", ""),
        }

        extracted_images.append(record)
        notify_tile(on_tile, record)

    return image_counter


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


# Validation outcomes, in the vocabulary catalog_pipeline.py already uses
# for the UI-upload path (its STATUS_* constants, lines ~245-257). Three
# states, not two, because "Gemini says this is a bathroom photo" and
# "Gemini never answered" are different facts about an image and the
# pipeline must be able to act on them differently.
VALIDATION_APPROVED = "GEMINI_APPROVED"
VALIDATION_REJECTED = "GEMINI_REJECTED"
VALIDATION_DEFERRED = "REVIEW_REQUIRED"

# A fourth outcome, and the one that fixes the bad crops.
#
# IMPURE means: there IS tile here, but this framing is not a swatch --
# a person, a caption, a sofa or a whole room came with it. It is
# neither an approval nor a rejection. The caller must go and isolate
# the tile surface out of the frame (mine_tile_regions) rather than
# either saving the contaminated image or discarding a real tile.
VALIDATION_IMPURE = "NEEDS_ISOLATION"


def load_tile_purity_verifier():
    """Lazily imports the frame-purity verifier and its decision rule.

    Returns (verify_tile_only, assess_tile_purity) or None. None means
    the purity gate is skipped, which restores exactly the previous
    behaviour -- so a missing key or a failed import can never turn into
    a crash, only into the older, looser acceptance.

    Deliberately NOT cached: one process legitimately runs the pipeline
    more than once (tests do), and a cached verifier would leak the
    first run's Gemini state into the second.
    """
    try:
        from app.gemini_service import verify_tile_only
        from app.image_validator import assess_tile_purity
        return verify_tile_only, assess_tile_purity
    except Exception as exc:  # noqa: BLE001 -- missing key raises RuntimeError
        print(f"  [tile-purity] Purity verification unavailable: {exc}")
        return None


def validate_and_correct_tile_image(
    output_path, image_rect, text_spans, semantic_validator,
    purity_is_authoritative=False,
):
    """Gates and corrects ONE already-saved candidate image in place.

    Returns (status, reason, metadata) where status is one of
    VALIDATION_APPROVED, VALIDATION_REJECTED or VALIDATION_DEFERRED.

    APPROVED and REJECTED are verdicts: the classifier looked at the image
    and decided. The caller keeps an approved image and deletes a rejected
    one -- the fail-closed posture the UI-upload path already takes, since
    a lifestyle photo reaching Drive/MASTER is worse than a missing one.

    DEFERRED is NOT a verdict. It means no classifier ran -- quota
    exhausted, rate limited, key missing, API error -- so nothing has
    judged this image yet. Deleting it here would discard a real tile for
    an infrastructure reason, so the caller preserves the file for a later
    run instead. What it must NOT do is publish it: an unvalidated image
    is exactly the room photo or logo this pipeline exists to keep out of
    the catalog, so deferred candidates stay out of Drive, MASTER and the
    Tile table until a classifier has actually seen them.

    metadata carries values derived on the way through (Gemini's product
    name, the size text near the image) plus the classifier type and
    confidence, so the caller can attach them to a synced Tile row.
    """
    if semantic_validator is None:
        # A missing key is a configuration problem, not a judgement about
        # the image -- defer rather than destroy, same as a dead quota.
        return (
            VALIDATION_DEFERRED,
            'semantic validation unavailable (GEMINI_API_KEY not configured)',
            {},
        )

    analyze_product_image, validate_product_decision, validate_bbox = semantic_validator

    nearby_text = '\n'.join(span['text'] for span in text_near_image(image_rect, text_spans)[:8])

    try:
        gemini_result = analyze_product_image(str(output_path), page_text=nearby_text)
    except Exception as exc:  # noqa: BLE001 -- see docstring
        # The call itself blew up after its own retries, so again: no
        # verdict was reached. Defer rather than reject.
        return VALIDATION_DEFERRED, f'Gemini validation failed ({exc})', {}

    # A structurally malformed result is a MALFUNCTION, not a verdict.
    #
    # validate_product_decision reads its fields with getattr defaults,
    # so an object that carries none of them -- a truncated response, a
    # parse that half-failed, an SDK shape change -- silently becomes
    # image_type="" and is_product_image=False, which reads exactly like
    # a confident "this is not a tile" and the image gets DELETED.
    #
    # A real ProductAnalysis always carries both fields (they have
    # defaults). Neither present means nothing classified this image,
    # which is the deferral case, not the rejection case.
    if not (
        str(getattr(gemini_result, 'decision', '') or '').strip()
        or str(getattr(gemini_result, 'image_type', '') or '').strip()
    ):
        return (
            VALIDATION_DEFERRED,
            'classifier returned an unusable result (no decision and no '
            'image_type) -- nothing judged this image',
            {},
        )

    # cv_score is accepted by validate_product_decision for signature
    # compatibility with its other caller (catalog_pipeline.py) but is not
    # read by its current decision logic (image_type + is_product_image
    # only) -- so it is not computed here. calculate_cv_score() reads the
    # file with OpenCV, whose build in this environment has no WebP
    # support (these candidates are saved as .webp), so calling it would
    # only add a silent-failure risk for a value that is discarded anyway.
    classifier_info = {
        'image_type': getattr(gemini_result, 'image_type', '?'),
        'confidence': getattr(gemini_result, 'confidence', 0.0),
    }

    decision = validate_product_decision(None, gemini_result)
    verdict = decision.get('decision')

    if verdict == 'REVIEW':
        # No classification happened (quota/rate limit). Report it as its
        # own state so the caller preserves the file instead of deleting
        # a tile nobody has actually looked at.
        return (
            VALIDATION_DEFERRED,
            decision.get('reason') or 'classification did not run',
            classifier_info,
        )

    if verdict != 'APPROVED' and not purity_is_authoritative:
        detail = decision.get('reason') or 'not approved as a standalone tile product'
        return (
            VALIDATION_REJECTED,
            f"{detail} [type={classifier_info['image_type']} "
            f"confidence={classifier_info['confidence']:.2f}]",
            classifier_info,
        )

    # On a region candidate the broad classifier does NOT get the casting
    # vote. It answers "what is this image?" about a swatch that was cut
    # out of a page, and it routinely answers OTHER or GRAPHIC at high
    # confidence for a genuine tile sample -- there is no room, no
    # product staging and no context left in the crop for it to
    # recognise. Rejecting on that verdict discarded real tiles.
    #
    # The question that actually applies to a candidate is the purity
    # one below: is this specific patch a tile surface, and only a tile
    # surface? The classifier's opinion is kept for the log and for the
    # product name, not for the decision.
    classifier_info['classifier_verdict'] = verdict

    with Image.open(output_path) as opened:
        opened.load()
        image = opened.convert('RGB') if opened.mode not in ('RGB', 'RGBA') else opened

        # Only trust the classifier's product box when the classifier
        # actually recognised a product. On a candidate it rejected, its
        # box points at nothing in particular.
        if gemini_result.product_bbox and verdict == 'APPROVED':
            bbox_check = validate_bbox(gemini_result.product_bbox, image.width, image.height)
            if bbox_check.get('valid'):
                trim_ok, trim_reason = bbox_trim_only_removes_background(
                    image, bbox_check['bbox'],
                )
                if trim_ok:
                    image = crop_image_to_validated_bbox(image, bbox_check['bbox'])
                else:
                    print(f"  [bbox] ignoring the classifier's product box: "
                          f"{trim_reason}")

        detected_size = detect_nearby_size_text(nearby_text)
        target_ratio = parse_product_aspect_ratio(detected_size)

        # A SIZE LABEL MUST NEVER CUT THE PRODUCT DOWN.
        #
        # crop_image_to_aspect_ratio centre-crops to the ratio read off
        # the page, and `nearby_text` is the text near the SOURCE image,
        # within MAX_LABEL_DISTANCE_PT. Two things follow, and both were
        # destroying products:
        #
        #  * On a region candidate the rect passed in belongs to the
        #    PARENT image, not to this crop, so the label can belong to a
        #    different product on the same page entirely. The region's
        #    own boundary is the better evidence of its shape -- it was
        #    measured from this product's pixels -- so the label does not
        #    get to overrule it.
        #  * Even on a whole image, forcing a 1:2 panel to a "600x600"
        #    label throws away half the product. Measured on the real
        #    single_catalog/18_mozart_frame_collection pages: a complete
        #    931x1859 framed panel became 931x931, losing 50% of itself
        #    and both moulded ends -- the extracted "tile" was a
        #    featureless slab.
        #
        # So the correction now only ever trims a slight mismatch, and
        # only where the label can actually be this product's own.
        if target_ratio and not purity_is_authoritative:
            before_area = image.width * image.height
            corrected = crop_image_to_aspect_ratio(image, target_ratio)
            kept = (corrected.width * corrected.height) / max(1, before_area)
            if kept >= MAX_ASPECT_CORRECTION_LOSS:
                image = corrected
            else:
                print(
                    f"  [aspect] ignoring size label {detected_size}: "
                    f"cropping to it would discard {100 * (1 - kept):.0f}% "
                    f"of the product"
                )

        image.save(output_path, 'WEBP', quality=IMAGE_QUALITY, method=6)

    metadata = {
        'product_name': (gemini_result.product_name or '').strip(),
        'size': detected_size or '',
        **classifier_info,
    }

    # THE PURITY GATE.
    #
    # Everything above decided that this image is ABOUT a tile product.
    # That was the only question the pipeline used to ask, and it is why
    # a kitchen, a caption and a person reached the catalog: all three
    # are images about a tile.
    #
    # Now ask what is actually in the frame. It runs here, after the
    # bbox and aspect-ratio corrections have been written, so it judges
    # the exact pixels that would be saved -- a correction that already
    # cropped the person away should pass, and does.
    purity_verifier = load_tile_purity_verifier()
    if purity_verifier is None:
        if verdict != 'APPROVED':
            # The classifier's rejection was set aside a moment ago only
            # because purity was going to decide instead. With purity
            # unavailable there is nothing left to decide with, so the
            # rejection stands rather than becoming an approval by
            # default.
            return (
                VALIDATION_REJECTED,
                f"{decision.get('reason') or 'not a tile product'} "
                f"(purity verification unavailable)",
                classifier_info,
            )
        return VALIDATION_APPROVED, decision.get('reason') or '', metadata

    verify_tile_only, assess_tile_purity = purity_verifier

    try:
        observation = verify_tile_only(str(output_path))
    except Exception as exc:  # noqa: BLE001 -- no verdict, not a dirty verdict
        observation = None
        purity_error = str(exc)
    else:
        purity_error = ''

    if observation is None:
        # Nothing inspected the frame, so its contents are unknown. An
        # unknown frame must not be published -- that is how the girl
        # got in -- but it must not be deleted either. Same posture as a
        # missing classification: defer and look again later.
        return (
            VALIDATION_DEFERRED,
            'purity verification did not run'
            + (f' ({purity_error})' if purity_error else ''),
            metadata,
        )

    purity = assess_tile_purity(observation)
    metadata['purity'] = observation
    metadata['purity_state'] = purity['state']

    from app.image_validator import PURITY_CLEAN, PURITY_CONTAMINATED

    if purity['state'] == PURITY_CLEAN:
        return VALIDATION_APPROVED, purity['reason'], metadata

    if purity['state'] == PURITY_CONTAMINATED:
        # Real tile, wrong framing. Not a rejection -- the caller goes
        # and cuts the tile surface out of it.
        return VALIDATION_IMPURE, purity['reason'], metadata

    return VALIDATION_REJECTED, purity['reason'], metadata


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
    on_tile=None,
):
    """Extracts validated tile-only images from one catalog PDF.

    `on_tile` is called with each finished tile record the moment it is
    accepted, so the caller can upload and record it immediately rather
    than waiting for the whole PDF. Extraction does not depend on what
    it does; a failure there is reported and the search continues.
    """
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
    # Appearance of every product accepted ANYWHERE in this catalog, so a
    # range photographed again on a later page is recognised. seen_hashes
    # above is exact-byte and catches only a literally identical source
    # image; this is perceptual and survives re-rasterization.
    catalog_signatures = []
    candidates_examined = 0
    too_small_skipped = 0
    duplicates_skipped = 0
    room_photos_skipped = 0
    semantic_rejections = 0
    hard_filtered_count = 0
    rejection_categories = {}

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

    # Region mining needs the same validator for its second pass, so it is
    # pointless without one.
    region_miner = load_tile_region_miner() if semantic_validator else None
    regions_recovered = 0
    page_render_recoveries = 0

    # Candidates whose file was kept but which no classifier judged --
    # counted and manifested separately from rejections, because a
    # rejection is a decision and this is the absence of one.
    validation_deferred = 0
    deferred_records = []

    # One entry per tile-surface candidate examined, whatever became of
    # it. Written out at the end of the catalog so a run that recovered
    # nothing can be diagnosed from its decisions rather than re-run under
    # a debugger -- which geometry arrived, what it normalized to, which
    # stage ended it, and what the region validator said.
    region_trace = []

    for page_number, page in enumerate(
        document,
        start=1,
    ):

        # Cached once per page: get_page_text_spans() re-reads the whole
        # page's text layout, so computing it once and reusing it for every
        # image on the page (rather than once per image) avoids repeating
        # that work for a page with several tiles on it.
        text_spans = get_page_text_spans(page)

        # Watermark for the page-render fallback below: if nothing is
        # appended for this page by the embedded-image path, the page's
        # tiles (if any) are not embedded rasters at all.
        accepted_before_page = len(extracted_images)
        # One set per PAGE, shared by every search of it, so a tile seen
        # by two routes is kept once. Deliberately per-page: it carries
        # page geometry, which only means anything within one page --
        # catalogs lay products on a fixed grid, so the same box on two
        # pages is two different products. Cross-page repeats are caught
        # by catalog_signatures instead, on appearance alone.
        page_signatures = []

        emit(f"   Page {page_number}")

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

                    # Ignore tiny icons/logos -- but count them, so a
                    # catalog that comes back short can be diagnosed from
                    # its own summary instead of guessed at.
                    if is_too_small_for_a_product(width, height):
                        too_small_skipped += 1
                        print(
                            f"  TOO SMALL -- page {page_number}: "
                            f"{width}x{height}px is below the product floor "
                            f"(long side {MIN_IMAGE_LONG_SIDE}, short side "
                            f"{MIN_IMAGE_SHORT_SIDE}, area {MIN_IMAGE_AREA})"
                        )
                        continue

                    # Conservative early reject: extreme aspect ratios,
                    # obvious logo/text banners, tiny page fragments.
                    # Does not call Gemini.
                    early_reject, early_reason = early_reject_candidate(
                        width, height, image_bytes=image_bytes,
                        image_rect=image_rect, page_rect=page.rect,
                    )
                    if early_reject:
                        print(f"  [early-filter] page {page_number}: "
                              f"rejected ({early_reason})")
                        continue

                    candidates_examined += 1

                    # Thin-strip filter -- pure arithmetic on the
                    # dimensions already in hand, so it runs before even
                    # a pixel decode. See is_thin_strip_image's own
                    # docstring for why the threshold is safe.
                    strip_reject, strip_reason = is_thin_strip_image(width, height)
                    if strip_reject:
                        hard_filtered_count += 1
                        print(
                            f"  HARD FILTER -- page {page_number}, "
                            f"candidate #{candidates_examined}: {strip_reason}"
                        )
                        continue

                    # Early hard filters -- conservative, pre-Gemini reject.
                    # Unlike the room/lifestyle check below, a pure solid
                    # colour bar or a block of printed text has no tile
                    # surface anywhere inside it for a region search to
                    # recover, so this skips straight past BOTH the
                    # whole-image call and the region-mining search below
                    # rather than choosing between them. See
                    # classify_hard_reject's own docstring for why these
                    # thresholds are safe.
                    hard_reject, hard_reason = classify_hard_reject(image_bytes)
                    if hard_reject:
                        hard_filtered_count += 1
                        # No image_counter/filename yet -- this candidate is
                        # filtered before either is assigned, so it is named
                        # by page and its running catalog-wide count instead.
                        print(
                            f"  HARD FILTER -- page {page_number}, "
                            f"candidate #{candidates_examined}: {hard_reason}"
                        )
                        continue

                    # Statistical room/lifestyle detection. Deliberately NOT
                    # a place to stop any more: a room photo is precisely
                    # where a tiled wall or floor lives, and that surface is
                    # the product the catalog is selling. Skipping here threw
                    # those away before anything had looked for them.
                    #
                    # What it still decides is whether the whole-image
                    # semantic call is worth paying for. It isn't: the
                    # statistics already say this is a scene, and asking
                    # Gemini "is this whole photo a tile product?" would only
                    # confirm it. So the image goes straight to the region
                    # search below instead, which is the question that
                    # actually matters for a scene.
                    is_room_photo, _reason = classify_image_content(
                        image_bytes, image_rect, page.rect
                    )

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

                    # THE SAME PAGE-TRIM THE REGION PATH DOES.
                    #
                    # A catalog that prints its products at an angle does
                    # it in its embedded images too: a tilted tile with
                    # the page, and often a caption, around it. Trimming
                    # here means the classifier and the purity model see
                    # the product instead.
                    #
                    # Only a clean "trimmed" verdict is acted on. A frame
                    # this cannot resolve is left exactly as it was,
                    # because region mining below may still find real
                    # products inside it -- refusing the whole image here
                    # would throw those away with it.
                    try:
                        import cv2
                        import numpy as np

                        from app.tile_region_extractor import trim_to_product

                        trimmed, trim_note = trim_to_product(
                            cv2.cvtColor(
                                np.array(image.convert("RGB")),
                                cv2.COLOR_RGB2BGR,
                            )
                        )
                        if trim_note.get("action") == "trimmed":
                            image = Image.fromarray(
                                cv2.cvtColor(trimmed, cv2.COLOR_BGR2RGB)
                            )
                            print(f"  [trim] page {page_number} image "
                                  f"{image_counter}: {trim_note['reason']}")
                    except Exception as exc:  # noqa: BLE001 -- never fatal
                        print(f"  [trim] page {page_number} image "
                              f"{image_counter}: not trimmed ({exc})")

                    image.save(
                        output_path,
                        "WEBP",
                        quality=IMAGE_QUALITY,
                        method=6,
                    )

                    if is_room_photo:
                        room_photos_skipped += 1

                        print(
                            f"  [tile-region] page {page_number} image "
                            f"{image_counter}: reads statistically as a "
                            f"room/lifestyle scene -- searching it for tiled "
                            f"surfaces rather than discarding it"
                        )

                        recovered, region_deferred = [], []
                        if region_miner is not None:
                            recovered, region_deferred = mine_tile_regions(
                                output_path,
                                page_number,
                                image_counter,
                                text_spans,
                                image_rect,
                                semantic_validator,
                                region_miner,
                                output_directory,
                                trace=region_trace,
                                seen_signatures=page_signatures,
                                catalog_signatures=catalog_signatures,
                            )

                        # Deferrals are preserved BEFORE the source is
                        # deleted. A deferred entry can BE the source
                        # image -- that is what mining hands back when
                        # detection never ran -- and unlinking first
                        # deleted the very file being preserved.
                        for deferred_path, deferred_reason, deferred_meta in region_deferred:
                            if defer_for_revalidation(
                                deferred_path, page_number, image_counter,
                                deferred_reason, deferred_meta,
                                output_directory, deferred_records,
                            ) is not None:
                                validation_deferred += 1

                        output_path.unlink(missing_ok=True)

                        regions_recovered += len(recovered)
                        image_counter = append_recovered_regions(
                            recovered, extracted_images,
                            page_number, image_counter, on_tile,
                        )
                        continue

                    # Last gate, and the only one that judges what the
                    # image actually DEPICTS rather than how its pixels are
                    # statistically distributed (classify_image_content
                    # above) -- see validate_and_correct_tile_image. Also
                    # applies the product aspect-ratio correction in place
                    # on the same saved file when approved.
                    validation_status, validation_reason, tile_metadata = validate_and_correct_tile_image(
                        output_path, image_rect, text_spans, semantic_validator,
                    )

                    if validation_status == VALIDATION_DEFERRED and not TILE_ONLY_CATALOG:
                        # Gemini never classified this image, so there is
                        # no verdict to act on. Keep the file and record
                        # how to finish the job later -- deleting a tile
                        # because an API ran out of quota is the bug this
                        # branch exists to prevent. It stays out of Drive,
                        # MASTER and the Tile table until something has
                        # actually looked at it.
                        #
                        # Not in tile-only mode. Deferral exists because an
                        # unclassified image MIGHT be a bathroom photo and
                        # publishing it unseen is the worse error. On a
                        # catalog that contains no bathroom photos there is
                        # nothing to protect against, and holding products
                        # back for a classifier they do not need just means
                        # a dead quota empties the catalog. It falls through
                        # to the search below instead, and is kept.
                        print(
                            f"  DEFERRED -- validation could not run "
                            f"(page {page_number} image {image_counter}): "
                            f"{validation_reason}"
                        )
                        kept = defer_for_revalidation(
                            output_path, page_number, image_counter,
                            validation_reason, tile_metadata,
                            output_directory, deferred_records,
                        )
                        if kept is not None:
                            validation_deferred += 1
                            print(
                                f"    image preserved for revalidation: "
                                f"{DEFERRED_DIRECTORY_NAME}/{kept.name}"
                            )
                        continue

                    if validation_status != VALIDATION_APPROVED:
                        if validation_status == VALIDATION_IMPURE:
                            # Not a rejection. The tile is real; this
                            # framing just is not a swatch, so the mining
                            # below goes and cuts the surface out of it.
                            # Saying "REJECTED" here would describe the
                            # exact bug this branch fixes.
                            category = "needs tile isolation"
                            print(
                                f"  NOT TILE-ONLY -- "
                                f"(page {page_number} image {image_counter}): "
                                f"{validation_reason}"
                            )
                            print(
                                f"    isolating the tile surface instead of "
                                f"saving the frame as-is"
                            )
                        elif validation_status == VALIDATION_DEFERRED:
                            # Not a rejection, and saying so matters. The
                            # line used to read "REJECTED -- validation
                            # could not run", which is a contradiction:
                            # nothing judged this frame, so nothing
                            # rejected it. Reading those as verdicts is
                            # what made a run whose quota had died look
                            # like a pipeline refusing everything.
                            category = "not judged"
                            print(
                                f"  NOT JUDGED -- nothing classified this "
                                f"image (page {page_number} image "
                                f"{image_counter}): {validation_reason}"
                            )
                        else:
                            category = categorize_rejection(validation_reason)
                            print(
                                f"  REJECTED -- {category} "
                                f"(page {page_number} image {image_counter}): "
                                f"{validation_reason}"
                            )

                        # The image is not a tile product, but it may
                        # SHOW tile. Mine it for surfaces before discarding
                        # it -- unconditionally: the source image's own
                        # classification (GRAPHIC, ROOM, COLLAGE, whatever
                        # category printed above) is where the search
                        # starts, never a reason to skip searching. Each
                        # recovered swatch is independently re-validated
                        # inside mine_tile_regions -- on the swatch itself,
                        # not on this verdict.
                        recovered, region_deferred = [], []
                        if region_miner is not None:
                            would_have_skipped = (
                                category not in LEGACY_REGION_MINEABLE_CATEGORIES
                            )
                            print(
                                f"  [tile-region] source classification "
                                f"'{category}'"
                                + (
                                    " -- searching anyway (previously this "
                                    "category would have skipped region "
                                    "search entirely)"
                                    if would_have_skipped else ""
                                )
                            )
                            recovered, region_deferred = mine_tile_regions(
                                output_path,
                                page_number,
                                image_counter,
                                text_spans,
                                image_rect,
                                semantic_validator,
                                region_miner,
                                output_directory,
                                trace=region_trace,
                                seen_signatures=page_signatures,
                                catalog_signatures=catalog_signatures,
                            )

                        # Before the unlink, and before the early exit
                        # below. This loop used to sit after both: the
                        # source was deleted first, and then skipped
                        # entirely whenever nothing was recovered --
                        # which is precisely the case a deferral exists
                        # for. A quota-killed image hit both bugs at
                        # once and vanished without a record.
                        # NOTHING WAS CUT OUT OF IT, AND THE SOURCE SAYS
                        # IT IS A PRODUCT.
                        #
                        # On a tile-only catalog this is the last place a
                        # product can silently disappear: the classifier
                        # declined it, the region search then found no
                        # surface inside it either, and the old path
                        # deleted it on the strength of those two. But an
                        # embedded image on a prepared page IS a product
                        # picture -- a search that finds no sub-region in
                        # it has found that it is ONE tile, not that it is
                        # no tile. So it is kept whole, and falls through
                        # to the normal accept path below.
                        #
                        # UNLESS the source's own classification already
                        # named it as something that cannot be rescued
                        # this way -- see KEEP_WHOLE_BLOCKED_CATEGORIES.
                        # A logo and a captioned multi-tile layout page
                        # are exactly the inputs this guard exists for:
                        # both confidently are NOT one tile product, so a
                        # region search finding nothing inside them is not
                        # evidence that the whole frame is the product.
                        from app.image_validator import tile_only_may_keep_whole

                        keep_whole = (
                            TILE_ONLY_CATALOG
                            and not recovered
                            and category not in KEEP_WHOLE_BLOCKED_CATEGORIES
                            and tile_only_may_keep_whole(
                                validation_status, tile_metadata,
                                impure_status=VALIDATION_IMPURE,
                                deferred_status=VALIDATION_DEFERRED,
                            )
                        )

                        if not keep_whole:
                            for deferred_path, deferred_reason, deferred_meta in region_deferred:
                                if defer_for_revalidation(
                                    deferred_path, page_number, image_counter,
                                    deferred_reason, deferred_meta,
                                    output_directory, deferred_records,
                                ) is not None:
                                    validation_deferred += 1

                            # A frame nothing ever judged is not deleted
                            # either. Publishing it unseen was the bug
                            # above; throwing it away on a dead quota is
                            # the opposite one, and the catalog loses a
                            # product for an outage. Keep it where a
                            # later run can finish the job.
                            if validation_status == VALIDATION_DEFERRED:
                                if defer_for_revalidation(
                                    output_path, page_number, image_counter,
                                    validation_reason, tile_metadata,
                                    output_directory, deferred_records,
                                ) is not None:
                                    validation_deferred += 1
                                    print(f"    unjudged frame preserved for "
                                          f"revalidation (page {page_number} "
                                          f"image {image_counter})")
                                    continue

                            output_path.unlink(missing_ok=True)

                            if not recovered:
                                # Only a rejection when something actually
                                # judged it. A deferred image was never
                                # looked at, so counting it as rejected
                                # would report a verdict nobody reached.
                                if not region_deferred:
                                    semantic_rejections += 1
                                    rejection_categories[category] = (
                                        rejection_categories.get(category, 0) + 1
                                    )
                                continue

                            regions_recovered += len(recovered)
                            image_counter = append_recovered_regions(
                                recovered, extracted_images,
                                page_number, image_counter, on_tile,
                            )
                            continue

                        print(f"  [tile-only] page {page_number} image "
                              f"{image_counter}: no separate surface inside "
                              f"it, so the image itself is the product -- "
                              f"kept whole")

                    # validate_and_correct_tile_image may have cropped the
                    # saved file (bbox and/or aspect-ratio correction), so
                    # the recorded width/height must reflect the FINAL
                    # saved pixels, not the pre-crop ones above. Canvas
                    # presentation runs only after approval.
                    present_tile_on_canvas(output_path)

                    with Image.open(output_path) as corrected:
                        width, height = corrected.size

                    record = {
                        "page": page_number,
                        "image_index": image_counter,
                        "filename": output_filename,
                        "path": str(
                            output_path
                        ),
                        "width": width,
                        "height": height,
                        # Carried purely so the backend sync below can
                        # fill these columns on the Tile row; both are
                        # already-derived values, and either may be "".
                        "product_name": tile_metadata.get("product_name", ""),
                        "size": tile_metadata.get("size", ""),
                    }

                    try:
                        import cv2

                        _whole = cv2.imread(str(output_path), cv2.IMREAD_COLOR)
                        if _whole is not None:
                            _whole_signature = crop_signature(_whole)

                            # ASK BEFORE TELLING.
                            #
                            # This path registered its signature in both
                            # lists and never once read either of them,
                            # so the checks it was feeding could not see
                            # it coming. A product already extracted --
                            # as a region, or whole on an earlier page --
                            # was accepted a second time here under a
                            # different filename, which is precisely the
                            # "same tile, two names" the catalog owner
                            # reported.
                            #
                            # The region path asks both questions before
                            # accepting; this one now asks the same two,
                            # in the same order, with the same
                            # tolerances.
                            from app.tile_region_extractor import (
                                signatures_match,
                            )

                            _twin = None
                            if signature_already_seen(
                                page_signatures, _whole_signature,
                                source_key=f"embedded-image:{output_filename}",
                                page_box=(tuple(float(v) for v in image_rect)
                                          if image_rect is not None else None),
                            ):
                                _twin = "another route on this page"
                            else:
                                _twin = next(
                                    (name for name, other in catalog_signatures
                                     if signatures_match(
                                         _whole_signature, other,
                                         max_difference_fraction=(
                                             CATALOG_DUPLICATE_MAX_DIFFERENCE),
                                     )),
                                    None,
                                )

                            if _twin is not None:
                                print(f"  DUPLICATE -- page {page_number} "
                                      f"image {image_counter}: already "
                                      f"extracted as {_twin}")
                                output_path.unlink(missing_ok=True)
                                duplicates_skipped += 1
                                continue

                            page_signatures.append((
                                f"embedded-image:{output_filename}",
                                _whole_signature,
                                tuple(float(v) for v in image_rect)
                                if image_rect is not None else None,
                            ))
                            # Also into the catalog-wide list, so a
                            # product saved WHOLE here is recognised when
                            # the same product turns up as a region on a
                            # later page. Without this the cross-page
                            # check only ever saw region crops and a
                            # whole-image product could still be
                            # extracted twice.
                            catalog_signatures.append(
                                (output_filename, _whole_signature)
                            )
                    except Exception:  # noqa: BLE001 -- dedupe aid only
                        pass

                    extracted_images.append(record)
                    notify_tile(on_tile, record)

                except Exception as exc:

                    print(
                        "Image extraction failed in "
                        f"{pdf_path.name}: {exc}"
                    )

        # ----------------------------------------------------------
        # Page-render fallback.
        #
        # Everything above reads page.get_images() -- the PDF's embedded
        # raster resources. Plenty of catalogs do not put their tiles
        # there: the swatch is vector artwork, or a composed layout of
        # clipped graphics, or a shape filled with a pattern. For those
        # pages get_images() returns nothing (or nothing usable) and the
        # tile is never even looked at, however clearly it is printed.
        #
        # So when a page yields no accepted tile, rasterize the page
        # itself and put THAT through the same region detection and the
        # same strict per-region validation. Nothing is loosened: a
        # rendered page is simply another image to search, and every
        # swatch cut out of it must still independently pass the
        # validator before it can become a Tile row.
        # ----------------------------------------------------------
        # NOTE: this deliberately no longer requires the page to have
        # yielded nothing. It used to read
        #     len(extracted_images) == accepted_before_page
        # which meant one tile found in an embedded image stopped the
        # page render from ever running -- so on a sheet showing several
        # tiles, the ones only visible in the render were never looked
        # for. Every page with visual content is now searched by both
        # routes, and page_signatures keeps a tile found twice from
        # being extracted twice.
        if (
            region_miner is not None
            and page_has_visual_content(page)
        ):
            render_path = (
                output_directory
                / f"{pdf_path.stem}_page_{page_number}_render.webp"
            )

            try:
                page_bytes, page_width, page_height = render_image_crop(
                    page, page.rect, dpi=PAGE_RENDER_DPI,
                )

                with Image.open(BytesIO(page_bytes)) as rendered:
                    rendered.convert("RGB").save(
                        render_path, "WEBP",
                        quality=IMAGE_QUALITY, method=6,
                    )

                print(
                    f"  [page-render] page {page_number}: no tile from "
                    f"embedded images -- searching the rendered page "
                    f"({page_width}x{page_height} @ {PAGE_RENDER_DPI}dpi)"
                )

                recovered, region_deferred = mine_tile_regions(
                    render_path,
                    page_number,
                    0,
                    text_spans,
                    page.rect,
                    semantic_validator,
                    region_miner,
                    output_directory,
                    source_type="rendered-page",
                    trace=region_trace,
                    seen_signatures=page_signatures,
                    catalog_signatures=catalog_signatures,
                )

                for deferred_path, deferred_reason, deferred_meta in region_deferred:
                    if defer_for_revalidation(
                        deferred_path, page_number, 0,
                        deferred_reason, deferred_meta,
                        output_directory, deferred_records,
                    ) is not None:
                        validation_deferred += 1

                regions_recovered += len(recovered)
                page_render_recoveries += len(recovered)
                image_counter = append_recovered_regions(
                    recovered, extracted_images, page_number, image_counter,
                    on_tile,
                )

            except Exception as exc:  # noqa: BLE001 -- a fallback must never abort the run
                print(
                    f"  [page-render] page {page_number} failed: {exc}"
                )

            finally:
                # The full-page render is scaffolding, never a product
                # image -- only the validated regions cut from it survive.
                render_path.unlink(missing_ok=True)

        # After BOTH routes, so the count is the page's real yield rather
        # than whatever the first route happened to find.
        emit(f"   Page {page_number} complete: "
             f"{len(extracted_images) - accepted_before_page} unique tile(s)")

    document.close()

    print("")
    print(f"Total PDF images discovered : {candidates_examined}")
    print(f"Too small to be a product   : {too_small_skipped}")
    print(f"Duplicates skipped          : {duplicates_skipped}")
    print(f"Hard-filtered (graphic/text): {hard_filtered_count}")
    print(f"Room/lifestyle -> mined     : {room_photos_skipped}")
    print(f"Rejected by tile validation : {semantic_rejections}")
    print(f"Deferred (not validated)    : {validation_deferred}")
    if region_miner is not None:
        print(f"Tile regions recovered      : {regions_recovered}")
        print(f"  from embedded images      : {regions_recovered - page_render_recoveries}")
        print(f"  from rendered pages       : {page_render_recoveries}")
    print(f"Accepted tile images        : {len(extracted_images)}")

    if rejection_categories:
        print("")
        print("Rejected by category:")
        for label, count in sorted(
            rejection_categories.items(),
            key=lambda item: (-item[1], item[0]),
        ):
            print(f"  {count:4d}  REJECTED -- {label}")

    if extracted_images:
        print("")
        print("Accepted tile images:")
        for accepted in extracted_images:
            print(f"  {accepted['filename']}")

    if deferred_records:
        manifest_path = (
            output_directory
            / DEFERRED_DIRECTORY_NAME
            / f"{pdf_path.stem}_deferred.json"
        )
        try:
            manifest_path.write_text(
                json.dumps(
                    {
                        "catalog": pdf_path.name,
                        "status": VALIDATION_DEFERRED,
                        "reason": (
                            "Gemini classification did not run for these "
                            "images. They are NOT rejected and NOT "
                            "published; re-run this catalog once Gemini is "
                            "available and they will be validated normally."
                        ),
                        "count": len(deferred_records),
                        "images": deferred_records,
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
            print("")
            print("=" * 70)
            print(f"{len(deferred_records)} IMAGE(S) AWAITING VALIDATION")
            print("=" * 70)
            print(
                "These were extracted successfully but never classified, "
                "because Gemini was\nunavailable. They are preserved, not "
                "rejected, and are not in the catalog yet."
            )
            print("")
            print(f"  Files    : {manifest_path.parent}")
            print(f"  Manifest : {manifest_path}")
            print("")
            print(
                "  Re-run this catalog once Gemini quota resets to validate "
                "and publish them."
            )
            print("=" * 70)
        except OSError as exc:
            print(f"  [deferred] could not write {manifest_path}: {exc}")

    if region_trace:
        report_path = output_directory / f"{pdf_path.stem}_extraction_report.json"

        region_outcomes, region_reject_reasons = (
            summarise_candidate_outcomes(region_trace)
        )

        # WHY THE CATALOG CAME OUT THE SIZE IT DID.
        #
        # The same roll-up the report gets, on the terminal, once per
        # catalog. Without it a run that refused forty candidates said
        # so forty times during the pages and not once at the end, so
        # the operator could see THAT the catalog was nearly empty but
        # not WHICH decision emptied it -- which is the only question
        # worth asking of a disappointing run. Grouped and counted, so
        # one repeated verdict is one line.
        # Duplicates are left out of THIS list, though the report
        # still carries them. "Already extracted from the other route
        # on this page" is the dedup working, not a product lost, and
        # listing it under "did not become tiles" turns a healthy run
        # into an alarming one.
        refusals = {}
        materials_by_reason = {}
        for entry in region_trace:
            if str(entry.get("final") or "") in ("ACCEPTED", "DUPLICATE"):
                continue
            reason = str(
                entry.get("validation_reason")
                or entry.get("purity_state")
                or entry.get("reason")
                or "no reason recorded"
            )
            refusals[reason] = refusals.get(reason, 0) + 1
            material = entry.get("material")
            if material:
                materials_by_reason.setdefault(reason, set()).add(
                    str(material)
                )
        region_reject_reasons_shown = dict(
            sorted(refusals.items(), key=lambda item: -item[1])
        )

        if region_reject_reasons_shown:
            refused = sum(region_reject_reasons_shown.values())
            emit("")
            emit(f"   Why {refused} candidate(s) did not become tiles:")
            for reason, count in list(region_reject_reasons_shown.items())[:8]:
                # The model's own word for the surface, where it had
                # one. A sentence like "a landmark clad in tile is
                # still a landmark" does not say whether the model
                # answered LANDMARK or FRAME, and on a catalog of
                # decorative frames those are very different findings.
                named = sorted(materials_by_reason.get(reason, ()))
                suffix = f"   [model said: {', '.join(named)}]" if named else ""
                emit(f"      {count:>3}  {reason}{suffix}")
            remaining = len(region_reject_reasons_shown) - 8
            if remaining > 0:
                emit(f"           ... and {remaining} other reason(s); "
                     f"the full list is in the report below")

        try:
            report_path.write_text(
                json.dumps(
                    {
                        "catalog": pdf_path.name,
                        "images_discovered": candidates_examined,
                        "candidates": len(region_trace),
                        "accepted": len(extracted_images),
                        "regions_recovered": regions_recovered,
                        "from_rendered_pages": page_render_recoveries,
                        "duplicates_skipped": duplicates_skipped,
                        "hard_filtered": hard_filtered_count,
                        "too_small_skipped": too_small_skipped,
                        "rejected_by_validation": semantic_rejections,
                        "deferred_for_validation": validation_deferred,
                        "candidate_outcomes": region_outcomes,
                        "candidate_reject_reasons": region_reject_reasons,
                        "trace": region_trace,
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
            print("")
            print(f"Extraction report           : {report_path}")
        except OSError as exc:
            print(f"  [report] could not write {report_path}: {exc}")

    if semantic_validator is None and not extracted_images and semantic_rejections > 0:
        print(
            "  [tile-validation] ERROR -- every candidate was rejected because semantic "
            "validation is unavailable. Configure GEMINI_API_KEY before assuming this "
            "catalog has no tiles."
        )

    return extracted_images


def summarise_candidate_outcomes(region_trace):
    """What happened to every mined candidate, and why, for the report.

    The run's own counters only cover the whole-image route, so a
    catalog whose regions were all refused still summarised as
    "candidates: 12, rejected_by_validation: 0": the report said
    nothing about the decision that actually emptied the catalog, and
    the trace had to be read entry by entry to find it. Both tallies
    are derived from that same trace -- no decision is made or changed
    here, only reported -- and the outcomes sum to len(region_trace),
    so a candidate that reaches the report without a recorded outcome
    shows up as UNRECORDED rather than disappearing from the total.

    Returns (outcomes, reject_reasons), reasons ordered commonest
    first.
    """
    outcomes = {}
    reasons = {}
    for entry in region_trace:
        outcome = str(entry.get("final") or "UNRECORDED")
        outcomes[outcome] = outcomes.get(outcome, 0) + 1
        if outcome == "ACCEPTED":
            continue
        reason = str(
            entry.get("validation_reason")
            or entry.get("purity_state")
            or entry.get("reason")
            or f"{outcome.lower()}, no reason recorded"
        )
        reasons[reason] = reasons.get(reason, 0) + 1
    ordered = dict(sorted(reasons.items(), key=lambda item: -item[1]))
    return outcomes, ordered


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

    _catalog_tiles = []

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

    emit("")
    emit(f"\U0001F4C1 Company: {brand}")
    emit(f"   \U0001F4E6 Catalog: {catalog}")
    if TILE_ONLY_CATALOG:
        emit("   Mode: TILE-ONLY (source is pre-filtered; semantic "
             "classification is advisory)")

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
    # 2. Create/find Brand folder in Google Drive
    #
    # The Drive and Sheets destinations are prepared BEFORE any
    # extraction, because each tile is now uploaded the moment it is
    # found. Previously this ran after the whole PDF had been read,
    # which is precisely why nothing survived a crash mid-catalog.
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
    # 3. Create/find Catalog folder inside Brand
    # --------------------------------------------------------

    catalog_folder_id = (
        get_or_create_folder(
            drive_service,
            catalog,
            parent_id=brand_folder_id,
        )
    )

    # One lookup per distinct size per run, not per tile. Filled in by
    # persist_tile as sizes are met; see size_folder_name().
    size_folder_ids = {}

    # --------------------------------------------------------
    # 4. Register Brand and Catalog
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
    # 5. Per-tile persistence, called during extraction
    # --------------------------------------------------------

    uploaded_count = 0        # completed the FULL chain incl. Tile row
    drive_uploaded_count = 0  # reached Google Drive
    master_row_count = 0      # reached the MASTER sheet
    skipped_count = 0
    sheet_failed_count = 0
    sync_failed_count = 0
    # Counted apart from the sheet and backend failures below: a tile
    # that never reached Drive is a different problem from one that
    # reached Drive and then failed to be recorded, and the summary
    # should not make an operator guess which happened.
    drive_failed_count = 0

    persisted = 0

    # TARGET-IMAGE IDENTITY, held for the length of this catalog.
    #
    # already_processed() is keyed on a hash that includes the FILENAME,
    # and filenames are unique by construction -- page_1_img_1_region_2
    # is never page_1_render_region_1 even when both hold the same tile.
    # So the same physical tile found by two routes produced two keys,
    # neither of which had been seen, and two Drive files.
    #
    # This is the same saved bytes under a different name, which is a
    # thing the content alone can answer. Held in memory for the run AND
    # written to the processed-files table, so the guard survives a
    # re-run as well as a second route within one run. Exact bytes only:
    # two genuinely different tiles cannot collide, so no real product is
    # ever suppressed by it.
    uploaded_content_hashes = set()

    # Tiles are numbered WITHIN their page, because that is the unit the
    # operator is checking: "this sheet showed three tiles, did three
    # come out?" is answerable from Tile 1/2/3 under Page 1 and is not
    # answerable from a catalog-wide running index.
    page_tile_counter = {}

    def persist_tile(image):
        """Uploads ONE finished tile and records it, immediately.

        Called by extract_images_from_pdf the moment a tile passes
        validation, so each tile reaches Drive and MASTER before the
        next candidate is looked at. Previously this ran as a loop
        after the whole PDF had been extracted, so a crash anywhere
        in extraction meant nothing at all had been uploaded.
        """
        nonlocal uploaded_count, drive_uploaded_count, master_row_count
        nonlocal skipped_count, sheet_failed_count, sync_failed_count
        nonlocal drive_failed_count
        nonlocal persisted

        persisted += 1

        page_number = image.get("page", 0)
        page_tile_counter[page_number] = page_tile_counter.get(page_number, 0) + 1
        position = page_tile_counter[page_number]

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

        # The same key without the filename in it: "these exact pixels,
        # from this catalog". See uploaded_content_hashes above.
        content_key = (
            f"{pdf_path.resolve()}::content::{image_content_hash}"
        )

        # A RE-RUN RE-EXTRACTS. ONLY THIS RUN'S OWN WORK IS DEDUPED.
        #
        # already_processed() reads the processed-files table, which
        # outlives the run, so running the same catalog again skipped
        # every tile it had ever produced. That is not duplicate
        # prevention -- it is a one-way door. Delete a tile from Drive
        # by accident and no command could ever bring it back: the row
        # saying "done" is still there, and the only thing that would
        # have re-made the image is the run that now refuses to.
        #
        # So the cross-run memory no longer suppresses anything. It is
        # still WRITTEN (mark_processed below), because the table is
        # read by other parts of the system and losing its rows would
        # be a different kind of damage.
        #
        # uploaded_content_hashes is this run's own set and still
        # applies: the same tile found twice by two routes in ONE pass
        # is a duplicate and is still dropped, which is the "same tile,
        # two names" case. Across runs it is not a duplicate; it is the
        # same catalog being extracted again, deliberately.
        if (image_content_hash != "unreadable"
                and image_content_hash in uploaded_content_hashes):
            print(
                "SKIP duplicate target image: "
                f"{image['filename']}"
            )
            emit(f"      Tile {position} \u2192 already extracted in this "
                 f"run \u2192 skipped")
            skipped_count += 1
            return

        # A running count, not "n of N": the total is not known while
        # tiles are still being found, and printing a denominator that
        # kept growing is what produced the old "Uploading tile 24/23".
        print(
            f"[DRIVE UPLOAD] started  tile {position}: "
            f"{image['filename']}"
        )

        # ROOT / BRAND / CATALOG / SIZE / the image.
        #
        # Resolved per tile and memoised per run, so a catalog with
        # four sizes costs four folder lookups rather than one per
        # image. A lookup failure is never fatal: the tile goes to the
        # catalog folder exactly as it did before, because an image
        # filed one level up is recoverable and an image not uploaded
        # at all is not.
        destination_folder_id = catalog_folder_id
        folder_label = size_folder_name(image.get("size", ""))
        try:
            if folder_label not in size_folder_ids:
                size_folder_ids[folder_label] = get_or_create_folder(
                    drive_service,
                    folder_label,
                    parent_id=catalog_folder_id,
                )
            destination_folder_id = size_folder_ids[folder_label]
        except Exception as exc:  # noqa: BLE001 -- see comment above
            print(f"[DRIVE UPLOAD] size folder {folder_label!r} "
                  f"unavailable ({exc}); using the catalog folder")
            folder_label = ""

        try:
            uploaded = upload_file(
                drive_service,
                image["path"],
                destination_folder_id,
            )
        except Exception as exc:  # noqa: BLE001
            # Not marked processed, so the next run retries THIS tile
            # while the ones that did upload are skipped -- per-candidate
            # recovery rather than per-page.
            print(f"[DRIVE UPLOAD] FAILED  {image['filename']}: {exc}")
            emit(f"      Tile {position} \u2192 extracted \u2192 UPLOAD "
                 f"FAILED ({exc}) -- will retry next run")
            drive_failed_count += 1
            return

        drive_url = uploaded.get(
            "webViewLink",
            "",
        )

        drive_uploaded_count += 1

        print(
            f"[DRIVE UPLOAD] success  {image['filename']} -> "
            f"{uploaded.get('id', '?')}"
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

            emit(f"      Tile {position} \u2192 uploaded \u2192 SHEET WRITE "
                 f"FAILED ({exc}) -- will retry next run")

            return

        master_row_count += 1

        print(f"[SHEETS] metadata saved  {product_id}  {drive_url}")

        # The MASTER row exists now. Mirror it into the Node backend's
        # Tile table so this product is actually selectable when
        # combinations are generated -- that generator reads only from
        # Postgres, never from Sheets/Drive, so a product that stops here
        # would be visible in MASTER but unusable in a mood board.
        #
        # Deliberately best-effort and AFTER the sheet write: it must
        # never abort a catalog whose row and image already landed.
        # The optional fields are the ones already derived during
        # extraction. Without them the Tile row lands with size/collection
        # NULL, which makes it score far below an older classified tile
        # when mood board candidates are ranked. backend_sync drops any of
        # these that is blank, so a product whose size text or name could
        # not be read syncs exactly as it does today.
        synced = sync_master_product_to_backend(
            product_code=product_id,
            brand=brand,
            product_name=image.get("product_name", ""),
            image_url=drive_url,
            size=image.get("size", ""),
            collection=catalog,
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
                f"  {product_id}"
            )
            print(
                f"    Drive upload : SUCCESS"
            )
            print(
                f"    MASTER row   : SUCCESS"
            )
            print(
                f"    Tile row     : FAILED -- see the [backend_sync] line "
                f"above for the reason"
            )
            print(
                f"    Not marked processed, so the next run retries it."
            )

            return

        mark_processed(
            file_hash=file_hash,
            filename=image["filename"],
        )

        # Recorded only after the upload has actually succeeded, so a
        # tile that failed to reach Drive is retried on the next run
        # rather than being remembered as done -- which is what keeps a
        # partial failure recoverable per candidate.
        if image_content_hash != "unreadable":
            uploaded_content_hashes.add(image_content_hash)
            mark_processed(
                file_hash=content_key,
                filename=image["filename"],
            )

        # Reported in the same shape as the failure case above, so a run
        # can be read stage by stage rather than by noticing which lines
        # are absent.
        print(f"  {product_id}")
        print(f"    Drive upload : SUCCESS")
        print(f"    MASTER row   : SUCCESS")
        print(f"    Tile row     : SUCCESS")

        uploaded_count += 1
        _catalog_tiles.append(image["filename"])
        # Where it landed, not just that it landed: the folder is the
        # answer to "where do I find it", and it is the one thing a
        # bare "uploaded" never told anyone.
        where = f"{brand} / {catalog}"
        if folder_label:
            where += f" / {folder_label}"
        emit(f"      Tile {position} \u2192 uploaded \u2192 "
             f"{where} / {image['filename']}")

    # --------------------------------------------------------
    # 6. Extract images -- each accepted tile is uploaded and
    #    recorded immediately, through persist_tile above
    # --------------------------------------------------------

    with quiet_stage():
        images = extract_images_from_pdf(
            pdf_path,
            images_directory,
            on_tile=persist_tile,
        )

    if not _catalog_tiles:
        emit("      (no tile images extracted)")

    # --------------------------------------------------------
    # 7. Save image information locally
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

    print("")

    # Reported per STAGE rather than as one "uploaded" number. A run where
    # every image reached Drive and MASTER but no Tile row was created is a
    # partial failure, and saying so plainly is the only way the operator
    # can tell it apart from a clean run.
    print(
        f"Accepted tile images : {len(images)}"
    )

    print(
        f"Already processed    : {skipped_count}"
    )

    print(
        f"Uploaded to Drive    : {drive_uploaded_count}"
    )

    print(
        f"Drive upload failures: {drive_failed_count}"
    )

    print(
        f"MASTER rows written  : {master_row_count}"
    )

    print(
        f"Tile rows created    : {uploaded_count}"
    )

    print(
        f"Sheet failures       : {sheet_failed_count}"
    )

    print(
        f"Backend sync failures: {sync_failed_count}"
    )

    if uploaded_count:
        print("")
        print("Tile rows created for:")
        for image in images:
            print(f"  {image['filename']}")

    # A run where every product reached Drive and MASTER but none reached
    # Postgres otherwise looks like a complete success -- the mood board
    # simply never shows the new tiles, with nothing in the output saying
    # why. Called out explicitly instead.
    if sync_failed_count:
        print("")
        print(
            f"WARNING -- {sync_failed_count} product(s) reached Drive and MASTER "
            f"but did NOT get a Tile row, so they cannot appear in a mood "
            f"board. They are deliberately left unmarked and will be retried "
            f"on the next run."
        )
        print(
            "  If the reason above is 'Internal sync is not configured on this "
            "server (INTERNAL_SYNC_API_KEY is unset)', the key is missing on "
            "the BACKEND, not here -- this extractor did send one. Set "
            "INTERNAL_SYNC_API_KEY to the same value in the backend's "
            "environment and in catalog_processor/.env."
        )
        print(
            "  Also confirm BACKEND_SYNC_URL points at the backend you mean "
            "(it defaults to http://localhost:5000/...)."
        )

    return {
        "brand": brand,
        "catalog": catalog,
        "pdf": pdf_path.name,
        "pages": len(pages),
        "images": len(images),
        "uploaded": uploaded_count,
        "drive_uploaded": drive_uploaded_count,
        "master_rows": master_row_count,
        "skipped": skipped_count,
        "sheet_failed": sheet_failed_count,
        "sync_failed": sync_failed_count,
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

    # Checked HERE, before a single page is read, rather than being
    # discovered one 403 at a time somewhere in the middle of the first
    # catalog. A misconfigured key does not stop the run -- Drive and
    # MASTER still work, and the products left unmarked are retried on the
    # next run once the key is fixed -- but the operator is told up front
    # which side is wrong, instead of after dozens of uploads.
    sync_ok, sync_detail = preflight_internal_sync()
    print("")
    if sync_ok:
        print(f"Tile sync : {sync_detail}")
    else:
        print(sync_detail)
        print("")
        print(
            "  Extraction will continue: images and MASTER rows are "
            "unaffected, and every product\n"
            "  whose Tile row fails is left unmarked so the next run "
            "retries it automatically."
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

    emit("")
    emit("=" * 50)
    emit("CATALOG EXTRACTION")
    emit("=" * 50)

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
    _companies = {r.get("brand") for r in results if isinstance(r, dict)}
    _images = sum(
        r.get("uploaded", 0) for r in results if isinstance(r, dict)
    )

    emit("")
    emit("=" * 50)
    emit("EXTRACTION COMPLETE")
    emit("=" * 50)
    emit(f"Companies processed: {len([c for c in _companies if c])}")
    emit(f"Products processed : {len(results)}")
    emit(f"Images extracted   : {_images}")
    emit("=" * 50)
    if not CATALOG_DEBUG:
        emit("(set CATALOG_DEBUG=1 for full per-candidate diagnostics)")
    emit("")

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
            "(example E:\\): "
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