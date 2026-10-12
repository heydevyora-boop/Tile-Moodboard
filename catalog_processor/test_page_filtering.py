"""
test_page_filtering.py

Regression for app/image_extractor.py's should_skip_page() and its
integration into extract_pdf_images().

THE PROBLEM THIS COVERS
------------------------
Catalog PDFs mixed pages that are never a product -- the cover, an
index/table of contents, an instructions or legend page, a disclaimer
-- in with the real product pages. extract_pdf_images() extracted every
embedded image on every page with no page-level judgement at all, so a
cover photo, a legend icon, or a block of instructional text rendered
as an image could reach Gemini and get uploaded as if it were a tile.

WHAT THIS FILE CHECKS
----------------------
1. should_skip_page() as a pure function, against each rule on its own:
   page 1 is always skipped regardless of content; a keyword match
   skips a page regardless of images; a text-heavy page with no large
   image is skipped; a text-heavy page that DOES carry a large image is
   NOT skipped by that rule (a long product description is not a
   disqualifier); a small icon does not count as a large image; keyword
   matching is case-insensitive.

2. The real extract_pdf_images(), run over an in-memory PDF built with
   PyMuPDF (no Gemini, no Drive, no Sheets -- same approach as
   test_extract_images_from_pdf.py), proving the filtering actually
   stops a skipped page's images from ever being written to disk, not
   merely that the predicate function returns the right boolean.

Run:  python3 test_page_filtering.py
"""

import sys
from io import BytesIO
from pathlib import Path

import numpy as np
import pymupdf as fitz
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.image_extractor import (  # noqa: E402
    LARGE_IMAGE_MIN_SIDE,
    TEXT_HEAVY_WORD_THRESHOLD,
    extract_pdf_images,
    should_skip_page,
)


def check(label, ok, detail=""):
    return (label, bool(ok), detail)


# ----------------------------------------------------------------------
# should_skip_page(): pure-function checks
# ----------------------------------------------------------------------

LARGE_IMAGE = [(LARGE_IMAGE_MIN_SIDE, LARGE_IMAGE_MIN_SIDE)]
SMALL_IMAGE = [(LARGE_IMAGE_MIN_SIDE - 1, LARGE_IMAGE_MIN_SIDE - 1)]
NO_IMAGES = []

# 85 words, deliberately free of every SKIP_PAGE_KEYWORDS substring, so
# rule 3 (text-heavy, no large image) can be exercised on its own.
TEXT_HEAVY_FILLER = (
    "Please store tiles flat in their original packaging until "
    "installation begins. Avoid exposing boxes to direct sunlight or "
    "moisture for long periods before laying begins. When handling "
    "large format pieces always use two people to prevent accidental "
    "breakage during transport around the site. Clean surfaces gently "
    "with a soft cloth and warm water after installation is complete. "
    "Allow adequate curing time before heavy foot traffic resumes in "
    "the finished area to ensure long term durability and a lasting "
    "finish for every room in the home."
)

SHORT_PRODUCT_TEXT = "Terra Grey  600x1200mm  Matte"


def rule_1_page_one_always_skipped():
    return [
        check(
            "page 1 is skipped even with a large image and short text",
            should_skip_page(1, SHORT_PRODUCT_TEXT, LARGE_IMAGE),
        ),
        check(
            "page 1 is skipped even with no text and no images at all",
            should_skip_page(1, "", NO_IMAGES),
        ),
    ]


def rule_2_keyword_pages():
    results = []
    for keyword in (
        "Instructions", "INDEX", "Table of Contents", "Cover Page",
        "Developer Notes", "How To Install", "Legend", "Symbol Key",
        "Notes", "Disclaimer",
    ):
        results.append(check(
            f'a page containing "{keyword}" is skipped even with a large image',
            should_skip_page(2, f"{keyword}\nSome other text here.", LARGE_IMAGE),
            f"keyword={keyword!r}",
        ))

    results.append(check(
        "keyword matching is case-insensitive",
        should_skip_page(2, "INSTRUCTIONS FOR INSTALLATION", LARGE_IMAGE),
    ))

    results.append(check(
        "a keyword embedded inside a product line still triggers "
        "(substring match is intentional, not whole-word)",
        should_skip_page(2, "See disclaimer at the back of this catalog.", LARGE_IMAGE),
    ))

    return results


def rule_3_text_heavy_no_large_image():
    return [
        check(
            "a text-heavy page (>=80 words) with NO large image is skipped",
            should_skip_page(2, TEXT_HEAVY_FILLER, NO_IMAGES),
            f"{len(TEXT_HEAVY_FILLER.split())} words, no images",
        ),
        check(
            "a text-heavy page with only a SMALL image is still skipped",
            should_skip_page(2, TEXT_HEAVY_FILLER, SMALL_IMAGE),
        ),
        check(
            "the same text-heavy page is NOT skipped once it carries a "
            "large image -- a long product description is not a "
            "disqualifier",
            not should_skip_page(2, TEXT_HEAVY_FILLER, LARGE_IMAGE),
        ),
        check(
            "a short product page (one large image, few words) is not "
            "skipped",
            not should_skip_page(2, SHORT_PRODUCT_TEXT, LARGE_IMAGE),
            f"{len(SHORT_PRODUCT_TEXT.split())} words",
        ),
        check(
            "a page with no text and no images is not skipped by rule 3 "
            "-- word count is 0, below the text-heavy threshold",
            not should_skip_page(2, "", NO_IMAGES),
        ),
        check(
            "the text-heavy threshold is exactly as documented",
            TEXT_HEAVY_WORD_THRESHOLD == 80,
            f"got {TEXT_HEAVY_WORD_THRESHOLD}",
        ),
    ]


def rule_3_boundary():
    just_under = " ".join(["word"] * (TEXT_HEAVY_WORD_THRESHOLD - 1))
    exactly_at = " ".join(["word"] * TEXT_HEAVY_WORD_THRESHOLD)
    return [
        check(
            "one word under the threshold, no large image, is NOT skipped",
            not should_skip_page(2, just_under, NO_IMAGES),
        ),
        check(
            "exactly at the threshold, no large image, IS skipped",
            should_skip_page(2, exactly_at, NO_IMAGES),
        ),
    ]


# ----------------------------------------------------------------------
# extract_pdf_images(): the real function, over a real in-memory PDF
# ----------------------------------------------------------------------

PAGE_W, PAGE_H = 600.0, 800.0


def _png_bytes(image):
    buffer = BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def _solid_tile(rgb, size=400):
    array = np.full((size, size, 3), rgb, dtype=np.uint8)
    return Image.fromarray(array)


def _small_icon(size=60):
    array = np.full((size, size, 3), (20, 20, 20), dtype=np.uint8)
    return Image.fromarray(array)


def _build_mixed_catalog(path):
    """Four pages, one per should_skip_page rule, mirroring a real
    catalog's shape: a cover, an index, a real product, and a
    disclaimer -- plus one more real product to prove normal pages
    keep working either side of a skipped one."""
    doc = fitz.open()

    # Page 1: looks exactly like a real product page (large image, short
    # text) -- still must be skipped, because it's page 1.
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    page.insert_image(
        fitz.Rect(50, 50, 450, 450),
        stream=_png_bytes(_solid_tile((210, 190, 170))),
    )
    page.insert_text((50, 470), "Cover Product 600x600mm", fontsize=12)

    # Page 2: an index/table of contents page -- keyword match, no
    # large image.
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    page.insert_textbox(
        fitz.Rect(40, 40, 560, 760),
        "TABLE OF CONTENTS\n\nSection 1 .... 3\nSection 2 .... 8\n"
        "Section 3 .... 15",
        fontsize=14,
    )

    # Page 3: a genuine product page -- one large image, a short
    # product line. Must survive filtering.
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    page.insert_image(
        fitz.Rect(50, 50, 450, 450),
        stream=_png_bytes(_solid_tile((90, 130, 160))),
    )
    page.insert_text((50, 470), "Onyx Vein  600x1200mm  Polished", fontsize=12)

    # Page 4: a disclaimer / care-instructions page -- long body text,
    # no large image (just a small decorative icon). Exercises rule 3
    # as well as the keyword list.
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    page.insert_image(
        fitz.Rect(500, 20, 560, 80),
        stream=_png_bytes(_small_icon()),
    )
    page.insert_textbox(
        fitz.Rect(40, 100, 560, 760),
        "DISCLAIMER\n\n" + TEXT_HEAVY_FILLER,
        fontsize=11,
    )

    # Page 5: another genuine product page, to prove filtering a page
    # does not disturb extraction of the pages around it.
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    page.insert_image(
        fitz.Rect(50, 50, 450, 450),
        stream=_png_bytes(_solid_tile((170, 80, 70))),
    )
    page.insert_text((50, 470), "Brass Strip  300x600mm  Matte", fontsize=12)

    doc.save(str(path))
    doc.close()


def integration_extract_pdf_images(tmp_root):
    pdf_path = tmp_root / "mixed_catalog.pdf"
    output_dir = tmp_root / "extracted"
    _build_mixed_catalog(pdf_path)

    extracted = extract_pdf_images(pdf_path, output_dir)
    pages_with_output = sorted({record["page"] for record in extracted})

    results = [
        check(
            "page 1 (cover, looks like a product) contributed no images",
            1 not in pages_with_output,
            f"pages with output: {pages_with_output}",
        ),
        check(
            "page 2 (table of contents) contributed no images",
            2 not in pages_with_output,
        ),
        check(
            "page 3 (real product) DID contribute an image",
            3 in pages_with_output,
        ),
        check(
            "page 4 (disclaimer, text-heavy, no large image) "
            "contributed no images",
            4 not in pages_with_output,
        ),
        check(
            "page 5 (real product, after a skipped page) DID contribute "
            "an image",
            5 in pages_with_output,
        ),
        check(
            "exactly two images were ever written to disk",
            len(extracted) == 2,
            f"got {len(extracted)}: {[r['page'] for r in extracted]}",
        ),
    ]

    # The skipped pages' images must never have touched the filesystem,
    # not merely be absent from the returned list.
    written_files = sorted(p.name for p in output_dir.glob("*"))
    results.append(check(
        "no file on disk is named for page 1, 2 or 4",
        not any(
            f"_page_{page}_" in name
            for name in written_files
            for page in (1, 2, 4)
        ),
        str(written_files),
    ))

    return results


def main():
    import tempfile

    groups = [
        ("rule 1: page 1 is always skipped", rule_1_page_one_always_skipped()),
        ("rule 2: keyword pages are skipped", rule_2_keyword_pages()),
        ("rule 3: text-heavy, no large image", rule_3_text_heavy_no_large_image()),
        ("rule 3: threshold boundary", rule_3_boundary()),
    ]

    with tempfile.TemporaryDirectory() as tmp:
        groups.append((
            "extract_pdf_images: mixed catalog end-to-end",
            integration_extract_pdf_images(Path(tmp)),
        ))

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
                    print(f"  FAIL  {label}" + (f"  [{detail}]" if detail else ""))

        print(f"\n{total - failures}/{total} checks passed")
        return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
