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
                "a compact powder washroom -- vanity, basin, WC and "
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
    placement = FEATURE_PLACEMENTS.get(_key(feature))
    if placement and _key(feature) == "shower nook" and "powder" in _key(room):
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
