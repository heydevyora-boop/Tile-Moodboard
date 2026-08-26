"""
scene_image_generator.py

Locked-scene image generation pipeline.

Pipeline:

    LOCKED SCENE
        |
        v
    CAMERA ANGLE
        |
        v
    GEMINI IMAGE GENERATION
        |
        v
    LOCAL IMAGE
        |
        v
    GOOGLE DRIVE
        |
        v
    DATABASE COMPLETION

Important:
- Products are never changed by this module.
- Camera angle changes only the viewpoint/framing.
- Database completion is explicitly called after Drive upload.
- The module does not depend on the legacy top-level angle_generator.py.
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from dotenv import load_dotenv
from google import genai
from google.genai import types

# ------------------------------------------------------------
# Package-safe Drive module import
# ------------------------------------------------------------
#
# The project is executed with:
#
#     python -m app.test_scene_image_generator
#
# Therefore the Drive helper lives inside the app package.
# The old top-level import:
#
#     import drive_folders
#
# causes:
#     ModuleNotFoundError: No module named 'drive_folders'
#
# Use the package import first, with a legacy fallback so this
# module can also be imported directly when needed.
try:
    from app import drive_folders
except ModuleNotFoundError:
    import drive_folders


# ============================================================
# ENVIRONMENT
# ============================================================

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

if not GEMINI_API_KEY:
    raise RuntimeError(
        "GEMINI_API_KEY is missing from .env"
    )


# ============================================================
# CONFIGURATION
# ============================================================

IMAGE_MODEL = os.getenv(
    "GEMINI_IMAGE_MODEL",
    "gemini-3.1-flash-image",
)

OUTPUT_ROOT = Path(
    os.getenv(
        "SCENE_OUTPUT_ROOT",
        "output/scenes",
    )
)

OUTPUT_ASPECT_RATIO = os.getenv(
    "GEMINI_IMAGE_ASPECT_RATIO",
    "16:9",
)

OUTPUT_IMAGE_SIZE = os.getenv(
    "GEMINI_IMAGE_SIZE",
    "2K",
)

SCENE_DRIVE_ROOT_FOLDER_ID = os.getenv(
    "SCENE_DRIVE_ROOT_FOLDER_ID",
    getattr(drive_folders, "ROOT_FOLDER_ID", ""),
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

ANGLE_FILENAMES = {
    "FRONT": "front.png",
    "LEFT": "left.png",
    "RIGHT": "right.png",
    "WIDE": "wide.png",
    "SHOWER_CLOSEUP": "shower_closeup.png",
}

ANGLE_SPECS = {
    "FRONT": {
        "position": "front",
        "direction": "straight_on",
        "framing": "balanced",
        "purpose": "primary product presentation",
    },
    "LEFT": {
        "position": "left",
        "direction": "three_quarter_left",
        "framing": "medium",
        "purpose": "left-side product presentation",
    },
    "RIGHT": {
        "position": "right",
        "direction": "three_quarter_right",
        "framing": "medium",
        "purpose": "right-side product presentation",
    },
    "WIDE": {
        "position": "far",
        "direction": "straight_on",
        "framing": "wide",
        "purpose": "complete bathroom scene presentation",
    },
    "SHOWER_CLOSEUP": {
        "position": "near_shower",
        "direction": "shower_detail",
        "framing": "close",
        "purpose": "shower/product detail presentation",
    },
}


# ============================================================
# OPTIONAL SCENE MANAGER
# ============================================================

try:
    from app import scene_manager as _scene_manager
except Exception:
    _scene_manager = None


# ============================================================
# ANGLE SERVICE
# ============================================================

class _AngleService:
    """
    Compatibility service used by scene_image_generator.

    This deliberately lives in this module so generation does
    not depend on the old angle_generator.py / angle_config.py
    dependency chain.
    """

    @staticmethod
    def validate_angle(angle: str) -> str:
        normalized = str(angle).strip().upper()

        aliases = {
            "CLOSE_UP": "SHOWER_CLOSEUP",
            "CLOSEUP": "SHOWER_CLOSEUP",
            "SHOWER_CLOSE_UP": "SHOWER_CLOSEUP",
        }

        normalized = aliases.get(
            normalized,
            normalized,
        )

        if normalized not in ANGLE_FILENAMES:
            raise ValueError(
                "Unsupported scene angle: "
                f"{angle}. Supported angles: "
                f"{', '.join(ANGLE_FILENAMES)}"
            )

        return normalized

    @staticmethod
    def prepare_angle_request(
        scene_id: str,
        angle: str,
    ) -> Dict[str, Any]:

        normalized_angle = (
            _AngleService.validate_angle(angle)
        )

        scene = load_locked_scene(scene_id)

        camera = dict(
            ANGLE_SPECS[normalized_angle]
        )

        request = {
            "scene_id": scene_id,
            "angle": normalized_angle,
            "product_lock": True,
            "scene": scene,
            "locked_products": list(
                scene["products"]
            ),
            "locked_product_ids": [
                product["product_id"]
                for product in scene["products"]
            ],
            "product_ids": [
                product["product_id"]
                for product in scene["products"]
            ],
            "camera": {
                "position": camera["position"],
                "direction": camera["direction"],
                "framing": camera["framing"],
            },
        }

        request["prompt"] = (
            build_locked_scene_prompt(
                scene,
                request,
            )
        )

        return request

    @staticmethod
    def start_angle_generation(
        scene_id: str,
        angle: str,
    ) -> Any:
        """
        Notify the scene manager that generation started.

        Several project versions used different names. We support
        the known names without requiring the legacy angle module.
        """

        if _scene_manager is None:
            return {
                "scene_id": scene_id,
                "angle": angle,
                "status": "GENERATING",
            }

        for name in (
            "start_angle_generation",
            "mark_angle_generating",
        ):
            function = getattr(
                _scene_manager,
                name,
                None,
            )

            if callable(function):
                return function(
                    scene_id,
                    angle,
                )

        return {
            "scene_id": scene_id,
            "angle": angle,
            "status": "GENERATING",
        }

    @staticmethod
    def complete_angle_generation(
        scene_id: str,
        angle: str,
        drive_url: str,
    ) -> Dict[str, Any]:
        """
        Persist the completed angle.

        This function MUST be called after successful Drive upload.
        """

        if not drive_url:
            raise RuntimeError(
                "Cannot complete scene angle without a Drive URL."
            )

        if _scene_manager is None:
            raise RuntimeError(
                "app.scene_manager could not be imported. "
                "Database completion cannot be persisted."
            )

        for name in (
            "complete_angle_generation",
            "mark_angle_generated",
            "save_generated_angle",
            "update_angle_generated",
        ):
            function = getattr(
                _scene_manager,
                name,
                None,
            )

            if not callable(function):
                continue

            result = function(
                scene_id,
                angle,
                drive_url,
            )

            if result is None:
                # Some database wrappers intentionally return None.
                return {
                    "scene_id": scene_id,
                    "angle": angle,
                    "status": "GENERATED",
                    "drive_url": drive_url,
                }

            if isinstance(result, dict):
                return result

            return {
                "scene_id": scene_id,
                "angle": angle,
                "status": "GENERATED",
                "drive_url": drive_url,
                "raw_result": result,
            }

        raise RuntimeError(
            "scene_manager does not provide a database completion "
            "function. Expected one of: "
            "complete_angle_generation, "
            "mark_angle_generated, "
            "save_generated_angle, "
            "update_angle_generated."
        )

    @staticmethod
    def fail_angle_generation(
        scene_id: str,
        angle: str,
    ) -> Any:

        if _scene_manager is None:
            return None

        for name in (
            "fail_angle_generation",
            "mark_angle_failed",
        ):
            function = getattr(
                _scene_manager,
                name,
                None,
            )

            if callable(function):
                return function(
                    scene_id,
                    angle,
                )

        return None


# ============================================================
# PUBLIC COMPATIBILITY OBJECT
# ============================================================

# Tests and older project code can patch:
#
#     scene_image_generator.angle_generator
#
# without importing the obsolete angle_generator.py module.
angle_generator = _AngleService


# ============================================================
# LOAD LOCKED SCENE
# ============================================================

def load_locked_scene(
    scene_id: str,
) -> Dict[str, Any]:
    """
    Load the authoritative locked Scene.

    Preferred source:
        scene_manager.get_scene()

    Fallback:
        SCENE_OUTPUT_ROOT/<scene_id>/scene.json
    """

    if not scene_id:
        raise ValueError(
            "scene_id is required."
        )

    scene = None

    if _scene_manager is not None:
        getter = getattr(
            _scene_manager,
            "get_scene",
            None,
        )

        if callable(getter):
            scene = getter(scene_id)

    if scene is None:
        scene_path = (
            OUTPUT_ROOT /
            scene_id /
            "scene.json"
        )

        if scene_path.exists():
            scene = json.loads(
                scene_path.read_text(
                    encoding="utf-8"
                )
            )

    if scene is None:
        raise FileNotFoundError(
            f"Locked Scene not found: {scene_id}"
        )

    if not isinstance(scene, dict):
        raise TypeError(
            f"Scene {scene_id} must be a dictionary."
        )

    actual_scene_id = scene.get(
        "scene_id",
        scene.get("id", ""),
    )

    if actual_scene_id != scene_id:
        raise ValueError(
            "Scene ID mismatch. "
            f"Expected {scene_id}, found {actual_scene_id}"
        )

    status = str(
        scene.get("status", "")
    ).upper()

    product_lock = (
        scene.get("product_lock") is True
        or scene.get("locked") is True
        or status == "LOCKED"
    )

    if not product_lock:
        raise ValueError(
            f"Scene {scene_id} is not product-locked."
        )

    products = scene.get(
        "products",
        [],
    )

    if not isinstance(products, list):
        raise ValueError(
            f"Scene {scene_id}.products must be a list."
        )

    if not products:
        raise ValueError(
            f"Scene {scene_id} contains no locked products."
        )

    # Validate every locked product.
    for index, product in enumerate(products):
        if not isinstance(product, dict):
            raise ValueError(
                f"Scene {scene_id} product #{index + 1} "
                "must be a dictionary."
            )

        product_id = str(
            product.get("product_id", "")
        ).strip()

        if not product_id:
            raise ValueError(
                f"Scene {scene_id} contains a product "
                f"without product_id at index {index}."
            )

    return scene


# ============================================================
# BUILD LOCKED SCENE PROMPT
# ============================================================

def build_locked_scene_prompt(
    scene: Dict[str, Any],
    request: Dict[str, Any],
) -> str:
    """
    Build a strict camera-only prompt.

    Products, materials, architecture and layout are locked.
    """

    product_lines = []

    for product in scene.get(
        "products",
        [],
    ):
        product_lines.append(
            "- "
            f"Product ID: {product.get('product_id', '')}; "
            f"Name: {product.get('product_name', '')}; "
            f"Brand: {product.get('brand', '')}; "
            f"Code: {product.get('product_code', '')}; "
            f"Dimensions: {product.get('dimensions', '')}"
        )

    product_block = "\n".join(
        product_lines
    )

    camera = request.get(
        "camera",
        {},
    )

    return f"""
You are generating a NEW CAMERA VIEW of an EXISTING LOCKED
bathroom scene.

SCENE ID:
{scene.get('scene_id', '')}

PRODUCT LOCK:
TRUE

LOCKED PRODUCTS:
{product_block}

REQUESTED ANGLE:
{request.get('angle', '')}

CAMERA POSITION:
{camera.get('position', '')}

CAMERA DIRECTION:
{camera.get('direction', '')}

FRAMING:
{camera.get('framing', '')}

ABSOLUTE RULES:

1. Preserve the exact same bathroom scene.
2. Preserve every locked product.
3. Do not add products.
4. Do not remove products.
5. Do not replace products.
6. Do not substitute visually similar products.
7. Preserve exact tile/material selection.
8. Preserve colors.
9. Preserve finishes.
10. Preserve sanitary fixtures.
11. Preserve basin and faucet.
12. Preserve WC and flush plate.
13. Preserve shower configuration.
14. Preserve glass/partition configuration.
15. Preserve architectural layout.
16. Preserve product proportions.
17. Preserve product placement.
18. Do not redesign the bathroom.
19. Do not create a new moodboard.
20. Do not change the interior style.
21. Only change camera position.
22. Only change viewing angle.
23. Only change framing and field of view.
24. The output must look like the SAME bathroom photographed
    from a different camera position.

If a requested camera angle would normally require changing
the bathroom design, keep the design unchanged and adjust only
the camera viewpoint.

Return a photorealistic interior visualization.
""".strip()


# ============================================================
# BUILD GEMINI CONTENTS
# ============================================================

def build_image_contents(
    request: Dict[str, Any],
):
    prompt = request.get(
        "prompt",
        "",
    )

    if not prompt:
        prompt = build_locked_scene_prompt(
            request["scene"],
            request,
        )

    return [
        types.Part.from_text(
            text=prompt
        )
    ]


# ============================================================
# EXTRACT IMAGE
# ============================================================

def extract_generated_image(
    response: Any,
):
    if response is None:
        raise RuntimeError(
            "Gemini returned no response."
        )

    try:
        parts = getattr(
            response,
            "parts",
            [],
        )

        for part in parts:
            if part is None:
                continue

            if getattr(
                part,
                "text",
                None,
            ):
                continue

            as_image = getattr(
                part,
                "as_image",
                None,
            )

            if callable(as_image):
                image = as_image()

                if image is not None:
                    return image

    except Exception:
        pass

    try:
        candidates = getattr(
            response,
            "candidates",
            None,
        )

        if candidates:
            for candidate in candidates:
                content = getattr(
                    candidate,
                    "content",
                    None,
                )

                if content is None:
                    continue

                for part in getattr(
                    content,
                    "parts",
                    [],
                ):
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

                    if inline_data is None:
                        continue

                    data = getattr(
                        inline_data,
                        "data",
                        None,
                    )

                    if data is not None:
                        return data

    except Exception:
        pass

    raise RuntimeError(
        "Gemini response did not contain a generated image."
    )


# ============================================================
# SAVE GENERATED IMAGE
# ============================================================

def save_generated_image(
    generated_image: Any,
    output_path: Path,
) -> None:

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
        return

    if isinstance(
        generated_image,
        bytes,
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
# OUTPUT PATH
# ============================================================

def get_scene_output_path(
    scene_id: str,
    angle: str,
) -> Path:

    normalized_angle = (
        angle_generator.validate_angle(
            angle
        )
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
        exist_ok=True,
    )

    return (
        scene_directory /
        filename
    )


# ============================================================
# GOOGLE DRIVE UPLOAD
# ============================================================

def upload_scene_image_to_drive(
    scene_id: str,
    image_path: Path,
) -> Dict[str, Any]:
    """
    Upload:

        GENERATED_SCENES/<scene_id>/<image>

    """

    if not SCENE_DRIVE_ROOT_FOLDER_ID:
        raise RuntimeError(
            "SCENE_DRIVE_ROOT_FOLDER_ID is missing and "
            "drive_folders.ROOT_FOLDER_ID is not configured."
        )

    image_path = Path(
        image_path
    )

    if not image_path.exists():
        raise FileNotFoundError(
            f"Generated scene image not found: {image_path}"
        )

    drive = drive_folders.get_drive_service()

    generated_root_id = (
        drive_folders.get_or_create_folder(
            drive,
            "GENERATED_SCENES",
            SCENE_DRIVE_ROOT_FOLDER_ID,
        )
    )

    scene_folder_id = (
        drive_folders.get_or_create_folder(
            drive,
            scene_id,
            generated_root_id,
        )
    )

    uploaded = (
        drive_folders.upload_file_to_folder(
            file_path=image_path,
            folder_id=scene_folder_id,
            filename=image_path.name,
        )
    )

    if not isinstance(
        uploaded,
        dict,
    ):
        raise RuntimeError(
            "Google Drive upload returned an invalid result."
        )

    file_id = uploaded.get(
        "id"
    )

    if not file_id:
        raise RuntimeError(
            "Google Drive upload succeeded but no file ID "
            "was returned."
        )

    return {
        "file_id": file_id,
        "name": uploaded.get(
            "name",
            image_path.name,
        ),
        "webViewLink": uploaded.get(
            "webViewLink",
            "",
        ),
        "folder_id": scene_folder_id,
        "folder_name": scene_id,
    }


# ============================================================
# GENERATE ONE SCENE ANGLE
# ============================================================

def generate_scene_angle(
    scene_id: str,
    angle: str,
) -> Dict[str, Any]:
    """
    Generate one angle.

    Order is intentionally:

        validate/load scene
        -> start generation
        -> Gemini
        -> save local
        -> Drive upload
        -> DATABASE COMPLETION
        -> return

    The database completion call is NOT skipped.
    """

    # --------------------------------------------------------
    # LOAD + LOCK SCENE
    # --------------------------------------------------------

    scene = load_locked_scene(
        scene_id
    )

    # --------------------------------------------------------
    # PREPARE ANGLE REQUEST
    # --------------------------------------------------------

    request = (
        angle_generator.prepare_angle_request(
            scene_id=scene_id,
            angle=angle,
        )
    )

    if not isinstance(
        request,
        dict,
    ):
        raise TypeError(
            "prepare_angle_request() must return a dictionary."
        )

    normalized_angle = (
        angle_generator.validate_angle(
            request.get(
                "angle",
                angle,
            )
        )
    )

    # --------------------------------------------------------
    # HARD PRODUCT LOCK
    # --------------------------------------------------------

    locked_products = list(
        scene["products"]
    )

    locked_product_ids = [
        product["product_id"]
        for product in locked_products
    ]

    request["scene_id"] = scene_id
    request["angle"] = normalized_angle
    request["scene"] = scene
    request["product_lock"] = True
    request["locked_products"] = locked_products
    request["locked_product_ids"] = (
        locked_product_ids
    )
    request["product_ids"] = (
        list(locked_product_ids)
    )

    request["camera"] = {
        **ANGLE_SPECS[normalized_angle],
    }

    request["prompt"] = (
        build_locked_scene_prompt(
            scene,
            request,
        )
    )

    # --------------------------------------------------------
    # OUTPUT PATH
    # --------------------------------------------------------

    output_path = (
        get_scene_output_path(
            scene_id,
            normalized_angle,
        )
    )

    # --------------------------------------------------------
    # START
    # --------------------------------------------------------

    angle_generator.start_angle_generation(
        scene_id,
        normalized_angle,
    )

    try:
        # ----------------------------------------------------
        # GEMINI CONTENTS
        # ----------------------------------------------------

        contents = build_image_contents(
            request
        )

        # ----------------------------------------------------
        # GEMINI IMAGE GENERATION
        # ----------------------------------------------------

        response = (
            client.models.generate_content(
                model=IMAGE_MODEL,
                contents=contents,
                config=types.GenerateContentConfig(
                    response_modalities=[
                        "IMAGE"
                    ],
                    image_config=types.ImageConfig(
                        aspect_ratio=(
                            OUTPUT_ASPECT_RATIO
                        ),
                        image_size=(
                            OUTPUT_IMAGE_SIZE
                        ),
                    ),
                ),
            )
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
            output_path,
        )

        if not output_path.exists():
            raise RuntimeError(
                "Generated image was not saved."
            )

        # ----------------------------------------------------
        # GOOGLE DRIVE UPLOAD
        # ----------------------------------------------------

        drive_file = (
            upload_scene_image_to_drive(
                scene_id=scene_id,
                image_path=output_path,
            )
        )

        drive_url = (
            drive_file.get(
                "webViewLink",
                "",
            )
        )

        if not drive_url:
            raise RuntimeError(
                "Google Drive upload did not return "
                "a webViewLink."
            )

        # ----------------------------------------------------
        # DATABASE COMPLETION
        # ----------------------------------------------------
        #
        # THIS IS THE FIX FOR THE CURRENT ERROR.
        #
        # Do not return before this call.
        # Do not hide this call inside an optional branch.
        # ----------------------------------------------------

        database_result = (
            angle_generator
            .complete_angle_generation(
                scene_id=scene_id,
                angle=normalized_angle,
                drive_url=drive_url,
            )
        )

        if database_result is None:
            # Some database implementations return None after
            # successfully writing. Treat that as a valid
            # completion only when the service explicitly has
            # such behavior.
            database_result = {
                "scene_id": scene_id,
                "angle": normalized_angle,
                "status": "GENERATED",
                "drive_url": drive_url,
            }

        # ----------------------------------------------------
        # FINAL RESULT
        # ----------------------------------------------------

        return {
            "scene_id": scene_id,
            "angle": normalized_angle,
            "status": "GENERATED",
            "product_lock": True,
            "locked_product_ids": (
                list(locked_product_ids)
            ),
            "image_path": str(
                output_path
            ),
            "drive_file_id": (
                drive_file.get(
                    "file_id"
                )
            ),
            "drive_url": drive_url,
            "drive_folder_id": (
                drive_file.get(
                    "folder_id"
                )
            ),
            "database": database_result,
        }

    except Exception as error:
        # ----------------------------------------------------
        # FAILURE STATE
        # ----------------------------------------------------

        try:
            angle_generator.fail_angle_generation(
                scene_id,
                normalized_angle,
            )
        except Exception:
            pass

        raise RuntimeError(
            "Scene angle generation failed: "
            f"{error}"
        ) from error


# ============================================================
# GENERATE ALL INITIAL ANGLES
# ============================================================

def generate_all_scene_angles(
    scene_id: str,
):
    """
    Generate:

        FRONT
        LEFT
        RIGHT
        WIDE
        SHOWER_CLOSEUP
    """

    angles = [
        "FRONT",
        "LEFT",
        "RIGHT",
        "WIDE",
        "SHOWER_CLOSEUP",
    ]

    results = []

    for angle in angles:
        results.append(
            generate_scene_angle(
                scene_id=scene_id,
                angle=angle,
            )
        )

    return results