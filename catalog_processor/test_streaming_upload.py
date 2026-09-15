"""Regression: a tile must reach Drive the moment it is extracted.

The failure this covers is loss, not correctness. process_pdf used to
run as:

    images = extract_images_from_pdf(...)   # the WHOLE catalog
    for image in images:                    # only now, upload
        upload_to_drive(image)

so nothing at all reached Drive until every page had been read, and the
Drive folder was not even created until then. A crash, a killed process
or an API failure on page 9 of a 10-page catalog threw away the eight
tiles already found and cleaned. On a long catalog that is most of the
work.

What must hold now: tile N is uploaded and recorded before candidate
N+1 is looked at, so an interruption costs only the tile in flight.

Run:  GEMINI_API_KEY=test python3 test_streaming_upload.py
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

import main_step6_complete as pipeline  # noqa: E402
from app.image_validator import (  # noqa: E402
    assess_tile_purity,
    validate_bbox,
    validate_product_decision,
)

OUT = Path(__file__).resolve().parent / "output" / "streaming_upload_test"

TILE_A = (198, 188, 172)
TILE_B = (176, 166, 150)
GROUT = (112, 104, 92)

PAGES = 6


def tile_photo(cell):
    canvas = np.zeros((760, 760, 3), dtype=np.uint8)
    for y in range(760):
        for x in range(760):
            if x % cell < 6 or y % cell < 6:
                canvas[y, x] = GROUT
            else:
                canvas[y, x] = TILE_A if ((x // cell) + (y // cell)) % 2 == 0 else TILE_B
    return Image.fromarray(canvas, "RGB")


def build_pdf(path):
    document = fitz.open()
    for index in range(PAGES):
        page = document.new_page(width=595, height=842)
        page.insert_text((60, 70), f"ONERY ELITE -- PLATE {index + 1}", fontsize=18)
        source = OUT / f"_src_{index}.png"
        tile_photo(30 + index * 8).save(source)
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


def install():
    pipeline.load_semantic_tile_validator = lambda: (
        lambda path, page_text="": Analysis(),
        validate_product_decision,
        validate_bbox,
    )
    pipeline.load_tile_region_miner = lambda: None
    pipeline.load_tile_purity_verifier = lambda: (
        lambda path: {
            "tile_fraction": 1.0, "material": "TILE",
            "contains_person": False, "contains_text": False,
            "contains_logo": False, "contains_furniture": False,
            "contains_fixture": False, "contains_object": False,
            "is_scene": False, "distinct_tile_designs": 1,
            "reason": "tile grid",
        },
        assess_tile_purity,
    )


def check(label, condition, detail=""):
    mark = "PASS" if condition else "FAIL"
    print(f"  [{mark}] {label}" + (f" -- {detail}" if detail else ""))
    return bool(condition)


class Drive:
    """Stands in for Google Drive, recording when each upload happened."""

    def __init__(self, fail_on=None):
        self.uploads = []
        self.fail_on = fail_on
        # Counted separately from successful uploads: keying the failure
        # off len(uploads) means a failed attempt never advances the
        # counter, so the stub fails on every subsequent tile instead of
        # the one it was asked to.
        self.attempts = 0

    def upload(self, record):
        self.attempts += 1
        if self.fail_on is not None and self.attempts == self.fail_on:
            raise RuntimeError("drive is down")
        self.uploads.append(record["filename"])
        return f"drive-id-{len(self.uploads)}"


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)
    build_pdf(OUT / "onery.pdf")
    install()

    results = []

    # ------------------------------------------------------------------
    print("=" * 72)
    print("RUN 1 -- uploads must interleave with extraction, not follow it")
    print("=" * 72)

    drive = Drive()
    order = []

    def on_tile(record):
        order.append(("upload", record["filename"]))
        drive.upload(record)

    directory = OUT / "interleaved"
    directory.mkdir(parents=True, exist_ok=True)

    real_validate = pipeline.validate_and_correct_tile_image

    def traced_validate(path, *args, **kwargs):
        order.append(("extract", Path(path).name))
        return real_validate(path, *args, **kwargs)

    pipeline.validate_and_correct_tile_image = traced_validate
    images = pipeline.extract_images_from_pdf(
        OUT / "onery.pdf", directory, on_tile=on_tile,
    )
    pipeline.validate_and_correct_tile_image = real_validate

    print("")
    results.append(check(
        "every extracted tile was handed over for upload",
        len(drive.uploads) == len(images) == PAGES,
        f"{len(images)} extracted, {len(drive.uploads)} uploaded",
    ))

    # The point of the whole change: the sequence must alternate. If
    # uploads were still batched they would all sit at the end.
    uploads_before_last_extract = sum(
        1 for kind, _name in order[:max(
            i for i, (k, _n) in enumerate(order) if k == "extract"
        )] if kind == "upload"
    )
    results.append(check(
        "tiles were uploaded while extraction was still running",
        uploads_before_last_extract >= PAGES - 1,
        f"{uploads_before_last_extract} of {PAGES} uploaded before the "
        f"last page was even examined",
    ))

    first_upload = next(i for i, (k, _n) in enumerate(order) if k == "upload")
    last_extract = max(i for i, (k, _n) in enumerate(order) if k == "extract")
    results.append(check(
        "the first upload happens before the last extraction",
        first_upload < last_extract,
        f"first upload at step {first_upload}, last extraction at "
        f"{last_extract}",
    ))

    # ------------------------------------------------------------------
    print("")
    print("=" * 72)
    print("RUN 2 -- a crash part-way through keeps what already uploaded")
    print("=" * 72)

    directory = OUT / "crash"
    directory.mkdir(parents=True, exist_ok=True)

    crashing = Drive()
    delivered = []

    def crashing_on_tile(record):
        if len(delivered) == 3:
            raise KeyboardInterrupt("process killed mid-catalog")
        crashing.upload(record)
        delivered.append(record["filename"])

    try:
        pipeline.extract_images_from_pdf(
            OUT / "onery.pdf", directory, on_tile=crashing_on_tile,
        )
    except KeyboardInterrupt:
        pass

    print("")
    results.append(check(
        "tiles found before the crash are already in Drive",
        len(crashing.uploads) == 3,
        f"{len(crashing.uploads)} safely uploaded before the interruption",
    ))
    results.append(check(
        "under the old batch flow this would have been zero",
        len(crashing.uploads) > 0,
    ))

    # ------------------------------------------------------------------
    print("")
    print("=" * 72)
    print("RUN 3 -- a Drive failure must not abort the rest of the catalog")
    print("=" * 72)

    directory = OUT / "drive_down"
    directory.mkdir(parents=True, exist_ok=True)

    flaky = Drive(fail_on=2)

    images = pipeline.extract_images_from_pdf(
        OUT / "onery.pdf", directory, on_tile=flaky.upload,
    )

    print("")
    results.append(check(
        "extraction continued past the failed upload",
        len(images) == PAGES, f"{len(images)} tiles still extracted",
    ))
    results.append(check(
        "the tiles after the failure still reached Drive",
        len(flaky.uploads) == PAGES - 1,
        f"{len(flaky.uploads)} uploaded, 1 failed",
    ))

    passed = sum(1 for r in results if r)
    print("")
    print(f"{passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
