import json
from typing import Any, Dict, Optional

from app import angle_config
from app import scene_manager


# ============================================================
# ANGLE GENERATOR
# ============================================================
#
# IMPORTANT:
#
# This module works ONLY with an existing locked Scene.
#
# It must NEVER:
#   - select new products
#   - replace products
#   - redesign the bathroom
#   - change tiles
#   - change sanitary fixtures
#   - change faucets
#   - change basin
#   - change WC
#   - change shower
#   - change partition
#   - change colors
#   - change finishes
#   - change layout
#
# It only changes:
#   - Camera position
#   - Camera angle
#   - Framing
#   - Field of view
#
# ============================================================


# ============================================================
# IMMUTABLE SCENE INSTRUCTION
# ============================================================

SCENE_LOCK_INSTRUCTION = """
PRESERVE THE EXACT EXISTING BATHROOM SCENE.

The selected bathroom is already locked.

You MUST preserve:

- Exact selected products
- Exact product identities
- Exact floor products
- Exact wall products
- Exact highlight products
- Exact basin
- Exact faucet
- Exact WC
- Exact flush plate
- Exact shower
- Exact shower configuration
- Exact shower partition
- Exact bathroom layout
- Exact architectural configuration
- Exact colors
- Exact materials
- Exact finishes
- Exact tile patterns
- Exact product placement
- Exact sanitary fixture placement

DO NOT:

- Select new products
- Replace products
- Add products
- Remove products
- Change products
- Redesign the bathroom
- Change the layout
- Change materials
- Change colors
- Change finishes
- Change sanitary fixtures
- Change faucets
- Change basin
- Change WC
- Change shower
- Change partition

ONLY CHANGE:

- Camera position
- Camera viewing angle
- Camera framing
- Field of view

The requested output must represent the SAME bathroom scene,
not a newly designed bathroom.
""".strip()


# ============================================================
# SCENE VALIDATION
# ============================================================

def validate_scene(scene_id: str) -> Dict[str, Any]:
    """
    Load and validate an existing Scene.

    Angle generation is not allowed without a valid Scene.
    """

    if not isinstance(scene_id, str):
        raise ValueError(
            "scene_id must be a string."
        )

    scene_id = scene_id.strip()

    if not scene_id:
        raise ValueError(
            "scene_id is required."
        )

    scene = scene_manager.get_scene(
        scene_id
    )

    if scene is None:
        raise ValueError(
            f"Scene not found: {scene_id}"
        )

    return scene


# ============================================================
# ANGLE VALIDATION
# ============================================================

def validate_angle(angle: str) -> str:
    """
    Normalize and validate the requested angle.
    """

    normalized = angle_config.normalize_angle(
        angle
    )

    if not normalized:
        raise ValueError(
            f"Unsupported angle: {angle}"
        )

    return normalized


# ============================================================
# BUILD LOCKED PRODUCT DESCRIPTION
# ============================================================

def build_locked_scene_description(
    scene: Dict[str, Any]
) -> str:
    """
    Convert the locked Scene into a structured description.

    This description is used as context for the image
    generation layer.
    """

    products = scene.get(
        "products",
        {}
    )

    requirements = scene.get(
        "requirements",
        {}
    )

    scene_description = {

        "scene_id": scene.get(
            "scene_id"
        ),

        "moodboard_id": scene.get(
            "moodboard_id"
        ),

        "layout": scene.get(
            "layout"
        ),

        "shower": scene.get(
            "shower"
        ),

        "partition": scene.get(
            "partition"
        ),

        "style": scene.get(
            "style"
        ),

        "colors": scene.get(
            "colors"
        ),

        "finishes": scene.get(
            "finishes"
        ),

        "requirements": requirements,

        "locked_products": products,
    }

    return json.dumps(
        scene_description,
        indent=2,
        ensure_ascii=False,
        default=str
    )


# ============================================================
# BUILD ANGLE PROMPT
# ============================================================

def build_angle_prompt(
    scene: Dict[str, Any],
    angle: str
) -> str:
    """
    Build the prompt used by the future image-generation
    service.

    This function does NOT call Gemini.
    """

    normalized_angle = validate_angle(
        angle
    )

    config = angle_config.get_angle_config(
        normalized_angle
    )

    locked_scene = build_locked_scene_description(
        scene
    )

    prompt = f"""
You are generating another camera view of an EXISTING
LOCKED bathroom scene.

SCENE ID:
{scene["scene_id"]}

REQUESTED VIEW:
{config["name"]}

CAMERA POSITION:
{config["camera_position"]}

CAMERA ANGLE:
{config["camera_angle"]}

FRAMING:
{config["framing"]}

FIELD OF VIEW:
{config["field_of_view"]}

ANGLE-SPECIFIC INSTRUCTION:
{config["prompt_instruction"]}


LOCKED SCENE DATA:
{locked_scene}


STRICT SCENE LOCK:
{SCENE_LOCK_INSTRUCTION}


FINAL REQUIREMENT:

Generate the SAME bathroom shown in the locked scene.

Do not redesign it.

Only change the camera viewpoint according to the requested
angle.
""".strip()

    return prompt


# ============================================================
# PREPARE ANGLE REQUEST
# ============================================================

def prepare_angle_request(
    scene_id: str,
    angle: str
) -> Dict[str, Any]:
    """
    Prepare everything required for an angle-generation request.

    This does not call the AI image generator yet.
    """

    scene = validate_scene(
        scene_id
    )

    normalized_angle = validate_angle(
        angle
    )

    prompt = build_angle_prompt(
        scene,
        normalized_angle
    )

    return {

        "scene_id": scene_id,

        "angle": normalized_angle,

        "prompt": prompt,

        "scene": scene,

        "angle_config": angle_config.get_angle_config(
            normalized_angle
        ),

        "status": "READY",
    }


# ============================================================
# START ANGLE GENERATION
# ============================================================

def start_angle_generation(
    scene_id: str,
    angle: str
) -> Dict[str, Any]:
    """
    Start an angle request.

    At this stage the function prepares the request and
    creates the database record.

    Actual AI image generation will be connected in the
    next step.
    """

    request = prepare_angle_request(
        scene_id,
        angle
    )

    # --------------------------------------------------------
    # Store generation state
    # --------------------------------------------------------

    scene_manager.save_angle(
        scene_id=request["scene_id"],
        angle=request["angle"],
        drive_url="",
        status="GENERATING",
    )

    request["status"] = "GENERATING"

    return request


# ============================================================
# COMPLETE ANGLE GENERATION
# ============================================================

def complete_angle_generation(
    scene_id: str,
    angle: str,
    drive_url: str
) -> Dict[str, Any]:
    """
    Mark an angle as successfully generated.

    The actual image must already have been generated and
    uploaded by the image-generation/storage layer.
    """

    normalized_angle = validate_angle(
        angle
    )

    scene = validate_scene(
        scene_id
    )

    result = scene_manager.save_angle(
        scene_id=scene["scene_id"],
        angle=normalized_angle,
        drive_url=drive_url,
        status="GENERATED",
    )

    return result


# ============================================================
# FAIL ANGLE GENERATION
# ============================================================

def fail_angle_generation(
    scene_id: str,
    angle: str
) -> Dict[str, Any]:
    """
    Mark an angle generation request as failed.
    """

    normalized_angle = validate_angle(
        angle
    )

    scene = validate_scene(
        scene_id
    )

    return scene_manager.save_angle(
        scene_id=scene["scene_id"],
        angle=normalized_angle,
        drive_url="",
        status="FAILED",
    )


# ============================================================
# GET EXISTING ANGLE
# ============================================================

def get_generated_angle(
    scene_id: str,
    angle: str
) -> Optional[Dict[str, Any]]:
    """
    Return an existing generated angle.
    """

    normalized_angle = validate_angle(
        angle
    )

    validate_scene(
        scene_id
    )

    return scene_manager.get_angle(
        scene_id,
        normalized_angle
    )