"""Regression: a decorative product is a PRODUCT, a picture is not.

THE FAILURE THIS COVERS
-----------------------
A real catalog page laid out nine products. Five were extracted.

The four that vanished were not plain square field tiles: they were the
highlighter, the border, the 3D relief panel and the mosaic sheet -- the
decorative half of the range, sold under their own codes, on their own
rows. The purity verifier named them for what they looked like
("DECOR_PANEL", "HIGHLIGHTER", "BORDER"), none of those words was TILE,
and `ARTWORK` was defined in the prompt as "a printed picture, poster,
mural or DECORATIVE PANEL" -- so every one of them landed in
NON_TILE_MATERIALS and was rejected as artwork.

The fix is NOT "decorative = accept". That would readmit the printed
page motif this pipeline already learned to refuse. It is that
"decorative" stops being a verdict at all:

    decorative + a real physical piece   -> a product, judged on the
                                            same rules as any tile
    decorative + ink on the page         -> still rejected

WHAT THIS TEST ACTUALLY CHECKS
------------------------------
assess_tile_purity is the REAL decision rule -- no stub, no API key. The
observations are hand-written, which is the point: each case fixes one
exact combination of what a verifier might report, so a change that
widens the gate by accident fails a named case here rather than being
discovered on a catalog.

Run:  python3 test_decorative_products.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.image_validator import (  # noqa: E402
    MATERIAL_DECOR,
    MATERIAL_TILE,
    MATERIAL_UNDECIDED,
    PURITY_CLEAN,
    PURITY_CONTAMINATED,
    PURITY_NOT_TILE,
    assess_tile_purity,
    normalize_material,
)


def observation(material, **overrides):
    """A clean, physical, single-design frame of `material`.

    Everything that is not the axis under test is set to the innocent
    value, so a case that fails fails for the reason it names.
    """
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


# ------------------------------------------------------------------
# The nine products of the failing page, by the word a verifier would
# most plausibly reach for. Every one is a real manufactured piece.
# ------------------------------------------------------------------
PRODUCT_MATERIALS = [
    ("base tile", "TILE"),
    ("large-format slab", "PORCELAIN_SLAB"),
    ("highlighter", "HIGHLIGHTER"),
    ("border", "BORDER"),
    ("listello strip", "LISTELLO"),
    ("decorative panel", "DECOR_PANEL"),
    ("3D relief panel", "RELIEF_PANEL"),
    ("embossed panel", "EMBOSSED"),
    ("mosaic sheet", "MOSAIC_SHEET"),
    ("floral / patterned face", "PATTERNED"),
    ("accent insert", "ACCENT"),
    ("special shape", "SPECIAL_SHAPE"),
    ("narrow strip", "STRIP_TILE"),
]

# Things that are NOT products however clean the frame is. These are the
# cases that must not be swept up by widening the gate.
NON_PRODUCT_MATERIALS = [
    ("printed page graphic", "GRAPHIC"),
    ("poster", "POSTER"),
    ("painting on a wall", "PAINTING"),
    ("mural", "MURAL"),
    ("pattern illustration", "ILLUSTRATION"),
    ("colour chart", "COLOUR_CHART"),
    ("fitted worktop", "COUNTERTOP"),
    ("stone slab stock", "STONE_SLAB"),
    ("building facade", "ARCHITECTURE"),
    ("wooden floor", "WOOD"),
    ("painted wall", "PAINTED_WALL"),
    ("carpet", "FABRIC"),
]


def check(label, condition, detail=""):
    return (label, bool(condition), detail)


def decorative_products_are_accepted():
    """Every decorative range on the page has to survive the gate."""
    results = []
    for name, material in PRODUCT_MATERIALS:
        verdict = assess_tile_purity(observation(material))
        results.append(check(
            f"{name} ({material}) is accepted as a product",
            verdict["state"] == PURITY_CLEAN,
            f"got {verdict['state']} -- {verdict['reason']}",
        ))
    return results


def pictures_are_still_rejected():
    """Widening the gate must not readmit a picture of a pattern."""
    results = []
    for name, material in NON_PRODUCT_MATERIALS:
        verdict = assess_tile_purity(observation(material))
        results.append(check(
            f"{name} ({material}) is still refused",
            verdict["state"] == PURITY_NOT_TILE,
            f"got {verdict['state']} -- {verdict['reason']}",
        ))
    return results


def printed_decoration_is_rejected():
    """The exact case the ARTWORK rule was protecting against.

    A decorative motif inked on a catalog page reports the same material
    a real decor panel does, and differs only in physical_surface. It
    must still be refused -- otherwise the fix has traded one failure
    for the other.
    """
    results = []
    for _name, material in PRODUCT_MATERIALS:
        verdict = assess_tile_purity(
            observation(material, physical_surface=False)
        )
        results.append(check(
            f"printed {material} motif is refused (not a physical surface)",
            verdict["state"] == PURITY_NOT_TILE,
            f"got {verdict['state']} -- {verdict['reason']}",
        ))
    return results


def decorative_products_face_every_other_rule():
    """Being a product buys no exemption from anything else."""
    return [
        check(
            "a decor panel in a room photo is still a scene",
            assess_tile_purity(
                observation("DECOR_PANEL", is_scene=True)
            )["state"] == PURITY_CONTAMINATED,
        ),
        check(
            "a decor panel with a person in frame is still contaminated",
            assess_tile_purity(
                observation("DECOR_PANEL", contains_person=True)
            )["state"] == PURITY_CONTAMINATED,
        ),
        check(
            "a decor panel with the product code printed on it is contaminated",
            assess_tile_purity(
                observation("DECOR_PANEL", contains_text=True)
            )["state"] == PURITY_CONTAMINATED,
        ),
        check(
            "two decor panels side by side is a layout, not a product",
            assess_tile_purity(
                observation("DECOR_PANEL", distinct_tile_designs=2)
            )["state"] == PURITY_CONTAMINATED,
        ),
        check(
            "a decor panel filling 40% of the frame is contaminated",
            assess_tile_purity(
                observation("DECOR_PANEL", tile_fraction=0.40)
            )["state"] == PURITY_CONTAMINATED,
        ),
    ]


def material_normalization():
    """The word-level mapping the gate is built on."""
    return [
        check("DECOR_PANEL normalizes to a decorative product",
              normalize_material("DECOR_PANEL") == MATERIAL_DECOR),
        check("'decor panel' (spaces) normalizes the same",
              normalize_material("decor panel") == MATERIAL_DECOR),
        check("'Decor-Panel' (hyphen, mixed case) normalizes the same",
              normalize_material("Decor-Panel") == MATERIAL_DECOR),
        check("HIGHLIGHTER normalizes to a decorative product",
              normalize_material("HIGHLIGHTER") == MATERIAL_DECOR),
        check("PORCELAIN_SLAB normalizes to tile, not to a slab reject",
              normalize_material("PORCELAIN_SLAB") == MATERIAL_TILE),
        check("STONE_SLAB still names itself (and rejects)",
              normalize_material("STONE_SLAB") == "STONE_SLAB"),
        check("ARTWORK still names itself (and rejects)",
              normalize_material("ARTWORK") == "ARTWORK"),
        check("a word nobody anticipated is UNDECIDED, not a rejection",
              normalize_material("CRACKLE_GLAZE") == MATERIAL_UNDECIDED),
        check("an unnamed decorative tile still ends in _TILE and is tile",
              normalize_material("SCULPTED_TILE") == MATERIAL_TILE),
    ]


def an_unnamed_product_still_passes():
    """The regression that started all of this must stay fixed.

    "I could not name this surface" is not evidence against a product.
    """
    return [
        check("OTHER falls through to the remaining rules and passes",
              assess_tile_purity(observation("OTHER"))["state"] == PURITY_CLEAN),
        check("a blank material falls through and passes",
              assess_tile_purity(observation(""))["state"] == PURITY_CLEAN),
    ]


def second_interpretation():
    """The contradiction resolver, with the real verify_tile_only.

    "material = ARTWORK" together with "physical_surface = true" is not
    a verdict, it is the verifier disagreeing with itself: one field
    says picture, the other says there is a real manufactured thing in
    front of the camera. Settling that in favour of ARTWORK is what
    deleted the decorative half of a range.

    So the question is put back once, on its own. What matters as much
    as the PRODUCT case is every other row here: an ARTWORK second
    opinion, a call that fails, a quota that is gone, an UNSURE and a
    reply nobody can parse must all leave the first verdict untouched.
    The fallback is the behaviour that existed before this ran.
    """
    import json
    import os

    os.environ.setdefault("GEMINI_API_KEY", "test-key-not-used")

    try:
        from PIL import Image
    except ImportError:  # noqa: BLE001 -- the rest of the file still runs
        return [check("second interpretation (Pillow unavailable)", True,
                      "skipped")]

    import app.gemini_service as gemini_service

    probe_directory = Path(__file__).resolve().parent / "output" / "decor_test"
    probe_directory.mkdir(parents=True, exist_ok=True)
    probe = probe_directory / "_probe.webp"
    Image.new("RGB", (240, 240), (190, 175, 150)).save(
        probe, "WEBP", quality=90, method=6
    )

    class Response:
        def __init__(self, text):
            self.text = text

    # The verifier's own reply: decorative, and contradicting itself.
    contradictory = json.dumps({
        "material": "ARTWORK",
        "tile_fraction": 0.96,
        "is_scene": False,
        "physical_surface": True,
        "distinct_tile_designs": 1,
        "reason": "an ornate patterned face",
    })

    real_call = gemini_service._generate_content_safe

    def run(second_reply):
        """Answers the purity call normally and the re-ask with `second_reply`."""
        def fake(model=None, contents=None, config=None, **_kwargs):
            prompt = contents[1] if contents and len(contents) > 1 else ""
            if prompt is gemini_service.PRODUCT_OR_ARTWORK_PROMPT:
                if isinstance(second_reply, Exception):
                    raise second_reply
                return second_reply
            return Response(contradictory)

        gemini_service._generate_content_safe = fake
        try:
            return gemini_service.verify_tile_only(str(probe))
        finally:
            gemini_service._generate_content_safe = real_call

    def material_of(second_reply):
        seen = run(second_reply)
        return None if seen is None else seen["material"]

    product = Response(json.dumps({"verdict": "PRODUCT", "reason": "relief"}))
    artwork = Response(json.dumps({"verdict": "ARTWORK", "reason": "printed"}))
    unsure = Response(json.dumps({"verdict": "UNSURE"}))
    garbage = Response("I'm sorry, I can't help with that.")

    reinterpreted = material_of(product)
    results = [
        check("a PRODUCT second opinion rewrites ARTWORK to DECOR_PANEL",
              reinterpreted == "DECOR_PANEL", f"got {reinterpreted}"),
        check("...and that material then passes the purity gate",
              assess_tile_purity(run(product))["state"] == PURITY_CLEAN),
        check("an ARTWORK second opinion leaves the verdict alone",
              material_of(artwork) == "ARTWORK"),
        check("an UNSURE second opinion leaves the verdict alone",
              material_of(unsure) == "ARTWORK"),
        check("an unparseable second opinion leaves the verdict alone",
              material_of(garbage) == "ARTWORK"),
        check("a raised exception leaves the verdict alone, and does not escape",
              material_of(RuntimeError("boom")) == "ARTWORK"),
        check("an exhausted quota (None) leaves the verdict alone",
              material_of(None) == "ARTWORK"),
        check("the untouched ARTWORK verdict still rejects",
              assess_tile_purity(run(artwork))["state"] == PURITY_NOT_TILE),
    ]

    # The re-ask must not fire on a frame that is not contradictory --
    # it costs a call, and a second opinion on a settled question is how
    # a gate gets talked out of a correct rejection.
    fired = {"count": 0}

    def counting(model=None, contents=None, config=None, **_kwargs):
        prompt = contents[1] if contents and len(contents) > 1 else ""
        if prompt is gemini_service.PRODUCT_OR_ARTWORK_PROMPT:
            fired["count"] += 1
            return Response(json.dumps({"verdict": "PRODUCT"}))
        return Response(json.dumps({
            "material": "ARTWORK", "tile_fraction": 0.1, "is_scene": False,
            "physical_surface": False, "reason": "ink on the page",
        }))

    gemini_service._generate_content_safe = counting
    try:
        printed = gemini_service.verify_tile_only(str(probe))
    finally:
        gemini_service._generate_content_safe = real_call

    results.append(check(
        "a printed graphic does not trigger a second opinion",
        fired["count"] == 0, f"fired {fired['count']} time(s)",
    ))
    results.append(check(
        "...and is still rejected",
        assess_tile_purity(printed)["state"] == PURITY_NOT_TILE,
    ))

    probe.unlink(missing_ok=True)
    return results


def main():
    groups = [
        ("decorative products are accepted", decorative_products_are_accepted()),
        ("pictures are still rejected", pictures_are_still_rejected()),
        ("printed decoration is still rejected", printed_decoration_is_rejected()),
        ("products face every other rule", decorative_products_face_every_other_rule()),
        ("material normalization", material_normalization()),
        ("an unnamed product still passes", an_unnamed_product_still_passes()),
        ("second interpretation of a contradiction", second_interpretation()),
    ]

    failures = 0
    total = 0
    for title, results in groups:
        print(f"\n{title}")
        print("-" * len(title))
        for label, ok, *rest in results:
            total += 1
            detail = rest[0] if rest else ""
            if ok:
                print(f"  PASS  {label}")
            else:
                failures += 1
                print(f"  FAIL  {label}"
                      + (f"  [{detail}]" if detail else ""))

    print(f"\n{total - failures}/{total} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
