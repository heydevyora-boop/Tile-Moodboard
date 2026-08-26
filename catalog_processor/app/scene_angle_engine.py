from pathlib import Path

import json
import hashlib
from datetime import datetime, timezone
from typing import Any, Dict, List


# ============================================================
# SUPPORTED SCENE ANGLES
# ============================================================

ANGLE_TYPES = [
    "FRONT",
    "LEFT",
    "RIGHT",
    "WIDE",
    "SHOWER_CLOSEUP",
]


# ============================================================
# SCENE ID
# ============================================================

def _scene_id(scene: Dict[str, Any]) -> str:
    """
    Return the scene ID.

    The scene_id is required for deterministic angle IDs.
    """

    return str(
        scene.get(
            "scene_id",
            ""
        )
    ).strip()


# ============================================================
# BUILD DETERMINISTIC ANGLE ID
# ============================================================

def _build_angle_id(
    scene_id: str,
    angle_type: str
) -> str:
    """
    Build a deterministic unique angle ID.
    """

    raw = (
        f"{scene_id}|{angle_type}"
    )

    digest = hashlib.sha1(
        raw.encode("utf-8")
    ).hexdigest()[:12]

    return (
        f"ANGLE_{digest}"
    )


# ============================================================
# EXTRACT LOCKED PRODUCT IDS
# ============================================================

def _extract_locked_product_ids(
    scene: Dict[str, Any]
) -> List[str]:
    """
    Extract locked product IDs from the scene.

    Supported scene structures:

    1. Preferred:
       scene["products"] = [
           {
               "product_id": "TEST-P001",
               ...
           }
       ]

    2. Also supported:
       scene["product_ids"] = [
           "TEST-P001",
           "TEST-P002"
       ]

    The products list is authoritative when available.
    """

    # --------------------------------------------------------
    # FIRST: USE LOCKED PRODUCTS
    # --------------------------------------------------------

    products = scene.get(
        "products",
        []
    )

    if isinstance(
        products,
        list
    ) and products:

        product_ids = []

        for product in products:

            # Product should normally be a dictionary.
            if isinstance(
                product,
                dict
            ):

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

            # Also allow a direct product ID string.
            elif isinstance(
                product,
                str
            ):

                product_id = (
                    product.strip()
                )

                if product_id:
                    product_ids.append(
                        product_id
                    )

        # Remove duplicates while preserving order.
        product_ids = list(
            dict.fromkeys(
                product_ids
            )
        )

        if product_ids:
            return product_ids

    # --------------------------------------------------------
    # FALLBACK: scene.product_ids
    # --------------------------------------------------------

    product_ids = scene.get(
        "product_ids",
        []
    )

    if isinstance(
        product_ids,
        list
    ):

        cleaned_ids = []

        for product_id in product_ids:

            value = str(
                product_id
            ).strip()

            if value:
                cleaned_ids.append(
                    value
                )

        # Remove duplicates while preserving order.
        return list(
            dict.fromkeys(
                cleaned_ids
            )
        )

    return []


# ============================================================
# CAMERA SPECIFICATIONS
# ============================================================

CAMERA_SPECS = {

    "FRONT": {

        "camera_position":
            "front",

        "camera_direction":
            "straight_on",

        "framing":
            "balanced",

        "purpose":
            "primary product presentation",
    },

    "LEFT": {

        "camera_position":
            "left",

        "camera_direction":
            "three_quarter_left",

        "framing":
            "medium",

        "purpose":
            "left-side product presentation",
    },

    "RIGHT": {

        "camera_position":
            "right",

        "camera_direction":
            "three_quarter_right",

        "framing":
            "medium",

        "purpose":
            "right-side product presentation",
    },

    "WIDE": {

        "camera_position":
            "far",

        "camera_direction":
            "straight_on",

        "framing":
            "wide",

        "purpose":
            "complete scene presentation",
    },

    "SHOWER_CLOSEUP": {

        "camera_position":
            "near",

        "camera_direction":
            "detail",

        "framing":
            "close",

        "purpose":
            "shower and product detail presentation",
    },
}


# ============================================================
# BUILD SCENE ANGLES
# ============================================================

def build_scene_angles(
    scene: Dict[str, Any]
) -> List[Dict[str, Any]]:
    """
    Generate deterministic camera-angle specifications.

    IMPORTANT:

    The locked product list is copied unchanged into every
    angle.

    This function does NOT:

    - create products
    - remove products
    - replace products
    - modify product IDs
    - change the locked scene

    The scene's locked products remain the source of truth.
    """

    # --------------------------------------------------------
    # VALIDATE SCENE
    # --------------------------------------------------------

    if not isinstance(
        scene,
        dict
    ):

        raise ValueError(
            "scene must be a dictionary"
        )

    # --------------------------------------------------------
    # GET SCENE ID
    # --------------------------------------------------------

    scene_id = _scene_id(
        scene
    )

    if not scene_id:

        raise ValueError(
            "scene_id is required"
        )

    # --------------------------------------------------------
    # GET LOCKED PRODUCT IDS
    # --------------------------------------------------------

    locked_product_ids = (
        _extract_locked_product_ids(
            scene
        )
    )

    # --------------------------------------------------------
    # PRODUCT LOCK IS REQUIRED
    # --------------------------------------------------------

    product_lock = scene.get(
        "product_lock",
        True
    )

    if product_lock is not True:

        raise ValueError(
            "Cannot generate scene angles "
            "because product_lock is not True"
        )

    # --------------------------------------------------------
    # PRODUCTS ARE REQUIRED
    # --------------------------------------------------------

    if not locked_product_ids:

        raise ValueError(
            "Cannot generate scene angles "
            "without locked products"
        )

    # --------------------------------------------------------
    # BUILD ANGLES
    # --------------------------------------------------------

    angles = []

    for angle_type in ANGLE_TYPES:

        spec = CAMERA_SPECS.get(
            angle_type
        )

        if spec is None:

            raise ValueError(
                f"Missing camera specification "
                f"for angle: {angle_type}"
            )

        angle = {

            # ------------------------------------------------
            # IDENTIFICATION
            # ------------------------------------------------

            "angle_id":
                _build_angle_id(
                    scene_id,
                    angle_type
                ),

            "scene_id":
                scene_id,

            "angle_type":
                angle_type,

            # ------------------------------------------------
            # LOCKED PRODUCTS
            # ------------------------------------------------

            "product_ids":
                list(
                    locked_product_ids
                ),

            "locked_product_ids":
                list(
                    locked_product_ids
                ),

            "product_lock":
                True,

            # ------------------------------------------------
            # CAMERA
            # ------------------------------------------------

            "camera": {

                "position":
                    spec[
                        "camera_position"
                    ],

                "direction":
                    spec[
                        "camera_direction"
                    ],

                "framing":
                    spec[
                        "framing"
                    ],
            },

            # ------------------------------------------------
            # PURPOSE
            # ------------------------------------------------

            "purpose":
                spec[
                    "purpose"
                ],

            # ------------------------------------------------
            # TIMESTAMP
            # ------------------------------------------------

            "created_at":
                datetime.now(
                    timezone.utc
                ).isoformat(),
        }

        angles.append(
            angle
        )

    # --------------------------------------------------------
    # FINAL VALIDATION
    # --------------------------------------------------------

    if len(angles) != len(
        ANGLE_TYPES
    ):

        raise RuntimeError(
            "Scene angle generation produced "
            f"{len(angles)} angles instead of "
            f"{len(ANGLE_TYPES)}."
        )

    # Make absolutely sure every angle has the same locked
    # products.

    for angle in angles:

        if angle.get(
            "product_ids"
        ) != locked_product_ids:

            raise RuntimeError(
                "Product lock violation detected "
                f"for angle {angle.get('angle_type')}"
            )

        if angle.get(
            "locked_product_ids"
        ) != locked_product_ids:

            raise RuntimeError(
                "Locked product list mismatch detected "
                f"for angle {angle.get('angle_type')}"
            )

        if angle.get(
            "product_lock"
        ) is not True:

            raise RuntimeError(
                "Product lock was lost for "
                f"angle {angle.get('angle_type')}"
            )

    return angles


# ============================================================
# SAVE SCENE ANGLES
# ============================================================

def save_scene_angles(
    scene: Dict[str, Any],
    output_dir
) -> Path:
    """
    Build and save all locked scene angles.

    Output:

        scene_angles.json
    """

    # --------------------------------------------------------
    # VALIDATE INPUT
    # --------------------------------------------------------

    if not isinstance(
        scene,
        dict
    ):

        raise ValueError(
            "scene must be a dictionary"
        )

    output_dir = Path(
        output_dir
    )

    output_dir.mkdir(
        parents=True,
        exist_ok=True
    )

    # --------------------------------------------------------
    # EXTRACT LOCKED PRODUCTS
    # --------------------------------------------------------

    locked_product_ids = (
        _extract_locked_product_ids(
            scene
        )
    )

    if not locked_product_ids:

        raise ValueError(
            "Cannot save scene angles "
            "without locked products"
        )

    # --------------------------------------------------------
    # BUILD ANGLES
    # --------------------------------------------------------

    angles = build_scene_angles(
        scene
    )

    # --------------------------------------------------------
    # OUTPUT PATH
    # --------------------------------------------------------

    output_path = (
        output_dir /
        "scene_angles.json"
    )

    # --------------------------------------------------------
    # BUILD PAYLOAD
    # --------------------------------------------------------

    payload = {

        "scene_id":
            scene[
                "scene_id"
            ],

        "product_lock":
            True,

        "locked_product_ids":
            list(
                locked_product_ids
            ),

        "angle_count":
            len(angles),

        "angles":
            angles,

        "created_at":
            datetime.now(
                timezone.utc
            ).isoformat(),
    }

    # --------------------------------------------------------
    # WRITE JSON
    # --------------------------------------------------------

    output_path.write_text(

        json.dumps(
            payload,
            indent=2,
            ensure_ascii=False
        ),

        encoding="utf-8"
    )

    return output_path


# ============================================================
# LOAD SAVED SCENE ANGLES
# ============================================================

def load_scene_angles(
    scene_angles_path
) -> Dict[str, Any]:
    """
    Load a previously generated scene_angles.json file.
    """

    path = Path(
        scene_angles_path
    )

    if not path.exists():

        raise FileNotFoundError(
            f"Scene angles file not found: {path}"
        )

    try:

        payload = json.loads(
            path.read_text(
                encoding="utf-8"
            )
        )

    except json.JSONDecodeError as error:

        raise ValueError(
            f"Invalid scene_angles.json: {path}"
        ) from error

    if not isinstance(
        payload,
        dict
    ):

        raise ValueError(
            "scene_angles.json must contain "
            "a JSON object"
        )

    return payload


# ============================================================
# VALIDATE SAVED SCENE ANGLES
# ============================================================

def validate_scene_angles(
    angles: List[Dict[str, Any]],
    locked_product_ids: List[str]
) -> bool:
    """
    Validate that all generated angles preserve
    the exact locked product list.
    """

    if not isinstance(
        angles,
        list
    ):

        raise ValueError(
            "angles must be a list"
        )

    if not isinstance(
        locked_product_ids,
        list
    ):

        raise ValueError(
            "locked_product_ids must be a list"
        )

    expected_products = list(
        dict.fromkeys(
            str(product_id).strip()
            for product_id in locked_product_ids
            if str(product_id).strip()
        )
    )

    if not expected_products:

        raise ValueError(
            "locked_product_ids cannot be empty"
        )

    if len(angles) != len(
        ANGLE_TYPES
    ):

        raise ValueError(
            f"Expected {len(ANGLE_TYPES)} scene angles, "
            f"found {len(angles)}"
        )

    found_angle_types = []

    for angle in angles:

        if not isinstance(
            angle,
            dict
        ):

            raise ValueError(
                "Each scene angle must be a dictionary"
            )

        angle_type = angle.get(
            "angle_type"
        )

        if angle_type not in ANGLE_TYPES:

            raise ValueError(
                f"Unsupported angle type: {angle_type}"
            )

        found_angle_types.append(
            angle_type
        )

        if angle.get(
            "product_lock"
        ) is not True:

            raise ValueError(
                f"Product lock missing for "
                f"{angle_type}"
            )

        angle_products = angle.get(
            "product_ids",
            []
        )

        if angle_products != expected_products:

            raise ValueError(
                f"Product lock mismatch for "
                f"{angle_type}. "
                f"Expected {expected_products}, "
                f"found {angle_products}"
            )

        locked_products = angle.get(
            "locked_product_ids",
            []
        )

        if locked_products != expected_products:

            raise ValueError(
                f"Locked product mismatch for "
                f"{angle_type}"
            )

    if set(found_angle_types) != set(
        ANGLE_TYPES
    ):

        raise ValueError(
            "Scene angles do not contain "
            "the complete supported angle set"
        )

    return True


# ============================================================
# MODULE TEST
# ============================================================

if __name__ == "__main__":

    print("=" * 70)
    print("SCENE ANGLE ENGINE TEST")
    print("=" * 70)

    test_scene = {

        "scene_id":
            "TEST_SCENE_001",

        "product_lock":
            True,

        "products": [

            {
                "product_id":
                    "TEST-P001",

                "product_name":
                    "Test Product 1",
            },

            {
                "product_id":
                    "TEST-P002",

                "product_name":
                    "Test Product 2",
            },

            {
                "product_id":
                    "TEST-P003",

                "product_name":
                    "Test Product 3",
            },
        ],
    }

    try:

        angles = build_scene_angles(
            test_scene
        )

        validate_scene_angles(
            angles,
            [
                "TEST-P001",
                "TEST-P002",
                "TEST-P003",
            ]
        )

        print()
        print(
            "[PASS] Scene angle generation successful."
        )

        print(
            f"[PASS] Angles generated: {len(angles)}"
        )

        for angle in angles:

            print(
                f"  - {angle['angle_type']}: "
                f"{angle['angle_id']}"
            )

        print()
        print(
            "[PASS] Product lock preserved "
            "across all angles."
        )

        print()
        print("=" * 70)

    except Exception as error:

        print()
        print(
            "[FAIL] Scene angle engine test failed:"
        )

        print(
            error
        )

        raise