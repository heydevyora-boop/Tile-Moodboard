"""
visualization_api.py

Production-facing application service for the complete tile
visualization workflow.

This module is the single entry point that a future frontend,
FastAPI route, Flask route, or other backend adapter can call.

Input:
    - spreadsheet_id
    - bathroom/scene image
    - product_id
    - surface
    - optional scene_id
    - optional moodboard/final_design

Output:
    - applied visualization
    - registry information
    - Drive information
    - MASTER persistence result
    - optional moodboard/final-design result

This module does not create a web server by itself. Keeping the
business API independent from HTTP makes it easy to attach
FastAPI/Flask later without duplicating business logic.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional

import hashlib
import re
import base64
import urllib.parse
import os
import uuid
import importlib
import inspect
import asyncio

from app.visualization_orchestrator import (
    generate_and_persist_visualization,
    validate_orchestration_input,
)
# ============================================================
# RANDOM BATHROOM SCENE GENERATION
# ============================================================

def _is_placeholder_scene_reference(value: str) -> bool:
    """Return True for metadata IDs that are not image locations."""
    text = str(value or "").strip()

    if not text:
        return True

    if re.search(r"\.(png|jpe?g|webp|bmp)$", text, re.IGNORECASE):
        return False

    if re.match(
        r"^(SEED_|feminine_|bathroom-|scene-|AI_RANDOM_BATHROOM)",
        text,
        re.IGNORECASE,
    ):
        return True

    if (
        "://" not in text
        and "/" not in text
        and "\\" not in text
    ):
        return True

    return False


def _call_existing_scene_generator(
    output_path: Path,
    requirements: Optional[Dict[str, Any]] = None,
    scene_id: Optional[str] = None,
) -> Optional[Path]:
    """
    Use the project's existing scene_image_generator when present.
    Several historical function names are supported.
    """
    try:
        module = importlib.import_module("app.scene_image_generator")
    except Exception:
        return None

    candidates = (
        "generate_bathroom_scene",
        "generate_random_bathroom_scene",
        "generate_scene_image",
        "create_bathroom_scene",
        "create_scene_image",
        "generate_scene",
    )

    requirements = (
        requirements if isinstance(requirements, dict) else {}
    )

    prompt = (
        "Create a photorealistic luxury bathroom interior "
        "for a tile visualization. Show clear wall and floor "
        "surfaces, realistic lighting, vanity, mirror, sanitaryware, "
        "and enough visible tile area for a tile application model."
    )

    for name in candidates:
        function = getattr(module, name, None)
        if not callable(function):
            continue

        try:
            signature = inspect.signature(function)
        except Exception:
            signature = None

        kwargs = {
            "output_path": str(output_path),
            "path": str(output_path),
            "save_path": str(output_path),
            "filename": str(output_path),
            "output_file": str(output_path),
            "prompt": prompt,
            "room": "BATHROOM",
            "room_type": "BATHROOM",
            "style": requirements.get("style", "LUXURY"),
            "theme": requirements.get(
                "combination_name",
                "Warm Luxury Sanctuary",
            ),
            "scene_id": scene_id,
            "requirements": requirements,
        }

        if signature is not None:
            accepts_kwargs = any(
                parameter.kind == inspect.Parameter.VAR_KEYWORD
                for parameter in signature.parameters.values()
            )
            if not accepts_kwargs:
                allowed = set(signature.parameters)
                kwargs = {
                    key: value
                    for key, value in kwargs.items()
                    if key in allowed
                }

        try:
            result = function(**kwargs)

            if inspect.isawaitable(result):
                try:
                    result = asyncio.run(result)
                except RuntimeError:
                    loop = asyncio.new_event_loop()
                    try:
                        result = loop.run_until_complete(result)
                    finally:
                        loop.close()

            if isinstance(result, Path):
                candidate = result
            elif isinstance(result, str):
                candidate = Path(result)
            elif isinstance(result, dict):
                candidate = Path(
                    str(
                        result.get("image_path")
                        or result.get("path")
                        or result.get("file_path")
                        or result.get("output_path")
                        or ""
                    )
                )
            else:
                candidate = output_path

            if (
                candidate
                and candidate.exists()
                and candidate.is_file()
                and candidate.stat().st_size > 0
            ):
                return candidate.resolve()

        except Exception:
            continue

    return None


def _create_local_bathroom_fallback(output_path: Path) -> Path:
    """
    Last-resort local bathroom scene. The AI scene generator is tried
    first; this fallback only guarantees that a fake Drive ID can never
    crash the visualization pipeline.
    """
    try:
        from PIL import Image, ImageDraw
    except Exception as error:
        raise RuntimeError(
            "No bathroom scene generator is available and Pillow is "
            "not installed. Install Pillow or restore "
            "app.scene_image_generator.py."
        ) from error

    width, height = 1400, 1000
    image = Image.new("RGB", (width, height), "#e8e0d2")
    draw = ImageDraw.Draw(image)

    draw.rectangle([0, 0, width, 690], fill="#e9e2d5")
    draw.rectangle([0, 690, width, height], fill="#b9ae9d")

    draw.rectangle(
        [480, 105, 920, 430],
        fill="#cbd0cc",
        outline="#5b5146",
        width=12,
    )

    draw.rectangle([360, 430, 1040, 650], fill="#8f7962")
    draw.rectangle([330, 410, 1070, 450], fill="#ded4c1")

    draw.ellipse(
        [610, 430, 790, 515],
        fill="#f4f1e9",
        outline="#847866",
        width=5,
    )

    draw.rounded_rectangle(
        [80, 480, 350, 770],
        radius=35,
        fill="#f2eee6",
        outline="#71685c",
        width=8,
    )

    draw.rectangle(
        [1080, 120, 1310, 680],
        fill="#d4dedb",
        outline="#6f756f",
        width=8,
    )

    draw.rectangle([120, 340, 190, 470], fill="#8c6a48")
    draw.ellipse([80, 260, 230, 410], fill="#78856c")

    for x in range(0, width + 1, 140):
        draw.line(
            [x, 690, width // 2 + (x - width // 2) // 3, height],
            fill="#9b907e",
            width=2,
        )

    for y in range(760, height, 80):
        draw.line([0, y, width, y], fill="#9b907e", width=2)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path, format="PNG")
    return output_path.resolve()


def _generate_random_bathroom_scene(
    output_root: Optional[Path] = None,
    requirements: Optional[Dict[str, Any]] = None,
    scene_id: Optional[str] = None,
) -> Path:
    """Generate a new bathroom scene without Google Drive."""
    root = (
        Path(output_root)
        if output_root is not None
        else Path(__file__).resolve().parent.parent / "output"
    )

    scene_dir = root / "scene_images"
    scene_dir.mkdir(parents=True, exist_ok=True)

    output_path = (
        scene_dir
        / f"generated_bathroom_{uuid.uuid4().hex}.png"
    )

    generated = _call_existing_scene_generator(
        output_path=output_path,
        requirements=requirements,
        scene_id=scene_id,
    )

    if generated:
        return generated

    return _create_local_bathroom_fallback(output_path)


# ============================================================
# SCENE IMAGE RESOLUTION
# ============================================================

def _normalize_scene_image_reference(value: Any) -> str:
    """Normalize local paths and common malformed HTTP/Drive references."""
    if value is None:
        return ""

    text = str(value).strip().strip('"').strip("'")

    # Common frontend escaping problem:
    # https:\drive.google.com\... -> https://drive.google.com/...
    if text.lower().startswith(("http:\\", "https:\\")):
        text = text.replace("\\", "/")
        if text.startswith("http:/") and not text.startswith("http://"):
            text = text.replace("http:/", "http://", 1)
        elif text.startswith("https:/") and not text.startswith("https://"):
            text = text.replace("https:/", "https://", 1)

    return text


def _is_remote_scene_image(value: str) -> bool:
    return value.lower().startswith(("http://", "https://"))


def _extract_google_drive_file_id(value: str) -> Optional[str]:
    """Extract a Drive file ID from common Google Drive URL formats."""
    try:
        parsed = urllib.parse.urlparse(value)
        host = parsed.netloc.lower()
        path = parsed.path

        if "drive.google.com" not in host:
            return None

        query_id = urllib.parse.parse_qs(parsed.query).get("id")
        if query_id and query_id[0]:
            return query_id[0]

        match = re.search(r"/file/d/([^/]+)", path)
        if match:
            return match.group(1)

        match = re.search(r"/uc/([^/]+)", path)
        if match:
            return match.group(1)

    except Exception:
        return None

    return None


def _download_scene_image(
    source: str,
    output_dir: Path,
) -> Path:
    """
    Download a remote scene image into a local file.

    Supports normal HTTP(S) URLs and Google Drive file URLs.
    """
    import requests

    output_dir.mkdir(parents=True, exist_ok=True)

    drive_file_id = _extract_google_drive_file_id(source)

    if drive_file_id:
        url = "https://drive.google.com/uc"
        response = requests.get(
            url,
            params={
                "export": "download",
                "id": drive_file_id,
            },
            timeout=60,
        )
    else:
        response = requests.get(
            source,
            timeout=60,
            allow_redirects=True,
        )

    response.raise_for_status()

    content_type = (
        response.headers.get("content-type", "").lower()
    )

    extension = ".jpg"

    if "png" in content_type:
        extension = ".png"
    elif "webp" in content_type:
        extension = ".webp"
    elif "jpeg" in content_type or "jpg" in content_type:
        extension = ".jpg"

    identifier = (
        drive_file_id
        or hashlib.sha256(source.encode("utf-8")).hexdigest()[:20]
    )

    output_path = output_dir / f"scene_{identifier}{extension}"

    output_path.write_bytes(response.content)

    if not output_path.exists() or output_path.stat().st_size == 0:
        raise RuntimeError(
            f"Downloaded scene image is empty: {output_path}"
        )

    return output_path.resolve()


def resolve_scene_image(
    scene_image: Any,
    output_root: Optional[Path] = None,
    *,
    requirements: Optional[Dict[str, Any]] = None,
    scene_id: Optional[str] = None,
    scene_image_mode: Optional[str] = None,
) -> Path:
    """
    Resolve a scene image.

    Empty values and metadata-only seeds such as SEED_feminine_01
    trigger a new local bathroom scene. They are never sent to Drive.
    """
    value = _normalize_scene_image_reference(scene_image)

    root = (
        Path(output_root)
        if output_root is not None
        else Path(__file__).resolve().parent.parent / "output"
    )

    should_generate = (
        not value
        or scene_image_mode == "random"
        or _is_placeholder_scene_reference(value)
    )

    if should_generate:
        return _generate_random_bathroom_scene(
            output_root=root,
            requirements=requirements,
            scene_id=scene_id,
        )

    if _is_remote_scene_image(value):
        return _download_scene_image(
            value,
            root / "scene_images",
        )

    path = Path(value)

    if not path.is_absolute():
        path = Path(__file__).resolve().parent.parent / path

    path = path.resolve()

    if not path.exists():
        raise FileNotFoundError(f"Scene image not found: {path}")

    if not path.is_file():
        raise ValueError(f"Scene image is not a file: {path}")

    return path



# ============================================================
# REQUEST VALIDATION
# ============================================================

def validate_visualization_request(
    request: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Validate and normalize an HTTP visualization request.

    product_id and surface are required.
    spreadsheet_id is optional at this boundary.
    scene_image is optional because Python can generate a random room.
    """
    if not isinstance(request, dict):
        raise TypeError("request must be a dictionary.")

    spreadsheet_id = str(
        request.get("spreadsheet_id", "")
        or os.getenv("GOOGLE_SPREADSHEET_ID", "")
        or os.getenv("SPREADSHEET_ID", "")
    ).strip()

    product_id = str(
        request.get("product_id", "")
    ).strip()

    scene_image = (
        request.get("scene_image")
        or request.get("scene_image_path")
        or request.get("scene_image_url")
        or ""
    )

    surface = str(
        request.get("surface", "")
    ).strip().upper()

    scene_id = str(
        request.get("scene_id", "") or ""
    ).strip()

    scene_image_mode = str(
        request.get("scene_image_mode", "") or ""
    ).strip().lower()

    generate_random_scene = (
        request.get("generate_random_scene") is True
        or scene_image_mode == "random"
        or not str(scene_image or "").strip()
        or _is_placeholder_scene_reference(
            str(scene_image or "")
        )
    )

    sheet_name = str(
        request.get("sheet_name", "MASTER")
    ).strip() or "MASTER"

    moodboard = request.get("moodboard")
    final_design = request.get("final_design")

    requirements = (
        request.get("requirements")
        if isinstance(request.get("requirements"), dict)
        else {}
    )

    if not product_id:
        raise ValueError("product_id is required.")

    if not surface:
        raise ValueError("surface is required.")

    scene_image = resolve_scene_image(
        "" if generate_random_scene else scene_image,
        requirements=requirements,
        scene_id=scene_id or None,
        scene_image_mode=(
            "random" if generate_random_scene else "reference"
        ),
    )

    if spreadsheet_id:
        normalized = validate_orchestration_input(
            spreadsheet_id=spreadsheet_id,
            product_id=product_id,
            scene_image=scene_image,
            surface=surface,
        )

        normalized_spreadsheet_id = normalized["spreadsheet_id"]
        normalized_product_id = normalized["product_id"]
        normalized_scene_image = Path(normalized["scene_image"])
        normalized_surface = normalized["surface"]
    else:
        normalized_spreadsheet_id = ""
        normalized_product_id = product_id
        normalized_scene_image = Path(scene_image)
        normalized_surface = surface

    return {
        "spreadsheet_id": normalized_spreadsheet_id,
        "product_id": normalized_product_id,
        "scene_image": normalized_scene_image,
        "surface": normalized_surface,
        "scene_id": scene_id or None,
        "sheet_name": sheet_name,
        "moodboard": moodboard,
        "final_design": final_design,
        "scene_generated": generate_random_scene,
        "scene_image_mode": (
            "random" if generate_random_scene else "reference"
        ),
    }



# ============================================================
# SUCCESS RESPONSE
# ============================================================

def _build_success_response(
    result: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Return a stable API response shape.
    """

    image_path = str(
        result.get("image_path", "") or ""
    ).strip()

    image_data_url = ""

    if image_path:
        try:
            image_file = Path(image_path)
            if (
                image_file.exists()
                and image_file.is_file()
                and image_file.stat().st_size > 0
            ):
                mime = {
                    ".png": "image/png",
                    ".jpg": "image/jpeg",
                    ".jpeg": "image/jpeg",
                    ".webp": "image/webp",
                }.get(
                    image_file.suffix.lower(),
                    "application/octet-stream",
                )

                encoded = base64.b64encode(
                    image_file.read_bytes()
                ).decode("ascii")

                image_data_url = (
                    f"data:{mime};base64,{encoded}"
                )
        except Exception:
            image_data_url = ""

    return {
        "success": True,
        "status": result.get(
            "status",
            "COMPLETED",
        ),
        "pipeline": result.get(
            "pipeline",
            "",
        ),
        "image": {
            "url": image_data_url or None,
            "data_url": image_data_url or None,
        },
        "visualization": {
            "visualization_id": result.get(
                "visualization_id",
                "",
            ),
            "product_id": result.get(
                "product_id",
                "",
            ),
            "product_name": result.get(
                "product_name",
                "",
            ),
            "surface": result.get(
                "surface",
                "",
            ),
            "image_path": result.get(
                "image_path",
                "",
            ),
        },
        "drive": result.get(
            "drive_result"
        ),
        "master": result.get(
            "master_result"
        ),
        "moodboard": result.get(
            "moodboard_result"
        ),
        "final_design": result.get(
            "final_design_result"
        ),
        "raw_result": result,
    }


# ============================================================
# ERROR RESPONSE
# ============================================================

def _build_error_response(
    error: Exception,
) -> Dict[str, Any]:
    """
    Return a stable error response without exposing secrets.
    """

    return {
        "success": False,
        "status": "FAILED",
        "error": {
            "type": type(
                error
            ).__name__,
            "message": str(
                error
            ),
        },
    }


# ============================================================
# BUSINESS API
# ============================================================

def create_visualization(
    request: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Main production business API.

    This is the function the frontend/HTTP adapter should call.
    """

    try:

        normalized = (
            validate_visualization_request(
                request
            )
        )

        result = (
            generate_and_persist_visualization(
                spreadsheet_id=(
                    normalized[
                        "spreadsheet_id"
                    ]
                ),
                product_id=(
                    normalized[
                        "product_id"
                    ]
                ),
                scene_image=(
                    normalized[
                        "scene_image"
                    ]
                ),
                surface=(
                    normalized[
                        "surface"
                    ]
                ),
                scene_id=(
                    normalized[
                        "scene_id"
                    ]
                ),
                sheet_name=(
                    normalized[
                        "sheet_name"
                    ]
                ),
                moodboard=(
                    normalized[
                        "moodboard"
                    ]
                ),
                final_design=(
                    normalized[
                        "final_design"
                    ]
                ),
            )
        )

        return _build_success_response(
            result
        )

    except Exception as error:

        return _build_error_response(
            error
        )


# ============================================================
# STRICT API
# ============================================================

def create_visualization_strict(
    request: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Same as create_visualization(), but raises the original
    exception instead of converting it to an error response.

    Useful during development and automated testing.
    """

    normalized = (
        validate_visualization_request(
            request
        )
    )

    result = (
        generate_and_persist_visualization(
            spreadsheet_id=(
                normalized[
                    "spreadsheet_id"
                ]
            ),
            product_id=(
                normalized[
                    "product_id"
                ]
            ),
            scene_image=(
                normalized[
                    "scene_image"
                ]
            ),
            surface=(
                normalized[
                    "surface"
                ]
            ),
            scene_id=(
                normalized[
                    "scene_id"
                ]
            ),
            sheet_name=(
                normalized[
                    "sheet_name"
                ]
            ),
            moodboard=(
                normalized[
                    "moodboard"
                ]
            ),
            final_design=(
                normalized[
                    "final_design"
                ]
            ),
        )
    )

    return _build_success_response(
        result
    )


# ============================================================
# FILE-BASED CONVENIENCE API
# ============================================================

def create_visualization_from_file(
    *,
    spreadsheet_id: str,
    product_id: str,
    scene_image: str | Path,
    surface: str,
    scene_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Convenience wrapper for a frontend/backend file path.
    """

    return create_visualization(
        {
            "spreadsheet_id": spreadsheet_id,
            "product_id": product_id,
            "scene_image": str(
                scene_image
            ),
            "surface": surface,
            "scene_id": scene_id,
        }
    )


# ============================================================
# END
# ===============================