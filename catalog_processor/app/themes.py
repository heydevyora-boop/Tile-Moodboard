"""
themes.py

The design themes the mood board offers, as the generator needs them.

A theme reached the generator as a bare label. "Moroccan" was dropped
into the room prompt as an adjective -- "a photorealistic luxury
moroccan bathroom interior" -- and that was the whole of it. The model
was left to recall what Moroccan means, so the theme showed up as a
colour wash and a lamp rather than as zellige, arches and brasswork.

Two things are added here, and nothing else about the flow changes:

  description   what the theme actually asks for, in the catalog
                owner's own words. It goes into the prompt as text.

  references    photographs of real bathrooms in that theme. They go to
                Gemini as IMAGE PARTS, because a filename communicates
                nothing -- the point of a reference is that the model
                LOOKS at it.

The labels are the ones in frontend/mood-board.html (THEMES), which is
what the wizard sends as requirements.style. They are matched case- and
separator-insensitively, so "Roman Touch", "ROMAN_TOUCH" and
"roman-touch" are one theme.

This file holds no palette, no swatch and no card art: those already
exist in the wizard and in tileRecommendation.service.ts, and the
generator does not read them. It holds only what Gemini is given.
"""

from pathlib import Path
from typing import Any, Dict, List, Optional

ASSETS = Path(__file__).resolve().parent.parent / "assets" / "theme_references"


def _key(value: Any) -> str:
    """The same normalisation client_selections uses for its selections."""
    return " ".join(
        str(value or "").replace("_", " ").replace("-", " ").replace("&", " and ").lower().split()
    )


# Every theme the wizard offers. `slug` names the folder under
# assets/theme_references/; a theme with no folder simply has no
# references, which the caller reports rather than papers over.
THEMES: Dict[str, Dict[str, str]] = {
    "british": {
        "label": "British",
        "palette": "Heritage Green, Oxblood & Brass",
        "slug": "british",
        "description": (
            "A classic British heritage bathroom: deep forest-green tiles, rich "
            "oxblood accents, antique brass fixtures and elegant Victorian "
            "detailing. Vintage mirrors, refined patterns, and timeless luxury "
            "with a sophisticated country-house aesthetic."
        ),
    },
    "roman touch": {
        "label": "Roman Touch",
        "palette": "Travertine, Stone & Terracotta",
        "slug": "roman-touch",
        "description": (
            "A Roman-inspired bathroom: warm travertine stone, natural limestone "
            "textures, arched niches and sculptural stone basins. Subtle "
            "terracotta accents, soft warm lighting and balanced architectural "
            "proportions, for a luxurious Mediterranean spa feel."
        ),
    },
    "floral": {
        "label": "Floral",
        "palette": "Blush, Sage & Ivory",
        "slug": "floral",
        "description": (
            "A floral-inspired bathroom: delicate flower patterns, botanical "
            "motifs, blush-pink surfaces, sage-green accents and ivory finishes. "
            "Floral tiles or wallpaper carry the focal point, with elegant "
            "fixtures and a soft, romantic, garden-inspired atmosphere."
        ),
    },
    "tropical": {
        "label": "Tropical",
        "palette": "Palm, Teal & Sand",
        "slug": "tropical",
        "description": (
            "A tropical bathroom: palm-leaf patterns, lush green plants, teal "
            "accents and sand-toned natural stone. Organic textures, natural "
            "wood and abundant greenery, for a fresh, relaxing resort-style "
            "environment."
        ),
    },
    "geometrical": {
        "label": "Geometrical",
        "palette": "Ivory, Graphite & Terracotta",
        "slug": "geometrical",
        "description": (
            "A contemporary bathroom with bold geometric tiles, clean lines and "
            "structured patterns in ivory, graphite and terracotta. Hexagons, "
            "angular motifs or repeating shapes as feature elements, with visual "
            "balance and a modern architectural aesthetic."
        ),
    },
    "metallic": {
        "label": "Metallic",
        "palette": "Pearl, Gunmetal & Champagne",
        "slug": "metallic",
        "description": (
            "A sophisticated metallic bathroom: pearl-toned surfaces, "
            "champagne-gold fittings, gunmetal accents and subtle reflective "
            "finishes. Elegant stone textures, sleek fixtures and carefully "
            "balanced metallic detail, for a premium contemporary look."
        ),
    },
    "rustic": {
        "label": "Rustic",
        "palette": "Natural Clay, Terracotta & Ochre",
        "slug": "rustic",
        "description": (
            "An earthy rustic bathroom: terracotta tiles, natural clay textures, "
            "ochre accents and warm wooden elements. Handmade finishes, organic "
            "stone basins and imperfect natural textures, for an authentic, warm, "
            "handcrafted aesthetic."
        ),
    },
    "moroccan": {
        "label": "Moroccan",
        "palette": "Zellige, Cobalt & Saffron",
        "slug": "moroccan",
        "description": (
            "A Moroccan-inspired bathroom: handcrafted zellige tiles, rich "
            "cobalt-blue surfaces, saffron-yellow accents and decorative mosaic "
            "patterns. Arched niches, intricate tilework and brass details, for a "
            "vibrant, exotic, artisanal atmosphere."
        ),
    },
    # Offered by the wizard, and the one theme with no photographs yet.
    # It is here so the description still reaches Gemini; references_for
    # returns nothing and the caller says so.
    "black and white": {
        "label": "Black & White",
        "palette": "Ivory, Ash & Charcoal",
        "slug": "black-white",
        "description": (
            "A monochrome bathroom in ivory, ash and charcoal: high contrast "
            "between pale fields and dark detail, graphic borders or chequer "
            "work, and fittings in a single finish. No third colour anywhere."
        ),
    },
}


def describe_theme(theme: Any) -> Optional[Dict[str, str]]:
    """The theme a selection names, or None when it names none."""
    return THEMES.get(_key(theme))


def reference_images(theme: Any) -> List[Path]:
    """
    The photographs for this theme, in a stable order.

    An empty list means this theme has no references on disk. That is a
    fact the caller has to state rather than hide: the request then goes
    out with the description alone, and the prompt says so.
    """
    found = describe_theme(theme)
    if not found:
        return []

    folder = ASSETS / found["slug"]
    if not folder.is_dir():
        return []

    return sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in {".webp", ".jpg", ".jpeg", ".png"})


def theme_brief(theme: Any) -> str:
    """
    The theme as prompt text: its name, its palette and what it asks for.

    Empty when the selection names no theme the generator knows -- the
    caller then says nothing about the theme rather than inventing one.
    """
    found = describe_theme(theme)
    if not found:
        return ""

    return (
        f"{found['label']} -- {found['palette']}.\n{found['description']}"
    )
