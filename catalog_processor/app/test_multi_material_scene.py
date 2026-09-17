"""Regression: a mood board's three materials must all reach the generator.

THE FAILURE THIS COVERS
-----------------------
A board holds three selected materials -- BASE, HIGHLIGHT, ACCENT -- and
the generated bathroom came back showing only the base. The other two
selections had no visible effect on the image at all.

They were not being ignored by the model. They were never sent. The
generation request carried ONE product_id and ONE surface, all the way
down: the mood board picked `tiles.find(t => t.role === 'base')` and sent
that alone, and every layer below it was shaped for exactly one tile.

WHAT THIS TEST ACTUALLY CHECKS
------------------------------
The real prompt builder and the real Gemini request assembly. Gemini
itself is stubbed -- what is under test is what we ASK it, not what it
draws, because "only the base was applied" was caused entirely by what
was in the request.

So the assertions are about the request:

  * every material's bytes are present, and they are the RIGHT bytes
  * every material is labelled with its own role, next to its own image
  * the roles are described distinctly -- a highlight is not told to
    cover the same area as the base
  * with no combination supplied, the request is byte-for-byte the
    single-tile request that shipped before

Run:  python3 app/test_multi_material_scene.py
"""

import os
import sys
from pathlib import Path

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-used")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from PIL import Image  # noqa: E402

import app.tile_application_engine as engine  # noqa: E402

OUT = ROOT / "output" / "multi_material_test"

# Distinct solid colours, so "which image arrived" is answerable from the
# bytes rather than from trusting the plumbing that put them there.
MATERIAL_COLOURS = {
    "base": (200, 190, 170),
    "highlight": (90, 130, 160),
    "accent": (170, 80, 70),
    # A role the engine has no specific wording for, to prove an
    # unrecognised one is still sent rather than quietly dropped.
    "border": (60, 150, 90),
}
SCENE_COLOUR = (240, 240, 240)


def write_image(path, colour):
    Image.new("RGB", (160, 160), colour).save(path, "PNG")
    return path


class Captured(Exception):
    """Carries the assembled request back out of the stubbed call."""

    def __init__(self, contents):
        super().__init__("captured")
        self.contents = contents


def capture_request(materials):
    """Runs the real assembly and returns the parts it would have sent."""
    OUT.mkdir(parents=True, exist_ok=True)

    scene = write_image(OUT / "scene.png", SCENE_COLOUR)
    paths = {
        role: write_image(OUT / f"{role}.png", colour)
        for role, colour in MATERIAL_COLOURS.items()
    }

    supplied = None
    if materials:
        supplied = [
            {
                "role": role,
                "image_path": paths[role],
                "product_id": f"{role.upper()}-1",
                "name": f"Tile {role[0].upper()}",
            }
            for role in materials
        ]

    def fake_generate(client, model, contents, config):
        raise Captured(contents)

    real_generate = engine._generate_content_with_retry
    real_client = engine._get_gemini_client
    engine._generate_content_with_retry = fake_generate
    engine._get_gemini_client = lambda: object()

    try:
        engine.apply_tile_to_scene(
            scene_image=scene,
            tile_image=paths["base"],
            surface="WALL",
            output_path=OUT / "result.png",
            tile_product_id="BASE-1",
            tile_name="Tile B",
            materials=supplied,
        )
    except RuntimeError as error:
        # apply_tile_to_scene wraps any generation failure, so the
        # carrier comes back as the wrapped cause.
        captured = error.__cause__
        if not isinstance(captured, Captured):
            raise
        return captured.contents, paths
    finally:
        engine._generate_content_with_retry = real_generate
        engine._get_gemini_client = real_client

    raise AssertionError("the generation call was never reached")


def part_texts(contents):
    return [
        getattr(part, "text", "") or ""
        for part in contents
        if getattr(part, "text", None)
    ]


def part_blobs(contents):
    out = []
    for part in contents:
        blob = getattr(part, "inline_data", None)
        if blob is not None and getattr(blob, "data", None):
            out.append(blob.data)
    return out


def check(label, ok, detail=""):
    return (label, bool(ok), detail)


def all_three_materials_are_sent():
    contents, paths = capture_request(["base", "highlight", "accent"])
    blobs = part_blobs(contents)
    text = "\n".join(part_texts(contents))

    expected = {
        role: paths[role].read_bytes()
        for role in ("base", "highlight", "accent")
    }
    scene_bytes = (OUT / "scene.png").read_bytes()

    results = [
        check(f"the request carries 4 images ({len(blobs)})", len(blobs) == 4,
              f"{len(blobs)} image part(s)"),
        check("the scene is one of them", scene_bytes in blobs),
    ]

    for role, data in expected.items():
        results.append(check(
            f"the {role} material's own image bytes are in the request",
            data in blobs,
        ))

    # Order matters: the prompt numbers the images, so the bytes have to
    # arrive in the numbered order or IMAGE 3 is not the highlight.
    order = [blobs.index(expected[r]) for r in ("base", "highlight", "accent")]
    results.append(check(
        "base, highlight and accent arrive in that order",
        order == sorted(order), f"positions {order}",
    ))

    for role in ("BASE", "HIGHLIGHT", "ACCENT"):
        results.append(check(
            f"{role} is named in the request", role in text,
        ))

    results.append(check(
        "the request says every material must be visible",
        "EVERY supplied material MUST be visibly present" in text,
    ))
    results.append(check(
        "using only the first material is called out as a failure",
        "Using only the first material" in text,
    ))

    return results


def each_role_gets_its_own_surfaces():
    """Three materials on 'the wall' is only useful if they differ."""
    contents, _paths = capture_request(["base", "highlight", "accent"])
    text = "\n".join(part_texts(contents))

    return [
        check("the base is told to cover most of the area",
              "must cover most of the tiled area" in text),
        check("the highlight is told it is a feature area, secondary",
              "feature area" in text and "covering much less area" in text),
        check("the accent is told it is trim, not a field",
              "used as trim rather than as a field" in text),
        check("the three role descriptions are not identical",
              len({
                  engine.describe_material_role(r, "wall")
                  for r in ("base", "highlight", "accent")
              }) == 3),
    ]


def an_unknown_role_is_not_dropped():
    """Dropping a selected material is the bug; an odd role is not licence to."""
    contents, _paths = capture_request(["base", "border"])
    blobs = part_blobs(contents)
    text = "\n".join(part_texts(contents))

    return [
        check("a border material is still sent", len(blobs) == 3,
              f"{len(blobs)} image part(s)"),
        check("and is still named", "BORDER" in text),
    ]


def a_single_tile_request_is_unchanged():
    """No combination -> the request that shipped before, exactly."""
    contents, paths = capture_request(None)
    blobs = part_blobs(contents)
    text = "\n".join(part_texts(contents))

    return [
        check("only the scene and the one tile are sent", len(blobs) == 2,
              f"{len(blobs)} image part(s)"),
        check("the tile bytes are the supplied tile",
              paths["base"].read_bytes() in blobs),
        check("the original two-image wording is used",
              "Two images are supplied" in text),
        check("the original tile label is used",
              "IMAGE 2 = EXACT SELECTED CATALOG TILE." in text),
        check("no multi-material wording leaked in",
              "EVERY supplied material" not in text),
    ]


def main():
    groups = [
        ("all three materials are sent", all_three_materials_are_sent()),
        ("each role gets its own surfaces", each_role_gets_its_own_surfaces()),
        ("an unrecognised role is not dropped", an_unknown_role_is_not_dropped()),
        ("a single-tile request is unchanged", a_single_tile_request_is_unchanged()),
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
