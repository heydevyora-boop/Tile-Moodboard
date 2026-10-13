"""Regression: architectural frames / room scenes must not become tiles.

THE FAILURE THIS COVERS
-----------------------
Drive outputs from mozart_frame_collection saved render regions that were
architectural frames, door panels with knobs, and room crops with windows /
lifestyle props. Tile-only mode was force-accepting every purity rejection
except multi-product splits, so hard non-tile evidence never reached Drive
as a reject.

WHAT THIS TEST CHECKS
---------------------
Pure local rules -- assess_tile_purity + tile_only_may_force_accept -- with
hand-written observations matching the failure modes. No Gemini, no Drive,
no screenshots as fixtures (the attached Drive previews were used for
visual diagnosis only).

Run:  python3 test_frame_scene_rejection.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.image_validator import (  # noqa: E402
    MATERIAL_DECOR,
    MATERIAL_TILE,
    PURITY_CLEAN,
    PURITY_CONTAMINATED,
    PURITY_NOT_TILE,
    assess_tile_purity,
    normalize_material,
    tile_only_may_force_accept,
)


def observation(material="TILE", **overrides):
    base = {
        "material": material,
        "physical_surface": True,
        "tile_fraction": 0.97,
        "distinct_tile_designs": 1,
        "is_scene": False,
        "contains_person": False,
        "contains_text": False,
        "contains_logo": False,
        "contains_furniture": False,
        "contains_fixture": False,
        "contains_object": False,
        "reason": "test",
    }
    base.update(overrides)
    return base


def check(label, ok, detail=""):
    return (label, bool(ok), detail)


def main():
    outcomes = []

    # Genuine products still pass.
    for material, label in (
        ("TILE", "standalone field tile"),
        ("HIGHLIGHTER", "genuine highlight tile"),
        ("DECOR_PANEL", "genuine decorative tile panel"),
    ):
        purity = assess_tile_purity(observation(material))
        outcomes.append(check(
            f"{label} stays CLEAN",
            purity["state"] == PURITY_CLEAN,
            purity["reason"],
        ))
        outcomes.append(check(
            f"{label} normalizes as product",
            normalize_material(material) in {MATERIAL_TILE, MATERIAL_DECOR},
        ))

    # Mozart-style invalid crops.
    cases = [
        ("architectural ornamental frame",
         observation("ARCHITECTURE", tile_fraction=0.55, is_scene=True),
         PURITY_NOT_TILE),
        ("door / cabinet panel with hardware",
         observation("DOOR", contains_furniture=True, contains_object=True,
                     tile_fraction=0.6),
         PURITY_NOT_TILE),
        ("room crop with towels / bottles",
         observation("PAINTED_WALL", is_scene=True, contains_object=True,
                     tile_fraction=0.4),
         PURITY_NOT_TILE),
        ("wall panel + window fragment",
         observation("WINDOW_FRAME", is_scene=True, contains_fixture=True,
                     tile_fraction=0.5),
         PURITY_NOT_TILE),
        ("furniture-contaminated tile naming",
         observation("TILE", contains_furniture=True, tile_fraction=0.85),
         PURITY_CONTAMINATED),
        ("multi-product catalog region",
         observation("TILE", distinct_tile_designs=3),
         PURITY_CONTAMINATED),
    ]

    for label, obs, expected in cases:
        purity = assess_tile_purity(obs)
        outcomes.append(check(
            f"{label} -> {expected}",
            purity["state"] == expected,
            f"got {purity['state']}: {purity['reason']}",
        ))

        metadata = {"purity": obs, "purity_state": purity["state"]}
        status = (
            "NEEDS_ISOLATION" if purity["state"] == PURITY_CONTAMINATED
            else "GEMINI_REJECTED"
        )
        outcomes.append(check(
            f"{label}: tile-only must NOT force-accept",
            tile_only_may_force_accept(status, metadata) is False,
        ))

    # Soft mislabel on a clean swatch may still be overridden.
    soft = observation("OTHER")
    soft_purity = assess_tile_purity(soft)
    outcomes.append(check(
        "OTHER clean swatch is CLEAN (soft path)",
        soft_purity["state"] == PURITY_CLEAN,
        soft_purity["reason"],
    ))
    outcomes.append(check(
        "tile-only may override a soft classifier reject when purity is clean",
        tile_only_may_force_accept(
            "GEMINI_REJECTED",
            {"purity": soft, "purity_state": soft_purity["state"]},
        ) is True,
    ))

    # Bare WALL_PANEL / PANEL are not decorative tile names anymore.
    outcomes.append(check(
        "WALL_PANEL normalizes to non-tile",
        normalize_material("WALL_PANEL") == "WALL_PANEL",
    ))
    outcomes.append(check(
        "WALL_PANEL observation is NOT_TILE",
        assess_tile_purity(observation("WALL_PANEL"))["state"] == PURITY_NOT_TILE,
    ))

    failures = 0
    print("frame / room-scene rejection regression")
    print("=" * 40)
    for label, ok, detail in outcomes:
        if ok:
            print(f"  PASS  {label}")
        else:
            failures += 1
            print(f"  FAIL  {label}" + (f"  [{detail}]" if detail else ""))

    print()
    print(f"{len(outcomes) - failures}/{len(outcomes)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
