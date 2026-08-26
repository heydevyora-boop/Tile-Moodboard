import json
import uuid
from typing import Any, Dict, Optional

from app import database


# ============================================================
# SCENE CONFIGURATION
# ============================================================

SUPPORTED_ANGLES = {
    "FRONT",
    "LEFT",
    "RIGHT",
    "WIDE",
    "SHOWER_CLOSEUP",
}


# ============================================================
# SCENE ID
# ============================================================

def generate_scene_id() -> str:
    """
    Generate a unique Scene ID.

    Example:
        SCENE_A81F42C9
    """

    return f"SCENE_{uuid.uuid4().hex[:8].upper()}"


# ============================================================
# SAFE VALUE HELPER
# ============================================================

def _safe_value(value: Any, default: str = "") -> str:
    """
    Convert a value safely into a string.

    None becomes an empty string.
    """

    if value is None:
        return default

    if isinstance(value, str):
        return value.strip()

    return str(value)


# ============================================================
# JSON SERIALIZATION HELPER
# ============================================================

def _to_json(value: Any) -> str:
    """
    Safely convert Python data into JSON.

    Used for storing requirements and product information
    inside SQLite.
    """

    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            default=str
        )
    except (TypeError, ValueError):
        return json.dumps(
            str(value),
            ensure_ascii=False
        )


# ============================================================
# PRODUCT EXTRACTION
# ============================================================

def _extract_products(final_design: Dict[str, Any]) -> Dict[str, Any]:
    """
    Extract selected products from the final bathroom design.

    The function intentionally supports multiple possible
    structures because the existing engines may represent
    products differently.
    """

    products = {}

    # --------------------------------------------------------
    # 1. Direct products field
    # --------------------------------------------------------

    direct_products = final_design.get("products")

    if isinstance(direct_products, dict):
        products.update(direct_products)

    # --------------------------------------------------------
    # 2. Surface products
    # --------------------------------------------------------

    surface_products = final_design.get("surface_products")

    if isinstance(surface_products, dict):
        products["surface_products"] = surface_products

    elif isinstance(surface_products, list):
        products["surface_products"] = surface_products

    # --------------------------------------------------------
    # 3. Fixtures
    # --------------------------------------------------------

    fixtures = final_design.get("fixtures")

    if isinstance(fixtures, dict):
        products["fixtures"] = fixtures

    elif isinstance(fixtures, list):
        products["fixtures"] = fixtures

    # --------------------------------------------------------
    # 4. Selected moodboard
    # --------------------------------------------------------

    selected_moodboard = final_design.get(
        "selected_moodboard"
    )

    if isinstance(selected_moodboard, dict):

        moodboard_products = selected_moodboard.get(
            "products"
        )

        if moodboard_products is not None:
            products["moodboard_products"] = (
                moodboard_products
            )

    return products


# ============================================================
# REQUIREMENTS EXTRACTION
# ============================================================

def _extract_requirements(
    final_design: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Extract client requirements from final design.
    """

    requirements = final_design.get(
        "requirements"
    )

    if isinstance(requirements, dict):
        return requirements

    return {}


# ============================================================
# ATTRIBUTE EXTRACTION
# ============================================================

def _find_value(
    final_design: Dict[str, Any],
    requirements: Dict[str, Any],
    *keys: str
) -> str:
    """
    Find an attribute from either final_design or
    requirements.

    The first non-empty value is returned.
    """

    for key in keys:

        value = final_design.get(key)

        if value not in (None, ""):
            return _safe_value(value)

        value = requirements.get(key)

        if value not in (None, ""):
            return _safe_value(value)

    return ""


# ============================================================
# BUILD LOCKED SCENE DATA
# ============================================================

def build_scene_data(
    final_design: Dict[str, Any],
    scene_id: Optional[str] = None
) -> Dict[str, Any]:
    """
    Convert the existing final bathroom design into a
    locked Scene object.

    This does NOT generate an image.

    It only creates the immutable scene definition.
    """

    if not isinstance(final_design, dict):
        raise ValueError(
            "final_design must be a dictionary"
        )

    if scene_id is None:
        scene_id = generate_scene_id()

    requirements = _extract_requirements(
        final_design
    )

    products = _extract_products(
        final_design
    )

    selected_moodboard = final_design.get(
        "selected_moodboard"
    )

    moodboard_id = ""

    if isinstance(selected_moodboard, dict):

        moodboard_id = _safe_value(
            selected_moodboard.get(
                "moodboard_id"
            )
        )

    # --------------------------------------------------------
    # Extract locked attributes
    # --------------------------------------------------------

    layout = _find_value(
        final_design,
        requirements,
        "layout",
        "bathroom_layout",
        "space_layout"
    )

    shower = _find_value(
        final_design,
        requirements,
        "shower",
        "shower_type",
        "shower_configuration"
    )

    partition = _find_value(
        final_design,
        requirements,
        "partition",
        "shower_partition",
        "partition_type"
    )

    style = _find_value(
        final_design,
        requirements,
        "style",
        "design_style",
        "preferred_style"
    )

    colors = _find_value(
        final_design,
        requirements,
        "colors",
        "color",
        "primary_color",
        "colour"
    )

    finishes = _find_value(
        final_design,
        requirements,
        "finishes",
        "finish"
    )

    return {
        "scene_id": scene_id,

        "moodboard_id": moodboard_id,

        "requirements": requirements,

        "products": products,

        "layout": layout,

        "shower": shower,

        "partition": partition,

        "style": style,

        "colors": colors,

        "finishes": finishes,

        "status": "ACTIVE",
    }


# ============================================================
# SAVE SCENE
# ============================================================

def save_scene(
    scene: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Save a locked scene to the scenes table.
    """

    if not isinstance(scene, dict):
        raise ValueError(
            "scene must be a dictionary"
        )

    scene_id = _safe_value(
        scene.get("scene_id")
    )

    if not scene_id:
        raise ValueError(
            "scene_id is required"
        )

    connection = database.get_connection()

    cursor = connection.cursor()

    cursor.execute(
        """
        INSERT INTO scenes (
            scene_id,
            moodboard_id,
            requirements_json,
            products_json,
            layout,
            shower,
            partition,
            style,
            colors,
            finishes,
            status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            scene_id,

            _safe_value(
                scene.get("moodboard_id")
            ),

            _to_json(
                scene.get("requirements", {})
            ),

            _to_json(
                scene.get("products", {})
            ),

            _safe_value(
                scene.get("layout")
            ),

            _safe_value(
                scene.get("shower")
            ),

            _safe_value(
                scene.get("partition")
            ),

            _safe_value(
                scene.get("style")
            ),

            _safe_value(
                scene.get("colors")
            ),

            _safe_value(
                scene.get("finishes")
            ),

            _safe_value(
                scene.get("status"),
                "ACTIVE"
            ),
        )
    )

    connection.commit()
    connection.close()

    return scene


# ============================================================
# CREATE + SAVE SCENE
# ============================================================

def create_scene(
    final_design: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Create and save a new locked bathroom scene.

    This is the main function that will later be called
    after the user selects a final moodboard.
    """

    scene = build_scene_data(
        final_design
    )

    save_scene(scene)

    return scene


# ============================================================
# GET SCENE
# ============================================================

def get_scene(
    scene_id: str
) -> Optional[Dict[str, Any]]:
    """
    Retrieve a locked scene from the database.
    """

    scene_id = _safe_value(scene_id)

    if not scene_id:
        return None

    connection = database.get_connection()

    cursor = connection.cursor()

    cursor.execute(
        """
        SELECT
            scene_id,
            moodboard_id,
            requirements_json,
            products_json,
            layout,
            shower,
            partition,
            style,
            colors,
            finishes,
            created_at,
            status
        FROM scenes
        WHERE scene_id = ?
        """,
        (scene_id,)
    )

    row = cursor.fetchone()

    connection.close()

    if row is None:
        return None

    (
        scene_id,
        moodboard_id,
        requirements_json,
        products_json,
        layout,
        shower,
        partition,
        style,
        colors,
        finishes,
        created_at,
        status,
    ) = row

    try:
        requirements = json.loads(
            requirements_json or "{}"
        )
    except (json.JSONDecodeError, TypeError):
        requirements = {}

    try:
        products = json.loads(
            products_json or "{}"
        )
    except (json.JSONDecodeError, TypeError):
        products = {}

    return {
        "scene_id": scene_id,

        "moodboard_id": moodboard_id,

        "requirements": requirements,

        "products": products,

        "layout": layout,

        "shower": shower,

        "partition": partition,

        "style": style,

        "colors": colors,

        "finishes": finishes,

        "created_at": created_at,

        "status": status,
    }


# ============================================================
# CHECK SCENE
# ============================================================

def scene_exists(
    scene_id: str
) -> bool:
    """
    Check whether a scene exists.
    """

    return get_scene(scene_id) is not None


# ============================================================
# LOCK SCENE
# ============================================================

def lock_scene(
    scene_id: str
) -> bool:
    """
    Mark a scene as LOCKED.

    Once locked, angle generation should only use this
    existing scene and must not replace its products.
    """

    connection = database.get_connection()

    cursor = connection.cursor()

    cursor.execute(
        """
        UPDATE scenes
        SET status = 'LOCKED'
        WHERE scene_id = ?
        """,
        (scene_id,)
    )

    updated = cursor.rowcount > 0

    connection.commit()
    connection.close()

    return updated


# ============================================================
# CHECK ANGLE
# ============================================================

def is_supported_angle(
    angle: str
) -> bool:
    """
    Check whether an angle is supported.
    """

    if not isinstance(angle, str):
        return False

    return angle.strip().upper() in SUPPORTED_ANGLES


# ============================================================
# SAVE ANGLE RECORD
# ============================================================

def save_angle(
    scene_id: str,
    angle: str,
    drive_url: str = "",
    status: str = "GENERATED"
) -> Dict[str, Any]:
    """
    Save a generated angle against an existing scene.

    The scene itself is never modified here.
    """

    scene = get_scene(scene_id)

    if scene is None:
        raise ValueError(
            f"Scene not found: {scene_id}"
        )

    angle = _safe_value(
        angle
    ).upper()

    if not is_supported_angle(angle):
        raise ValueError(
            f"Unsupported angle: {angle}"
        )

    connection = database.get_connection()

    cursor = connection.cursor()

    cursor.execute(
        """
        INSERT INTO scene_angles (
            scene_id,
            angle,
            drive_url,
            status
        )
        VALUES (?, ?, ?, ?)

        ON CONFLICT(scene_id, angle)
        DO UPDATE SET
            drive_url = excluded.drive_url,
            status = excluded.status
        """,
        (
            scene_id,
            angle,
            _safe_value(drive_url),
            _safe_value(
                status,
                "GENERATED"
            ),
        )
    )

    connection.commit()
    connection.close()

    return {
        "scene_id": scene_id,
        "angle": angle,
        "drive_url": drive_url,
        "status": status,
    }


# ============================================================
# GET ANGLE
# ============================================================

def get_angle(
    scene_id: str,
    angle: str
) -> Optional[Dict[str, Any]]:
    """
    Retrieve one generated angle.
    """

    angle = _safe_value(
        angle
    ).upper()

    connection = database.get_connection()

    cursor = connection.cursor()

    cursor.execute(
        """
        SELECT
            scene_id,
            angle,
            drive_url,
            status,
            created_at
        FROM scene_angles
        WHERE scene_id = ?
          AND angle = ?
        """,
        (
            scene_id,
            angle
        )
    )

    row = cursor.fetchone()

    connection.close()

    if row is None:
        return None

    return {
        "scene_id": row[0],
        "angle": row[1],
        "drive_url": row[2],
        "status": row[3],
        "created_at": row[4],
    }


# ============================================================
# GET ALL ANGLES
# ============================================================

def get_scene_angles(
    scene_id: str
):
    """
    Return all generated angles for a scene.
    """

    connection = database.get_connection()

    cursor = connection.cursor()

    cursor.execute(
        """
        SELECT
            scene_id,
            angle,
            drive_url,
            status,
            created_at
        FROM scene_angles
        WHERE scene_id = ?
        ORDER BY id
        """,
        (scene_id,)
    )

    rows = cursor.fetchall()

    connection.close()

    return [
        {
            "scene_id": row[0],
            "angle": row[1],
            "drive_url": row[2],
            "status": row[3],
            "created_at": row[4],
        }
        for row in rows
    ]