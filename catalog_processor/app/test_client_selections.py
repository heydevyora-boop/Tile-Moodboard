"""Regression: the client's selections must reach the stage that uses them.

THE FAILURE THIS COVERS
-----------------------
The mood board wizard asks for a room (including Powder Room), a feature
wall, a floor module (size and finish), a palette, a grout colour and a
view. Every generated bathroom ignored all of them.

Nothing rejected them -- they were simply never delivered. The page sent
none of them; the Python API read only four keys from `requirements`;
the tile-install prompt had no parameter for any of them; and each
tile's catalog size and finish were in the database but never selected.
So a Powder Room board got a full bathroom with a shower, and the model
was told to honour "the exact dimensions" it was never given.

The room rules had the mirror-image problem. Section 8A (storage,
privacy, shower bench, lighting) was added to the system prompt, but
the room is designed in Stage 1, which never saw the system prompt;
Stage 2 only installs tile into that finished room and is told to change
nothing else, so 8A there could only contradict its own DO-NOT list.

WHAT THIS TEST ACTUALLY CHECKS
------------------------------
What each stage is ASKED, captured from the real prompt builders and the
real request normalization, with Gemini stubbed:

  * Stage 1 (the room) receives Section 8A and the room subcategory,
    in whatever casing the selection arrives in
  * Stage 2 (the tile) receives the selections and each tile's real
    size and finish, and is told 8A is already satisfied by the room
  * camera regeneration is told the same
  * every layer between the API and the engine FORWARDS the selections,
    not merely accepts them -- accepting and dropping is the bug class
  * a request that carries no selections produces no selections block,
    so older callers get no invented values

Run:  python3 app/test_client_selections.py
"""

import ast
import inspect
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-used")
os.environ.setdefault(
    "CATALOG_OUTPUT_ROOT",
    str(Path(tempfile.gettempdir()) / "client_selections_test"),
)

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from PIL import Image  # noqa: E402

import app.scene_image_generator as scene_generator  # noqa: E402
import app.tile_application_engine as engine  # noqa: E402
from app import visualization_api  # noqa: E402

SECTION_8A = "8A. BATHROOM FUNCTIONAL COMPLETENESS"
ROOM_IS_FIXED = "Sections 8 and 8A are satisfied by IMAGE 1"

WIZARD = {
    "room": "Powder Room",
    "style": "Warm Neutral",
    "combination_name": "Slate Calm",
    "feature": "Basin wall",
    "size": "600×1200 mm",
    "finish": "Honed Matte",
    "grout": "Charcoal",
    "view": "Vanity Close-Up",
}


def check(label, ok, detail=""):
    return (label, bool(ok), detail)


class Captured(Exception):
    pass


def room_prompt_through_the_api(requirements, surface="WALL"):
    """Stage 1's prompt, reached the way a real request reaches it."""
    seen = {}

    class Models:
        def generate_content(self, model=None, contents=None, **_):
            seen["prompt"] = "\n".join(
                part for part in contents if isinstance(part, str)
            )
            raise Captured()

    real = scene_generator.client
    scene_generator.client = type("Client", (), {"models": Models()})()
    try:
        visualization_api.validate_visualization_request({
            "product_id": "BASE-1",
            "surface": surface,
            "scene_image": "",
            "generate_random_scene": True,
            "requirements": requirements,
        })
    except Exception:  # noqa: BLE001 -- only the captured prompt matters
        pass
    finally:
        scene_generator.client = real
    return seen.get("prompt", "")


def stage_one():
    powder = room_prompt_through_the_api(dict(WIZARD))
    shouted = room_prompt_through_the_api({"room": "POWDER ROOM"})
    full = room_prompt_through_the_api({"room": "BATHROOM"})
    on_floor = room_prompt_through_the_api(dict(WIZARD), surface="FLOOR")
    nook = room_prompt_through_the_api(
        {"room": "Powder Room", "feature": "Shower nook"}
    )
    bare = room_prompt_through_the_api({})

    return [
        check("the room prompt carries Section 8A", SECTION_8A in powder),
        check("8A is the system prompt's own text, not a copy",
              scene_generator._doctrine_section("8A").strip() in powder),
        check("Powder Room reaches the room generator",
              "powder washroom" in powder),
        check("...and it is told: no shower, no bathtub",
              "no shower and no bathtub" in powder),
        check("'POWDER ROOM' (a saved board's casing) means the same",
              "no shower and no bathtub" in shouted),
        check("Bathroom asks for a full bathroom with a shower zone",
              "- Space: a full bathroom with a walk-in shower zone." in full
              and "powder washroom interior" not in full),
        check("the feature wall reaches the room, as the statement tile's wall",
              "the wall behind the vanity and basin. The statement tile is "
              "installed there" in powder),
        check("the floor module reaches the room",
              "600×1200 mm tiles in a Honed Matte finish" in powder),
        check("the view reaches the room",
              "close crop on the vanity and basin" in powder),
        check("the palette and board name reach the room",
              "warm neutral powder washroom" in powder
              and '"Slate Calm"' in powder),
        check("the room knows which surface the tile goes on",
              "on the walls" in powder),
        check("no floor module is imposed when the tile IS the floor",
              "floor module" not in on_floor),
        check("a shower nook is not requested of a powder washroom",
              "shower niche" not in nook and "no shower" in nook),
        check("with no selections, no selections block is invented",
              "CLIENT SELECTIONS" not in bare and SECTION_8A in bare),
    ]


def png(directory, name, rgb):
    path = directory / name
    Image.new("RGB", (48, 48), rgb).save(path)
    return path


def tile_prompt(directory, requirements, materials=None):
    """Stage 2's prompt, from the real engine, Gemini stubbed."""
    seen = {}
    real_client = engine._get_gemini_client
    real_generate = engine._generate_content_with_retry

    def generate(client, model, contents, config):
        seen["prompt"] = "\n".join(
            part.text for part in contents if getattr(part, "text", None)
        )
        raise Captured()

    engine._get_gemini_client = lambda: object()
    engine._generate_content_with_retry = generate
    try:
        engine.apply_tile_to_scene(
            scene_image=png(directory, "scene.png", (230, 230, 230)),
            tile_image=png(directory, "base.png", (200, 190, 170)),
            surface="WALL",
            tile_product_id="P-BASE",
            tile_name="Terra Grey",
            materials=materials,
            requirements=requirements,
        )
    except Exception:  # noqa: BLE001 -- only the captured prompt matters
        pass
    finally:
        engine._get_gemini_client = real_client
        engine._generate_content_with_retry = real_generate
    return seen.get("prompt", "")


def stage_two():
    directory = Path(tempfile.mkdtemp(prefix="selections_"))
    combination = [
        {"role": "base", "name": "Terra Grey", "product_id": "P-BASE",
         "size": "600X1200 MM", "finish": "Polished",
         "image_path": str(png(directory, "b.png", (200, 190, 170)))},
        {"role": "highlight", "name": "Onyx Vein", "product_id": "P-HL",
         "size": "300X600 MM", "finish": "Matt",
         "image_path": str(png(directory, "h.png", (90, 130, 160)))},
    ]

    board = tile_prompt(directory, dict(WIZARD), combination)
    single = tile_prompt(
        directory, {"tile_size": "600X600", "tile_finish": "Satin"}
    )
    plain = tile_prompt(directory, None)
    uniform = tile_prompt(
        directory, {"feature": "No feature wall"}, combination
    )

    return [
        check("the tile prompt still carries the whole system prompt",
              board.lstrip().startswith("You are the Devyora")
              and SECTION_8A in board),
        check("it is told 8A is already satisfied by the room",
              ROOM_IS_FIXED in board),
        check("...and to add, remove or move nothing to meet it",
              "do not add, remove, move or restyle" in board),
        check("each tile's real size reaches the prompt",
              "size 600X1200 MM" in board and "size 300X600 MM" in board),
        check("each tile's real finish reaches the prompt",
              "Polished finish" in board and "Matt finish" in board),
        check("the space reaches the tile step",
              "compact powder washroom" in board),
        check("the feature wall tells the highlight where to go",
              "Feature wall: the wall behind the vanity and basin" in board),
        check("the grout selection reaches the tile step",
              "- Grout: Charcoal." in board),
        check("'No feature wall' keeps the highlight off a whole wall",
              "never a whole wall" in uniform),
        check("a single tile states its catalog size and finish",
              "Tile Size: 600X600" in single
              and "Tile Finish: Satin" in single),
        check("no selections -> no selections block, nothing invented",
              "USER-SELECTED REQUIREMENTS" not in plain
              and "Tile Size" not in plain),
    ]


def camera_regeneration():
    prompt = scene_generator.build_locked_scene_prompt(
        {"scene_id": "S1", "products": []}, {"angle": "Left", "camera": {}}
    )
    return [
        check("camera regeneration is told 8A is already satisfied",
              "Sections 8 and 8A were applied when this scene was designed"
              in prompt),
    ]


def the_nook_note_is_logged_once():
    """Both stages ask about the feature wall; only one may report the drop."""
    import contextlib
    import io

    selections = {"room": "Powder Room", "feature": "Shower nook"}
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        scene_generator.build_room_scene_prompt("Modern", "Calm", dict(selections))
        engine.build_tile_application_prompt(
            surface="WALL",
            materials=[{"role": "base", "name": "Terra Grey"},
                       {"role": "highlight", "name": "Onyx Vein"}],
            requirements=dict(selections),
        )
    reported = output.getvalue().count("'Shower nook' ignored")
    return [
        check("a dropped shower nook is reported once per request, not per stage",
              reported == 1, f"reported {reported} time(s)"),
    ]


def forwards(function, downstream):
    """True when `function` passes requirements= in its call to `downstream`."""
    tree = ast.parse(inspect.getsource(function).lstrip())
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = getattr(node.func, "id", getattr(node.func, "attr", ""))
            if name == downstream and any(
                keyword.arg == "requirements" for keyword in node.keywords
            ):
                return True
    return False


def the_chain_forwards_it():
    from app.product_visualization_service import (
        generate_product_visualization,
    )
    from app.tile_visualization_pipeline import generate_tile_visualization
    from app.visualization_orchestrator import (
        generate_and_persist_visualization,
    )

    hops = [
        ("api -> orchestrator", visualization_api.create_visualization,
         "generate_and_persist_visualization"),
        ("orchestrator -> product service", generate_and_persist_visualization,
         "generate_product_visualization"),
        ("product service -> pipeline", generate_product_visualization,
         "generate_tile_visualization"),
        ("pipeline -> engine", generate_tile_visualization,
         "apply_tile_to_scene"),
        ("engine -> prompt", engine.apply_tile_to_scene,
         "build_tile_application_prompt"),
    ]

    normalized = visualization_api.validate_visualization_request({
        "product_id": "BASE-1",
        "surface": "WALL",
        "scene_image": "",
        "generate_random_scene": True,
        "requirements": {"room": "Bathroom", "grout": "Charcoal"},
        "materials": [{"role": "base", "image_url": "http://x/a.png",
                       "size": "600X600", "finish": "Matt"}],
    })

    return [
        check("the API boundary keeps the selections",
              (normalized.get("requirements") or {}).get("grout")
              == "Charcoal"),
        check("the API boundary keeps each material's size and finish",
              (normalized.get("materials") or [{}])[0].get("size")
              == "600X600"
              and normalized["materials"][0].get("finish") == "Matt"),
    ] + [
        check(f"{hop} forwards requirements=", forwards(function, downstream))
        for hop, function, downstream in hops
    ]


def main():
    groups = [
        ("stage 1: the room", stage_one()),
        ("stage 2: the tile", stage_two()),
        ("camera regeneration", camera_regeneration()),
        ("the shower-nook note", the_nook_note_is_logged_once()),
        ("the chain forwards the selections", the_chain_forwards_it()),
    ]

    failures = 0
    total = 0
    for title, results in groups:
        print(f"\n{title}")
        print("-" * len(title))
        for label, ok, detail in results:
            total += 1
            if ok:
                print(f"  PASS  {label}")
            else:
                failures += 1
                print(f"  FAIL  {label}" + (f"  [{detail}]" if detail else ""))

    print(f"\n{total - failures}/{total} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
