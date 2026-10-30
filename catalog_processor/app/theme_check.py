"""
theme_check.py

Does the finished image actually follow the theme that was asked for?

A generation that comes back as a handsome generic bathroom is a FAILED
result, and nothing used to say so -- the image was returned, the board
looked finished, and only the showroom noticed. This reads the image
back and reports, in the theme's own terms, what is there and what is
not.

TWO CATEGORIES, NEVER MIXED
---------------------------
The first version of this asked one question over one list and produced
nonsense on the owner's board:

    Not visible: Blue feature walls and sage-grey subway tiles must NOT
    dominate the composition...

A prohibition is not a missing feature. So the two are asked separately
and reported separately:

    missing      required characteristics that are ABSENT from the image
    deviations   prohibited elements that are PRESENT and dominant

EVIDENCE, NOT RECITATION
------------------------
A validator that echoes the avoid-list back is worse than none: it
produces confident warnings about things that are not in the picture. So
every finding has to carry what was SEEN, the model is told to leave a
list empty rather than fill it, and anything it cannot settle goes to
`uncertain` -- never counted as a confirmed failure.

Findings that arrive without evidence are dropped here, not trusted.

NO AUTOMATIC RETRY
------------------
One pass, reported. The request already pays for two image generations
and the function's maxDuration is 60s; regenerating here risks returning
no image at all. The showroom regenerates from the board, with the
corrective line this produces.

HONESTY
-------
`status` is "pass", "partial", "fail" or "unchecked". "unchecked" is
never a pass: it means the check could not run -- no theme, no image, no
key, no working model, or a reply this could not parse.
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.client_selections import describe_space
from app.themes import describe_theme, theme_checklist


def _candidate_models() -> List[str]:
    """
    The models to try, in order.

    The first default this shipped with, "gemini-3-flash", does not
    exist -- the live check came back 404 NOT_FOUND on every board. A
    model name is not something to guess at, so these are the names this
    deployment ALREADY runs. The env vars are read, not the modules, so
    nothing on the extraction side is imported or touched.
    """
    names = [
        os.getenv("GEMINI_THEME_CHECK_MODEL", ""),
        os.getenv("GEMINI_MODEL", ""),
        "gemini-3.1-flash-lite",
        os.getenv("GEMINI_IMAGE_MODEL", ""),
        "gemini-3.1-flash-image",
    ]
    seen = set()
    ordered = []
    for name in names:
        name = (name or "").strip()
        if name and name not in seen:
            seen.add(name)
            ordered.append(name)
    return ordered


# The three formats Gemini takes, which is every format this pipeline
# writes. Done here rather than by importing scene_image_generator for
# its get_mime_type: that module raises at import time when there is no
# API key, so a check with no key failed with "GEMINI_API_KEY is missing
# from .env" instead of its own honest reason -- and a report that names
# the wrong cause is worse than no report.
_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}


def _mime_type(path: Path) -> str:
    mime = _MIME.get(path.suffix.lower())
    if not mime:
        raise ValueError(f"the check cannot send a {path.suffix or 'typeless'} image")
    return mime


def _blank(status: str, theme: Optional[Dict[str, Any]] = None, reason: str = "") -> Dict[str, Any]:
    return {
        "status": status,
        "themeId": (theme or {}).get("id", ""),
        "theme": (theme or {}).get("label", ""),
        "reason": reason,
        "present": [],
        "partial": [],
        "missing": [],
        "deviations": [],
        "uncertain": [],
        "references": "",
        "products": "",
        "recommendation": "",
    }


def _clean(items: Any, limit: int = 6) -> List[str]:
    out = []
    for item in items if isinstance(items, list) else []:
        text = str(item).strip()
        if text and text.lower() not in {"none", "n/a", "none confirmed"}:
            out.append(text[:240])
        if len(out) >= limit:
            break
    return out


def _room(room: Any) -> Dict[str, str]:
    """
    What the image is OF, in the question's own words.

    This asked "you are judging ONE generated bathroom image" whatever
    the client had chosen, and then listed a bathroom's parts for the
    model to look at -- vanity, bathtub, shower. A living room judged as
    a bathroom is judged on things that are not in it, and QUESTION D
    asked whether it read as "a generic contemporary bathroom", which is
    not the failure a living room can have.

    Falls back to a bathroom, which is what the generator draws when no
    room is named, so an unnamed room asks exactly what it asked before.
    """
    space = describe_space(room)
    if not space:
        return {
            "noun": "bathroom",
            "parts": "walls, flooring, vanity, bathtub, shower, fixtures, mirrors",
        }
    return {
        "noun": space["noun"],
        "parts": f"walls, flooring, {space['fixtures']}, fixtures",
    }


def _question(theme: Dict[str, Any], required: List[str], room: Any = None) -> str:
    """
    What the model is asked.

    Written against three false positives the live board produced. It
    marked heritage green MISSING while looking at a forest-green vanity
    and a burgundy bathtub, because the only words available were
    "present" and "missing" and the room was not GREEN OVERALL. And it
    reported "a contemporary subway-tile bathroom" over large-format
    marble panels, by stretching a prohibition until it fit.

    So: four states rather than two, presence separated from dominance
    in as many words, the theme's own counting rules, and a prohibition
    that has to be identified confidently before it is reported at all.
    """
    numbered = "\n".join(f"{i}. {rule}" for i, rule in enumerate(required, start=1))
    forbidden = "\n".join(f"- {item}" for item in theme["avoid"])
    counts = theme.get("counts") or []
    counting = ("\n\nWHAT COUNTS for this theme:\n" + "\n".join(f"- {c}" for c in counts)) if counts else ""

    space = _room(room)

    return (
        f"You are judging ONE generated {space['noun']} image against the design theme "
        f"\"{theme['label']}\" ({theme['palette']}).\n\n"
        f"The theme is right when: {theme['success']}\n\n"
        f"Look at the WHOLE room before answering -- {space['parts']}, "
        "architectural detailing and decorative elements together. A theme is "
        "established by several coordinated elements, not by one wall or one material.\n\n"
        "PRESENCE IS NOT DOMINANCE. A characteristic is PRESENT if you can see it anywhere in the "
        "room, at any size. A green vanity is heritage green. A burgundy bathtub is oxblood. Do "
        "NOT call something missing because it is not the largest thing in the picture, and do NOT "
        "expect every characteristic to occupy a large share of the room."
        f"{counting}\n\n"
        "QUESTION A -- REQUIRED CHARACTERISTICS. Give each one exactly one state:\n"
        "  present    you can see it\n"
        "  partial    it is there but thin, small or only half-done\n"
        "  missing    you looked and it is genuinely not in the room\n"
        "  uncertain  you cannot tell from this image\n"
        f"{numbered}\n\n"
        "QUESTION B -- PROHIBITED ELEMENTS. Report one ONLY if you can actually SEE it and are "
        "confident. Do not stretch an item until it fits: large-format stone or marble panels are "
        "NOT subway tiles; a dark painted wall is not a blue feature wall; traditional cabinetry is "
        "not a floating vanity. These prohibitions are written for the theme as a whole, across "
        f"every room it is asked for. If an item names a room this is not -- you are judging a "
        f"{space['noun']} -- that item does not apply, and reporting it is a false positive. Your "
        "evidence must support the item you report: if what you saw shows the prohibited thing is "
        "absent, do not report it. If you are unsure, leave it out or mark it not confident. Seeing "
        "none is the correct and expected answer for a good image. Do NOT copy this list into your "
        f"answer:\n{forbidden}\n\n"
        "QUESTION C -- the products. Do the tiled surfaces look like real, consistently laid catalog "
        "products, or like invented patterns? One sentence.\n\n"
        "QUESTION D -- does the room read as a designed interior in this theme's language, or as a "
        f"generic contemporary {space['noun']}? One sentence.\n\n"
        "Every item you report must carry what you SAW, in your own words. Reply with JSON only, no "
        "prose and no code fence:\n"
        '{"present": [<numbers>], '
        '"partial": [{"n": <number>, "seen": "<what is there, and why it is thin>"}], '
        '"missing": [{"n": <number>, "seen": "<what is there instead>"}], '
        '"uncertain": [{"n": <number>, "why": "<why you cannot tell>"}], '
        '"deviations": [{"what": "<the prohibited element>", "seen": "<where you see it>", '
        '"confident": true}], '
        '"products": "<one sentence>", "identity": "<one sentence>"}'
    )


def check_theme(
    image_path: Any,
    theme: Any,
    client: Any = None,
    room: Any = None,
) -> Dict[str, Any]:
    """
    Reads the generated image and judges it against this theme.

    `client` is injectable so the check can be exercised without a key.
    `room` is what the client asked for, so the question is about that
    room and not about a bathroom; omitted, it asks what it always did.
    Returns a verdict dict; it never raises.
    """
    found = describe_theme(theme)
    if not found:
        return _blank("unchecked", None, "no theme was selected, so there is nothing to check against")

    required = theme_checklist(theme)
    if not required:
        return _blank("unchecked", found, "this theme has no visual characteristics configured")

    path = Path(str(image_path or ""))
    if not path.is_file():
        return _blank("unchecked", found, "the generated image could not be read back")

    try:
        if client is None:
            if not os.getenv("GEMINI_API_KEY"):
                return _blank("unchecked", found, "no GEMINI_API_KEY is configured for the check")
            from google import genai
            client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

        from google.genai import types

        contents = [
            types.Part.from_text(text=_question(found, required, room)),
            types.Part.from_bytes(data=path.read_bytes(), mime_type=_mime_type(path)),
        ]

        response = None
        tried = []
        for model in _candidate_models():
            try:
                response = client.models.generate_content(model=model, contents=contents)
                break
            except Exception as error:  # noqa: BLE001
                tried.append(f"{model}: {error}")
                # Only a missing/unsupported model is worth moving on
                # from. Anything else is a real failure of this call.
                if "NOT_FOUND" not in str(error) and "404" not in str(error):
                    raise

        if response is None:
            return _blank(
                "unchecked", found,
                "no configured model could run the check -- " + "; ".join(t[:120] for t in tried),
            )

        text = (getattr(response, "text", "") or "").strip()
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            return _blank("unchecked", found, "the check model's reply could not be read as JSON")

        reply = json.loads(text[start:end + 1])

        def rule(n: Any) -> str:
            try:
                index = int(n)
            except (TypeError, ValueError):
                return ""
            return required[index - 1] if 1 <= index <= len(required) else ""

        present = [rule(n) for n in reply.get("present", []) if rule(n)]

        def detailed(field: str, key: str) -> List[str]:
            """Findings that carry what was SEEN. The rest are recitation."""
            out = []
            for item in reply.get(field, []) if isinstance(reply.get(field), list) else []:
                if not isinstance(item, dict):
                    continue
                name, why = rule(item.get("n")), str(item.get(key, "")).strip()
                if name and (why or field == "uncertain"):
                    out.append(f"{name}{f' ({why[:140]})' if why else ''}")
            return out

        # EVIDENCE OR IT DID NOT HAPPEN.
        #
        # A finding without something the model says it SAW is a
        # finding it recited from the lists above, which is exactly
        # what this must not report. Dropped, not trusted.
        partial = detailed("partial", "seen")
        missing = detailed("missing", "seen")
        uncertain = detailed("uncertain", "why")

        # A PROHIBITION HAS TO BE IDENTIFIED, NOT MATCHED.
        #
        # The live board reported "a contemporary subway-tile bathroom"
        # over large-format marble panels, by stretching the avoid-list
        # until it fit. So a deviation needs evidence AND confidence;
        # anything less is an observation, not a finding, and goes to
        # uncertain where it cannot fail the board.
        deviations = []
        for item in reply.get("deviations", []) if isinstance(reply.get("deviations"), list) else []:
            if not isinstance(item, dict):
                continue
            what, seen = str(item.get("what", "")).strip(), str(item.get("seen", "")).strip()
            if not what or not seen:
                continue
            if item.get("confident") is False:
                uncertain.append(f"possibly {what} ({seen[:120]})")
            else:
                deviations.append(f"{what} ({seen[:140]})")

        status = _status(found, required, present, partial, missing, deviations, reply)

        verdict = _blank(status, found)
        if status == "unchecked":
            verdict["reason"] = "the check model judged none of the characteristics"
        verdict.update({
            "present": present[:8],
            "partial": _clean(partial),
            "missing": _clean(missing),
            "deviations": _clean(deviations, 4),
            "uncertain": _clean(uncertain, 4),
            "products": str(reply.get("products", ""))[:240],
            "references": str(reply.get("identity", ""))[:240],
            "recommendation": _recommend(found, missing, deviations),
        })
        return verdict

    except Exception as error:  # noqa: BLE001 -- advisory, never fatal
        return _blank("unchecked", found, f"the check could not run: {error}")


def _status(
    theme: Dict[str, Any],
    required: List[str],
    present: List[str],
    partial: List[str],
    missing: List[str],
    deviations: List[str],
    reply: Dict[str, Any],
) -> str:
    """
    PASS, PARTIAL or FAIL, from the findings alone.

    Weighted, and the weights come from the theme's own configuration
    rather than from invented thresholds:

      * The theme names ONE of its characteristics as the one that
        carries it (`identityCheck`). If that is present the room reads
        as the theme, and a thin decorative element elsewhere cannot
        take it to FAIL -- which is what happened to the owner's board.

      * Everything else is counted as a share of the theme's own
        characteristics: present counts whole, partial counts half.
        Below half of them is a room that does not carry the theme.

    FAIL is reserved for a room that genuinely is not the theme: its
    identity absent, OR a confidently identified prohibited element, OR
    fewer than half its characteristics satisfied.
    """
    identity_index = theme.get("identityCheck")
    identity_rule = (
        required[identity_index - 1]
        if isinstance(identity_index, int) and 1 <= identity_index <= len(required)
        else None
    )
    identity_failed = identity_rule is not None and any(m.startswith(identity_rule) for m in missing)

    # ONLY WHAT THE MODEL ACTUALLY CLASSIFIED COUNTS.
    #
    # A characteristic it never mentions is unknown, not absent. Dividing
    # by the full list punished a room for the model's silence: a reply
    # naming two of seven as present scored 0.29 and failed, although
    # nothing had been found wrong with it.
    classified = len(present) + len(partial) + len(missing)
    satisfied = len(present) + 0.5 * len(partial)
    share = satisfied / classified if classified else 0.0

    # Nothing judged at all is not a pass. It is a check that did not
    # happen, and saying so is the whole point of having "unchecked".
    if not classified and not deviations:
        return "unchecked"

    if deviations or identity_failed or (classified and share < 0.5):
        return "fail"
    if missing or partial:
        return "partial"
    return "pass"


def _recommend(theme: Dict[str, Any], missing: List[str], deviations: List[str]) -> str:
    """
    One corrective line, built from what was actually found.

    Only from the findings -- a recommendation assembled from the theme
    configuration would be advice about things that may well already be
    in the picture, which is the thing this must not do.
    """
    if not missing and not deviations:
        return ""

    sentences = []
    if deviations:
        sentences.append(
            "Replace the "
            + "; ".join(d.split(" (")[0].rstrip(".") for d in deviations[:2])
            + f" with authentic {theme['label']} styling."
        )
    if missing:
        sentences.append(
            "Strengthen: "
            + "; ".join(m.split(" (")[0].rstrip(".") for m in missing[:2])
            + "."
        )
    sentences.append("Keep the selected catalog products exactly as they are.")
    return " ".join(sentences)


def summarise(verdict: Optional[Dict[str, Any]]) -> str:
    """One line for a log, honest about what was not checked."""
    if not verdict:
        return ""
    theme = verdict.get("theme") or "the theme"
    status = verdict.get("status")
    if status == "pass":
        return f"{theme}: every required characteristic was visible, no deviations seen."
    if status == "partial":
        return f"{theme}: {len(verdict.get('missing', []))} required characteristic(s) not visible."
    if status == "fail":
        return (
            f"{theme}: {len(verdict.get('deviations', []))} prohibited element(s) seen"
            + (f", {len(verdict.get('missing', []))} characteristic(s) missing" if verdict.get("missing") else "")
            + "."
        )
    return f"{theme}: not checked -- {verdict.get('reason', 'no reason given')}."
