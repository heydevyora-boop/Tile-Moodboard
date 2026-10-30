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
    theme_checklist,
    theme_rules,
    theme_specification,
    room_styling,
)
from app.theme_check import check_theme, summarise, _question  # noqa: E402
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
    "Geometrical": ("hexagonal", "zellige"),
    "Metallic": ("champagne-gold", "zellige"),
    "Rustic": ("ochre", "champagne-gold"),
    "Moroccan": ("zellige", "travertine"),
    # No photographs yet, but a strict configuration like the rest.
    "Black & White": ("charcoal", "zellige"),
}

# The eight with photographs on disk. Black & White has none, and the
# prompt must say so rather than imply it has any.
WITH_PHOTOGRAPHS = {k: v for k, v in PHOTOGRAPHED.items() if k != "Black & White"}


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
                f"{label} has a written identity",
                len(found["identity"]) > 120, len(found["identity"])))
            results.append(check(
                f"{label} has mandatory characteristics",
                len(found["mandatory"]) >= 2, len(found["mandatory"])))
            results.append(check(
                f"{label} has prohibited deviations",
                len(found["avoid"]) >= 2, len(found["avoid"])))
            results.append(check(
                f"{label} has a success condition",
                len(found["success"]) > 40, found["success"][:60]))

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
    for label in WITH_PHOTOGRAPHS:
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
        if label in WITH_PHOTOGRAPHS:
            results.append(check(
                f"{label}: the prompt says the photographs are supplied",
                "REFERENCE PHOTOGRAPHS: 5 real rooms" in prompt))
            results.append(check(
                f"{label}: ...and that they are not to be copied",
                "do not reproduce their tiles" in prompt))
        else:
            results.append(check(
                f"{label}: the prompt states it has no photographs",
                "REFERENCE PHOTOGRAPHS: none are available" in prompt))

    # Reachable by the id the owner specified, not only by its label.
    for label, theme_id in [
        ("Black & White", "black_white"), ("Roman Touch", "roman_touch"),
        ("Moroccan", "moroccan"), ("Geometrical", "geometrical"),
    ]:
        results.append(check(
            f"{label} is reachable by its id \"{theme_id}\"",
            describe_theme(theme_id) is describe_theme(label)
            and describe_theme(theme_id) is not None))

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
    for label in WITH_PHOTOGRAPHS:
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


def the_floral_living_room_is_furnished_and_controlled():
    """The owner's floral LIVING ROOM came back as wallpaper everywhere.

    Two separate faults, in one board. The pattern was on almost every
    wall at an enlarged scale, so the room read as repetitive rather
    than designed -- nothing in the theme asked for the pattern to be
    CONTROLLED. And the specification opened "A floral bathroom", which
    is an instruction to draw one, pasted into a living room's prompt
    under the heading THE SPECIFICATION.

    Nothing here can prove what the model draws. What it proves is that
    the room is asked for as a living room, furnished as one, and told
    where the pattern may and may not go.
    """
    results = []
    living = build_room_scene_prompt(
        "Floral", "A Board Name",
        {"room": "Living Room", "surface": "WALL", "style": "Floral"},
    )
    bathroom = build_room_scene_prompt(
        "Floral", "A Board Name",
        {"room": "Bathroom", "surface": "WALL", "style": "Floral"},
    )
    floral = describe_theme("Floral")

    # THE DISTRIBUTION. Every room, not just this one: the pattern was
    # uncontrolled in the theme itself.
    for label, prompt in (("living room", living), ("bathroom", bathroom)):
        results.append(check(
            f"{label}: one dominant floral surface, and no more",
            "ONE dominant floral surface and no more" in prompt))
        results.append(check(
            f"{label}: the other walls carry the palette, not the pattern",
            "they carry the palette, not the pattern" in prompt))
        results.append(check(
            f"{label}: the motif is held to one realistic scale",
            "one consistent scale" in prompt
            and "Do not enlarge it until a few flowers fill a wall" in prompt))
        results.append(check(
            f"{label}: the botanical identity reaches the smaller things",
            "cushions, textiles, artwork, soft furnishings, accessories" in prompt))
        results.append(check(
            f"{label}: covering every wall is forbidden outright",
            "floral pattern covering most or all of the walls in the room" in prompt))
        results.append(check(
            f"{label}: so is an enlarged motif",
            "oversized flower motifs enlarged until a few of them fill a whole surface"
            in prompt))
        results.append(check(
            f"{label}: neither blush nor sage may take the room",
            "a room that reads as overwhelmingly pink, or overwhelmingly green" in prompt
            and "No single one of them may take the whole room." in prompt))
        results.append(check(
            f"{label}: and the styling may not be busy",
            "busy decorative styling with too many ornaments competing for attention"
            in prompt))

    # THE FURNITURE. A living room's, and only a living room's.
    styling = room_styling("Floral", "Living Room")
    results.append(check(
        "the living room is furnished by the theme",
        len(styling) == 6 and all(item in living for item in styling),
        [i[:40] for i in styling if i not in living]))
    results.append(check(
        "...under a heading that names the room",
        "IN THIS ROOM -- how this theme is furnished in a living room:" in living))
    results.append(check(
        "a blush or sage sofa and ivory accent chairs are asked for",
        "A principal sofa in blush pink or sage green" in living
        and "ivory or warm-cream accent chairs" in living
        and "in realistic proportion to the room" in living))
    results.append(check(
        "so is wood, a coffee table and botanical artwork",
        "warm natural timber" in living and "coffee table" in living
        and "botanical artwork" in living))
    results.append(check(
        "the furniture must not compete with the feature surface",
        "complements the floral surface instead of competing with it" in living))

    # ...and nowhere else. A floral bathroom gets no sofa, and a British
    # living room gets no sage one.
    results.append(check(
        "a floral bathroom is given no living-room furniture",
        "IN THIS ROOM" not in bathroom and "accent chairs" not in bathroom))
    results.append(check(
        "a floral bathroom keeps its own description otherwise",
        all(rule in bathroom for rule in floral["mandatory"])))
    for other in ("British", "Moroccan", "Tropical", "Rustic"):
        prompt = build_room_scene_prompt(
            other, "A Board Name",
            {"room": "Living Room", "surface": "WALL", "style": other},
        )
        results.append(check(
            f"a {other} living room is not given Floral's furniture",
            "IN THIS ROOM" not in prompt and "accent chairs" not in prompt))
        results.append(check(
            f"...and {other} still gets its own rules",
            all(rule in prompt for rule in describe_theme(other)["mandatory"])))

    # THE INTEGRATION. The first live Floral living room obeyed "ONE
    # dominant floral surface" by hanging a framed rectangle of pattern
    # in the middle of a grey tiled wall. Capping the pattern was right;
    # saying nothing about where it STOPS was not.
    for label, prompt in (("living room", living), ("bathroom", bathroom)):
        results.append(check(
            f"{label}: the dominant surface must be architecturally integrated",
            "That dominant surface must be ARCHITECTURALLY INTEGRATED" in prompt))
        results.append(check(
            f"{label}: ...filling a real plane, edges landing on architecture",
            "every edge of it lands on an architectural line" in prompt
            and "a whole wall, an alcove, a chimney breast, a panelled recess" in prompt))
        results.append(check(
            f"{label}: a framed rectangle is named as NOT a feature wall",
            "is NOT a feature wall and does not satisfy this theme" in prompt))
        results.append(check(
            f"{label}: ...and forbidden outright",
            "a rectangle of floral pattern floated in the middle of another material, "
            "framed like a picture or a sample board" in prompt))
        results.append(check(
            f"{label}: one quieter botanical note is required besides it",
            "ONE quieter botanical note besides the dominant surface" in prompt
            and "clearly subordinate to it" in prompt))
        results.append(check(
            f"{label}: a single floral element in a plain room is not the theme",
            "One isolated floral element in an otherwise plain contemporary room "
            "is not this theme." in prompt))
        results.append(check(
            f"{label}: one floral panel and nothing else is forbidden",
            "a generic contemporary room with one floral panel in it and nothing "
            "else botanical" in prompt))
        results.append(check(
            f"{label}: grey must be balanced, and kept when it is the product",
            "must be BALANCED against warmer ivory, blush and sage ones" in prompt
            and "keep it exactly as it is and warm the room around it" in prompt))
        results.append(check(
            f"{label}: grey taking over is forbidden",
            "large-format grey or neutral surfaces taking over the room" in prompt))
        results.append(check(
            f"{label}: the products themselves are still never altered",
            "KEEP THE REAL PRODUCT" in prompt
            and "Never recolour, repattern or substitute a supplied product" in prompt))

    results.append(check(
        "the feature wall is the living room's focal plane",
        "the room's focal plane, with the furniture arranged to face it" in living))
    results.append(check(
        "integration is part of what makes the theme right",
        "built into the architecture rather than hung on it" in living))

    # THE ROOM TYPE. The specification was written for bathrooms.
    results.append(check(
        "the living room is told the specification is not the room type",
        "THE SPECIFICATION BELOW DESCRIBES THE THEME, NOT THE ROOM TYPE" in living))
    results.append(check(
        "...to read its bathroom wording as this theme in a living room",
        "read it as this theme applied to a living room" in living))
    results.append(check(
        "...to take none of its sanitaryware",
        "take none of its sanitaryware" in living))
    results.append(check(
        "the room drawn is a living room, said outright",
        "It must read unmistakably as a living room and as nothing else." in living))
    results.append(check(
        "a bathroom needs no such caveat",
        "NOT THE ROOM TYPE" not in bathroom))
    results.append(check(
        "the floral description no longer opens by naming a bathroom",
        not floral["identity"].lower().startswith("a floral bathroom")))

    # THE VALIDATION. The check has to judge a living room as one.
    asked = _question(floral, theme_checklist("Floral"), "Living Room")
    results.append(check(
        "the check is told it is judging a living room",
        "ONE generated living room image" in asked))
    results.append(check(
        "...and looks at a living room's parts",
        "real seating, a media unit and side tables" in asked
        and "vanity, bathtub, shower" not in asked))
    results.append(check(
        "...and asks whether it reads as a generic contemporary living room",
        "generic contemporary living room" in asked))
    results.append(check(
        "the check asks about the pattern's distribution",
        "concentrated on one dominant surface, with the other walls plain" in asked))
    results.append(check(
        "...about the scale it repeats at",
        "one consistent scale and repeats realistically" in asked))
    results.append(check(
        "...about the balance of blush, sage and ivory",
        "all present and balanced, with no single one taking the whole room" in asked))
    results.append(check(
        "...and about whether the furnishings look coordinated",
        "deliberately coordinated with the floral scheme" in asked))
    results.append(check(
        "a plain wall beside the feature wall is not reported as missing floral",
        "that is the controlled distribution this theme asks for" in asked))
    results.append(check(
        "...and blush counts wherever it appears",
        "Blush is present if you can see it anywhere" in asked))
    results.append(check(
        "excess is reported only when the pattern really does cover the walls",
        "only when it actually covers most of the walls" in asked))

    results.append(check(
        "the check asks whether the surface is built in or set into another material",
        "rather than a framed rectangle set into another material" in asked))
    results.append(check(
        "...and is told how to tell the two apart",
        "INTEGRATED means the floral surface fills a real plane" in asked
        and "another material visible all the way around it is NOT integrated" in asked))
    results.append(check(
        "the check asks for the quieter botanical note",
        "A quieter botanical note appears somewhere besides it" in asked))
    results.append(check(
        "...and for warm surfaces balancing the grey",
        "balance any large grey or neutral surfaces" in asked))

    # The live board reported "a generic modern bathroom with one potted
    # plant" against a living room, and its OWN evidence said "The image
    # is a living room, not a bathroom". A prohibition naming another
    # room cannot be a finding about this one.
    results.append(check(
        "a prohibition naming another room type does not apply to this one",
        "you are judging a living room -- that item does not apply" in asked
        and "reporting it is a false positive" in asked))
    results.append(check(
        "...and evidence that contradicts the finding disqualifies it",
        "if what you saw shows the prohibited thing is absent, do not report it" in asked))

    with_no_room = _question(floral, theme_checklist("Floral"))
    results.append(check(
        "an unnamed room asks exactly what it asked before",
        "ONE generated bathroom image" in with_no_room
        and "vanity, bathtub, shower" in with_no_room))
    return results


def the_specification_reaches_the_prompt():
    """Chunk 4 Part C: both layers, and the theme's own rules in full."""
    results = []
    for label, (belongs, foreign) in PHOTOGRAPHED.items():
        prompt = build_room_scene_prompt(
            label, "A Board Name",
            {"room": "Bathroom", "surface": "WALL", "style": label},
        )
        found = describe_theme(label)

        results.append(check(
            f"{label}: the common instruction layer is present",
            "Treat the written specification as the design requirement" in prompt
            and "visually analyse every supplied reference photograph" in prompt))
        results.append(check(
            f"{label}: ...and the theme-specific layer beside it",
            "THE SPECIFICATION" in prompt and belongs in prompt.lower()))
        results.append(check(
            f"{label}: every mandatory rule is sent, in full",
            all(rule in prompt for rule in found["mandatory"]),
            [r[:50] for r in found["mandatory"] if r not in prompt]))
        results.append(check(
            f"{label}: every prohibited deviation is sent",
            all(item in prompt for item in found["avoid"]),
            [i[:40] for i in found["avoid"] if i not in prompt]))
        results.append(check(
            f"{label}: the success condition is sent",
            found["success"] in prompt))
        results.append(check(
            f"{label}: a mismatched product is kept, not recoloured",
            "KEEP THE REAL PRODUCT" in prompt
            and "Never recolour, repattern or substitute a supplied product" in prompt))
        results.append(check(
            f"{label}: no other theme's wording is present",
            foreign not in prompt.lower(), foreign))

    unknown = build_room_scene_prompt(
        "Brutalist", "X", {"room": "Bathroom", "surface": "WALL", "style": "Brutalist"})
    results.append(check(
        "an unknown theme gets no specification at all",
        "THE SPECIFICATION" not in unknown and theme_specification("Brutalist") == ""))
    return results


def the_check_asks_only_what_a_picture_can_answer():
    """The verdict must name things that are either in the image or not.

    The mandatory rules are written for the GENERATOR and include
    conditions and prohibitions -- "blue feature walls must NOT dominate
    unless they are the selected products", "a burgundy vanity and brass
    taps alone do not establish the theme". The check used to ask "is
    this visible?" of those, and the owner's British board duly reported
    them under "Not visible", which says nothing anyone can act on.
    """
    import re
    results = []
    unanswerable = re.compile(r"must NOT|alone do not|\bunless\b|may appear|\bnever \b", re.I)

    for label in [*PHOTOGRAPHED]:
        asked = theme_checklist(label)
        results.append(check(
            f"{label}: the check has something to ask", len(asked) >= 3, len(asked)))
        offending = [r[:70] for r in asked if unanswerable.search(r)]
        results.append(check(
            f"{label}: nothing it asks is a condition or a prohibition",
            not offending, offending))

        # ...while the generator still receives the full rules.
        rules = theme_rules(label)
        results.append(check(
            f"{label}: the generator still gets every mandatory rule",
            len(rules) >= len(describe_theme(label)["mandatory"]), len(rules)))

    results.append(check(
        "a theme with no configuration asks nothing", theme_checklist("Brutalist") == []))

    # The British board's exact complaint must not be reproducible.
    british = " ".join(theme_checklist("British"))
    results.append(check(
        "the lines the owner saw under \"Not visible\" are no longer asked",
        "must NOT dominate" not in british and "alone do not establish" not in british))
    results.append(check(
        "...and what IS asked is the owner's own final visual check",
        "immediately recognisable" in british
        and "Victorian or Edwardian architectural detailing" in british
        and "flooring" in british
        and "Botanical detailing is balanced" in british))
    return results


def the_theme_check_is_honest():
    """The five cases the owner asked for, plus the ways it must not lie.

    Gemini is stubbed: what is under test is how a reply is turned into
    a verdict, which is where a validator that recites its own avoid-list
    back would do its damage.
    """
    results = []

    for label, verdict in [
        ("no theme selected", check_theme("/nowhere.png", "")),
        ("no image to read", check_theme("/nowhere.png", "British")),
    ]:
        results.append(check(f"{label} -> unchecked, not a pass", verdict["status"] == "unchecked"))
    results.append(check(
        "...and it names the theme it could not check",
        check_theme("/nowhere.png", "British")["theme"] == "British"))

    image = ROOT / "assets" / "theme_references" / "british" / "01.webp"
    results.append(check("a real image to check against exists", image.is_file()))

    rules = theme_checklist("British")
    everything = ", ".join(str(i) for i in range(1, len(rules) + 1))

    def stub(payload):
        class Models:
            last = None

            @staticmethod
            def generate_content(**kwargs):
                Models.last = kwargs
                class R:
                    text = payload
                return R()

        class Client:
            models = Models
        return Client()

    # ── 1. a clearly compliant British bathroom ───────────────────────
    compliant = check_theme(image, "British", stub(
        '{"present": [' + everything + '], "missing": [], "uncertain": [], "deviations": [],'
        ' "products": "the tiles look consistently laid", "identity": "reads as a country house"}'))
    results.append(check("1. a compliant room -> PASS", compliant["status"] == "pass", compliant["status"]))
    results.append(check("1. ...with nothing missing and nothing flagged",
        compliant["missing"] == [] and compliant["deviations"] == [], compliant))
    results.append(check("1. ...and no recommendation to act on", compliant["recommendation"] == ""))

    # ── 2. a generic contemporary bathroom, generated for British ─────
    generic = check_theme(image, "British", stub(
        '{"present": [], "missing": [{"n": 1, "seen": "a plain modern room"},'
        ' {"n": 2, "seen": "flat painted walls, no panelling"},'
        ' {"n": 5, "seen": "plain large-format floor"}],'
        ' "deviations": [{"what": "generic modern luxury bathroom styling",'
        ' "seen": "frameless glass, floating vanity, no mouldings"}],'
        ' "products": "tiles look real", "identity": "generic contemporary"}'))
    results.append(check("2. a generic room -> FAIL", generic["status"] == "fail", generic["status"]))
    results.append(check("2. ...missing and deviations are separate",
        len(generic["missing"]) == 3 and len(generic["deviations"]) == 1, generic))
    results.append(check("2. ...and each carries what was SEEN",
        all("(" in m for m in generic["missing"]) and "floating vanity" in generic["deviations"][0]))

    # ── 3. prohibited dominant blue surfaces ──────────────────────────
    blue = check_theme(image, "British", stub(
        '{"present": [' + everything + '], "missing": [],'
        ' "deviations": [{"what": "dominant blue feature wall", "seen": "the shower wall is cobalt"}],'
        ' "products": "fine", "identity": "British apart from the blue"}'))
    results.append(check("3. a confirmed prohibited element -> FAIL", blue["status"] == "fail"))
    results.append(check("3. ...reported as a deviation, never as something missing",
        blue["missing"] == [] and "cobalt" in blue["deviations"][0], blue))
    results.append(check("3. ...and the recommendation says to replace it, keeping the products",
        "blue feature wall" in blue["recommendation"]
        and "Keep the selected catalog products exactly as they are" in blue["recommendation"],
        blue["recommendation"]))

    # ── 4. correct British styling, plain flooring ────────────────────
    floor = check_theme(image, "British", stub(
        '{"present": [1, 2, 3, 4], "missing": [{"n": 5, "seen": "plain pale floor, no pattern"}],'
        ' "deviations": [], "products": "fine", "identity": "British"}'))
    results.append(check("4. right styling, wrong floor -> PARTIAL, not FAIL",
        floor["status"] == "partial", floor["status"]))
    results.append(check("4. ...the one real gap is named, and nothing is invented",
        len(floor["missing"]) == 1 and floor["deviations"] == []
        and "plain pale floor" in floor["missing"][0], floor))
    results.append(check("4. ...and what IS right is acknowledged, not re-demanded",
        len(floor["present"]) == 4, floor["present"]))

    # ── 5. uncertain / partially visible characteristics ──────────────
    unsure = check_theme(image, "British", stub(
        '{"present": [1, 2], "missing": [],'
        ' "uncertain": [{"n": 3, "why": "the image is too dim to judge the colour"}],'
        ' "deviations": [], "products": "fine", "identity": "probably British"}'))
    results.append(check("5. uncertainty is NOT a failure", unsure["status"] != "fail", unsure["status"]))
    results.append(check("5. ...it is reported apart from the confirmed findings",
        len(unsure["uncertain"]) == 1 and unsure["missing"] == []
        and "too dim" in unsure["uncertain"][0], unsure))

    # ── a validator that recites its own lists back is the failure ────
    recited = check_theme(image, "British", stub(
        '{"present": [], "missing": [{"n": 1}, {"n": 2}],'
        ' "deviations": [{"what": "dominant blue feature walls"}, {"what": "excessive gold"}],'
        ' "products": "", "identity": ""}'))
    results.append(check(
        "a finding with no evidence is dropped, not reported",
        recited["missing"] == [] and recited["deviations"] == [], recited))
    results.append(check(
        "...so an evidence-free reply invents no failures",
        recited["missing"] == [] and recited["deviations"] == [] and recited["status"] != "fail",
        recited["status"]))
    results.append(check(
        "...and a reply that judged nothing is reported as unchecked, not as a pass",
        recited["status"] == "unchecked", recited["status"]))

    # ── it must ask about THIS theme, in both directions ──────────────
    probe = stub('{"present": [1], "missing": [], "deviations": []}')
    check_theme(image, "Rustic", probe)
    asked = " ".join(getattr(p, "text", "") or "" for p in probe.models.last["contents"])
    results.append(check("the question carries this theme's required characteristics",
        all(r in asked for r in theme_checklist("Rustic"))))
    results.append(check("...and its prohibitions, as a separate question",
        all(a in asked for a in describe_theme("Rustic")["avoid"])
        and "QUESTION A" in asked and "QUESTION B" in asked))
    results.append(check("...and tells the model that seeing none is the right answer",
        "Seeing none is the correct and expected answer" in asked))
    results.append(check("...and not to copy the prohibitions into its reply",
        "Do NOT copy this list" in asked))
    results.append(check("...and not another theme's wording", "zellige" not in asked.lower()))
    results.append(check("the image itself is sent, not its filename",
        any(getattr(p, "inline_data", None) is not None for p in probe.models.last["contents"])))

    # ── the model fallback, which the live 404 made necessary ─────────
    from app.theme_check import _candidate_models
    candidates = _candidate_models()
    results.append(check("the invented model name is gone", "gemini-3-flash" not in candidates, candidates))
    results.append(check("the candidates are models this project already runs",
        all(c.startswith("gemini-3.1-") for c in candidates), candidates))

    class Missing:
        class models:
            tried = []

            @staticmethod
            def generate_content(**kwargs):
                Missing.models.tried.append(kwargs["model"])
                raise RuntimeError("404 NOT_FOUND models/x is not found for API version v1beta")

    gone = check_theme(image, "British", Missing())
    results.append(check("every model missing -> unchecked, never a pass", gone["status"] == "unchecked"))
    results.append(check("...after trying each candidate",
        len(Missing.models.tried) == len(candidates), Missing.models.tried))

    class Quota:
        class models:
            calls = []

            @staticmethod
            def generate_content(**kwargs):
                Quota.models.calls.append(kwargs["model"])
                raise RuntimeError("429 RESOURCE_EXHAUSTED")

    quota = check_theme(image, "British", Quota())
    results.append(check("a real failure is not retried against every model",
        len(Quota.models.calls) == 1, Quota.models.calls))
    results.append(check("...and is reported as unchecked", quota["status"] == "unchecked"))

    # ── the owner's own board: the false positives must not recur ────
    #
    # Green panelled vanity, burgundy freestanding bathtub, brass
    # fittings, patterned floor, Victorian mirror -- on large-format
    # marble walls. The first validator called it NON-COMPLIANT and said
    # heritage green was missing.
    real = check_theme(image, "British", stub(
        '{"present": [1,2,4,5,7],'
        ' "partial": [{"n": 3, "seen": "green vanity and burgundy bathtub present, walls are brown marble"}],'
        ' "missing": [], "uncertain": [], "deviations": [],'
        ' "products": "consistently laid", "identity": "reads as a country house"}'))
    results.append(check(
        "the owner's board is PARTIAL, not NON-COMPLIANT", real["status"] == "partial", real["status"]))
    results.append(check(
        "...heritage green is PARTIAL, not missing",
        real["missing"] == [] and len(real["partial"]) == 1
        and "green vanity" in real["partial"][0], real))
    results.append(check(
        "...and the five characteristics it does have are acknowledged",
        len(real["present"]) == 5, real["present"]))

    # A prohibition stretched to fit must not fail the board.
    stretched = check_theme(image, "British", stub(
        '{"present": [1,2,4,5,7], "partial": [], "missing": [],'
        ' "deviations": [{"what": "a contemporary subway-tile bathroom",'
        ' "seen": "large-format marble panels that mimic subway proportions", "confident": false}],'
        ' "products": "ok", "identity": "British"}'))
    results.append(check(
        "a prohibition the model is not sure of does not fail the board",
        stretched["status"] != "fail" and stretched["deviations"] == [], stretched))
    results.append(check(
        "...it is reported as uncertain instead",
        any("possibly" in u for u in stretched["uncertain"]), stretched["uncertain"]))

    # One thin decorative element must not sink a room whose identity holds.
    thin = check_theme(image, "British", stub(
        '{"present": [1,2,3,4,5,7], "partial": [],'
        ' "missing": [{"n": 6, "seen": "no botanical pattern anywhere"}],'
        ' "deviations": [], "products": "ok", "identity": "British"}'))
    results.append(check(
        "one missing decorative element is PARTIAL when the identity holds",
        thin["status"] == "partial", thin["status"]))

    # ...but a room that is NOT the theme still fails.
    notTheme = check_theme(image, "British", stub(
        '{"present": [], "partial": [],'
        ' "missing": [{"n": 1, "seen": "a plain modern hotel bathroom"},'
        ' {"n": 2, "seen": "flat walls"}, {"n": 4, "seen": "floating vanity"},'
        ' {"n": 5, "seen": "plain floor"}, {"n": 7, "seen": "generic"}],'
        ' "deviations": [], "products": "ok", "identity": "generic contemporary"}'))
    results.append(check(
        "a room whose identity is absent still FAILS", notTheme["status"] == "fail", notTheme["status"]))

    # ...and a confidently seen prohibition still fails.
    realDeviation = check_theme(image, "British", stub(
        '{"present": [1,2,4,5,7], "partial": [], "missing": [],'
        ' "deviations": [{"what": "dominant blue feature wall",'
        ' "seen": "the entire shower wall is cobalt gloss", "confident": true}],'
        ' "products": "ok", "identity": "British apart from the blue"}'))
    results.append(check(
        "a prohibition actually seen still FAILS", realDeviation["status"] == "fail"))

    # The counting rules must reach the model.
    probe2 = stub('{"present": [1], "partial": [], "missing": [], "deviations": []}')
    check_theme(image, "British", probe2)
    asked2 = " ".join(getattr(p, "text", "") or "" for p in probe2.models.last["contents"])
    results.append(check(
        "the model is told presence is not dominance", "PRESENCE IS NOT DOMINANCE" in asked2))
    results.append(check(
        "...that a green vanity counts", "A green vanity is heritage green" in asked2))
    results.append(check(
        "...that large-format stone is not subway tile",
        "are NOT subway tiles" in asked2))
    results.append(check(
        "...and it is offered all four states",
        all(w in asked2 for w in ["present ", "partial ", "missing ", "uncertain "])))
    results.append(check(
        "...and told to look at the whole room", "Look at the WHOLE room" in asked2))

    results.append(check("an unchecked verdict reads as unchecked, never as approval",
        "not checked" in summarise(check_theme("/nowhere.png", "British"))))
    return results


def main():
    groups = [
        ("every theme is configured", every_theme_is_configured()),
        ("each theme has its own references", each_theme_has_its_own_references()),
        ("the prompt carries the right theme", the_prompt_carries_the_right_theme()),
        ("the photographs are actually sent", the_photographs_are_actually_sent()),
        ("the tile step knows the theme too", the_tile_step_knows_the_theme_too()),
        ("the theme holds in every room", the_theme_holds_in_every_room()),
        ("the specification reaches the prompt", the_specification_reaches_the_prompt()),
        ("the floral living room is furnished and controlled",
         the_floral_living_room_is_furnished_and_controlled()),
        ("the check asks only what a picture can answer",
         the_check_asks_only_what_a_picture_can_answer()),
        ("the theme check is honest", the_theme_check_is_honest()),
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
