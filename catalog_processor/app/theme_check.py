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


def _question(theme: Dict[str, Any], required: List[str]) -> str:
    """
    What the model is asked.

    It is asked to LOOK, in both directions, and to leave a list empty
    rather than fill it -- because a validator that recites the
    configuration back is the failure mode this is guarding against.
    """
    numbered = "\n".join(f"{i}. {rule}" for i, rule in enumerate(required, start=1))
    forbidden = "\n".join(f"- {item}" for item in theme["avoid"])

    return (
        f"You are judging ONE generated bathroom image against the design theme "
        f"\"{theme['label']}\" ({theme['palette']}).\n\n"
        f"The theme is right when: {theme['success']}\n\n"
        "Judge ONLY what is actually visible in the image. Not what the theme's name "
        "suggests ought to be there, and not what the lists below say. A matching colour "
        "palette on its own satisfies nothing.\n\n"
        "QUESTION A -- REQUIRED CHARACTERISTICS. For each, say whether it is clearly "
        "present, clearly absent, or you cannot tell from this image:\n"
        f"{numbered}\n\n"
        "QUESTION B -- PROHIBITED ELEMENTS. These must not appear. Report one ONLY if you "
        "can actually SEE it dominating the image. If you see none, say none -- an empty "
        "list is the correct and expected answer for a good image. Do NOT copy this list "
        "into your answer:\n"
        f"{forbidden}\n\n"
        "QUESTION C -- the products. Do the tiled surfaces look like real, consistently "
        "laid catalog products, or like invented patterns? One sentence.\n\n"
        "QUESTION D -- does the room read as a designed interior in this theme's language, "
        "or as a generic contemporary bathroom? One sentence.\n\n"
        "Every item you report must carry what you SAW, in your own words. Reply with JSON "
        "only, no prose and no code fence:\n"
        '{"present": [<numbers clearly present>], '
        '"missing": [{"n": <number>, "seen": "<what is there instead>"}], '
        '"uncertain": [{"n": <number>, "why": "<why you cannot tell>"}], '
        '"deviations": [{"what": "<the prohibited element>", "seen": "<where you see it>"}], '
        '"products": "<one sentence>", "identity": "<one sentence>"}'
    )


def check_theme(image_path: Any, theme: Any, client: Any = None) -> Dict[str, Any]:
    """
    Reads the generated image and judges it against this theme.

    `client` is injectable so the check can be exercised without a key.
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
            types.Part.from_text(text=_question(found, required)),
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

        # EVIDENCE OR IT DID NOT HAPPEN.
        #
        # A finding without something the model says it SAW is a
        # finding it recited from the lists above, which is exactly
        # what this must not report. Dropped, not trusted.
        missing = []
        for item in reply.get("missing", []) if isinstance(reply.get("missing"), list) else []:
            if not isinstance(item, dict):
                continue
            name, seen = rule(item.get("n")), str(item.get("seen", "")).strip()
            if name and seen:
                missing.append(f"{name} ({seen[:140]})")

        uncertain = []
        for item in reply.get("uncertain", []) if isinstance(reply.get("uncertain"), list) else []:
            if not isinstance(item, dict):
                continue
            name, why = rule(item.get("n")), str(item.get("why", "")).strip()
            if name:
                uncertain.append(f"{name}{f' ({why[:120]})' if why else ''}")

        deviations = []
        for item in reply.get("deviations", []) if isinstance(reply.get("deviations"), list) else []:
            if not isinstance(item, dict):
                continue
            what, seen = str(item.get("what", "")).strip(), str(item.get("seen", "")).strip()
            if what and seen:
                deviations.append(f"{what} ({seen[:140]})")

        # The status follows from the findings, not from the model's own
        # opinion of them -- so the same findings always read the same way.
        if deviations:
            status = "fail"
        elif missing:
            status = "partial"
        else:
            status = "pass"

        verdict = _blank(status, found)
        verdict.update({
            "present": present[:8],
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
