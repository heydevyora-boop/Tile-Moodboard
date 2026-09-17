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
from app.output_paths import writable_output_root
from typing import Any, Dict, List, Optional
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

OUTPUT_ROOT = writable_output_root(
    Path(
        os.getenv(
            "OUTPUT_ROOT",
            str(PROJECT_ROOT / "output"),
        )
    )
)

ALLOWED_SURFACES = {
    "FLOOR",
    "WALL",
    "BACK_WALL",
    "SHOWER_WALL",
    # The Scene & Angles frontend's Surface dropdown has always offered
    # "Wall + Floor" (sent as surface="BOTH"), but this set never
    # actually included it -- every "Wall + Floor" request 400'd with
    # "Unsupported surface: BOTH" before it ever reached Gemini.
    "BOTH",
}

# Human-readable description of each surface, used in the prompt text
# below instead of the raw enum value -- "Apply the material ONLY to
# the requested BOTH." doesn't parse as a coherent instruction, so BOTH
# specifically needs its own wording naming both real surfaces.
SURFACE_DESCRIPTIONS = {
    "WALL": "wall",
    "FLOOR": "floor",
    "BACK_WALL": "back wall",
    "SHOWER_WALL": "shower wall",
    "BOTH": "wall AND floor surfaces (apply the same tile to both)",
}


def describe_surface(surface: str) -> str:
    return SURFACE_DESCRIPTIONS.get(surface, surface.lower())


# ============================================================
# MATERIAL ROLES
#
# A mood board is a COMBINATION -- a base tile plus the highlight and
# accent chosen to sit with it -- and the whole point of visualizing it
# is seeing those materials together in one room. Only the base was ever
# reaching the generator, so every board rendered as a single-material
# bathroom and the other two selections had no visible effect.
#
# Each role gets the surfaces a tile showroom would actually put it on.
# This is deliberately description, not geometry: the model is choosing
# where a highlight band or an accent frame belongs in THIS room, which
# is exactly the judgement it is good at and which no fixed rectangle
# could get right across different bathrooms.
# ============================================================

MATERIAL_ROLE_SURFACES = {
    "base": (
        "the PRIMARY surfaces -- the main field of the {surface_description}. "
        "This is the dominant material and must cover most of the tiled area."
    ),
    "highlight": (
        "the HIGHLIGHT surfaces -- one feature area within the "
        "{surface_description}, such as a single feature wall, the wall "
        "behind the vanity or inside the shower niche. Secondary to the "
        "base, clearly visible, but covering much less area than it."
    ),
    "accent": (
        "the ACCENT surfaces -- decorative detail within the "
        "{surface_description}, such as a border course, a framed panel, "
        "a strip between fields, or a niche/inset surround. The smallest "
        "area of the three, used as trim rather than as a field."
    ),
    "border": (
        "the BORDER surfaces -- a trim course or framing band within the "
        "{surface_description}, running between or around the other "
        "materials rather than filling an area."
    ),
}

# Roles named in a combination that this file has no wording for still
# have to appear in the room; they are described generically rather than
# dropped, because dropping a selected material is the bug being fixed.
MATERIAL_ROLE_FALLBACK = (
    "a distinct secondary area of the {surface_description}, "
    "clearly visible and clearly separate from the other materials."
)


def describe_material_role(role: str, surface_description: str) -> str:
    """Says where one role's material belongs, in this room."""
    template = MATERIAL_ROLE_SURFACES.get(
        str(role or "").strip().lower(),
        MATERIAL_ROLE_FALLBACK,
    )
    return template.format(surface_description=surface_description)


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

# Camera-angle instructions for Scene & Angles. Keyed by the exact angle
# labels the frontend sends (frontend/scene-angles.html's ANGLES list),
# lowercased. This is what actually differentiates "Front" from "Left"
# from "Shower close-up" -- without it, every angle produced an identical
# prompt (and therefore effectively the same image) even after angle
# started reaching this far, because nothing here described what a
# different camera position should look like.
ANGLE_CAMERA_INSTRUCTIONS = {
    "front": (
        "Frame the room in a straight-on establishing shot facing into "
        "the room, as if standing at the entrance/doorway looking "
        "forward -- the default reference view."
    ),
    "left": (
        "Rotate the camera to look toward the LEFT side of the room "
        "from roughly the same standing position as the front view, "
        "revealing whatever is on that side (e.g. the left wall, the "
        "vanity end, adjacent fixtures)."
    ),
    "right": (
        "Rotate the camera to look toward the RIGHT side of the room "
        "from roughly the same standing position as the front view, "
        "revealing whatever is on that side."
    ),
    "wide": (
        "Pull back to a wider-angle establishing shot with a larger "
        "field of view, showing more of the room at once than a "
        "standard front view."
    ),
    "shower close-up": (
        "Move the camera close to the shower enclosure for a tight, "
        "detail-focused shot of the shower area, its fixtures, and the "
        "surrounding surface."
    ),
    "basin close-up": (
        "Move the camera close to the basin/vanity area for a tight, "
        "detail-focused shot of the basin, countertop, and the "
        "surrounding surface."
    ),
    "wc area": (
        "Move and reframe the camera so the WC/toilet area of the room "
        "is clearly and directly in frame."
    ),
}


def build_tile_application_prompt(
    surface: str,
    tile_product_id: Optional[str] = None,
    tile_name: Optional[str] = None,
    angle: Optional[str] = None,
    materials: Optional[List[Dict[str, Any]]] = None,
) -> str:

    surface = validate_surface(
        surface
    )

    surface_description = describe_surface(
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

    # Angle handling is intentionally an either/or against the room's
    # camera: most callers (single-shot generation elsewhere in the app)
    # never pass an angle and get the original "camera stays exactly as
    # supplied" behavior. Scene & Angles passes one, and for that request
    # the camera is exactly what's SUPPOSED to move -- the DO NOT list
    # below normally forbids that, so it has to be lifted specifically
    # (and only) when an angle was actually requested, or this section and
    # that one would tell Gemini to do contradictory things.
    normalized_angle = str(angle or "").strip()

    if normalized_angle:

        angle_instruction = ANGLE_CAMERA_INSTRUCTIONS.get(
            normalized_angle.lower(),
            (
                f"Adjust the camera position/framing to match a "
                f"\"{normalized_angle}\" view of this room."
            ),
        )

        camera_section = f"""
CAMERA ANGLE FOR THIS REQUEST: "{normalized_angle}"

{angle_instruction}

This is the ONE thing about the room that should change from a
default/front view. Everything else about the room -- architecture,
room dimensions, doors, windows, sanitary fixtures, vanity, mirrors,
lighting, existing objects, and the tile/material itself -- MUST stay
exactly the same as it would for any other angle of this same room.
"""
        camera_do_not_line = ""

    else:

        camera_section = ""
        camera_do_not_line = "- change camera\n"

    # ONE MATERIAL OR SEVERAL.
    #
    # With no `materials` the wording is exactly what it always was, so
    # every existing caller (Scene & Angles, the tests, the single-tile
    # pipeline) is unaffected. With a combination, the task changes
    # shape: it is no longer "apply this tile" but "install these
    # materials, each in its own role", and the images have to be
    # enumerated because there are now more than two of them.
    if materials:
        lines = []
        for position, material in enumerate(materials, start=2):
            role = str(material.get("role") or "").strip().lower()
            label = role.upper() or f"MATERIAL {position - 1}"
            where = describe_material_role(role, surface_description)

            named = ""
            if material.get("name"):
                named += f" (\"{material['name']}\""
                if material.get("product_id"):
                    named += f", product {material['product_id']}"
                named += ")"
            elif material.get("product_id"):
                named += f" (product {material['product_id']})"

            lines.append(
                f"  IMAGE {position} = the EXACT {label} material"
                f"{named}.\n"
                f"      Install it on {where}"
            )

        material_block = "\n".join(lines)

        return f"""
You are a professional architectural visualization engine.

TASK:
{len(materials) + 1} images are supplied, in this order:
  IMAGE 1 = the bathroom/interior scene.
{material_block}

Install ALL {len(materials)} supplied materials into IMAGE 1 together, each
one on the surfaces described for its own role above. This is a single
coordinated tile scheme, exactly as a showroom would lay it up.

EVERY supplied material MUST be visibly present in the finished image.
Using only the first material, or blending them into one, is a FAILED
result. Each must read as its own distinct, identifiable product, taken
exactly from its own supplied photograph -- its pattern, colour,
texture, finish, geometry and markings -- and must NOT be invented,
substituted, or inferred from a product name, SKU or brand.

Where two materials meet, finish the junction the way real tiling does:
a clean cut, a trim piece or a grout line, never a blur or a fade.

{identity}
{camera_section}
REFERENCE PRIORITY:

1. IMAGE 1 (the bathroom) is the source of truth for: architecture,
   layout, fixtures, camera and lighting. Its EXISTING tiles are NOT
   any of the materials to use and must be replaced.

2. Each material image is the ONLY source of truth for that material.

DO NOT:
- change room
- change layout
- change fixtures
- change sanitaryware
- change vanity
- change faucets
- change shower
- change mirrors
- change lighting
{camera_do_not_line}- change room proportions
- add furniture
- add decoration
- remove objects
- omit any supplied material
- apply one material where another was specified

TILE APPLICATION RULES:

1. Use the exact supplied materials.
2. Preserve each one's original appearance.
3. Preserve realistic tile scale for each.
4. Preserve perspective.
5. Follow the existing surface geometry.
6. Follow vanishing points.
7. Match lighting.
8. Match shadows.
9. Match reflections.
10. Generate realistic grout where appropriate.
11. Keep every material within the {surface_description} and the role
    described for it.
12. Do not apply them to unrelated surfaces.

OUTPUT:

Produce one photorealistic finished bathroom visualization showing all
{len(materials)} materials installed together.

The result must look like a professionally photographed bathroom with
the selected tiles physically installed, not like a pasted image or
flat texture.

It must read as an actual photograph of a real, physically
built room — not an illustration, rendering, drawing, diagram,
or CGI-looking image.
"""

    return f"""
You are a professional architectural visualization engine.

TASK:
Two images are supplied, in this order:
  IMAGE 1 = the bathroom/interior scene.
  IMAGE 2 = the EXACT selected catalog tile.

Apply the EXACT tile shown in IMAGE 2 to the {surface_description}
of IMAGE 1.

{identity}
{camera_section}
REFERENCE PRIORITY:

1. IMAGE 1 (the bathroom) is the source of truth for:
   - architecture
   - room dimensions
   - doors
   - windows
   - sanitary fixtures
   - vanity
   - mirrors
   - lighting
   - existing objects

2. IMAGE 2 (the selected catalog tile) is the ONLY source of
   truth for the tile itself:
   - tile color
   - texture
   - pattern
   - finish
   - geometry/shape
   - distinctive markings and surface details
   - visual character

   Reproduce that exact tile. Do NOT invent a visually similar
   tile, and do NOT derive the tile from the product name, SKU or
   brand. Any tile already present in IMAGE 1 is part of the old
   room, never the tile to apply.

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
{camera_do_not_line}- change room proportions
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
11. Apply the material ONLY to the requested {surface_description}.
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
    angle: Optional[str] = None,
    materials: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """
    Apply selected tile(s) to a bathroom/interior image using Gemini.

    `materials` carries a whole mood-board combination -- a list of
    {role, image_path, product_id, name} -- and every entry is sent to
    the model as its own labelled image with its own role. Omitted, this
    behaves exactly as it always did: one tile, one surface. `tile_image`
    stays required either way and remains the base/primary material, so
    no existing caller changes and a combination whose extra images all
    fail to resolve still produces the single-tile result rather than
    failing outright.
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

    # Only materials whose image actually resolved can be described to
    # the model -- promising it an IMAGE 4 that is not in the request is
    # worse than not mentioning it, so the prompt is built from the same
    # list the parts are built from, below.
    resolved_materials = []

    # The base is the material `tile_image` already carries. A caller
    # that sends a combination without naming it still gets it, first, so
    # rebuilding the image tail below can never drop the one image the
    # single-tile path always sent.
    if materials and not any(
        str(m.get("role") or "").strip().lower() == "base" for m in materials
    ):
        materials = [{
            "role": "base",
            "image_path": tile_image,
            "product_id": tile_product_id,
            "name": tile_name,
        }] + list(materials)

    for material in (materials or []):
        raw_path = material.get("image_path")
        if not raw_path:
            continue
        try:
            path = validate_image(Path(raw_path), "Material image")
        except Exception as error:  # noqa: BLE001 -- one bad image, not a failed render
            print(
                f"  [visualization] material "
                f"{material.get('role') or '?'} image unusable "
                f"({raw_path}): {error}"
            )
            continue
        resolved_materials.append({**material, "image_path": path})

    prompt = build_tile_application_prompt(
        surface=surface,
        tile_product_id=tile_product_id,
        tile_name=tile_name,
        angle=angle,
        materials=resolved_materials or None,
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

    # Both images used to be passed as bare, adjacent, unlabelled byte
    # parts, so nothing in the request said which one was the room and
    # which one was the tile -- the model had to infer that from their
    # content alone, and could treat the scene as authoritative for
    # everything and invent a plausible-looking tile instead of
    # reproducing the supplied one. Naming each image immediately before
    # its own bytes binds the role to the part itself.
    contents = [

        types.Part.from_text(
            text=prompt
        ),

        types.Part.from_text(
            text=(
                "IMAGE 1 = BATHROOM SCENE REFERENCE. "
                "The room in the next image is the source of truth for "
                "architecture, layout, fixtures, camera and lighting "
                "ONLY. Its existing tiles/materials are NOT the tile to "
                "use and must be replaced on the requested surface."
            )
        ),

        types.Part.from_bytes(
            data=scene_bytes,
            mime_type=scene_mime_type,
        ),

        types.Part.from_text(
            text=(
                "IMAGE 2 = EXACT SELECTED CATALOG TILE. "
                "The next image is the real catalog photograph of the "
                "one tile product being visualized, and is the ONLY "
                "source of truth for the tile itself. Reproduce this "
                "exact tile -- its pattern, colour, texture, finish, "
                "geometry/shape and distinctive markings -- on the "
                "requested surface. Do NOT invent a visually similar "
                "tile, and do NOT substitute a tile inferred from the "
                "product name, SKU or brand."
            )
        ),

        types.Part.from_bytes(
            data=tile_bytes,
            mime_type=tile_mime_type,
        ),
    ]

    # THE WHOLE COMBINATION, EACH IMAGE LABELLED WITH ITS ROLE.
    #
    # The two labels above describe IMAGE 2 as "the one tile product
    # being visualized", which stops being true the moment a board has a
    # highlight and an accent as well. So for a combination the tile tail
    # is rebuilt from scratch: scene, then one labelled image per
    # material, in the order the prompt enumerated them. Labelling each
    # part immediately before its own bytes is what binds a material to
    # its role -- with four images, an unlabelled part is an invitation
    # to put the accent where the base belongs.
    if resolved_materials:

        contents = contents[:3]  # prompt, scene label, scene bytes

        for position, material in enumerate(resolved_materials, start=2):
            role = str(material.get("role") or "").strip().upper()
            path = material["image_path"]

            contents.append(
                types.Part.from_text(
                    text=(
                        f"IMAGE {position} = EXACT "
                        f"{role or 'SELECTED'} CATALOG MATERIAL. "
                        "The next image is the real catalog photograph "
                        "of this material and is the ONLY source of "
                        "truth for it. Reproduce it exactly -- pattern, "
                        "colour, texture, finish, geometry and "
                        "markings -- on the surfaces named for its role. "
                        "Do NOT invent a similar material and do NOT "
                        "substitute one inferred from a name or SKU."
                    )
                )
            )

            contents.append(
                types.Part.from_bytes(
                    data=path.read_bytes(),
                    mime_type=_get_mime_type(path),
                )
            )

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

        "angle": angle,
    }