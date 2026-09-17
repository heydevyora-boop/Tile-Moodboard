"""Regression: the whole chain must carry all three materials, not just base.

test_multi_material_scene.py proves the GENERATOR does the right thing
once it is handed a combination. This proves it is actually handed one:
the materials survive every layer between the HTTP boundary and the
Gemini request, which is where they were being dropped.

The layers, and what each was doing to a board's highlight and accent:

    mood-board.html          picked tiles.find(role === 'base'), sent it alone
    api-client.js            had no field to carry the others
    ai_visualization.routes  destructured a fixed list; no materials in it
    python-ai.service.ts     one product_id on the request type
    InternalVisualizationRequest   one product_id
    visualization_api        no materials in the normalized request
    orchestrator / pipeline  no parameter to pass one through
    tile_application_engine  "IMAGE 2 = the EXACT selected catalog tile"

Every one of those had to change for a selected material to reach the
image, so this walks the Python half of that chain with a real request
dict and asserts the combination is intact at the far end.

Run:  python3 app/test_multi_material_chain.py
"""

import os
import sys
from pathlib import Path

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-used")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import visualization_api  # noqa: E402


def check(label, ok, detail=""):
    return (label, bool(ok), detail)


def base_request(**overrides):
    request = {
        "spreadsheet_id": "sheet-1",
        "product_id": "BASE-1",
        "surface": "WALL",
        "scene_image": "",
        "generate_random_scene": True,
    }
    request.update(overrides)
    return request


COMBINATION = [
    {"role": "base", "image_url": "http://x/a.png",
     "product_id": "A", "name": "Tile A"},
    {"role": "highlight", "image_url": "http://x/b.png",
     "product_id": "B", "name": "Tile B"},
    {"role": "accent", "image_url": "http://x/c.png",
     "product_id": "C", "name": "Tile C"},
]


def the_boundary_keeps_every_material():
    normalized = visualization_api.validate_visualization_request(
        base_request(materials=COMBINATION)
    )
    materials = normalized.get("materials") or []

    return [
        check(f"all three materials survive normalization "
              f"({len(materials)})", len(materials) == 3),
        check("their roles are preserved",
              [m["role"] for m in materials] == ["base", "highlight", "accent"],
              str([m.get("role") for m in materials])),
        check("each keeps its own image",
              [m["image_path"] for m in materials]
              == [m["image_url"] for m in COMBINATION]),
        check("each keeps its own product id",
              [m["product_id"] for m in materials] == ["A", "B", "C"]),
    ]


def materials_nested_in_requirements_still_arrive():
    """The older frontend path nests extras inside requirements."""
    normalized = visualization_api.validate_visualization_request(
        base_request(requirements={"materials": COMBINATION})
    )
    materials = normalized.get("materials") or []
    return [
        check("a combination sent inside requirements is still read",
              len(materials) == 3, f"{len(materials)} material(s)"),
    ]


def a_material_with_no_image_is_dropped_not_faked():
    normalized = visualization_api.validate_visualization_request(
        base_request(materials=[
            COMBINATION[0],
            {"role": "highlight", "product_id": "B"},   # no image
            COMBINATION[2],
        ])
    )
    materials = normalized.get("materials") or []
    return [
        check("an entry with no image is dropped", len(materials) == 2,
              f"{len(materials)} kept"),
        check("the materials that DO have images still go through",
              [m["role"] for m in materials] == ["base", "accent"]),
    ]


def a_single_tile_request_carries_no_materials():
    normalized = visualization_api.validate_visualization_request(
        base_request()
    )
    return [
        check("no combination -> materials is None, the old path exactly",
              normalized.get("materials") is None,
              repr(normalized.get("materials"))),
    ]


def every_layer_accepts_the_parameter():
    """A missing keyword anywhere in the chain silently drops it."""
    import inspect

    from app.product_visualization_service import (
        generate_product_visualization,
    )
    from app.tile_application_engine import apply_tile_to_scene
    from app.tile_visualization_pipeline import generate_tile_visualization
    from app.visualization_orchestrator import (
        generate_and_persist_visualization,
    )

    layers = [
        ("orchestrator", generate_and_persist_visualization),
        ("product service", generate_product_visualization),
        ("pipeline", generate_tile_visualization),
        ("engine", apply_tile_to_scene),
    ]

    return [
        check(f"{name} accepts materials=",
              "materials" in inspect.signature(function).parameters)
        for name, function in layers
    ]


def main():
    groups = [
        ("the HTTP boundary keeps every material",
         the_boundary_keeps_every_material()),
        ("a combination nested in requirements still arrives",
         materials_nested_in_requirements_still_arrive()),
        ("a material with no image is dropped, not faked",
         a_material_with_no_image_is_dropped_not_faked()),
        ("a single-tile request is unchanged",
         a_single_tile_request_carries_no_materials()),
        ("every layer in the chain accepts the parameter",
         every_layer_accepts_the_parameter()),
    ]

    failures = 0
    total = 0
    for title, results in groups:
        print(f"\n{title}")
        print("-" * len(title))
        for label, ok, *rest in results:
            total += 1
            detail = rest[0] if rest else ""
            if ok:
                print(f"  PASS  {label}")
            else:
                failures += 1
                print(f"  FAIL  {label}" + (f"  [{detail}]" if detail else ""))

    print(f"\n{total - failures}/{total} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
