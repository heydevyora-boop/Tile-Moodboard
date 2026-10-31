"""The seven Floral-bedroom scenarios, A to G, as the validator sees them.

WHAT THIS IS, AND WHAT IT IS NOT
--------------------------------
Each scenario names a PICTURE. No picture is generated or inspected
here: there is no GEMINI_API_KEY in this environment, and there never
has been in any round of this work. What is driven is the half that
lives in this repository -- given the reading a model would return for
that picture, what verdict does the check produce?

That is the half that was broken. A professionally designed Floral
bedroom came back NON-COMPLIANT not because the model misread it but
because the arithmetic downstream turned an ordinary reading into a
failure. These scenarios pin that arithmetic down.

They cannot tell you whether the model reads a picture correctly. Only
a real generation can, and this file does not claim to be one.

Run:  python3 app/test_floral_bedroom_scenarios.py
"""

import json
import os
import sys
from pathlib import Path

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-used")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.theme_check import check_theme, summarise  # noqa: E402
from app.themes import theme_checklist  # noqa: E402

IMAGE = ROOT / "assets" / "theme_references" / "floral" / "01.webp"
RULES = theme_checklist("Floral")

results = []


def check(label, ok, detail=""):
    results.append((label, bool(ok), "" if detail == "" else str(detail)))


def reading(**over):
    """The reading a model would return for one of these pictures."""
    body = {
        "present": [], "partial": [], "missing": [], "uncertain": [],
        "deviations": [],
        "room": {"verdict": "yes", "seen": "a bedroom: bed, headboard, side tables"},
        "productFidelity": {"verdict": "faithful", "seen": "tiles look consistently laid"},
        "products": "", "identity": "",
    }
    body.update(over)

    class Models:
        last = None

        @staticmethod
        def generate_content(**kwargs):
            Models.last = kwargs
            class R:
                text = json.dumps(body)
            return R()

    class Client:
        models = Models

    return check_theme(IMAGE, "Floral", Client, room="Bedroom")


def index(fragment):
    """The 1-based number of the characteristic whose text starts this way."""
    for i, rule in enumerate(RULES, start=1):
        if rule.lower().startswith(fragment.lower()):
            return i
    raise AssertionError(f"no characteristic starts with {fragment!r}")


MOTIFS = index("Clearly recognisable floral")
PRESENCE = index("The floral treatment has meaningful presence")
ONE_SURFACE = index("The floral pattern is concentrated on one dominant surface")
BUILT_IN = index("That surface reads as a built part")
SECOND_NOTE = index("A quieter botanical note")
CLEAN_DRAW = index("The floral motif is drawn cleanly")
PALETTE = index("Blush, sage and ivory are all present")


def main():
    # ────────────────────────────────────────────────────────────────
    # TEST A -- large botanical feature wall, blush headboard, ivory
    # bedding, subtle sage. Must never fail for the size of the motif.
    # ────────────────────────────────────────────────────────────────
    a = reading(
        present=[MOTIFS, PRESENCE, ONE_SURFACE, BUILT_IN, CLEAN_DRAW, PALETTE],
        partial=[{"n": SECOND_NOTE, "seen": "one botanical print beside the wardrobe"}],
        identity="a botanical bedroom, the mural behind the bed",
    )
    check("A. a large feature wall with blush, ivory and subtle sage is not failed",
          a["status"] in {"pass", "partial"}, a["status"])
    check("A. ...and the one thin element is reported as PARTIAL, not missing",
          a["status"] == "partial" and a["partial"] and not a["missing"], a["status"])
    check("A. ...with no deviation invented against it",
          a["deviations"] == [], a["deviations"])

    # The same room, read as having an oversized motif. Size alone is a
    # valid design decision and may not appear as a finding at all.
    a_big = reading(
        present=[MOTIFS, PRESENCE, ONE_SURFACE, BUILT_IN, CLEAN_DRAW, PALETTE, SECOND_NOTE],
        identity="an oversized botanical mural behind the bed",
    )
    check("A. an oversized motif, everything else right -> PASS",
          a_big["status"] == "pass", a_big["status"])
    check("A. ...and no recommendation is produced for a clean room",
          a_big["recommendation"] == "", a_big["recommendation"])

    # ────────────────────────────────────────────────────────────────
    # TEST B -- a generic contemporary bedroom with no floral identity.
    # ────────────────────────────────────────────────────────────────
    b = reading(
        missing=[
            {"n": MOTIFS, "seen": "no flower or leaf anywhere in the room"},
            {"n": PRESENCE, "seen": "every wall is plain painted plaster"},
            {"n": SECOND_NOTE, "seen": "no botanical artwork or textile"},
        ],
        identity="a generic contemporary bedroom",
    )
    check("B. a bedroom with no floral identity FAILS", b["status"] == "fail", b["status"])
    check("B. ...because the characteristic that carries the theme is absent",
          any("Clearly recognisable floral" in m for m in b["missing"]), b["missing"])
    check("B. ...and the recommendation says what to strengthen",
          "Strengthen" in b["recommendation"], b["recommendation"])

    # ────────────────────────────────────────────────────────────────
    # TEST C -- ivory-dominant, prominent mural, subtle blush and sage.
    # ────────────────────────────────────────────────────────────────
    c = reading(
        present=[MOTIFS, PRESENCE, ONE_SURFACE, BUILT_IN, CLEAN_DRAW, PALETTE, SECOND_NOTE],
        identity="ivory room, large floral mural, blush and sage in the soft furnishings",
    )
    check("C. an ivory-led room with a mural is recognised as valid Floral",
          c["status"] == "pass", c["status"])
    check("C. ...with nothing reported against it at all",
          not c["missing"] and not c["partial"] and not c["deviations"], c)

    # And the model is TOLD this, rather than being left to infer it.
    text = " ".join(getattr(p, "text", "") or "" for p in PROBE_CONTENTS["contents"])
    check("C. ...and the question states an ivory-led room is correct",
          "one colour of the palette leading as the room's background" in text
          and "an ivory-led room with blush and sage running through it is CORRECT" in text)
    check("C. ...and forbids inventing a colour percentage",
          "Do NOT apply a percentage to any colour" in text)

    # ────────────────────────────────────────────────────────────────
    # TEST D -- one floral feature wall, plain complementary walls.
    # ────────────────────────────────────────────────────────────────
    d = reading(
        present=[MOTIFS, PRESENCE, ONE_SURFACE, BUILT_IN, SECOND_NOTE, CLEAN_DRAW, PALETTE],
        identity="one patterned wall behind the bed, the other three plain ivory",
    )
    check("D. one feature wall with plain walls around it is valid Floral",
          d["status"] == "pass", d["status"])
    check("D. ...and the question says so outright",
          "one dominant feature wall, with the other walls plain and complementary" in text)
    check("D. ...and the counting rules say plain walls are not a missing treatment",
          "A patterned feature wall plus plain walls around it is CORRECT" in text)

    # ────────────────────────────────────────────────────────────────
    # TEST E -- chaotic or distorted floral patterns.
    # ────────────────────────────────────────────────────────────────
    e = reading(
        present=[MOTIFS, PRESENCE, ONE_SURFACE, BUILT_IN, PALETTE],
        missing=[{"n": CLEAN_DRAW, "seen": "the flowers are malformed and the repeat breaks mid-wall"}],
        deviations=[{
            "what": "a pattern whose repeat breaks, misaligns or dissolves across the surface",
            "seen": "the repeat jumps halfway up the headboard wall",
            "confident": True, "critical": False,
        }],
        identity="botanical, but the pattern is broken",
    )
    check("E. a broken pattern is identified as a genuine problem",
          e["deviations"] and "repeat jumps" in e["deviations"][0], e["deviations"])
    check("E. ...and reported, not swept into a pass",
          e["status"] in {"partial", "fail"}, e["status"])
    check("E. ...with the recommendation naming it",
          "repeat breaks" in e["recommendation"] or "Strengthen" in e["recommendation"],
          e["recommendation"])
    e_bad = reading(
        present=[MOTIFS, PRESENCE],
        missing=[{"n": CLEAN_DRAW, "seen": "flowers are melted and smeared across the wall"}],
        deviations=[{
            "what": "distorted or malformed flowers",
            "seen": "petals dissolve into each other across the whole wall",
            "confident": True, "critical": True,
        }],
    )
    check("E. ...and a distortion bad enough to be called critical FAILS",
          e_bad["status"] == "fail", e_bad["status"])
    check("E. the forbidden list names distortion, not size",
          "distorted or malformed flowers" in text
          and "A LARGE motif is not excessive" in text)

    # ────────────────────────────────────────────────────────────────
    # TEST F -- a bathroom or living room when Bedroom was selected.
    # ────────────────────────────────────────────────────────────────
    for other, seen in (
        ("bathroom", "a vanity, a basin and a walk-in shower -- this is a bathroom"),
        ("living room", "two sofas and a media wall -- this is a living room"),
    ):
        f = reading(
            present=[MOTIFS, PRESENCE, ONE_SURFACE, BUILT_IN, SECOND_NOTE, CLEAN_DRAW, PALETTE],
            room={"verdict": "no", "seen": seen},
            identity="beautifully floral, but not the room that was ordered",
        )
        check(f"F. a {other} when a bedroom was ordered FAILS",
              f["status"] == "fail", f["status"])
        check(f"F. ...even though every characteristic was present",
              len(f["present"]) == 7 and f["status"] == "fail", len(f["present"]))
        check(f"F. ...reported as the wrong room, carrying what was seen",
              any("not a bedroom" in d for d in f["deviations"])
              and any(seen.split(" --")[0][:20] in d for d in f["deviations"]),
              f["deviations"])
        check(f"F. ...and asks for a bedroom",
              "Generate a bedroom" in f["recommendation"], f["recommendation"])
        check(f"F. ...and the verdict carries the room it judged",
              f["room"] == "bedroom" and f["roomOk"] == "no", f["roomOk"])

    # ────────────────────────────────────────────────────────────────
    # TEST G -- a catalog product changed, recoloured or distorted.
    # ────────────────────────────────────────────────────────────────
    for what in (
        "a flower pattern has been drawn onto a plain catalog tile",
        "the base tile is sage here; no supplied product is that colour",
        "the highlight tile's pattern is stretched and does not match the product",
    ):
        g = reading(
            present=[MOTIFS, PRESENCE, ONE_SURFACE, BUILT_IN, SECOND_NOTE, CLEAN_DRAW, PALETTE],
            productFidelity={"verdict": "altered", "seen": what},
        )
        check(f"G. altered product FAILS -- {what[:34]}",
              g["status"] == "fail", g["status"])
        check("G. ...and says exactly what was done to it",
              g["productFidelity"] == "altered" and what[:24] in g["products"], g["products"])
        check("G. ...and asks for the real product back",
              "Restore the supplied catalog products exactly" in g["recommendation"])

    g_ok = reading(
        present=[MOTIFS, PRESENCE, ONE_SURFACE, BUILT_IN, SECOND_NOTE, CLEAN_DRAW, PALETTE],
        productFidelity={"verdict": "unsure", "seen": "the tiles are too small in frame to tell"},
    )
    check("G. a product it cannot judge is PARTIAL, never a silent pass",
          g_ok["status"] == "partial", g_ok["status"])
    check("G. ...and the question guards the obvious false positive",
          "An ordinary tile you simply do not recognise is NOT altered." in text)

    # ────────────────────────────────────────────────────────────────
    # The pipeline promise: one call, whatever the scenario.
    # ────────────────────────────────────────────────────────────────
    calls = {"n": 0}

    class Counting:
        class models:
            @staticmethod
            def generate_content(**kwargs):
                calls["n"] += 1
                class R:
                    text = json.dumps({"present": [1], "deviations": []})
                return R()

    check_theme(IMAGE, "Floral", Counting, room="Bedroom")
    check("one validation call per board, no retry", calls["n"] == 1, calls["n"])

    failures = 0
    for label, ok, detail in results:
        if ok:
            print(f"  PASS  {label}")
        else:
            failures += 1
            print(f"  FAIL  {label}" + (f"  [{detail}]" if detail else ""))
    print(f"\n{len(results) - failures}/{len(results)} checks passed")
    return 1 if failures else 0


# The question text, captured once from a real assembly.
PROBE_CONTENTS = {}


def _capture():
    class Models:
        last = None

        @staticmethod
        def generate_content(**kwargs):
            PROBE_CONTENTS.update(kwargs)
            class R:
                text = json.dumps({"present": [1], "deviations": []})
            return R()

    class Client:
        models = Models

    check_theme(IMAGE, "Floral", Client, room="Bedroom")


if __name__ == "__main__":
    _capture()
    sys.exit(main())
