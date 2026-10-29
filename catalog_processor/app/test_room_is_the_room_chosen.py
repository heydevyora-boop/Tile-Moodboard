"""Regression: the generated scene must be the room the client chose.

THE FAILURE THIS COVERS
-----------------------
A client picked Kitchen & Dining. The board's own button read GENERATE
KITCHEN & DINING SCENE. Gemini returned a bathroom -- vanity, basin,
mirror, towels.

Nothing in the request said kitchen. Three things said bathroom:

  1. describe_space() knew only the two wet rooms. Every other
     selection returned None, and the room prompt read that as "no room
     was named" and fell back to its default: bathroom.

  2. The photograph sentence asked outright for "a real vanity, basin,
     mirror and fixtures", for every room, whatever was chosen.

  3. Section 8A of the system prompt -- which opens "applies only when
     the selected space is a Bathroom" -- was pasted into every room's
     prompt and then named as the section governing the design.

The tile step then said "bathroom" throughout as well, so even a
correct kitchen scene arriving as IMAGE 1 was asked to come back as a
bathroom visualization.

WHAT THIS TEST CHECKS
---------------------
The real prompt builders, for every room the wizard offers. Gemini is
not called: what is under test is what we ASK it, which is where every
one of the three faults lived. Nothing here can prove what the model
draws.

Run:  python3 app/test_room_is_the_room_chosen.py
"""

import os
import re
import sys
from pathlib import Path

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-used")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.client_selections import (  # noqa: E402
    describe_feature,
    describe_space,
    describe_view,
)
from app.scene_image_generator import build_room_scene_prompt  # noqa: E402
from app.tile_application_engine import (  # noqa: E402
    build_tile_application_prompt,
)


# The six rooms frontend/mood-board.html offers, each with the noun it
# must be called, the two feature surfaces it offers, and its close-up.
ROOMS = {
    "Bathroom": {
        "noun": "bathroom",
        "features": ("Basin wall", "Shower nook"),
        "view": "Vanity Close-Up",
        "wet": True,
    },
    "Powder Room": {
        "noun": "powder washroom",
        "features": ("Basin wall", "Mirror wall"),
        "view": "Vanity Close-Up",
        "wet": True,
    },
    "Living Room": {
        "noun": "living room",
        "features": ("Media wall", "Fireplace wrap"),
        "view": "Media Wall Close-Up",
        "wet": False,
    },
    "Bedroom": {
        "noun": "bedroom",
        "features": ("Headboard wall", "Wardrobe return"),
        "view": "Headboard Close-Up",
        "wet": False,
    },
    "Kitchen & Dining": {
        "noun": "kitchen",
        "features": ("Splashback", "Island face"),
        "view": "Splashback Close-Up",
        "wet": False,
    },
    "Balcony & Patio": {
        "noun": "balcony",
        "features": ("Boundary wall", "Planter return"),
        "view": "Parapet Close-Up",
        "wet": False,
    },
}

# The fittings that only belong in a wet room. A dry room's prompt may
# not ask for any of them.
WET_FITTINGS = re.compile(
    r"\b(vanit(?:y|ies)|basins?|washbasins?|showers?|bathtubs?|"
    r"sanitaryware|bathrooms?|powder washrooms?)\b",
    re.I,
)


def check(label, ok, detail=""):
    return (label, bool(ok), detail)


def every_room_is_known():
    results = []
    for room, want in ROOMS.items():
        space = describe_space(room)
        results.append(check(
            f"{room} is a room the generator knows",
            space is not None,
        ))
        if space:
            results.append(check(
                f"...and is called a {want['noun']}",
                space["noun"] == want["noun"],
                space["noun"],
            ))
    results.append(check(
        "a room nobody named is still None, not a guess",
        describe_space("") is None and describe_space("Garage") is None,
    ))
    return results


def the_room_prompt_asks_for_that_room():
    results = []
    for room, want in ROOMS.items():
        prompt = build_room_scene_prompt(
            "LUXURY", "Moroccan Essential",
            {"room": room, "surface": "WALL"},
        )
        noun = want["noun"]

        results.append(check(
            f"{room}: the photograph is of a {noun}",
            f"built luxury {noun} " in prompt,
            prompt[:0],
        ))
        results.append(check(
            f"{room}: ...and says so unmistakably",
            f"must read unmistakably as a {noun} and as nothing else"
            in prompt,
        ))

        if not want["wet"]:
            offending = [
                line.strip()[:90]
                for line in prompt.splitlines()
                if WET_FITTINGS.search(line)
            ]
            results.append(check(
                f"{room}: nothing in the prompt asks for wet fittings",
                not offending,
                offending[0] if offending else "",
            ))
            results.append(check(
                f"{room}: ...and Section 8A, which is bathroom-only, "
                "is not pasted in",
                "BATHROOM FUNCTIONAL COMPLETENESS" not in prompt,
            ))
        else:
            results.append(check(
                f"{room}: a wet room still gets Section 8A",
                "BATHROOM FUNCTIONAL COMPLETENESS" in prompt,
            ))

    # With no room named at all the old default still stands, so a
    # caller that never had a room keeps the behaviour it had.
    bare = build_room_scene_prompt("LUXURY", "X", {})
    results.append(check(
        "with no room named, the default bathroom is unchanged",
        "built luxury bathroom " in bare
        and "BATHROOM FUNCTIONAL COMPLETENESS" in bare,
    ))
    return results


def the_tile_step_installs_into_that_room():
    results = []
    for room, want in ROOMS.items():
        noun = want["noun"]
        prompt = build_tile_application_prompt(
            "WALL",
            tile_name="Elite Whitebody",
            requirements={"room": room},
        )
        results.append(check(
            f"{room}: IMAGE 1 is named a {noun}",
            f"IMAGE 1 = the {noun} scene." in prompt,
        ))
        results.append(check(
            f"{room}: the output asked for is a {noun} visualization",
            f"finished {noun} visualization" in prompt,
        ))
        results.append(check(
            f"{room}: ...and the room's purpose is locked to it",
            f"IMAGE 1 is a {noun} and the result" in prompt,
        ))
        if not want["wet"]:
            # Only THIS REQUEST is scoped to one room. Everything above
            # it is DEVYORA_SYSTEM_PROMPT, the doctrine every generation
            # shares, and its Section 3 lists "shower/vanity walls"
            # among the surfaces to evaluate independently -- an example
            # of a surface, not an instruction to build one.
            request = prompt.split("THIS REQUEST", 1)[-1]
            offending = [
                line.strip()[:90]
                for line in request.splitlines()
                if WET_FITTINGS.search(line)
            ]
            results.append(check(
                f"{room}: the tile step never says bathroom either",
                not offending,
                offending[0] if offending else "",
            ))
    return results


def each_room_keeps_its_own_feature():
    results = []
    for room, want in ROOMS.items():
        for feature in want["features"]:
            placement = describe_feature(feature, room)
            results.append(check(
                f"{room}: '{feature}' has a placement",
                bool(placement),
                str(placement),
            ))

        # ...and a selection saved against another room is dropped
        # rather than built.
        stranded = "Shower nook" if room != "Bathroom" else "Splashback"
        results.append(check(
            f"{room}: '{stranded}' belongs to another room and is dropped",
            describe_feature(stranded, room) is None,
            str(describe_feature(stranded, room)),
        ))

    results.append(check(
        "Custom still names the walls the client ticked",
        "left-hand wall" in (describe_feature("Left wall", "Bedroom") or ""),
    ))
    results.append(check(
        "...and still hands the choice back when asked",
        "of your choosing"
        in (describe_feature("left to the studio", "Kitchen & Dining") or ""),
    ))
    return results


def each_room_keeps_its_own_close_up():
    results = []
    for room, want in ROOMS.items():
        framing = describe_view(want["view"])
        results.append(check(
            f"{room}: '{want['view']}' is a framing the generator knows",
            bool(framing),
            str(framing),
        ))
        prompt = build_room_scene_prompt(
            "LUXURY", "X",
            {"room": room, "surface": "WALL", "view": want["view"]},
        )
        results.append(check(
            f"{room}: ...and reaches the prompt",
            framing is not None and framing in prompt,
        ))

    for shared in ("Front Elevation", "Wide Corner"):
        results.append(check(
            f"'{shared}' still works in any room",
            bool(describe_view(shared)),
        ))
    return results


def main():
    groups = [
        ("every room the wizard offers is known", every_room_is_known()),
        ("the room prompt asks for that room",
         the_room_prompt_asks_for_that_room()),
        ("the tile step installs into that room",
         the_tile_step_installs_into_that_room()),
        ("each room keeps its own feature surfaces",
         each_room_keeps_its_own_feature()),
        ("each room keeps its own close-up",
         each_room_keeps_its_own_close_up()),
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
