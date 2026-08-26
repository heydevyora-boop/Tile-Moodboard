from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import List, Dict, Any
import hashlib
import json


SCENE_ANGLES = (
    "FRONT",
    "LEFT",
    "RIGHT",
    "WIDE",
    "CLOSE_UP",
)


@dataclass
class SceneProduct:
    product_id: str
    product_name: str
    brand: str = ""
    product_code: str = ""
    dimensions: str = ""
    drive_url: str = ""


@dataclass
class Scene:
    scene_id: str
    scene_type: str
    products: List[SceneProduct]
    created_at: str


def create_scene_id(
    brand: str,
    catalog: str,
    scene_type: str,
    products: List[Dict[str, Any]],
) -> str:

    product_ids = sorted(
        str(product.get("product_id", "")).strip()
        for product in products
        if product.get("product_id")
    )

    raw = "|".join([
        str(brand).strip().lower(),
        str(catalog).strip().lower(),
        str(scene_type).strip().upper(),
        ",".join(product_ids),
    ])

    digest = hashlib.sha256(
        raw.encode("utf-8")
    ).hexdigest()[:16]

    return f"SCENE_{digest.upper()}"


def lock_scene_products(
    products: List[Dict[str, Any]],
) -> List[SceneProduct]:

    locked = []

    for product in products:

        product_id = str(
            product.get("product_id", "")
        ).strip()

        if not product_id:
            continue

        locked.append(
            SceneProduct(
                product_id=product_id,
                product_name=str(
                    product.get(
                        "product_name",
                        ""
                    )
                ).strip(),
                brand=str(
                    product.get(
                        "brand",
                        ""
                    )
                ).strip(),
                product_code=str(
                    product.get(
                        "product_code",
                        ""
                    )
                ).strip(),
                dimensions=str(
                    product.get(
                        "dimensions",
                        ""
                    )
                ).strip(),
                drive_url=str(
                    product.get(
                        "drive_url",
                        ""
                    )
                ).strip(),
            )
        )

    # Stable ordering
    locked.sort(
        key=lambda item: item.product_id
    )

    return locked


def create_scene(
    brand: str,
    catalog: str,
    products: List[Dict[str, Any]],
    scene_type: str = "BATHROOM",
) -> Scene:

    scene_type = (
        str(scene_type)
        .strip()
        .upper()
    )

    locked_products = lock_scene_products(
        products
    )

    if not locked_products:
        raise ValueError(
            "Cannot create a scene without products."
        )

    scene_id = create_scene_id(
        brand,
        catalog,
        scene_type,
        [
            asdict(product)
            for product in locked_products
        ],
    )

    return Scene(
        scene_id=scene_id,
        scene_type=scene_type,
        products=locked_products,
        created_at=datetime.now(
            timezone.utc
        ).isoformat(),
    )


def create_scene_angles(
    scene: Scene,
) -> Dict[str, Dict[str, Any]]:

    angles = {}

    for angle in SCENE_ANGLES:

        angles[angle] = {
            "scene_id": scene.scene_id,
            "scene_type": scene.scene_type,
            "angle": angle,

            # IMPORTANT:
            # Always use the exact same locked
            # product list.
            "products": [
                asdict(product)
                for product in scene.products
            ],

            "product_lock": True,

            "camera_instruction": (
                get_camera_instruction(angle)
            ),
        }

    return angles


def get_camera_instruction(
    angle: str,
) -> str:

    instructions = {

        "FRONT":
            "Straight-on front camera view.",

        "LEFT":
            "Camera positioned toward the "
            "left side of the scene.",

        "RIGHT":
            "Camera positioned toward the "
            "right side of the scene.",

        "WIDE":
            "Wide-angle view showing the "
            "complete bathroom environment.",

        "CLOSE_UP":
            "Closer camera view highlighting "
            "the selected products.",
    }

    return instructions.get(
        angle,
        instructions["FRONT"]
    )


def scene_to_dict(
    scene: Scene,
) -> Dict[str, Any]:

    return asdict(scene)


def save_scene(
    scene: Scene,
    output_path: str,
) -> None:

    with open(
        output_path,
        "w",
        encoding="utf-8",
    ) as file:

        json.dump(
            scene_to_dict(scene),
            file,
            indent=4,
            ensure_ascii=False,
        )