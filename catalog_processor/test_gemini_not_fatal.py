"""Regression: Gemini must never be able to stop the catalog.

The failure this covers came off a real run's traceback:

    extract_images_from_pdf
      -> validate_and_correct_tile_image
        -> analyze_product_image
          -> generate_content
            -> (network wait)
              -> KeyboardInterrupt

The run did not fail. It HUNG, and someone eventually pressed Ctrl-C.
genai.Client was built without http_options, so the SDK timeout was
None and a stalled connection was waited on forever. The retry logic
around it never helped: a hang raises nothing to retry.

Three things have to hold now:

  1. every request is bounded by a timeout
  2. a timing-out, hanging, erroring or garbage-returning Gemini
     DEFERS the image -- preserved, not deleted, not published
  3. extraction carries on to the next page either way, and tiles
     found before the trouble are already in Drive

Run:  GEMINI_API_KEY=test python3 test_gemini_not_fatal.py
"""

import os
import shutil
import sys
from pathlib import Path

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-used")

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fitz  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import app.gemini_service as gemini_service  # noqa: E402
import main_step6_complete as pipeline  # noqa: E402
from app.image_validator import (  # noqa: E402
    assess_tile_purity,
    validate_bbox,
    validate_product_decision,
)

OUT = Path(__file__).resolve().parent / "output" / "gemini_not_fatal_test"

TILE_A = (198, 188, 172)
TILE_B = (176, 166, 150)
GROUT = (112, 104, 92)

PAGES = 4
# Which page's classification call misbehaves.
BAD_PAGE = 2


def tile_photo(cell=34):
    canvas = np.zeros((720, 720, 3), dtype=np.uint8)
    for y in range(720):
        for x in range(720):
            if x % cell < 6 or y % cell < 6:
                canvas[y, x] = GROUT
            else:
                canvas[y, x] = TILE_A if ((x // cell) + (y // cell)) % 2 == 0 else TILE_B
    return Image.fromarray(canvas, "RGB")


def build_pdf(path):
    document = fitz.open()
    for index in range(PAGES):
        page = document.new_page(width=595, height=842)
        page.insert_text((60, 70), f"PLATE {index + 1}", fontsize=18)
        source = OUT / f"_src_{index}.png"
        tile_photo(30 + index * 6).save(source)
        page.insert_image(fitz.Rect(60, 120, 460, 520), filename=str(source))
    document.save(str(path))
    document.close()


class Analysis:
    def __init__(self):
        self.image_type = "TILE_SAMPLE"
        self.is_product_image = True
        self.decision = "APPROVED"
        self.confidence = 0.94
        self.product_name = "Colorbody"
        self.product_bbox = None
        self.reason = "standalone tile"


CLEAN_PURITY = {
    "tile_fraction": 1.0, "material": "TILE",
    "contains_person": False, "contains_text": False,
    "contains_logo": False, "contains_furniture": False,
    "contains_fixture": False, "contains_object": False,
    "is_scene": False, "distinct_tile_designs": 1, "reason": "tile grid",
}


def install(misbehave):
    """`misbehave` is raised/returned for BAD_PAGE's classification call."""

    def analyze(image_path, page_text=""):
        if f"page_{BAD_PAGE}_" in Path(image_path).name:
            return misbehave()
        return Analysis()

    pipeline.load_semantic_tile_validator = lambda: (
        analyze, validate_product_decision, validate_bbox,
    )
    pipeline.load_tile_region_miner = lambda: None
    pipeline.load_tile_purity_verifier = lambda: (
        lambda path: dict(CLEAN_PURITY), assess_tile_purity,
    )


def check(label, condition, detail=""):
    mark = "PASS" if condition else "FAIL"
    print(f"  [{mark}] {label}" + (f" -- {detail}" if detail else ""))
    return bool(condition)


def run(name, misbehave):
    directory = OUT / name
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True, exist_ok=True)

    install(misbehave)
    uploaded = []
    images = pipeline.extract_images_from_pdf(
        OUT / "catalog.pdf", directory,
        on_tile=lambda record: uploaded.append(record["filename"]),
    )
    review = directory / pipeline.DEFERRED_DIRECTORY_NAME
    preserved = sorted(review.glob("*.webp")) if review.exists() else []
    return images, uploaded, preserved


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)
    build_pdf(OUT / "catalog.pdf")

    results = []

    # ------------------------------------------------------------------
    print("=" * 72)
    print("The request timeout that was missing entirely")
    print("=" * 72)

    timeout_ms = gemini_service.client._api_client._http_options.timeout
    results.append(check(
        "every Gemini request is bounded by a timeout",
        timeout_ms is not None and timeout_ms > 0,
        f"{timeout_ms}ms (was None -- wait forever)",
    ))
    results.append(check(
        "a timeout is treated as retryable, so it defers rather than fails",
        gemini_service._is_gemini_transient_error(
            TimeoutError("request timed out")
        ),
    ))

    # ------------------------------------------------------------------
    # Each of these is a different way Gemini can misbehave. All four
    # must end the same way: that page deferred, every other page
    # extracted and uploaded.
    # ------------------------------------------------------------------
    def timing_out():
        raise TimeoutError("the read operation timed out")

    def hanging_then_giving_up():
        raise ConnectionError("server disconnected without sending a response")

    def exploding():
        raise ValueError("unparseable response")

    def returning_junk():
        class Junk:
            pass
        return Junk()

    scenarios = [
        ("timeout", timing_out, "request times out"),
        ("disconnect", hanging_then_giving_up, "connection drops"),
        ("exception", exploding, "call raises"),
        ("junk", returning_junk, "response is garbage"),
    ]

    for name, misbehave, description in scenarios:
        print("")
        print("=" * 72)
        print(f"Gemini {description} on page {BAD_PAGE}")
        print("=" * 72)

        images, uploaded, preserved = run(name, misbehave)

        print("")
        results.append(check(
            f"{name}: the run completed instead of hanging",
            True, "no interrupt needed",
        ))
        results.append(check(
            f"{name}: the other {PAGES - 1} pages were still extracted",
            len(images) == PAGES - 1, f"{len(images)} extracted",
        ))
        results.append(check(
            f"{name}: those tiles reached Drive immediately",
            len(uploaded) == PAGES - 1, f"{len(uploaded)} uploaded",
        ))
        results.append(check(
            f"{name}: the affected page was preserved, not deleted",
            len(preserved) == 1, f"{len(preserved)} in review_required/",
        ))
        results.append(check(
            f"{name}: the affected page was NOT published",
            all(f"page_{BAD_PAGE}_" not in n for n in uploaded),
        ))

    passed = sum(1 for r in results if r)
    print("")
    print(f"{passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
