"""
themes.py

The design themes, as the IMAGE generator needs them.

A theme reached the generator as a bare label. "Moroccan" was dropped
into the room prompt as an adjective -- "a photorealistic luxury
moroccan bathroom interior" -- and that was the whole of it. The model
was left to recall what Moroccan means, so the theme showed up as a
colour wash and a lamp rather than as zellige, arches and brasswork.

Three things reach Gemini from here, and nothing else about the flow
changes:

  specification  what the theme asks for: its palette, its visual
                 identity, the rules it must satisfy, the deviations it
                 forbids, and the condition it is judged against. Sent
                 as text.

  references     photographs of real bathrooms in that theme. Sent as
                 IMAGE PARTS, because a filename communicates nothing --
                 the point of a reference is that the model LOOKS at it.

  checklist      the same mandatory rules, reused by the theme check
                 that reads the finished image back.

THE SOURCE OF TRUTH IS shared/themes.json, which the Node side reads
too (backend/src/services/themes.service.ts) so the step that PICKS the
tiles is held to the same specification as the step that draws them.
Node and Python are separate functions on Vercel with no shared disk and
no shared package -- they cannot import one module, but they can read
one file, and vercel.json bundles it into both.

This file holds no palette swatch and no card art: those already exist
in the wizard and in tileRecommendation.service.ts, and the generator
does not read them.
"""

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets" / "theme_references"
CONFIG = ROOT.parent / "shared" / "themes.json"


def _key(value: Any) -> str:
    """The same normalisation themes.service.ts uses, so one label cannot mean two things."""
    return " ".join(
        str(value or "")
        .replace("_", " ")
        .replace("-", " ")
        .replace("&", " and ")
        .lower()
        .split()
    )


def _load() -> Dict[str, Dict[str, Any]]:
    """
    The themes, read once.

    A missing or unreadable file is LOUD but not fatal. Raising here
    would take every visualization down, not just the theme -- and a
    client who asked for a kitchen would get an error instead of a
    kitchen. So it complains to the log and returns nothing, which puts
    every theme on the path an unrecognised theme already takes: the
    prompt says nothing about a theme rather than inventing one, and the
    board still generates.

    It must never fail silently. A generator that quietly knows no
    themes produces exactly the generic bathroom this file exists to
    prevent.
    """
    try:
        with CONFIG.open(encoding="utf-8") as handle:
            document = json.load(handle)
    except (OSError, ValueError) as error:
        print(
            f"  [visualization] THE THEME CONFIGURATION IS UNUSABLE at {CONFIG}: {error}. "
            "Every board will generate WITHOUT its theme until this is fixed. "
            "On Vercel it is bundled by the includeFiles entry in vercel.json."
        )
        return {}

    themes = document.get("themes")
    if not isinstance(themes, dict) or not themes:
        print(
            f"  [visualization] THE THEME CONFIGURATION at {CONFIG} HAS NO THEMES. "
            "Every board will generate without its theme until this is fixed."
        )
        return {}
    return themes


THEMES: Dict[str, Dict[str, Any]] = _load()


def _index(themes: Dict[str, Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """
    Every name a theme answers to.

    The key is what the wizard's label normalises to. A theme may also
    declare aliases, for an id that normalises differently -- "Black &
    White" becomes "black and white", while its id `black_white` becomes
    "black white", and both have to find the same theme.
    """
    index: Dict[str, Dict[str, Any]] = {}
    for key, theme in themes.items():
        index[key] = theme
        index[_key(theme.get("id"))] = theme
        for alias in theme.get("aliases", []):
            index[_key(alias)] = theme
    index.pop("", None)
    return index


_BY_NAME: Dict[str, Dict[str, Any]] = _index(THEMES)


def describe_theme(theme: Any) -> Optional[Dict[str, Any]]:
    """The theme a selection names, by label, id or alias; None when it names none."""
    return _BY_NAME.get(_key(theme))


def reference_images(theme: Any) -> List[Path]:
    """
    The photographs for this theme, in a stable order.

    An empty list means this theme has no references on disk. That is a
    fact the caller has to state rather than hide: the request then goes
    out with the specification alone, and the prompt says so.
    """
    found = describe_theme(theme)
    if not found:
        return []

    folder = ASSETS / found["slug"]
    if not folder.is_dir():
        return []

    return sorted(
        path for path in folder.iterdir()
        if path.is_file() and path.suffix.lower() in {".webp", ".jpg", ".jpeg", ".png"}
    )


def room_styling(theme: Any, room: Any) -> List[str]:
    """
    What this theme's furnishing looks like in THIS room, if it says.

    A theme is described once and then asked for in seven different
    spaces. Most of what it says travels: a palette, a motif, a material
    is the same thing in a bathroom and in a living room. Furniture is
    not. "Sage-green sofas, ivory accent chairs, a coffee table" is the
    whole of what makes a floral LIVING ROOM read as designed rather
    than wallpapered, and it is meaningless in a floral bathroom -- so
    it cannot go in the shared description, and it cannot go in
    client_selections.py either, where it would hand British and
    Moroccan living rooms a sage sofa.

    Keyed by the room's own noun from SPACES. A theme that says nothing
    about the selected room returns nothing, which is what every theme
    did before this existed.
    """
    found = describe_theme(theme)
    if not found:
        return []
    rooms = found.get("rooms")
    if not isinstance(rooms, dict):
        return []
    wanted = _key(room)
    for name, styling in rooms.items():
        if _key(name) == wanted:
            return list(styling or [])
    return []


def theme_specification(theme: Any, room: Any = None) -> str:
    """
    The theme as prompt text: everything the owner wrote about it.

    Empty when the selection names no theme this knows -- the caller then
    says nothing about the theme rather than inventing one.

    `room` is optional and adds nothing unless this theme has written
    something for that room; see room_styling.
    """
    found = describe_theme(theme)
    if not found:
        return ""

    lines = [
        f"{found['label']} -- {found['palette']}.",
        "",
        found["identity"],
        "",
        "MANDATORY for this theme:",
    ]
    lines += [f"- {rule}" for rule in found["mandatory"]]
    lines += ["", "FORBIDDEN in this theme -- none of these may appear:"]
    lines += [f"- {item}" for item in found["avoid"]]

    styling = room_styling(theme, room)
    if styling:
        lines += [
            "",
            f"IN THIS ROOM -- how this theme is furnished in a {_key(room)}:",
        ]
        lines += [f"- {item}" for item in styling]

    lines += ["", f"IT IS RIGHT WHEN: {found['success']}"]
    return "\n".join(lines)


def theme_checklist(theme: Any) -> List[str]:
    """
    What the finished image is judged on.

    NOT the mandatory rules. Those are written for the generator and
    include conditions and prohibitions -- "blue feature walls must NOT
    dominate unless they are the selected products", "a burgundy vanity
    and brass taps alone do not establish the theme". Asking "is this
    visible in the picture?" of a rule like that is meaningless, and the
    board showed it: the owner's British board reported those very lines
    under "Not visible", which says nothing anyone can act on.

    `visible` is the positive half -- the things that either are or are
    not in the photograph. A theme without one falls back to its
    mandatory rules, which is the old behaviour.
    """
    found = describe_theme(theme)
    if not found:
        return []
    return list(found.get("visible") or found["mandatory"])


def theme_rules(theme: Any) -> List[str]:
    """The mandatory rules, for the prompts. See theme_checklist for the other half."""
    found = describe_theme(theme)
    return list(found["mandatory"]) if found else []


# Kept so existing callers and tests keep working; theme_specification is
# what the prompts use now.
def theme_brief(theme: Any) -> str:
    """The theme's name, palette and identity, without its rule lists."""
    found = describe_theme(theme)
    if not found:
        return ""
    return f"{found['label']} -- {found['palette']}.\n{found['identity']}"
