"""Regression: the selected theme must actually reach the model.

THE FAILURE THIS COVERS
-----------------------
A theme arrived at the generator as a bare label. "Moroccan" was dropped
into the room prompt as an adjective -- "a photorealistic luxury moroccan
bathroom interior" -- and that was the whole of it. The written
description the catalog owner wrote for each theme was never sent, and
the bathroom reference photographs were never sent either: the room call
was `contents=[scene_prompt]`, text and nothing else.

So every board came back generically themed, and the prompt could talk
about "references" that the model had never been shown.

WHAT THIS TEST CHECKS
---------------------
The real theme table and the real request assembly. Gemini is stubbed --
what is under test is what we ASK it and what we SEND it, which is where
the fault was. Nothing here can prove what the model draws.

Run:  python3 app/test_theme_reaches_gemini.py
"""

import os
import sys
from pathlib import Path

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-used")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import scene_image_generator as generator  # noqa: E402
from app.themes import (  # noqa: E402
    THEMES,
    describe_theme,
    reference_images,
    theme_brief,
)
from app.scene_image_generator import build_room_scene_prompt  # noqa: E402
from app.tile_application_engine import build_tile_application_prompt  # noqa: E402

# The eight themes the owner supplied reference photographs for, with a
# phrase from each description that must survive into the prompt, and a
# word that belongs to a DIFFERENT theme and must not appear.
PHOTOGRAPHED = {
    "British": ("oxblood", "zellige"),
    "Roman Touch": ("travertine", "palm-leaf"),
    "Floral": ("blush-pink", "gunmetal"),
    "Tropical": ("palm-leaf", "oxblood"),
    "Geometrical": ("hexagons", "terracotta tiles"),
    "Metallic": ("champagne-gold", "zellige"),
    "Rustic": ("ochre", "champagne-gold"),
    "Moroccan": ("zellige", "travertine"),
}


def check(label, ok, detail=""):
    return (label, bool(ok), detail)


class Captured(Exception):
    """Carries the assembled request back out of the stubbed call."""

    def __init__(self, contents):
        super().__init__("captured")
        self.contents = contents


def capture_scene_request(theme):
    """Runs the real room-scene assembly and returns the parts it would send."""
    return capture_scene_request_for(theme, "Bathroom")


def capture_scene_request_for(theme, room):
    """The same, for a named room."""
    class FakeModels:
        def generate_content(self, **kwargs):
            raise Captured(kwargs["contents"])

    class FakeClient:
        models = FakeModels()

    real = generator.client
    generator.client = FakeClient()
    try:
        generator.generate_bathroom_scene(
            output_path=ROOT / "output" / "theme_test.png",
            style=theme,
            theme="A Board Name",
            requirements={"room": room, "surface": "WALL", "style": theme},
        )
    except Captured as captured:
        return captured.contents
    finally:
        generator.client = real
    raise AssertionError("the stub was never reached")


def every_theme_is_configured():
    results = []
    for label in [*PHOTOGRAPHED, "Black & White"]:
        found = describe_theme(label)
        results.append(check(f"{label} is a theme the generator knows", found is not None))
        if found:
            results.append(check(
                f"{label} has a written description",
                len(found["description"]) > 120, len(found["description"])))

    results.append(check(
        "a theme nobody named yields nothing, not a guess",
        describe_theme("") is None and describe_theme("Brutalist") is None))
    results.append(check(
        "the label is matched however it is spelled",
        describe_theme("roman-touch") is describe_theme("ROMAN TOUCH") is describe_theme("Roman_Touch")))
    results.append(check(
        "...including the ampersand in Black & White",
        describe_theme("black and white") is describe_theme("Black & White")))
    return results


def each_theme_has_its_own_references():
    results = []
    seen = {}
    for label in PHOTOGRAPHED:
        paths = reference_images(label)
        results.append(check(f"{label} has reference photographs", len(paths) >= 3, len(paths)))
        results.append(check(
            f"{label}: every one of them is a real file on disk",
            all(p.is_file() and p.stat().st_size > 0 for p in paths),
            [p.name for p in paths if not p.is_file()]))
        results.append(check(
            f"{label}: they live in that theme's own folder",
            all(p.parent.name == describe_theme(label)["slug"] for p in paths),
            [str(p.parent.name) for p in paths]))
        seen[label] = {p.read_bytes() for p in paths}

    # No two themes may share a photograph: that is how a Moroccan board
    # would come back looking Roman.
    labels = list(seen)
    overlapping = [
        (a, b) for i, a in enumerate(labels) for b in labels[i + 1:]
        if seen[a] & seen[b]
    ]
    results.append(check("no photograph is shared between two themes", not overlapping, overlapping))

    results.append(check(
        "Black & White has none yet, and does not borrow another theme's",
        reference_images("Black & White") == []))
    return results


def the_prompt_carries_the_right_theme():
    results = []
    for label, (belongs, foreign) in PHOTOGRAPHED.items():
        prompt = build_room_scene_prompt(
            label, "A Board Name",
            {"room": "Bathroom", "surface": "WALL", "style": label},
        )
        results.append(check(
            f"{label}: its own description is in the prompt",
            belongs in prompt.lower(), belongs))
        results.append(check(
            f"{label}: ...and no other theme's wording is",
            foreign not in prompt.lower(), foreign))
        results.append(check(
            f"{label}: the prompt says the photographs are supplied",
            "REFERENCE PHOTOGRAPHS: 5 real rooms" in prompt))
        results.append(check(
            f"{label}: ...and that they are not to be copied",
            "do not reproduce their tiles" in prompt))

    # The one theme with no photographs must say so, not imply it has any.
    mono = build_room_scene_prompt(
        "Black & White", "A Board Name",
        {"room": "Bathroom", "surface": "WALL", "style": "Black & White"},
    )
    results.append(check(
        "Black & White states that it has no references",
        "REFERENCE PHOTOGRAPHS: none are available" in mono))
    results.append(check(
        "...and still carries its description", "charcoal" in mono.lower()))

    # A theme the table does not know says nothing about a theme at all.
    unknown = build_room_scene_prompt(
        "Brutalist", "A Board Name",
        {"room": "Bathroom", "surface": "WALL", "style": "Brutalist"},
    )
    results.append(check(
        "an unknown theme invents no description",
        "THE SELECTED THEME" not in unknown))
    return results


def the_photographs_are_actually_sent():
    results = []
    for label in PHOTOGRAPHED:
        contents = capture_scene_request(label)
        blobs = [p for p in contents if getattr(p, "inline_data", None) is not None]
        expected = reference_images(label)

        results.append(check(
            f"{label}: the request carries image parts, not just text",
            len(blobs) == len(expected), f"{len(blobs)} of {len(expected)}"))

        sent = {bytes(p.inline_data.data) for p in blobs}
        results.append(check(
            f"{label}: ...and they are that theme's own bytes",
            sent == {p.read_bytes() for p in expected}))

        other = "Moroccan" if label != "Moroccan" else "British"
        results.append(check(
            f"{label}: ...with none of {other}'s mixed in",
            not (sent & {p.read_bytes() for p in reference_images(other)})))

        text = " ".join(getattr(p, "text", "") or "" for p in contents)
        results.append(check(
            f"{label}: every image is named before its bytes",
            text.count("THEME REFERENCE") == len(expected),
            text.count("THEME REFERENCE")))

    # A theme with no photographs sends none, and still generates.
    contents = capture_scene_request("Black & White")
    results.append(check(
        "Black & White sends text only",
        not [p for p in contents if getattr(p, "inline_data", None) is not None]))
    return results


def the_tile_step_knows_the_theme_too():
    results = []
    for label, (belongs, foreign) in PHOTOGRAPHED.items():
        prompt = build_tile_application_prompt(
            "WALL", tile_name="Elite Whitebody",
            requirements={"room": "Bathroom", "style": label},
        )
        results.append(check(
            f"{label}: the tile step is told the theme",
            belongs in prompt.lower(), belongs))
        results.append(check(
            f"{label}: ...and not another theme's",
            foreign not in prompt.lower(), foreign))

    # It must NOT be handed the reference photographs: the room is
    # already fixed by IMAGE 1 and this step only swaps materials.
    plain = build_tile_application_prompt(
        "WALL", tile_name="Elite Whitebody",
        requirements={"room": "Bathroom", "style": "Moroccan"},
    )
    results.append(check(
        "the tile step is not told to look at reference photographs",
        "THEME REFERENCE" not in plain and "REFERENCE PHOTOGRAPHS" not in plain))
    results.append(check(
        "...and still says the room may not change",
        "IMAGE 1 is a bathroom and the result" in plain))

    results.append(check(
        "an unknown theme adds no line at all",
        "- Theme:" not in build_tile_application_prompt(
            "WALL", tile_name="X", requirements={"room": "Bathroom", "style": "Brutalist"})))
    return results


def the_wizard_and_the_table_agree():
    """Every theme the wizard offers must exist here, and vice versa."""
    wizard = ROOT.parent / "frontend" / "mood-board.html"
    text = wizard.read_text(encoding="utf-8")
    offered = []
    for line in text.splitlines():
        if "label: '" in line and "spec: '" in line and "art: " not in line:
            continue
    # The theme entries are the ones carrying `art: 'img/themes/...'`.
    import re
    offered = re.findall(r"label: '([^']+)', spec: '[^']*',\n\s*art: 'img/themes/", text)

    results = [check("the wizard's theme list was found", len(offered) >= 8, offered)]
    for label in offered:
        results.append(check(f"the wizard's \"{label}\" is configured here", describe_theme(label) is not None))
    extra = [t["label"] for t in THEMES.values() if t["label"] not in offered]
    results.append(check("and nothing here is offered by nobody", not extra, extra))
    return results


def the_theme_holds_in_every_room():
    """Every reference photograph is a bathroom. Most rooms are not.

    Handing five bathrooms to a kitchen without saying what to take from
    them is asking for a bathroom back -- the exact failure that was
    just fixed in the room itself.
    """
    results = []
    dry = {
        "Kitchen & Dining": "kitchen",
        "Bedroom": "bedroom",
        "Living Room": "living room",
        "Balcony & Patio": "balcony",
    }

    for room, noun in dry.items():
        prompt = build_room_scene_prompt(
            "Moroccan", "A Board Name",
            {"room": room, "surface": "WALL", "style": "Moroccan"},
        )
        results.append(check(
            f"{room}: still gets the theme description",
            "zellige" in prompt.lower()))
        results.append(check(
            f"{room}: the photographs are named as bathrooms",
            f"THEY ARE ALL BATHROOMS, AND THIS ROOM IS A {noun.upper()}" in prompt))
        results.append(check(
            f"{room}: only the palette and materials are taken from them",
            "Take from them ONLY what is not a bathroom" in prompt))
        results.append(check(
            f"{room}: ...and none of the bathroom's fittings",
            "no vanity, no basin, no shower, no bathtub" in prompt))
        results.append(check(
            f"{room}: the room drawn is still a {noun}",
            f"The room you draw is a {noun}" in prompt))

    # A bathroom needs none of that caveat: the references ARE bathrooms.
    for room in ("Bathroom", "Powder Room"):
        prompt = build_room_scene_prompt(
            "Moroccan", "A Board Name",
            {"room": room, "surface": "WALL", "style": "Moroccan"},
        )
        results.append(check(
            f"{room}: no caveat is added, the references match the room",
            "THEY ARE ALL BATHROOMS" not in prompt))
        results.append(check(
            f"{room}: ...and it still gets the theme and its photographs",
            "zellige" in prompt.lower() and "REFERENCE PHOTOGRAPHS: 5 real rooms" in prompt))

    # The photographs themselves do not change with the room: the theme
    # decides which are sent, the room decides what to take from them.
    kitchen = capture_scene_request_for("Moroccan", "Kitchen & Dining")
    bathroom = capture_scene_request_for("Moroccan", "Bathroom")
    sent = lambda parts: {bytes(p.inline_data.data) for p in parts if getattr(p, "inline_data", None) is not None}
    results.append(check(
        "a kitchen and a bathroom are sent the same Moroccan photographs",
        sent(kitchen) == sent(bathroom) and len(sent(kitchen)) == 5,
        len(sent(kitchen))))
    return results


def main():
    groups = [
        ("every theme is configured", every_theme_is_configured()),
        ("each theme has its own references", each_theme_has_its_own_references()),
        ("the prompt carries the right theme", the_prompt_carries_the_right_theme()),
        ("the photographs are actually sent", the_photographs_are_actually_sent()),
        ("the tile step knows the theme too", the_tile_step_knows_the_theme_too()),
        ("the theme holds in every room", the_theme_holds_in_every_room()),
        ("the wizard and the table agree", the_wizard_and_the_table_agree()),
    ]

    total = 0
    failures = 0
    for title, results in groups:
        print(f"\n{title}")
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
