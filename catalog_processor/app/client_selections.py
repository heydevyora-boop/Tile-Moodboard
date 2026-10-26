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


def describe_space(room: Any) -> Optional[Dict[str, str]]:
    """The bathroom subcategory the room selection names, if any.

    Only bathroom subcategories are returned: the generator draws a
    bathroom scene, so a kitchen or bedroom selection has no bathroom
    subcategory to express.
    """
    key = _key(room)
    if "powder" in key:
        return {
            "noun": "powder washroom",
            "description": (
                "a compact powder washroom -- vanity, basin and "
                "mirror, with no shower and no bathtub"
            ),
        }
    if "bath" in key:
        return {
            "noun": "bathroom",
            "description": "a full bathroom with a walk-in shower zone",
        }
    return None


FEATURE_PLACEMENTS = {
    "basin wall": "the wall behind the vanity and basin",
    "shower nook": "the shower niche and its shelf return",
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

    A shower nook cannot exist in a powder washroom, which has no
    shower; that pairing returns None instead of asking the model to
    build a shower the room selection excludes. Both stages ask, so only
    the caller that passes log=True reports it -- once per request.
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
    if placement and key == "shower nook" and "powder" in _key(room):
        if log:
            print(
                "  [visualization] feature 'Shower nook' ignored: a powder "
                "washroom has no shower"
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
