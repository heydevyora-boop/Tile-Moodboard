"""
The chosen reference room, carried rather than fetched.

The Node backend used to hand this service an ADDRESS for the picture a
board is built on, and this service fetched it. Every step of that
journey belonged to somebody else, and each one broke in turn: Drive's
download endpoint answers a server with an HTML page; _build_remote_
download_url rewrites any Drive address back to exactly that form; and
a Vercel preview's Deployment Protection, which sits in front of every
function, answers the fetch with its sign-in page carrying a 200.

That last one is what the studio has been reading, four times over, as

    "The remote scene image did not contain a valid image file."

Pillow is right and the message is honest: what arrived really was not
an image. It was a login page.

So the backend stopped sending an address and started sending the
picture, inline, as a data: URL. This checks that THIS service -- which
is not modified for it -- already reads one: that it is not mistaken for
a Drive link, not rewritten, not taken for a placeholder, and that the
bytes come out the other end as a real image file on disk.

HOW IT READS THE PIPELINE. main_step6_complete imports the whole PDF
toolchain, which a test machine need not have, so the scene-resolution
helpers are lifted out of that file's own source at run time and
executed verbatim. Nothing is copied here: rename one and this fails
rather than quietly testing a stale copy.

Run:  PYTHONPATH=. python3 app/test_scene_image_inline.py
"""

from __future__ import annotations

import ast
import base64
import pathlib
import sys

PIPELINE = pathlib.Path(__file__).resolve().parent.parent / "main_step6_complete.py"

WANTED = (
    "_extract_google_drive_file_id",
    "_build_remote_download_url",
    "_is_placeholder_scene_reference",
    "_validate_downloaded_image",
    "_download_drive_file_authenticated",
    "_download_scene_image",
    "resolve_scene_image",
)

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQ"
    "GAhKmMIQAAAABJRU5ErkJggg=="
)

passed = 0
failed = 0
failures: list[str] = []


def check(label: str, ok: bool, extra: object = None) -> None:
    global passed, failed
    if ok:
        print(f"  PASS  {label}")
        passed += 1
    else:
        print(f"  FAIL  {label}" + ("" if extra is None else f"  {extra!r}"[:300]))
        failed += 1
        failures.append(label)


def load_pipeline_helpers() -> dict:
    """The real functions, out of the real file, run as themselves."""
    source = PIPELINE.read_text(encoding="utf-8")
    tree = ast.parse(source)

    chunks = {
        node.name: ast.get_source_segment(source, node)
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name in WANTED
    }

    missing = [name for name in WANTED if name not in chunks]
    if missing:
        raise SystemExit(
            "main_step6_complete.py no longer defines: "
            + ", ".join(missing)
            + ". This test reads that file rather than copying it, so a rename "
            "has to be followed here instead of silently passing."
        )

    namespace: dict = {}
    preamble = "\n".join(
        [
            "from __future__ import annotations",
            "import hashlib, mimetypes, re, tempfile",
            "from io import BytesIO",
            "from pathlib import Path",
            "from typing import Any, Dict, List, Optional",
            "from urllib.error import HTTPError, URLError",
            "from urllib.parse import parse_qs, urlparse",
            "from urllib.request import Request, urlopen",
            "from PIL import Image",
            # The Drive client is this service's own, and needs
            # credentials. None makes _download_drive_file_authenticated
            # answer False immediately, which is what a machine without
            # them does anyway -- and a data: URL never reaches it.
            "MediaIoBaseDownload = None",
            "def get_drive_service(): raise RuntimeError('no Drive in this test')",
        ]
    )
    exec(preamble + "\n\n" + "\n\n".join(chunks[name] for name in WANTED), namespace)
    return namespace


def main() -> None:
    pipeline = load_pipeline_helpers()
    data_url = "data:image/png;base64," + base64.b64encode(PNG).decode()

    print("\n1. a picture carried inline is not mistaken for an address")
    check(
        "1a. it is not read as a Google Drive link",
        pipeline["_extract_google_drive_file_id"](data_url) is None,
        pipeline["_extract_google_drive_file_id"](data_url),
    )
    check(
        "1b. ...so the Drive rewrite leaves it exactly as it is",
        pipeline["_build_remote_download_url"](data_url) == data_url,
    )
    check(
        "1c. ...and it is not taken for a seeded placeholder id",
        pipeline["_is_placeholder_scene_reference"](data_url) is False,
    )

    print("\n2. and the bytes come out as a real image file")
    check(
        "2a. the picture inside it validates as a PNG",
        pipeline["_validate_downloaded_image"](PNG, data_url) == ".png",
        pipeline["_validate_downloaded_image"](PNG, data_url),
    )

    resolved = pipeline["_download_scene_image"](data_url, "inline-probe")
    on_disk = resolved.read_bytes()
    check("2b. the pipeline writes it to a file it can open", resolved.exists())
    check("2c. ...with the extension the bytes earned", resolved.suffix == ".png", resolved.suffix)
    check("2d. ...and byte for byte the picture that was sent", on_disk == PNG, len(on_disk))

    print("\n3. and the resolver routes it there, whatever its size")
    # THE ROUTING, which is the whole of it. resolve_scene_image sends
    # only http/https to the downloader; everything else it looks up on
    # disk. A data: URL fell through to that branch and was read as a
    # file name, which raised "[Errno 36] File name too long" for a
    # large one and "Scene image not found" for a small one. The size
    # was never the point -- BOTH had to work, and both are checked
    # here so neither can regress into the other's failure.
    large = "data:image/jpeg;base64," + base64.b64encode(b"x" * 300_000).decode()

    try:
        resolved_small = pipeline["resolve_scene_image"](data_url, "routing-small")
        check(
            "3a. a small picture carried inline resolves to a real file",
            resolved_small.exists() and resolved_small.read_bytes() == PNG,
            resolved_small,
        )
    except Exception as exc:
        # Caught rather than allowed to end the run: without the
        # routing it raises here, and a traceback says less than the
        # one line that names what went wrong.
        check(
            "3a. a small picture carried inline resolves to a real file",
            False,
            f"{type(exc).__name__}: {str(exc)[:110]}",
        )

    # 400 KB of base64: comfortably past the 255-byte file name limit
    # that produced Errno 36, and not a real image, so it must fail on
    # the BYTES rather than on the file name. That is the proof it
    # reached the decoder at all.
    try:
        pipeline["resolve_scene_image"](large, "routing-large")
        check("3b. a large one gets as far as the decoder", False, "it was accepted")
    except OSError as exc:
        check(
            "3b. a large one gets as far as the decoder, not the file system",
            False,
            f"still read as a path: {exc}",
        )
    except ValueError as exc:
        check(
            "3b. a large one gets as far as the decoder, not the file system",
            "did not contain a valid image file" in str(exc),
            str(exc)[:110],
        )

    print("\n4. the failure this replaces, for the record")
    # WHAT AN ADDRESS USED TO BRING BACK on a protected preview: a
    # sign-in page, answered with a 200, which is why the studio was
    # told their photograph was not an image.
    sso_page = b"<!doctype html><html><head><title>Authentication Required</title>"
    source = "https://casa-de-aurum-preview.vercel.app/static/library-reference/1AbC"
    try:
        pipeline["_validate_downloaded_image"](sso_page, source)
        check("4a. an html page answered with 200 is refused", False, "it was accepted")
    except ValueError as exc:
        check(
            "4a. an html page answered with 200 is refused, in the studio's own words",
            "did not contain a valid image file" in str(exc),
            str(exc)[:120],
        )
    check(
        "4b. ...and that address was never rewritten, so nothing else explains it",
        pipeline["_build_remote_download_url"](source) == source,
    )

    print(f"\n{passed}/{passed + failed} checks passed")
    if failures:
        print("failed:\n  " + "\n  ".join(failures))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
