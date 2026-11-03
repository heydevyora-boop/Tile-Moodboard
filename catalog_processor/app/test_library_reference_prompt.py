"""
When the room is the client's OWN photograph.

A generated scene normally comes out of this system's own Stage 1: the
room was drawn from the theme a moment earlier, so "true to the theme"
and "true to IMAGE 1" are the same thing and nothing has to say which
wins.

A De'vyora Library reference is not that. It is a photograph the client
pointed at, and it may not look like the theme's usual idea of itself --
a Moroccan reference can be cream and terracotta while the theme section
in the same prompt asks for blue and green. That section is several
hundred words long and emphatic. Without one that outranks it, the model
reconciles the two by drifting the room towards the theme, which is the
client's own choice being quietly overruled.

So this checks the two things that stop that: the paragraph is there when
a reference is in play, it is NOT there otherwise, and it says which one
wins.

Run:  PYTHONPATH=. python3 app/test_library_reference_prompt.py
"""

from __future__ import annotations

import os

os.environ.setdefault("GEMINI_API_KEY", "dummy-key-not-a-real-key")

from app.tile_application_engine import build_tile_application_prompt


passed = 0
failed = 0
failures: list[str] = []


def check(label: str, condition: bool, extra: object = None) -> None:
    global passed, failed
    if condition:
        print(f"  PASS  {label}")
        passed += 1
    else:
        print(f"  FAIL  {label}", "" if extra is None else repr(extra)[:300])
        failed += 1
        failures.append(label)


REFERENCE = '"Cobalt Hammam" (Bathroom)'

BASE_REQUIREMENTS = {
    "room": "BATHROOM",
    "style": "Moroccan",
    "feature": "Behind the basin",
    "grout": "Ivory matte",
}

MATERIALS = [
    {"role": "base", "image_path": "base.png", "name": "Cream Limestone"},
    {"role": "highlight", "image_path": "high.png", "name": "Cobalt Zellige"},
]


def main() -> None:
    print("\n1. without a reference, the prompt is what it always was")
    plain = build_tile_application_prompt(
        surface="WALL", tile_name="Cream Limestone", requirements=BASE_REQUIREMENTS
    )
    check("1a. no reference paragraph appears", "CHOSEN REFERENCE ROOM" not in plain)
    check("1b. the theme still governs", "Moroccan" in plain)
    check(
        "1c. ...and the room is still fixed by IMAGE 1",
        "IMAGE 1" in plain and "source of truth" in plain,
    )

    print("\n2. with one, it is named and put above the requirements")
    single = build_tile_application_prompt(
        surface="WALL",
        tile_name="Cream Limestone",
        requirements={**BASE_REQUIREMENTS, "reference_room": REFERENCE},
    )
    check("2a. the paragraph appears", "CHOSEN REFERENCE ROOM" in single)
    check("2b. ...naming the room the client chose", "Cobalt Hammam" in single)
    check(
        "2c. ...saying it is not a room this system designed",
        "not a room this system designed" in single,
    )
    check(
        "2d. ...and that it is the primary guide",
        "PRIMARY VISUAL GUIDE" in single,
    )
    check(
        "2e. it sits ABOVE the user-selected requirements it outranks",
        single.index("CHOSEN REFERENCE ROOM")
        < single.index("USER-SELECTED REQUIREMENTS"),
        (
            single.index("CHOSEN REFERENCE ROOM"),
            single.index("USER-SELECTED REQUIREMENTS"),
        ),
    )

    print("\n3. what must survive from the photograph")
    for label, needle in [
        ("3a. its composition and framing", "composition and framing"),
        ("3b. its camera, lens and perspective", "camera position, lens and perspective"),
        ("3c. every vanishing point", "vanishing point"),
        ("3d. the direction and temperature of its light", "colour temperature"),
        ("3e. its shadows and reflections", "shadow and reflection"),
        ("3f. its proportions, architecture and fittings", "proportions, its architecture"),
        ("3g. its overall mood", "overall mood"),
    ]:
        check(label, needle in single, needle)

    check(
        "3h. and exactly one thing may change: the material",
        "Change ONE thing and nothing else" in single,
    )

    print("\n4. the theme does not get to redraw the room")
    check("4a. the precedence is stated outright", "PHOTOGRAPH WINS" in single)
    check(
        "4b. restyling towards the theme is forbidden",
        "Do not restyle the room towards the theme" in single,
    )
    check(
        "4c. ...and so is correcting its colours towards the theme's palette",
        "correct its colours towards the theme" in single,
    )
    check(
        "4d. ...while the theme still governs how the materials are laid",
        "how the supplied materials are laid, cut and grouted" in single,
    )

    print("\n5. a whole combination gets it too, not only a single tile")
    combo = build_tile_application_prompt(
        surface="WALL",
        materials=MATERIALS,
        requirements={**BASE_REQUIREMENTS, "reference_room": REFERENCE},
    )
    check("5a. the paragraph appears on the combination path", "CHOSEN REFERENCE ROOM" in combo)
    check("5b. ...naming the room", "Cobalt Hammam" in combo)
    check(
        "5c. ...and every material is still enumerated with its role",
        "BASE material" in combo and "HIGHLIGHT material" in combo,
    )
    check(
        "5d. ...told the materials were matched TO this photograph",
        "the ones the studio matched TO this" in combo,
    )

    print("\n6. an empty or blank value is not a reference")
    for label, value in [("6a. empty string", ""), ("6b. whitespace", "   "), ("6c. None", None)]:
        blank = build_tile_application_prompt(
            surface="WALL",
            tile_name="Cream Limestone",
            requirements={**BASE_REQUIREMENTS, "reference_room": value},
        )
        check(label, "CHOSEN REFERENCE ROOM" not in blank)

    print(f"\n{passed}/{passed + failed} checks passed")
    if failures:
        print("failed:\n  " + "\n  ".join(failures))
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
