"""
tile_application_engine.py

Tile application / material visualization engine.

Pipeline:

Bathroom Image
        +
Selected Tile Image
        +
Surface
        ↓
Gemini Image Generation
        ↓
Applied Tile Bathroom Image
"""

from pathlib import Path
from typing import Any, Dict, Optional
import mimetypes
import os

from dotenv import load_dotenv
from PIL import Image

from google import genai
from google.genai import types
from tenacity import (
    retry,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)

from app.scene_image_resolver import resolve_scene_image


# ============================================================
# RETRY -- TRANSIENT GEMINI API ERRORS
# ============================================================
# Gemini's image model occasionally responds 503 "currently
# experiencing high demand" or 429 rate-limited -- both clear up on
# their own within seconds. Retrying those automatically avoids
# surfacing a failure to the user for what's really a momentary dip
# in Google's own capacity. Auth/validation errors (4xx other than
# 429) are not retried, since retrying won't fix them.

RETRYABLE_GEMINI_STATUS_CODES = {429, 500, 502, 503, 504}


def _is_retryable_gemini_error(error: BaseException) -> bool:
    code = getattr(error, "code", None)
    return code in RETRYABLE_GEMINI_STATUS_CODES


@retry(
    retry=retry_if_exception(_is_retryable_gemini_error),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=2, min=2, max=15),
    reraise=True,
)
def _generate_content_with_retry(client, model, contents, config):
    return client.models.generate_content(
        model=model,
        contents=contents,
        config=config,
    )


# ============================================================
# PROJECT ROOT
# ============================================================

PROJECT_ROOT = (
    Path(__file__)
    .resolve()
    .parent
    .parent
)


# ============================================================
# ENVIRONMENT
# ============================================================

PROJECT_ENV = PROJECT_ROOT / ".env"

if PROJECT_ENV.exists():
    load_dotenv(
        dotenv_path=PROJECT_ENV,
        override=False,
    )
else:
    load_dotenv()


# ============================================================
# CONFIGURATION
# ============================================================

IMAGE_MODEL = (
    os.getenv("GEMINI_IMAGE_MODEL")
    or "gemini-3.1-flash-image"
)

OUTPUT_ROOT = Path(
    os.getenv(
        "OUTPUT_ROOT",
        str(PROJECT_ROOT / "output"),
    )
)

ALLOWED_SURFACES = {
    "FLOOR",
    "WALL",
    "BACK_WALL",
    "SHOWER_WALL",
}


# ============================================================
# GEMINI CLIENT
# ============================================================

def _get_gemini_client():
    """
    Reuse the project's existing Gemini client whenever possible.

    This is important because app.gemini_service already handles
    loading the project's Gemini credentials.
    """

    # --------------------------------------------------------
    # FIRST: reuse existing project Gemini service
    # --------------------------------------------------------

    try:

        from app import gemini_service

        existing_client = getattr(
            gemini_service,
            "client",
            None,
        )

        if existing_client is not None:

            return existing_client

    except Exception:
        pass

    # --------------------------------------------------------
    # SECOND: create client directly from environment
    # --------------------------------------------------------

    api_key = (
        os.getenv("GEMINI_API_KEY")
        or os.getenv("GOOGLE_API_KEY")
    )

    if not api_key and PROJECT_ENV.exists():

        load_dotenv(
            dotenv_path=PROJECT_ENV,
            override=False,
        )

        api_key = (
            os.getenv("GEMINI_API_KEY")
            or os.getenv("GOOGLE_API_KEY")
        )

    if not api_key:

        raise RuntimeError(
            "Gemini client is unavailable.\n"
            "The existing app.gemini_service client could "
            "not be loaded and GEMINI_API_KEY was not found."
        )

    return genai.Client(
        api_key=api_key
    )


# ============================================================
# IMAGE VALIDATION
# ============================================================

def validate_image(
    image_path: Path,
    label: str,
) -> Path:

    image_path = Path(
        image_path
    )

    if not image_path.exists():

        raise FileNotFoundError(
            f"{label} not found: "
            f"{image_path}"
        )

    if not image_path.is_file():

        raise ValueError(
            f"{label} is not a file: "
            f"{image_path}"
        )

    try:

        with Image.open(
            image_path
        ) as image:

            image.verify()

    except Exception as error:

        raise ValueError(
            f"{label} is not a valid image: "
            f"{image_path}"
        ) from error

    return image_path


# ============================================================
# SURFACE VALIDATION
# ============================================================

def validate_surface(
    surface: str,
) -> str:

    if not isinstance(
        surface,
        str,
    ):

        raise TypeError(
            "surface must be a string."
        )

    normalized = surface.strip().upper()

    if normalized not in ALLOWED_SURFACES:

        raise ValueError(
            f"Unsupported surface: {surface}. "
            f"Allowed: {sorted(ALLOWED_SURFACES)}"
        )

    return normalized


# ============================================================
# MIME TYPE
# ============================================================

def _get_mime_type(
    image_path: Path,
) -> str:

    mime_type, _ = mimetypes.guess_type(
        str(image_path)
    )

    if (
        mime_type
        and mime_type.startswith(
            "image/"
        )
    ):

        return mime_type

    return "image/png"


# ============================================================
# PROMPT
# ============================================================

def build_tile_application_prompt(
    surface: str,
    tile_product_id: Optional[str] = None,
    tile_name: Optional[str] = None,
) -> str:

    surface = validate_surface(
        surface
    )

    identity = ""

    if tile_product_id:

        identity += (
            f"Tile Product ID: "
            f"{tile_product_id}\n"
        )

    if tile_name:

        identity += (
            f"Tile Name: "
            f"{tile_name}\n"
        )

    return f"""
You are a professional architectural visualization engine.

TASK:
Apply the EXACT tile shown in the supplied tile reference image
to the {surface} of the supplied bathroom/interior image.

{identity}

REFERENCE PRIORITY:

1. The bathroom image is the source of truth for:
   - architecture
   - camera position
   - room dimensions
   - doors
   - windows
   - sanitary fixtures
   - vanity
   - mirrors
   - lighting
   - existing objects

2. The tile image is the source of truth for:
   - tile color
   - texture
   - pattern
   - finish
   - visual character

DO NOT redesign the room.

DO NOT:
- move doors
- move windows
- move fixtures
- move vanity
- change WC
- change basin
- change faucets
- change shower
- change mirrors
- change lighting
- change camera
- change room proportions
- add furniture
- add decoration
- remove objects

TILE APPLICATION RULES:

1. Use the exact supplied tile.
2. Preserve its original appearance.
3. Preserve realistic tile scale.
4. Preserve perspective.
5. Follow the existing surface geometry.
6. Follow vanishing points.
7. Match lighting.
8. Match shadows.
9. Match reflections.
10. Generate realistic grout where appropriate.
11. Apply the material ONLY to the requested {surface}.
12. Do not apply it to unrelated surfaces.

OUTPUT:

Produce one photorealistic finished bathroom visualization.

The result must look like a professionally photographed
bathroom with the selected tile physically installed,
not like a pasted image or flat texture.

It must read as an actual photograph of a real, physically
built room — not an illustration, rendering, drawing, diagram,
or CGI-looking image.
"""


# ============================================================
# EXTRACT GENERATED IMAGE
# ============================================================

def extract_generated_image(
    response: Any,
) -> Any:

    candidates = getattr(
        response,
        "candidates",
        None,
    )

    if not candidates:

        raise RuntimeError(
            "Gemini returned no candidates."
        )

    for candidate in candidates:

        content = getattr(
            candidate,
            "content",
            None,
        )

        if content is None:
            continue

        parts = getattr(
            content,
            "parts",
            [],
        )

        for part in parts:

            # ----------------------------------------------
            # SDK image object
            # ----------------------------------------------

            if hasattr(
                part,
                "as_image",
            ):

                image = part.as_image()

                if image is not None:

                    return image

            # ----------------------------------------------
            # Inline image data
            # ----------------------------------------------

            inline_data = getattr(
                part,
                "inline_data",
                None,
            )

            if inline_data is None:

                inline_data = getattr(
                    part,
                    "inlineData",
                    None,
                )

            if inline_data is not None:

                data = getattr(
                    inline_data,
                    "data",
                    None,
                )

                if data:

                    return data

    raise RuntimeError(
        "Gemini response did not contain "
        "a generated image."
    )


# ============================================================
# SAVE GENERATED IMAGE
# ============================================================

def save_generated_image(
    generated_image: Any,
    output_path: Path,
) -> Path:

    output_path = Path(
        output_path
    )

    output_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    if hasattr(
        generated_image,
        "save",
    ):

        generated_image.save(
            str(output_path)
        )

        return output_path

    if isinstance(
        generated_image,
        bytes,
    ):

        output_path.write_bytes(
            generated_image
        )

        return output_path

    raise TypeError(
        "Unsupported generated image type: "
        f"{type(generated_image).__name__}"
    )


# ============================================================
# APPLY TILE
# ============================================================

def apply_tile_to_scene(
    scene_image: Path,
    tile_image: Path,
    surface: str = "FLOOR",
    output_path: Optional[Path] = None,
    tile_product_id: Optional[str] = None,
    tile_name: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Apply selected tile to bathroom/interior image using Gemini.
    """

    # --------------------------------------------------------
    # VALIDATE INPUTS
    # --------------------------------------------------------

    scene_image = resolve_scene_image(
        scene_image,
        output_root=OUTPUT_ROOT,
    )

    scene_image = validate_image(
        scene_image,
        "Scene image",
    )

    tile_image = validate_image(
        tile_image,
        "Tile image",
    )

    surface = validate_surface(
        surface
    )

    # --------------------------------------------------------
    # OUTPUT
    # --------------------------------------------------------

    if output_path is None:

        output_path = (
            OUTPUT_ROOT
            / "tile_applications"
            / (
                "applied_tile_"
                f"{surface.lower()}.png"
            )
        )

    output_path = Path(
        output_path
    )

    # --------------------------------------------------------
    # PROMPT
    # --------------------------------------------------------

    prompt = build_tile_application_prompt(
        surface=surface,
        tile_product_id=tile_product_id,
        tile_name=tile_name,
    )

    # --------------------------------------------------------
    # READ IMAGES
    # --------------------------------------------------------

    scene_bytes = (
        scene_image.read_bytes()
    )

    tile_bytes = (
        tile_image.read_bytes()
    )

    scene_mime_type = (
        _get_mime_type(
            scene_image
        )
    )

    tile_mime_type = (
        _get_mime_type(
            tile_image
        )
    )

    # --------------------------------------------------------
    # GEMINI INPUT
    # --------------------------------------------------------

    contents = [

        types.Part.from_text(
            text=prompt
        ),

        types.Part.from_bytes(
            data=scene_bytes,
            mime_type=scene_mime_type,
        ),

        types.Part.from_bytes(
            data=tile_bytes,
            mime_type=tile_mime_type,
        ),
    ]

    # --------------------------------------------------------
    # GET CLIENT
    # --------------------------------------------------------

    client = _get_gemini_client()

    # --------------------------------------------------------
    # GENERATE
    # --------------------------------------------------------

    try:

        response = (
            _generate_content_with_retry(
                client,
                IMAGE_MODEL,
                contents,
                types.GenerateContentConfig(
                    response_modalities=[
                        "IMAGE"
                    ],
                ),
            )
        )

    except Exception as error:

        raise RuntimeError(
            "Gemini tile application failed: "
            f"{error}"
        ) from error

    # --------------------------------------------------------
    # EXTRACT
    # --------------------------------------------------------

    generated_image = (
        extract_generated_image(
            response
        )
    )

    # --------------------------------------------------------
    # SAVE
    # --------------------------------------------------------

    saved_path = (
        save_generated_image(
            generated_image,
            output_path,
        )
    )

    # --------------------------------------------------------
    # RESULT
    # --------------------------------------------------------

    return {

        "status": "GENERATED",

        "surface": surface,

        "tile_product_id": (
            tile_product_id
        ),

        "tile_name": (
            tile_name
        ),

        "source_scene": str(
            scene_image
        ),

        "tile_reference": str(
            tile_image
        ),

        "image_path": str(
            saved_path
        ),

        "model": IMAGE_MODEL,
    }