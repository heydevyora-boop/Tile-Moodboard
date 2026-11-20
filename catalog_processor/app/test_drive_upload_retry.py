"""
A dropped connection must not cost a tile.

WHAT THE STUDIO SAW, on a Windows machine, part way through a catalog:

    [DRIVE] could not check for an existing Morson Harmoni 600X1200
    Catalogue_page_11_image_39.webp ([WinError 10060] A connection
    attempt failed because the connected party did not properly
    respond after a period of time) -- uploading as new
    [DRIVE UPLOAD] FAILED  Morson Harmoni 600X1200 ...image_39.webp:
    [WinError 10060] ...
          Tile 1 -> extracted -> UPLOAD FAILED (...) -- will retry next run

The extraction had worked. The tile was cut, screened and named, and
then one timed-out TCP connection threw it away.

WinError 10060 is WSAETIMEDOUT, and googleapiclient already knows that
errno: its own _retry_request lists it beside ECONNRESET, ECONNABORTED
and ETIMEDOUT as a thing worth trying again, with exponential backoff.
But a retry only happens if the caller asks for one, and num_retries
defaults to zero -- so every Drive call in google_services.py got
exactly one attempt.

So this checks the two halves of that, separately, because they fail
for different reasons and a passing half is not a passing whole:

  1. the library really does retry this errno, driven through the real
     _retry_request rather than a description of it;
  2. every Drive call in the upload path really does ask for retries,
     read out of the real source rather than trusted.

Run:  PYTHONPATH=. python3 app/test_drive_upload_retry.py
"""

from __future__ import annotations

import ast
import inspect
import pathlib
import socket
import sys

import googleapiclient.http as api_http

SERVICES = pathlib.Path(__file__).resolve().parent / "google_services.py"

# The functions that upload a tile, and everything they call to do it.
# A bare .execute() in any of them is a tile lost to one bad second.
UPLOAD_PATH = ("get_or_create_folder", "upload_file")

passed = 0
failed = 0
failures: list[str] = []


def check(label: str, ok: bool, extra: object = None) -> None:
    global passed, failed
    if ok:
        print(f"  PASS  {label}")
        passed += 1
    else:
        print(f"  FAIL  {label}" + ("" if extra is None else f"  {extra!r}"[:260]))
        failed += 1
        failures.append(label)


class Answer:
    """What httplib2 hands back: an object with a .status, not a dict."""

    def __init__(self, status: int) -> None:
        self.status = status


class FlakyHttp:
    """Times out the first `fail_times` attempts, then answers."""

    def __init__(self, fail_times: int, errno: int) -> None:
        self.fail_times = fail_times
        self.errno = errno
        self.attempts = 0

    def request(self, *args, **kwargs):
        self.attempts += 1
        if self.attempts <= self.fail_times:
            # The shape Windows raises for 10060 and Linux for 110:
            # an OSError carrying the errno, which is what
            # _retry_request matches on by name.
            raise OSError(self.errno, "A connection attempt failed")
        return (Answer(200), b"{}")


def drive(http: FlakyHttp, num_retries: int):
    """One request through the REAL retry path, with sleep taken out."""
    return api_http._retry_request(
        http,
        num_retries,
        "test",
        lambda _seconds: None,   # no real waiting in a test
        lambda: 0.0,
        "https://www.googleapis.com/upload",
        "POST",
    )


def main() -> None:
    print("\n1. the errno the studio actually hit is one the library retries")

    source = inspect.getsource(api_http._retry_request)
    for name in ("WSAETIMEDOUT", "ETIMEDOUT"):
        check(
            f"1. {name} is in googleapiclient's own retry set",
            f'"{name}"' in source or f"'{name}'" in source,
        )

    # WSAETIMEDOUT is 10060 and exists only on Windows, so the
    # behavioural half below runs on whichever of the two this machine
    # actually has a name for.
    errno = next(
        (n for n in (10060, getattr(__import__("errno"), "ETIMEDOUT", 110))
         if socket.errno.errorcode.get(n)),
        None,
    )
    check("1c. ...and this machine can name one of them", errno is not None,
          socket.errno.errorcode.get(errno or 0))

    print("\n2. without retries, one timeout is the end of it")
    one_shot = FlakyHttp(fail_times=1, errno=errno)
    try:
        drive(one_shot, num_retries=0)
        check("2a. a single attempt gives up on the first timeout", False,
              "it somehow succeeded")
    except OSError as exc:
        check("2a. a single attempt gives up on the first timeout",
              exc.errno == errno, exc)
    check("2b. ...having tried exactly once", one_shot.attempts == 1,
          one_shot.attempts)

    print("\n3. with them, the same connection recovers")
    flaky = FlakyHttp(fail_times=2, errno=errno)
    resp, _ = drive(flaky, num_retries=3)
    check("3a. two timeouts in a row are ridden out", resp.status == 200, resp.status)
    check("3b. ...on the third attempt, not more", flaky.attempts == 3, flaky.attempts)

    # AND IT STILL GIVES UP. A network that is genuinely unreachable
    # must not retry for ever -- the tile is left for the next run,
    # which is what "will retry next run" has always meant.
    stubborn = FlakyHttp(fail_times=99, errno=errno)
    try:
        drive(stubborn, num_retries=3)
        check("3c. a network that is really down still gives up", False,
              "it somehow succeeded")
    except OSError:
        check("3c. a network that is really down still gives up",
              stubborn.attempts == 4, stubborn.attempts)

    print("\n4. and the upload path really does ask for them")

    tree = ast.parse(SERVICES.read_text(encoding="utf-8"))
    functions = {
        node.name: node
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
    }

    for name in UPLOAD_PATH:
        node = functions.get(name)
        if node is None:
            check(f"4. {name} is still in google_services.py", False, "gone")
            continue

        bare = [
            call.lineno
            for call in ast.walk(node)
            if isinstance(call, ast.Call)
            and isinstance(call.func, ast.Attribute)
            and call.func.attr == "execute"
            and not any(kw.arg == "num_retries" for kw in call.keywords)
        ]
        asked = [
            call.lineno
            for call in ast.walk(node)
            if isinstance(call, ast.Call)
            and isinstance(call.func, ast.Attribute)
            and call.func.attr == "execute"
            and any(kw.arg == "num_retries" for kw in call.keywords)
        ]

        check(f"4. every Drive call in {name}() asks for retries",
              not bare and len(asked) > 0,
              {"bare at lines": bare, "with retries": len(asked)})

    print(f"\n{passed}/{passed + failed} checks passed")
    if failures:
        print("failed:\n  " + "\n  ".join(failures))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
