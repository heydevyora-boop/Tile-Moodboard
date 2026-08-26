from __future__ import annotations

from pathlib import Path
from typing import Any, Optional
import base64
import hashlib
import mimetypes
import re
import urllib.parse


# ============================================================
# PROJECT PATHS
# ============================================================

PROJECT_ROOT = Path(__file__).resolve().parent.parent

OUTPUT_ROOT = (
    PROJECT_ROOT / "output"
)

SCENE_IMAGE_ROOT = (
    OUTPUT_ROOT / "scene_images"
)


# ============================================================
# SUPPORTED IMAGE TYPES
# ============================================================

IMAGE_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".bmp",
}


# ============================================================
# IMAGE MIME TYPES
# ============================================================

MIME_TO_EXTENSION = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
}


# ============================================================
# NORMALIZE INPUT
# ============================================================

def _normalize_scene_image_reference(
    value: Any,
) -> Any:
    """
    Normalize scene image input.

    Supported inputs:

        str path
        str URL
        str data URL
        str base64
        bytes
        bytearray
        dict containing image data
    """

    if value is None:
        return ""

    # --------------------------------------------------------
    # Bytes
    # --------------------------------------------------------

    if isinstance(value, (bytes, bytearray)):
        return bytes(value)

    # --------------------------------------------------------
    # Dictionary
    #
    # Supports:
    #
    # {
    #   "data": "...",
    #   "mime_type": "image/png"
    # }
    #
    # or:
    #
    # {
    #   "dataUrl": "data:image/png;base64,..."
    # }
    # --------------------------------------------------------

    if isinstance(value, dict):

        for key in (
            "dataUrl",
            "data_url",
            "base64",
            "image",
            "data",
            "url",
            "path",
        ):

            if key in value:

                nested = value.get(key)

                if nested is not None:
                    return nested

        return ""

    # --------------------------------------------------------
    # String
    # --------------------------------------------------------

    text = str(value).strip()

    if not text:
        return ""

    # Remove accidental quotes
    text = text.strip('"').strip("'")

    # --------------------------------------------------------
    # Fix escaped URLs
    # --------------------------------------------------------

    text = text.replace("\\\\", "/")

    if text.startswith("http:/") and not text.startswith(
        "http://"
    ):
        text = text.replace(
            "http:/",
            "http://",
            1,
        )

    elif text.startswith("https:/") and not text.startswith(
        "https://"
    ):
        text = text.replace(
            "https:/",
            "https://",
            1,
        )

    return text


# ============================================================
# REMOTE URL
# ============================================================

def _is_remote_scene_image(
    value: str,
) -> bool:

    return value.lower().startswith(
        (
            "http://",
            "https://",
        )
    )


# ============================================================
# DATA URL
# ============================================================

def _is_data_url(
    value: str,
) -> bool:

    return value.lower().startswith(
        "data:image/"
    )


# ============================================================
# BASE64 DETECTION
# ============================================================

def _looks_like_base64(
    value: str,
) -> bool:

    if not value:
        return False

    # Base64 should not look like a filesystem path or URL.
    if "/" in value and not value.startswith(
        "data:"
    ):
        return False

    if ":" in value:
        return False

    if len(value) < 100:
        return False

    return bool(
        re.fullmatch(
            r"[A-Za-z0-9+/=\s]+",
            value,
        )
    )


# ============================================================
# IMAGE FORMAT FROM BYTES
# ============================================================

def _detect_image_extension(
    image_bytes: bytes,
) -> str:
    """
    Detect common image types using file signatures.
    """

    # PNG
    if image_bytes.startswith(
        b"\x89PNG\r\n\x1a\n"
    ):
        return ".png"

    # JPEG
    if image_bytes.startswith(
        b"\xff\xd8\xff"
    ):
        return ".jpg"

    # WEBP
    if (
        len(image_bytes) >= 12
        and image_bytes[0:4] == b"RIFF"
        and image_bytes[8:12] == b"WEBP"
    ):
        return ".webp"

    # BMP
    if image_bytes.startswith(
        b"BM"
    ):
        return ".bmp"

    return ".jpg"


# ============================================================
# SAVE IMAGE BYTES
# ============================================================

def _save_scene_bytes(
    image_bytes: bytes,
    output_dir: Path,
    identifier: str,
    extension: Optional[str] = None,
) -> Path:

    if not image_bytes:

        raise ValueError(
            "Scene image contains no data."
        )

    output_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    if not extension:
        extension = _detect_image_extension(
            image_bytes
        )

    if not extension.startswith("."):
        extension = "." + extension

    if extension.lower() not in IMAGE_EXTENSIONS:

        extension = ".jpg"

    output_path = (
        output_dir
        / f"scene_{identifier}{extension}"
    )

    output_path.write_bytes(
        image_bytes
    )

    if not output_path.exists():

        raise RuntimeError(
            "Scene image could not be saved: "
            f"{output_path}"
        )

    if output_path.stat().st_size == 0:

        raise RuntimeError(
            "Scene image was saved but is empty: "
            f"{output_path}"
        )

    return output_path.resolve()


# ============================================================
# SAVE DATA URL
# ============================================================

def _save_data_url(
    data_url: str,
    output_dir: Path,
) -> Path:
    """
    Convert:

        data:image/png;base64,AAAA...

    into a local image file.
    """

    try:

        header, encoded = data_url.split(
            ",",
            1,
        )

    except ValueError as error:

        raise ValueError(
            "Invalid image data URL."
        ) from error

    header_lower = header.lower()

    if ";base64" not in header_lower:

        raise ValueError(
            "Only base64 image data URLs are supported."
        )

    mime_match = re.match(
        r"data:([^;]+);base64",
        header_lower,
    )

    mime_type = (
        mime_match.group(1)
        if mime_match
        else "image/jpeg"
    )

    extension = MIME_TO_EXTENSION.get(
        mime_type,
        ".jpg",
    )

    try:

        image_bytes = base64.b64decode(
            encoded,
            validate=False,
        )

    except Exception as error:

        raise ValueError(
            "Invalid base64 image data."
        ) from error

    identifier = hashlib.sha256(
        image_bytes
    ).hexdigest()[:24]

    return _save_scene_bytes(
        image_bytes=image_bytes,
        output_dir=output_dir,
        identifier=identifier,
        extension=extension,
    )


# ============================================================
# SAVE RAW BASE64
# ============================================================

def _save_base64_image(
    encoded: str,
    output_dir: Path,
) -> Path:

    encoded = re.sub(
        r"\s+",
        "",
        encoded,
    )

    try:

        image_bytes = base64.b64decode(
            encoded,
            validate=False,
        )

    except Exception as error:

        raise ValueError(
            "Invalid base64 scene image."
        ) from error

    identifier = hashlib.sha256(
        image_bytes
    ).hexdigest()[:24]

    return _save_scene_bytes(
        image_bytes=image_bytes,
        output_dir=output_dir,
        identifier=identifier,
    )


# ============================================================
# DOWNLOAD HTTP IMAGE
# ============================================================

def _download_remote_scene_image(
    source: str,
    output_dir: Path,
) -> Path:

    import requests

    try:

        response = requests.get(
            source,
            timeout=60,
            allow_redirects=True,
        )

    except requests.RequestException as error:

        raise RuntimeError(
            "Unable to download scene image: "
            f"{error}"
        ) from error

    if response.status_code != 200:

        raise RuntimeError(
            "Unable to download scene image "
            f"(HTTP {response.status_code}): "
            f"{source}"
        )

    content_type = (
        response.headers.get(
            "content-type",
            "",
        ).split(";")[0].strip().lower()
    )

    # --------------------------------------------------------
    # Reject HTML responses
    # --------------------------------------------------------

    if (
        content_type == "text/html"
        or content_type == "application/json"
    ):

        raise RuntimeError(
            "The scene image URL returned HTML/JSON "
            "instead of an image.\n"
            f"URL: {source}"
        )

    extension = MIME_TO_EXTENSION.get(
        content_type,
        _detect_image_extension(
            response.content
        ),
    )

    identifier = hashlib.sha256(
        source.encode("utf-8")
    ).hexdigest()[:24]

    return _save_scene_bytes(
        image_bytes=response.content,
        output_dir=output_dir,
        identifier=identifier,
        extension=extension,
    )


# ============================================================
# LOCAL FILE
# ============================================================

def _resolve_local_scene_path(
    value: str,
) -> Path:

    path = Path(value)

    if not path.is_absolute():

        path = (
            PROJECT_ROOT / path
        )

    path = path.resolve()

    if not path.exists():

        raise FileNotFoundError(
            f"Scene image not found: {path}"
        )

    if not path.is_file():

        raise ValueError(
            f"Scene image is not a file: {path}"
        )

    if (
        path.suffix.lower()
        not in IMAGE_EXTENSIONS
    ):

        raise ValueError(
            "Unsupported scene image format: "
            f"{path.suffix}"
        )

    return path


# ============================================================
# MAIN RESOLVER
# ============================================================

def resolve_scene_image(
    scene_image: Any,
    output_root: Optional[Path] = None,
) -> Path:
    """
    Resolve a bathroom reference image.

    IMPORTANT:

    This function DOES NOT require Google Drive.

    The frontend should preferably send the actual
    bathroom image as a Base64 data URL.

    Supported:

        1. Base64 data URL

        2. Raw Base64

        3. HTTP/HTTPS image URL

        4. Local image path

        5. bytes

    """

    output_dir = (
        Path(output_root)
        if output_root is not None
        else SCENE_IMAGE_ROOT
    )

    output_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    value = _normalize_scene_image_reference(
        scene_image
    )

    # ========================================================
    # EMPTY
    # ========================================================

    if value is None or value == "":

        raise ValueError(
            "scene_image is required.\n"
            "Send the actual bathroom reference image "
            "as Base64/data URL or an accessible image URL."
        )

    # ========================================================
    # BYTES
    # ========================================================

    if isinstance(
        value,
        (bytes, bytearray),
    ):

        image_bytes = bytes(value)

        identifier = hashlib.sha256(
            image_bytes
        ).hexdigest()[:24]

        return _save_scene_bytes(
            image_bytes=image_bytes,
            output_dir=output_dir,
            identifier=identifier,
        )

    # ========================================================
    # DATA URL
    # ========================================================

    if isinstance(value, str):

        if _is_data_url(value):

            return _save_data_url(
                data_url=value,
                output_dir=output_dir,
            )

    # ========================================================
    # RAW BASE64
    # ========================================================

    if isinstance(value, str):

        if _looks_like_base64(value):

            return _save_base64_image(
                encoded=value,
                output_dir=output_dir,
            )

    # ========================================================
    # REMOTE URL
    # ========================================================

    if isinstance(value, str):

        if _is_remote_scene_image(value):

            return _download_remote_scene_image(
                source=value,
                output_dir=output_dir,
            )

    # ========================================================
    # LOCAL FILE
    # ========================================================

    if isinstance(value, str):

        return _resolve_local_scene_path(
            value
        )

    # ========================================================
    # INVALID
    # ========================================================

    raise TypeError(
        "Unsupported scene_image type: "
        f"{type(value).__name__}"
    )