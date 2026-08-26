import os
import json
import mimetypes
from pathlib import Path
from typing import Any, Dict, Optional

from dotenv import load_dotenv
from google import genai
from google.genai import types

from app import scene_angle_engine
from app import drive_folders
from app import angle_generator
from app.scene_reference_images import (
    resolve_scene_reference_images,
)


# ============================================================
# ENVIRONMENT
# ============================================================

load_dotenv()


GEMINI_API_KEY = os.getenv(
    "GEMINI_API_KEY"
)

if not GEMINI_API_KEY:
    raise RuntimeError(
        "GEMINI_API_KEY is missing from .env"
    )


# ============================================================
# IMAGE GENERATION MODEL
# ============================================================

IMAGE_MODEL = os.getenv(
    "GEMINI_IMAGE_MODEL",
    "gemini-3.1-flash-image"
)


# ============================================================
# OUTPUT DIRECTORY
# ============================================================

OUTPUT_ROOT = Path(
    os.getenv(
        "SCENE_OUTPUT_ROOT",
        "output/scenes"
    )
)


# ============================================================
# GEMINI CLIENT
# ============================================================

client = genai.Client(
    api_key=GEMINI_API_KEY
)


# ============================================================
# SUPPORTED ANGLES
# ============================================================

# Your current scene_angle_engine uses:
#
# FRONT
# LEFT
# RIGHT
# WIDE
# CLOSE_UP
#
# Older parts of the project used:
#
# SHOWER_CLOSEUP
#
# We support SHOWER_CLOSEUP as a compatibility alias.

ANGLE_ALIASES = {
    "SHOWER_CLOSEUP": "CLOSE_UP",
    "SHOWER_CLOSE_UP": "CLOSE_UP",
    "CLOSEUP": "CLOSE_UP",
    "CLOSE-UP": "CLOSE_UP",
}


ANGLE_FILENAMES = {

    "FRONT":
        "front.png",

    "LEFT":
        "left.png",

    "RIGHT":
        "right.png",

    "WIDE":
        "wide.png",

    "CLOSE_UP":
        "shower_closeup.png",
}


SUPPORTED_ANGLES = (
    "FRONT",
    "LEFT",
    "RIGHT",
    "WIDE",
    "CLOSE_UP",
)


# ============================================================
# OUTPUT SETTINGS
# ============================================================

OUTPUT_ASPECT_RATIO = "16:9"


OUTPUT_IMAGE_SIZE = os.getenv(
    "GEMINI_IMAGE_SIZE",
    "2K"
)


# ============================================================
# NORMALIZE ANGLE
# ============================================================

def normalize_angle(
    angle: str
) -> str:
    """
    Normalize an angle name.

    Supports both the current engine name CLOSE_UP
    and the legacy project name SHOWER_CLOSEUP.
    """

    if not isinstance(
        angle,
        str
    ):
        raise ValueError(
            "Scene angle must be a string."
        )

    normalized = (
        angle
        .strip()
        .upper()
        .replace(" ", "_")
    )

    normalized = ANGLE_ALIASES.get(
        normalized,
        normalized
    )

    if normalized not in SUPPORTED_ANGLES:
        raise ValueError(
            "Unsupported scene angle: "
            f"{angle}. Supported angles: "
            f"{', '.join(SUPPORTED_ANGLES)}"
        )

    return normalized


# ============================================================
# GET ANGLE SPECIFICATION
# ============================================================

def get_angle_spec(
    scene: Dict[str, Any],
    angle: str
) -> Dict[str, Any]:
    """
    Get the deterministic camera specification from
    scene_angle_engine.

    The scene_angle_engine remains the source of truth
    for camera-angle definitions.
    """

    if not isinstance(
        scene,
        dict
    ):
        raise ValueError(
            "Scene must be a dictionary."
        )

    normalized_angle = normalize_angle(
        angle
    )

    # Build the official angle definitions from
    # scene_angle_engine.
    angles = (
        scene_angle_engine.build_scene_angles(
            scene
        )
    )

    for angle_record in angles:

        if (
            angle_record.get(
                "angle_type"
            )
            == normalized_angle
        ):
            return angle_record

    raise ValueError(
        "Angle specification not found for "
        f"{normalized_angle}"
    )


# ============================================================
# GET OUTPUT PATH
# ============================================================

def get_scene_output_path(
    scene_id: str,
    angle: str
) -> Path:

    normalized_angle = normalize_angle(
        angle
    )

    filename = ANGLE_FILENAMES[
        normalized_angle
    ]

    scene_directory = (
        OUTPUT_ROOT /
        scene_id
    )

    scene_directory.mkdir(
        parents=True,
        exist_ok=True
    )

    return (
        scene_directory /
        filename
    )


# ============================================================
# MIME TYPE
# ============================================================

def get_mime_type(
    image_path: Path
) -> str:
    """
    Return a supported MIME type for
    a reference image.
    """

    image_path = Path(
        image_path
    )

    mime_type, _ = mimetypes.guess_type(
        str(image_path)
    )

    supported_types = {
        "image/jpeg",
        "image/png",
        "image/webp",
    }

    if mime_type not in supported_types:
        raise ValueError(
            "Unsupported reference image format: "
            f"{image_path}"
        )

    return mime_type


# ============================================================
# LOAD LOCKED SCENE
# ============================================================

def load_locked_scene(
    scene_id: str,
    scene_path: Optional[Path] = None
) -> Dict[str, Any]:
    """
    Load the locked scene definition.

    The locked scene is the source of truth
    for products.
    """

    if scene_path is None:

        scene_path = (
            OUTPUT_ROOT /
            scene_id /
            "scene.json"
        )

    scene_path = Path(
        scene_path
    )

    if not scene_path.exists():

        raise FileNotFoundError(
            f"Locked scene not found: "
            f"{scene_path}"
        )

    try:

        scene = json.loads(
            scene_path.read_text(
                encoding="utf-8"
            )
        )

    except json.JSONDecodeError as error:

        raise ValueError(
            f"Invalid scene.json: "
            f"{scene_path}"
        ) from error

    if not isinstance(
        scene,
        dict
    ):
        raise ValueError(
            "scene.json must contain a JSON object."
        )

    if scene.get(
        "scene_id"
    ) != scene_id:

        raise ValueError(
            f"Scene ID mismatch. "
            f"Expected {scene_id}, "
            f"found {scene.get('scene_id')}"
        )

    if scene.get(
        "product_lock"
    ) is not True:

        raise ValueError(
            f"Scene {scene_id} is not "
            "product-locked."
        )

    products = scene.get(
        "products",
        []
    )

    if not isinstance(
        products,
        list
    ) or not products:

        raise ValueError(
            f"Scene {scene_id} contains "
            "no locked products."
        )

    # --------------------------------------------------------
    # Make sure product IDs exist.
    # --------------------------------------------------------

    product_ids = []

    for product in products:

        if not isinstance(
            product,
            dict
        ):
            continue

        product_id = str(
            product.get(
                "product_id",
                ""
            )
        ).strip()

        if product_id:
            product_ids.append(
                product_id
            )

    if not product_ids:

        # Some scene records may already have
        # product_ids directly.
        existing_ids = scene.get(
            "product_ids",
            []
        )

        if isinstance(
            existing_ids,
            list
        ):
            product_ids = [
                str(product_id).strip()
                for product_id
                in existing_ids
                if str(product_id).strip()
            ]

    if not product_ids:

        raise ValueError(
            f"Scene {scene_id} has locked products "
            "but no product IDs."
        )

    # Remove accidental duplicates
    # while preserving order.

    scene["product_ids"] = list(
        dict.fromkeys(
            product_ids
        )
    )

    return scene


# ============================================================
# VALIDATE SCENE ANGLE
# ============================================================

def validate_scene_angle(
    angle: str
) -> str:
    """
    Validate and normalize supported showroom angles.
    """

    return normalize_angle(
        angle
    )


# ============================================================
# BUILD LOCKED SCENE PROMPT
# ============================================================

def build_locked_scene_prompt(
    scene: Dict[str, Any],
    request: Dict[str, Any]
) -> str:
    """
    Build a strict camera-only scene prompt.
    """

    products = scene.get(
        "products",
        []
    )

    product_lines = []

    for product in products:

        if not isinstance(
            product,
            dict
        ):
            continue

        product_lines.append(
            "- "
            f"Product ID: "
            f"{product.get('product_id', '')}; "
            f"Name: "
            f"{product.get('product_name', '')}; "
            f"Brand: "
            f"{product.get('brand', '')}; "
            f"Code: "
            f"{product.get('product_code', '')}; "
            f"Dimensions: "
            f"{product.get('dimensions', '')}"
        )

    product_block = "\n".join(
        product_lines
    )

    camera = request.get(
        "camera",
        {}
    )

    if not isinstance(
        camera,
        dict
    ):
        camera = {}

    angle = request.get(
        "angle",
        ""
    )

    return f"""
Generate a new camera view of the EXISTING LOCKED
bathroom scene.

SCENE ID:
{scene.get('scene_id', '')}

PRODUCT LOCK:
TRUE

LOCKED PRODUCTS:
{product_block}

REQUESTED ANGLE:
{angle}

CAMERA POSITION:
{camera.get('position', '')}

CAMERA DIRECTION:
{camera.get('direction', '')}

FRAMING:
{camera.get('framing', '')}

PURPOSE:
{request.get('purpose', '')}

STRICT PRESERVATION RULES:

1. Preserve the exact same bathroom scene.
2. Preserve every locked product.
3. Do not add products.
4. Do not remove products.
5. Do not replace products.
6. Do not substitute products with visually similar products.
7. Preserve the exact tile and material selections.
8. Preserve colors and finishes.
9. Preserve basin and faucet.
10. Preserve WC and flush plate.
11. Preserve shower configuration.
12. Preserve shower partition and glass.
13. Preserve architectural layout.
14. Preserve product proportions.
15. Preserve product placement.
16. Preserve product identity from the supplied reference images.
17. Do not redesign the bathroom.
18. Do not create a new moodboard.
19. Do not change the interior style.
20. Do not change the selected products.
21. ONLY change camera position, camera direction,
    framing and field of view.

The supplied product reference images are authoritative
references for product identity and appearance.

The result must look like the SAME bathroom photographed
from a different camera position.

Generate a photorealistic showroom-quality interior image.
""".strip()


# ============================================================
# BUILD GEMINI IMAGE CONTENTS
# ============================================================

def build_image_contents(
    request: Dict[str, Any]
):
    """
    Build Gemini image-generation input.

    First part:
        locked scene prompt

    Remaining parts:
        actual locked product reference images
    """

    scene = request.get(
        "scene"
    )

    if not isinstance(
        scene,
        dict
    ):
        raise ValueError(
            "Locked scene is required "
            "for image generation."
        )

    if scene.get(
        "product_lock"
    ) is not True:

        raise ValueError(
            "Cannot generate scene image "
            "without product_lock=True."
        )

    prompt = str(
        request.get(
            "prompt",
            ""
        )
    ).strip()

    if not prompt:

        prompt = build_locked_scene_prompt(
            scene,
            request
        )

    contents = [
        types.Part.from_text(
            text=prompt
        )
    ]

    # ========================================================
    # RESOLVE PRODUCT REFERENCE IMAGES
    # ========================================================

    reference_images = (
        resolve_scene_reference_images(
            scene
        )
    )

    if not reference_images:

        raise ValueError(
            "No product reference images were "
            "resolved for the locked scene."
        )

    # ========================================================
    # ADD PRODUCT REFERENCE IMAGES
    # ========================================================

    for image_path in reference_images:

        image_path = Path(
            image_path
        )

        if not image_path.exists():

            raise FileNotFoundError(
                "Reference image not found: "
                f"{image_path}"
            )

        if not image_path.is_file():

            raise FileNotFoundError(
                "Reference image is not a file: "
                f"{image_path}"
            )

        mime_type = get_mime_type(
            image_path
        )

        image_bytes = (
            image_path.read_bytes()
        )

        if not image_bytes:

            raise ValueError(
                "Reference image is empty: "
                f"{image_path}"
            )

        contents.append(
            types.Part.from_bytes(
                data=image_bytes,
                mime_type=mime_type
            )
        )

    return contents


# ============================================================
# EXTRACT GENERATED IMAGE
# ============================================================

def extract_generated_image(
    response: Any
):
    """
    Extract the first generated image
    from Gemini response.
    """

    if response is None:

        raise RuntimeError(
            "Gemini returned no response."
        )

    # ========================================================
    # PREFERRED SDK PATH
    # ========================================================

    try:

        for part in getattr(
            response,
            "parts",
            []
        ):

            if part is None:
                continue

            text = getattr(
                part,
                "text",
                None
            )

            if text:
                continue

            image_method = getattr(
                part,
                "as_image",
                None
            )

            if callable(
                image_method
            ):

                generated = (
                    image_method()
                )

                if generated is not None:
                    return generated

    except Exception:
        pass

    # ========================================================
    # CANDIDATE / INLINE DATA FALLBACK
    # ========================================================

    try:

        candidates = getattr(
            response,
            "candidates",
            None
        )

        if candidates:

            for candidate in candidates:

                content = getattr(
                    candidate,
                    "content",
                    None
                )

                if content is None:
                    continue

                parts = getattr(
                    content,
                    "parts",
                    []
                )

                for part in parts:

                    inline_data = getattr(
                        part,
                        "inline_data",
                        None
                    )

                    if inline_data is None:

                        inline_data = getattr(
                            part,
                            "inlineData",
                            None
                        )

                    if inline_data is None:
                        continue

                    data = getattr(
                        inline_data,
                        "data",
                        None
                    )

                    if data is not None:
                        return data

    except Exception:
        pass

    raise RuntimeError(
        "Gemini response did not contain "
        "a generated image."
    )


# ============================================================
# SAVE GENERATED IMAGE
# ============================================================

def save_generated_image(
    generated_image: Any,
    output_path: Path
):

    output_path = Path(
        output_path
    )

    output_path.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    # ========================================================
    # GEMINI IMAGE OBJECT
    # ========================================================

    if hasattr(
        generated_image,
        "save"
    ):

        generated_image.save(
            str(output_path)
        )

        return

    # ========================================================
    # RAW BYTES
    # ========================================================

    if isinstance(
        generated_image,
        bytes
    ):

        output_path.write_bytes(
            generated_image
        )

        return

    raise TypeError(
        "Unsupported generated image type: "
        f"{type(generated_image).__name__}"
    )


# ============================================================
# GOOGLE DRIVE SCENE STORAGE
# ============================================================

SCENE_DRIVE_ROOT_FOLDER_ID = os.getenv(
    "SCENE_DRIVE_ROOT_FOLDER_ID",
    getattr(
        drive_folders,
        "ROOT_FOLDER_ID",
        ""
    )
)


def upload_scene_image_to_drive(
    scene_id: str,
    image_path: Path
) -> Dict[str, Any]:
    """
    Upload generated scene image to:

    ROOT/
        GENERATED_SCENES/
            SCENE_ID/
                image.png
    """

    if not SCENE_DRIVE_ROOT_FOLDER_ID:

        raise RuntimeError(
            "SCENE_DRIVE_ROOT_FOLDER_ID is missing "
            "and drive_folders.ROOT_FOLDER_ID is not configured."
        )

    image_path = Path(
        image_path
    )

    if not image_path.exists():

        raise FileNotFoundError(
            "Generated scene image not found: "
            f"{image_path}"
        )

    drive = (
        drive_folders.get_drive_service()
    )

    generated_root_id = (
        drive_folders.get_or_create_folder(
            drive,
            "GENERATED_SCENES",
            SCENE_DRIVE_ROOT_FOLDER_ID
        )
    )

    scene_folder_id = (
        drive_folders.get_or_create_folder(
            drive,
            scene_id,
            generated_root_id
        )
    )

    uploaded = (
        drive_folders.upload_file_to_folder(
            file_path=image_path,
            folder_id=scene_folder_id,
            filename=image_path.name
        )
    )

    if not isinstance(
        uploaded,
        dict
    ):
        raise RuntimeError(
            "Google Drive upload returned "
            "an invalid response."
        )

    file_id = uploaded.get(
        "id"
    )

    if not file_id:

        raise RuntimeError(
            "Google Drive upload succeeded "
            "but no file ID was returned."
        )

    return {
        "file_id":
            file_id,

        "name":
            uploaded.get(
                "name",
                image_path.name
            ),

        "webViewLink":
            uploaded.get(
                "webViewLink",
                ""
            ),

        "folder_id":
            scene_folder_id,

        "folder_name":
            scene_id,
    }


# ============================================================
# SAVE LOCAL GENERATION RECORD
# ============================================================

def save_generation_record(
    scene_id: str,
    angle: str,
    result: Dict[str, Any]
) -> Path:
    """
    Save a lightweight generation record locally.

    This does not modify the locked scene.
    """

    scene_directory = (
        OUTPUT_ROOT /
        scene_id
    )

    scene_directory.mkdir(
        parents=True,
        exist_ok=True
    )

    record_path = (
        scene_directory /
        "generated_angles.json"
    )

    existing = {
        "scene_id":
            scene_id,

        "product_lock":
            True,

        "angles":
            []
    }

    if record_path.exists():

        try:

            loaded = json.loads(
                record_path.read_text(
                    encoding="utf-8"
                )
            )

            if isinstance(
                loaded,
                dict
            ):
                existing = loaded

        except Exception:

            # If an old record is invalid,
            # start a clean generation record.
            pass

    if not isinstance(
        existing.get("angles"),
        list
    ):

        existing["angles"] = []

    # Remove previous record for
    # the same angle.

    existing["angles"] = [
        item
        for item in existing["angles"]
        if not (
            isinstance(
                item,
                dict
            )
            and item.get(
                "angle"
            ) == angle
        )
    ]

    existing["angles"].append(
        result
    )

    existing["angle_count"] = len(
        existing["angles"]
    )

    record_path.write_text(
        json.dumps(
            existing,
            indent=2,
            ensure_ascii=False,
            default=str
        ),
        encoding="utf-8"
    )

    return record_path


# ============================================================
# GENERATE ONE SCENE ANGLE
# ============================================================

def generate_scene_angle(
    scene_id: str,
    angle: str,
    scene_path: Optional[Path] = None
) -> Dict[str, Any]:
    """
    Generate one camera angle for an existing
    locked Scene.

    The products remain locked.
    Only camera/view information changes.
    """

    # ========================================================
    # LOAD LOCKED SCENE
    # ========================================================

    scene = load_locked_scene(
        scene_id=scene_id,
        scene_path=scene_path
    )

    # ========================================================
    # VALIDATE ANGLE
    # ========================================================

    normalized_angle = (
        validate_scene_angle(
            angle
        )
    )

    # ========================================================
    # GET OFFICIAL ANGLE SPEC
    # ========================================================

    angle_spec = get_angle_spec(
        scene,
        normalized_angle
    )

    camera = angle_spec.get(
        "camera",
        {}
    )

    if not isinstance(
        camera,
        dict
    ):
        camera = {}

    # ========================================================
    # BUILD REQUEST
    # ========================================================

    request = {

        "scene_id":
            scene_id,

        "angle":
            normalized_angle,

        "product_lock":
            True,

        "scene":
            scene,

        "locked_products":
            list(
                scene.get(
                    "products",
                    []
                )
            ),

        "locked_product_ids":
            list(
                scene.get(
                    "product_ids",
                    []
                )
            ),

        "product_ids":
            list(
                scene.get(
                    "product_ids",
                    []
                )
            ),

        "camera":
            camera,

        "purpose":
            angle_spec.get(
                "purpose",
                ""
            ),
    }

    # ========================================================
    # HARD PRODUCT LOCK
    # ========================================================

    if not request[
        "locked_product_ids"
    ]:

        raise ValueError(
            f"Scene {scene_id} has no "
            "locked product IDs."
        )

    # ========================================================
    # BUILD STRICT PROMPT
    # ========================================================

    request["prompt"] = (
        build_locked_scene_prompt(
            scene,
            request
        )
    )

    # ========================================================
    # OUTPUT PATH
    # ========================================================

    output_path = (
        get_scene_output_path(
            scene_id,
            normalized_angle
        )
    )

    # ========================================================
    # GENERATE
    # ========================================================

    try:

        print()
        print("=" * 70)
        print(
            "SCENE IMAGE GENERATION"
        )
        print("=" * 70)

        print(
            f"Scene ID : {scene_id}"
        )

        print(
            f"Angle    : {normalized_angle}"
        )

        print(
            "Products : "
            f"{len(request['locked_product_ids'])}"
        )

        print(
            "Product Lock: TRUE"
        )

        print("=" * 70)

        # ----------------------------------------------------
        # BUILD GEMINI CONTENTS
        # ----------------------------------------------------

        contents = (
            build_image_contents(
                request
            )
        )

        print(
            "Reference images loaded."
        )

        # ----------------------------------------------------
        # GEMINI IMAGE GENERATION
        # ----------------------------------------------------

        print(
            "Calling Gemini image generation..."
        )

        response = (
            client.models.generate_content(
                model=IMAGE_MODEL,
                contents=contents,
                config=(
                    types.GenerateContentConfig(
                        response_modalities=[
                            "IMAGE"
                        ],
                        image_config=(
                            types.ImageConfig(
                                aspect_ratio=(
                                    OUTPUT_ASPECT_RATIO
                                ),
                                image_size=(
                                    OUTPUT_IMAGE_SIZE
                                ),
                            )
                        ),
                    )
                ),
            )
        )

        print(
            "Gemini generation completed."
        )

        # ----------------------------------------------------
        # EXTRACT IMAGE
        # ----------------------------------------------------

        generated_image = (
            extract_generated_image(
                response
            )
        )

        # ----------------------------------------------------
        # SAVE LOCAL IMAGE
        # ----------------------------------------------------

        save_generated_image(
            generated_image,
            output_path
        )

        print(
            f"Local image saved: "
            f"{output_path}"
        )

        # ----------------------------------------------------
        # GOOGLE DRIVE
        # ----------------------------------------------------

        drive_file = (
            upload_scene_image_to_drive(
                scene_id=scene_id,
                image_path=output_path
            )
        )

        print(
            "Google Drive upload completed."
        )

        # ----------------------------------------------------
        # RESULT
        # ----------------------------------------------------

        result = {

            "scene_id":
                scene_id,

            "angle":
                normalized_angle,

            "status":
                "GENERATED",

            "product_lock":
                True,

            "locked_product_ids":
                list(
                    request[
                        "locked_product_ids"
                    ]
                ),

            "camera":
                camera,

            "image_path":
                str(
                    output_path
                ),

            "drive_file_id":
                drive_file.get(
                    "file_id"
                ),

            "drive_url":
                drive_file.get(
                    "webViewLink",
                    ""
                ),

            "drive_folder_id":
                drive_file.get(
                    "folder_id"
                ),

            "generated_at":
                __import__(
                    "datetime"
                ).datetime.now(
                    __import__(
                        "datetime"
                    ).timezone.utc
                ).isoformat(),
        }

        # ----------------------------------------------------
        # SAVE GENERATION RECORD
        # ----------------------------------------------------

        record_path = (
            save_generation_record(
                scene_id,
                normalized_angle,
                result
            )
        )

        result[
            "generation_record"
        ] = str(
            record_path
        )

        print()
        print(
            "SCENE ANGLE GENERATED SUCCESSFULLY"
        )

        print(
            f"Image: {output_path}"
        )

        print(
            f"Drive ID: "
            f"{drive_file.get('file_id')}"
        )

        return result

    except Exception as error:

        print()
        print(
            "SCENE IMAGE GENERATION FAILED"
        )

        print(
            f"Scene: {scene_id}"
        )

        print(
            f"Angle: {normalized_angle}"
        )

        print(
            f"Error: {error}"
        )

        raise RuntimeError(
            "Scene angle generation failed: "
            f"{error}"
        ) from error


# ============================================================
# GENERATE ALL INITIAL ANGLES
# ============================================================

def generate_all_scene_angles(
    scene_id: str,
    scene_path: Optional[Path] = None
):
    """
    Generate all five supported camera views.

    FRONT
    LEFT
    RIGHT
    WIDE
    CLOSE_UP
    """

    angles = [
        "FRONT",
        "LEFT",
        "RIGHT",
        "WIDE",
        "CLOSE_UP",
    ]

    results = []

    for angle in angles:

        result = (
            generate_scene_angle(
                scene_id=scene_id,
                angle=angle,
                scene_path=scene_path
            )
        )

        results.append(
            result
        )

    return results


# ============================================================
# SIMPLE TEST
# ============================================================

if __name__ == "__main__":

    print(
        "scene_image_generator loaded successfully."
    )

    print(
        "Supported angles:"
    )

    for angle in SUPPORTED_ANGLES:

        print(
            f"  - {angle}"
        )

    print()
    print(
        "Legacy alias:"
    )

    print(
        "  - SHOWER_CLOSEUP -> CLOSE_UP"
    )