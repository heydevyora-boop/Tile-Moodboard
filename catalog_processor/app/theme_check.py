"""
theme_check.py

Does the finished image actually follow the theme that was asked for?

A generation that comes back as a handsome generic bathroom is a FAILED
result, and until now nothing said so -- the image was returned, the
board looked finished, and only the showroom noticed. This reads the
image back and says, in the theme's own terms, whether its mandatory
characteristics are visible.

WHAT THIS DELIBERATELY DOES NOT DO
----------------------------------
It does not regenerate. The visualization already costs two image
generations (the room, then the tiles) and the Python function's
maxDuration is 60 seconds; a validate-and-retry loop stands a real
chance of exceeding that and returning NO image, which is a worse
outcome than an imperfect one. So this adds exactly one cheap text
call, reports what it found, and leaves the decision to the showroom,
who can regenerate from the board.

HONESTY
-------
Every path that cannot reach a conclusion says so. `status` is:

    "pass"       every mandatory characteristic was found
    "fail"       at least one was not, and `missing` names them
    "unchecked"  the check could not run -- no theme, no image, no key,
                 a model error, or a reply this could not parse

"unchecked" is never reported as a pass. A caller that treats the
absence of a complaint as approval is making the same mistake the
prompt was making about references it had never been shown.
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.themes import describe_theme, theme_checklist

# A text model, not an image one: this reads a picture and answers a
# question about it.
#
# The first default, "gemini-3-flash", does not exist -- the live check
# came back 404 NOT_FOUND on every board. A model name is not something
# to guess at, so these are the names this deployment ALREADY runs
# successfully: GEMINI_MODEL is what the catalog side uses for text and
# vision, and GEMINI_IMAGE_MODEL is what both generation stages use. The
# env var is read, not the module, so nothing on the extraction side is
# imported or touched.
#
# They are tried in order and a NOT_FOUND moves to the next, so a model
# retired upstream degrades to the next working one instead of silently
# turning the check off again.
def _candidate_models() -> List[str]:
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

# The check is advisory. It must never be the reason a board fails.
CHECK_TIMEOUT_NOTE = "the theme check is advisory and never blocks a generation"


def _unchecked(reason: str, theme_label: str = "") -> Dict[str, Any]:
    return {
        "status": "unchecked",
        "theme": theme_label,
        "reason": reason,
        "present": [],
        "missing": [],
        "notes": "",
    }


def check_theme(
    image_path: Any,
    theme: Any,
    client: Any = None,
) -> Dict[str, Any]:
    """
    Reads the generated image and judges it against this theme's rules.

    `client` is injectable so the check can be exercised without a key.
    Returns a verdict dict; it never raises.
    """
    found = describe_theme(theme)
    if not found:
        return _unchecked("no theme was selected, so there is nothing to check against")

    label = found["label"]
    rules = theme_checklist(theme)
    if not rules:
        return _unchecked("this theme has no visual characteristics configured", label)

    path = Path(str(image_path or ""))
    if not path.is_file():
        return _unchecked("the generated image could not be read back", label)

    try:
        if client is None:
            if not os.getenv("GEMINI_API_KEY"):
                return _unchecked("no GEMINI_API_KEY is configured for the check", label)
            from google import genai
            client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

        from google.genai import types
        from app.scene_image_generator import get_mime_type

        numbered = "\n".join(f"{i}. {rule}" for i, rule in enumerate(rules, start=1))
        question = (
            f"This image was generated for the design theme \"{label}\" "
            f"({found['palette']}).\n\n"
            f"That theme is right when: {found['success']}\n\n"
            "Judge the image against each of these characteristics. "
            "Judge what is ACTUALLY VISIBLE, not what the theme's name suggests "
            "ought to be there. A matching colour palette on its own does not "
            "satisfy a characteristic.\n\n"
            f"{numbered}\n\n"
            "Also check that none of these appear, which this theme forbids:\n"
            + "\n".join(f"- {item}" for item in found["avoid"])
            + "\n\nReply with JSON only, no prose and no code fence:\n"
            '{"present": [<numbers satisfied>], "missing": [<numbers not satisfied>], '
            '"forbidden_seen": [<any forbidden item, quoted>], "notes": "<one sentence>"}'
        )

        contents = [
            types.Part.from_text(text=question),
            types.Part.from_bytes(
                data=path.read_bytes(),
                mime_type=get_mime_type(path),
            ),
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
            return _unchecked(
                "no configured model could run the check -- " + "; ".join(t[:120] for t in tried),
                label,
            )

        text = (getattr(response, "text", "") or "").strip()
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            return _unchecked("the check model's reply could not be read as JSON", label)

        verdict = json.loads(text[start:end + 1])
        missing_numbers = [int(n) for n in verdict.get("missing", []) if str(n).isdigit()]
        present_numbers = [int(n) for n in verdict.get("present", []) if str(n).isdigit()]
        forbidden = [str(f) for f in verdict.get("forbidden_seen", []) if str(f).strip()]

        missing = [rules[n - 1] for n in missing_numbers if 1 <= n <= len(rules)]
        present = [rules[n - 1] for n in present_numbers if 1 <= n <= len(rules)]

        return {
            "status": "fail" if (missing or forbidden) else "pass",
            "theme": label,
            "reason": "",
            "present": present,
            "missing": missing,
            "forbidden_seen": forbidden,
            "notes": str(verdict.get("notes", ""))[:300],
        }

    except Exception as error:  # noqa: BLE001 -- advisory, never fatal
        return _unchecked(f"the check could not run: {error}", label)


def summarise(verdict: Optional[Dict[str, Any]]) -> str:
    """One line for a log or a board, honest about what was not checked."""
    if not verdict:
        return ""
    status = verdict.get("status")
    theme = verdict.get("theme") or "the theme"
    if status == "pass":
        return f"{theme}: every mandatory characteristic was visible."
    if status == "fail":
        bits: List[str] = []
        if verdict.get("missing"):
            bits.append(f"{len(verdict['missing'])} mandatory characteristic(s) not visible")
        if verdict.get("forbidden_seen"):
            bits.append(f"{len(verdict['forbidden_seen'])} forbidden element(s) present")
        return f"{theme}: " + ", ".join(bits) + "."
    return f"{theme}: not checked -- {verdict.get('reason', 'no reason given')}."
