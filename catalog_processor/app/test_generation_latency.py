"""
What the client waits through, and what was being paid for twice.

Generating a scene is two Gemini image calls and one check of what came
back. Those are fixed. What is NOT fixed is everything the request did
around them, and three things were being paid for on every single
generation:

  the room step rendered its INTERMEDIATE at 2K, although the picture
  the client is served is the second step's, which asks for no size at
  all and takes the model's default

  the whole MASTER sheet was downloaded before anything was generated --
  columns A to ZZ, no row bound -- to find one product's row, and MASTER
  grows by a row per extracted product image

  a Drive upload was attempted every time, including on a host where it
  cannot work: a service account has no Drive storage of its own, so the
  folder calls succeed, the file upload fails, and the client waits
  through all of it for an archive copy that is never written

Run:  python3 app/test_generation_latency.py
"""

import importlib
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

results = []


def check(label, ok, detail=None):
    results.append((label, bool(ok), detail))


# ============================================================
# THE INTERMEDIATE IS NOT THE DELIVERED IMAGE
# ============================================================

def the_room_step_stops_rendering_at_2k():
    from app import scene_image_generator

    check(
        "the room step renders at 1K by default",
        scene_image_generator.OUTPUT_IMAGE_SIZE == "1K",
        scene_image_generator.OUTPUT_IMAGE_SIZE,
    )

    os.environ["GEMINI_IMAGE_SIZE"] = "2K"
    try:
        reloaded = importlib.reload(scene_image_generator)
        check(
            "...and a deployment can still ask for 2K back",
            reloaded.OUTPUT_IMAGE_SIZE == "2K",
            reloaded.OUTPUT_IMAGE_SIZE,
        )
    finally:
        del os.environ["GEMINI_IMAGE_SIZE"]
        importlib.reload(scene_image_generator)

    # The reason this is safe to lower: the delivered picture is the
    # tile step's, and that step asks for no image size at all.
    engine = (
        Path(__file__).resolve().parent / "tile_application_engine.py"
    ).read_text(encoding="utf-8")
    check(
        "the tile step passes no image size, so it sets the delivered size",
        "image_config" not in engine and "ImageConfig" not in engine,
    )

    room = (
        Path(__file__).resolve().parent / "scene_image_generator.py"
    ).read_text(encoding="utf-8")
    check(
        "...and the room step says so where the setting lives",
        "AN INTERMEDIATE, NOT THE DELIVERED IMAGE" in room,
    )


# ============================================================
# MASTER IS READ ONCE PER CONTAINER, NOT PER GENERATION
# ============================================================

def master_is_not_downloaded_for_every_generation():
    from app import product_visualization_service as svc

    calls = []

    def fake_loader(spreadsheet_id, sheet_name):
        calls.append((spreadsheet_id, sheet_name))
        return [{"Product ID": "URV-0014", "call": len(calls)}]

    original = svc.load_master_records
    svc.load_master_records = fake_loader
    try:
        svc.clear_master_cache()

        first = svc.load_product_master("sheet-1", "MASTER")
        second = svc.load_product_master("sheet-1", "MASTER")
        check("the sheet is read once for two generations", len(calls) == 1, calls)
        check("...and both get the same records", first == second and first[0]["call"] == 1)

        svc.load_product_master("sheet-1", "OTHER")
        check("a different sheet is its own read", len(calls) == 2, calls)
        svc.load_product_master("sheet-2", "MASTER")
        check("...and so is a different spreadsheet", len(calls) == 3, calls)

        svc.clear_master_cache()
        svc.load_product_master("sheet-1", "MASTER")
        check("clearing it forces a fresh read", len(calls) == 4, calls)

        # The window is real, not forever.
        window = svc.MASTER_CACHE_SECONDS
        svc.MASTER_CACHE_SECONDS = 0.05
        try:
            svc.clear_master_cache()
            svc.load_product_master("sheet-1", "MASTER")
            before = len(calls)
            time.sleep(0.08)
            svc.load_product_master("sheet-1", "MASTER")
            check("the sheet is read again once the window passes",
                  len(calls) == before + 1, {"before": before, "after": len(calls)})
        finally:
            svc.MASTER_CACHE_SECONDS = window

        # A failure must not be remembered: the usual cause is a
        # credential that is missing, and one that comes back should
        # work at once.
        svc.clear_master_cache()
        state = {"fail": True}

        def flaky(spreadsheet_id, sheet_name):
            calls.append((spreadsheet_id, sheet_name))
            if state["fail"]:
                raise RuntimeError("no credentials")
            return [{"Product ID": "OK"}]

        svc.load_master_records = flaky
        failed = len(calls)
        try:
            svc.load_product_master("sheet-3", "MASTER")
            check("a failing read raises rather than being swallowed", False)
        except RuntimeError:
            check("a failing read raises rather than being swallowed", True)
        state["fail"] = False
        got = svc.load_product_master("sheet-3", "MASTER")
        check("...and is not remembered, so the next one tries again",
              len(calls) == failed + 2 and got[0]["Product ID"] == "OK", calls[-2:])
    finally:
        svc.load_master_records = original
        svc.clear_master_cache()


# ============================================================
# A DRIVE THAT CANNOT WORK IS NOT TRIED EVERY TIME
# ============================================================

def a_failing_drive_is_not_retried_every_generation():
    from app import visualization_orchestrator as orch

    attempts = []

    def fails(record, update_registry=True):
        attempts.append(record)
        raise RuntimeError("Service Accounts do not have storage quota")

    def works(record, update_registry=True):
        attempts.append(record)
        return {"success": True, "image_upload": {"file_id": "f", "webViewLink": "u"}}

    original = orch.upload_visualization_to_drive
    try:
        orch.clear_drive_backoff()
        orch.upload_visualization_to_drive = fails
        first = _run_drive_step(orch)
        check("the first generation does try Drive", len(attempts) == 1, len(attempts))
        check("...and reports the real failure",
              first["success"] is False and "storage quota" in first["error"], first)

        second = _run_drive_step(orch)
        check("the next generation does not try it again", len(attempts) == 1, len(attempts))
        check("...and still reports the upload as not done",
              second["success"] is False and "skipped" in second["error"], second)

        window = orch.DRIVE_RETRY_SECONDS
        orch.DRIVE_RETRY_SECONDS = 0.05
        try:
            time.sleep(0.08)
            orch.upload_visualization_to_drive = works
            third = _run_drive_step(orch)
            check("once the window passes it is tried again",
                  len(attempts) == 2 and third["success"] is True, third)
        finally:
            orch.DRIVE_RETRY_SECONDS = window

        fourth = _run_drive_step(orch)
        check("and a working Drive is used every time after that",
              len(attempts) == 3 and fourth["success"] is True, fourth)
    finally:
        orch.upload_visualization_to_drive = original
        orch.clear_drive_backoff()


def _run_drive_step(orch):
    """The orchestrator's Drive step alone, with its own module state."""
    now = time.monotonic()
    blocked = (
        orch._drive_failed_at is not None
        and now - orch._drive_failed_at < orch.DRIVE_RETRY_SECONDS
    )
    if blocked:
        return {
            "success": False,
            "error": (
                "skipped: the previous Drive upload failed and the "
                f"retry window ({orch.DRIVE_RETRY_SECONDS:.0f}s) has not passed"
            ),
        }
    try:
        result = orch.upload_visualization_to_drive({"visualization_id": "v"}, update_registry=True)
        orch._remember_drive_worked()
        return result
    except Exception as error:  # noqa: BLE001
        orch._remember_drive_failed()
        return {"success": False, "error": str(error)}


def the_orchestrator_uses_that_same_decision():
    """The helper above must mirror the orchestrator, not a copy of it."""
    source = (
        Path(__file__).resolve().parent / "visualization_orchestrator.py"
    ).read_text(encoding="utf-8")
    for fragment in (
        "_drive_failed_at is not None",
        "now - _drive_failed_at < DRIVE_RETRY_SECONDS",
        "_remember_drive_worked()",
        "_remember_drive_failed()",
        "skipped: the previous Drive upload failed",
    ):
        check(f"the orchestrator itself carries: {fragment[:46]}", fragment in source)
    check("a failure is never fatal: the record still comes back",
          "drive_upload_succeeded = False" in source)


def main():
    the_room_step_stops_rendering_at_2k()
    master_is_not_downloaded_for_every_generation()
    a_failing_drive_is_not_retried_every_generation()
    the_orchestrator_uses_that_same_decision()

    failures = 0
    for label, ok, detail in results:
        if ok:
            print(f"  PASS  {label}")
        else:
            failures += 1
            print(f"  FAIL  {label}" + (f"  [{detail}]" if detail else ""))
    print(f"\n{len(results) - failures}/{len(results)} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
