"""
client_selections.py

The client's mood-board selections, interpreted once for both
generation stages.

Stage 1 designs the room and Stage 2 installs the tile into it. Both
read the same selections, and a selection that means one thing to the
room and another to the install is how a feature wall ends up behind the
vanity in one step and in the shower in the next. So each selection is
translated here, in one place.

Every value is read case- and separator-insensitively ("Powder Room",
"POWDER ROOM", "powder_room" are the same selection), as the system
prompt requires. An unrecognised or empty value yields None: nothing is
said about it, rather than a guess being presented to the model as the
client's choice.

The phrasing mirrors the wizard's own descriptions in
frontend/mood-board.html (ROOMS, FEATURES, VIEWS).
"""

from typing import Any, Dict, Optional


def _key(value: Any) -> str:
    return " ".join(
        str(value or "").replace("_", " ").replace("-", " ").lower().split()
    )


# EVERY ROOM THE WIZARD OFFERS.
#
# This held only the two wet ones, and every other selection fell
# through to None -- which the room generator read as "no room was
# named" and drew its default bathroom. A client who chose Kitchen &
# Dining, on a board whose own button said GENERATE KITCHEN & DINING
# SCENE, got a vanity, a basin and a mirror.
#
# `noun` is what the room is called in the prompts, `fixtures` is what
# has to be in the photograph for it to read as that room, and
# `features` is where its statement tile may go -- the same pairs the
# wizard offers, so a stale selection from another room cannot be
# passed off as this one's.
#
# `kind` is how the space is referred to -- an interior, unless it is
# open to the sky.
#
# `doctrine_8a` marks the rooms Section 8A of the system prompt applies
# to. It says so itself ("applies only when the selected space is a
# Bathroom"), and it was being handed to every room regardless.
#
# Ordered, and matched on a substring, because the first match wins:
# "powder" has to be tried before "bath", and "Kitchen & Dining" must
# not be read as a dining room of its own.
SPACES = (
    ("powder", {
        "noun": "powder washroom",
        "description": (
            "a compact powder washroom -- vanity, basin and "
            "mirror, with no shower and no bathtub"
        ),
        "fixtures": "a real vanity, basin and mirror",
        "features": ("basin wall", "mirror wall"),
        "doctrine_8a": True,
    }),
    ("bath", {
        "noun": "bathroom",
        "description": "a full bathroom with a walk-in shower zone",
        "fixtures": "a real vanity, basin, mirror and shower fittings",
        "features": ("basin wall", "shower nook"),
        "doctrine_8a": True,
    }),
    ("kitchen", {
        "noun": "kitchen",
        "description": (
            "a kitchen with a run of counter, cabinets above and "
            "below it, and the splashback between them"
        ),
        "fixtures": (
            "real cabinets, a worktop, a sink, a hob and the "
            "splashback wall behind them"
        ),
        "features": ("splashback", "island face"),
    }),
    ("bedroom", {
        "noun": "bedroom",
        "description": "a bedroom with the bed against its feature wall",
        "fixtures": "a real bed, side tables and a wardrobe",
        "features": ("headboard wall", "wardrobe return"),
    }),
    ("living", {
        "noun": "living room",
        "description": "a living room with seating facing a media wall",
        "fixtures": "real seating, a media unit and side tables",
        "features": ("media wall", "fireplace wrap"),
    }),
    ("balcony", {
        "noun": "balcony",
        "description": (
            "an open balcony or patio in daylight, with a parapet "
            "and an outdoor floor"
        ),
        "fixtures": "a real parapet, railing and outdoor seating",
        "features": ("boundary wall", "planter return"),
        "kind": "outdoor space",
    }),
    ("patio", {
        "noun": "patio",
        "description": (
            "an open patio in daylight, with a boundary wall and an "
            "outdoor floor"
        ),
        "fixtures": "a real boundary wall, railing and outdoor seating",
        "features": ("boundary wall", "planter return"),
        "kind": "outdoor space",
    }),
)


def describe_space(room: Any) -> Optional[Dict[str, Any]]:
    """The room the selection names, or None when it names none."""
    key = _key(room)
    for marker, space in SPACES:
        if marker in key:
            return space
    return None


# Where each room's statement tile goes. The wizard offers two per room
# (frontend/mood-board.html, ROOM_FEATURES); both are here, plus the
# walls the Custom option names, which belong to any room.
FEATURE_PLACEMENTS = {
    "basin wall": "the wall behind the vanity and basin",
    "shower nook": "the shower niche and its shelf return",
    "mirror wall": "the wall behind the mirror, carried full height",
    "media wall": "the wall behind the television and console",
    "fireplace wrap": "the hearth surround and its return",
    "headboard wall": "the wall behind the bed, across its full width",
    "wardrobe return": "the wardrobe face and its return",
    "splashback": "the wall between the counter and the overhead units",
    "island face": "the island cladding and its return",
    "boundary wall": "the parapet, on its weather-exposed face",
    "planter return": "the planter face and the step riser",
}

# The walls the wizard's Custom option lets a client name, each written
# as a noun phrase that reads after "Feature wall: ". They share one
# trailing clause, added once below, rather than each repeating it.
NAMED_WALLS = {
    "left wall": "the left-hand wall",
    "right wall": "the right-hand wall",
    "front wall": "the wall facing you",
    "back wall": "the wall behind you",
}

# How the client says "I have not decided -- you decide".
STUDIO_DECIDES = "left to the studio"


def _named_walls(key: str) -> Optional[str]:
    """The placement a Custom selection names, or None if it names none.

    Matched on "<side> wall" rather than on the whole sentence, so the
    wording the wizard builds can change without this losing the
    selection. "left to the studio" cannot collide with "left wall".
    """
    chosen = [phrase for wall, phrase in NAMED_WALLS.items() if wall in key]
    if not chosen:
        return None

    if len(chosen) == 1:
        walls, treat = chosen[0], "Treat that as the statement surface"
    else:
        walls = ", ".join(chosen[:-1]) + " and " + chosen[-1]
        treat = "Treat those together as one statement surface"

    return (
        f"{walls}, taking the doorway as the point of view. {treat} "
        "and leave every other wall in the plain base finish"
    )


def describe_feature(
    feature: Any,
    room: Any = None,
    log: bool = False,
) -> Optional[str]:
    """Where the statement tile goes, or None when no placement was chosen.

    A placement belonging to another room returns None instead of asking
    the model to build something this room does not have -- a shower
    nook in a powder washroom, which has no shower, or a basin wall in a
    kitchen. The wizard only offers each room its own two, so this
    catches a selection saved before that was true. Both stages ask, so
    only the caller that passes log=True reports it -- once per request.
    """
    key = _key(feature)

    # The wizard's Custom option, which names walls itself or hands the
    # choice back. Checked before the fixed table: those two entries
    # name a fitting, these name a wall, and neither can match the other.
    if STUDIO_DECIDES in key:
        return (
            "one wall of your choosing -- pick the wall the room's "
            "layout already makes the focus, and use only that one"
        )

    named = _named_walls(key)
    if named:
        return named

    placement = FEATURE_PLACEMENTS.get(key)
    space = describe_space(room)
    if placement and space and key not in space["features"]:
        if log:
            print(
                f"  [visualization] feature '{text(feature)}' ignored: a "
                f"{space['noun']} does not have one"
            )
        return None
    return placement


def wants_no_feature_wall(feature: Any) -> bool:
    return _key(feature) == "no feature wall"


VIEW_FRAMINGS = {
    "front elevation": (
        "a straight-on front elevation of the main wall, for "
        "like-for-like comparison"
    ),
    "vanity close up": (
        "a close crop on the vanity and basin with the wall behind them"
    ),
    "media wall close up": (
        "a close crop on the console wall and its return"
    ),
    "headboard close up": (
        "a close crop on the bed wall and its return"
    ),
    "splashback close up": (
        "a close crop on the counter run and the wall behind it"
    ),
    "parapet close up": (
        "a close crop on the boundary wall and the floor junction"
    ),
    "wide corner": (
        "a wide corner view showing the floor and the wall junction "
        "together"
    ),
}


def describe_view(view: Any) -> Optional[str]:
    return VIEW_FRAMINGS.get(_key(view))


SURFACE_PHRASES = {
    "WALL": "walls",
    "BACK_WALL": "back wall",
    "SHOWER_WALL": "shower wall",
    "FLOOR": "floor",
    "BOTH": "walls and floor",
}


def describe_surface_for_room(surface: Any) -> str:
    """The surface the tile will be installed on, as the room sees it."""
    return SURFACE_PHRASES.get(
        str(surface or "").strip().upper(),
        "wall and floor areas",
    )


def tile_goes_on_floor(surface: Any) -> bool:
    return str(surface or "").strip().upper() in {"FLOOR", "BOTH"}


def text(value: Any) -> str:
    """A selection's display text, or "" when it was not supplied."""
    return str(value or "").strip()
