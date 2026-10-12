from pathlib import Path
import pymupdf


# ============================================================
# PAGE-LEVEL FILTERING
#
# Certain pages in a catalog PDF are never a product/tile: the cover,
# an index/table of contents, an instructions/legend/symbol-key page,
# developer notes, a disclaimer. Extracting images from those pages
# wastes downstream Gemini calls on content that can never become a
# Tile, and worse, lets the wrong thing -- a cover photo, a legend
# icon, a chunk of body text rendered into a crop -- get uploaded as
# if it were a real product.
#
# This filtering runs BEFORE any image on the page is written to
# disk: a skipped page contributes nothing to extract_pdf_images'
# returned list.
# ============================================================

# Case-insensitive substrings. Any one of these appearing in a page's
# extracted text marks it as non-product -- instructions, an index, a
# legend, a disclaimer -- rather than a catalog item.
SKIP_PAGE_KEYWORDS = (
    "instruction",
    "index",
    "contents",
    "cover",
    "developer",
    "how to",
    "legend",
    "symbol",
    "notes",
    "disclaimer",
)

# An embedded image at least this large on both sides is big enough to
# plausibly BE a product/tile photo, as opposed to a small icon, logo,
# bullet, or page-furniture graphic. Matches the MIN_WIDTH/MIN_HEIGHT
# already used elsewhere in this codebase (app/image_filter.py) for
# the same "is this actually product-sized" judgement.
LARGE_IMAGE_MIN_SIDE = 250

# A page carrying at least this many words of body text, and no large
# image, reads as a text page (instructions, a price list, a
# foreword) rather than a product page. Not calibrated against a real
# catalog -- a starting point; tune it against real extraction output
# if it proves too strict or too loose.
TEXT_HEAVY_WORD_THRESHOLD = 80


def should_skip_page(page_number, page_text, image_sizes):
    """
    True when `page_number` should be skipped entirely -- no image on
    it should be extracted.

    page_text: the page's plain extracted text, e.g. from pymupdf's
        page.get_text("text").
    image_sizes: an iterable of (width, height) for every embedded
        image already present on the page (from
        page.get_images(full=True), read before anything is written
        to disk).
    """

    # Rule 1: the first page of a catalog is always the cover/title
    # page, never a product.
    if page_number == 1:
        return True

    normalized_text = (page_text or "").lower()

    # Rule 2: instruction/index/legend/etc. pages, identified by their
    # own wording.
    for keyword in SKIP_PAGE_KEYWORDS:
        if keyword in normalized_text:
            return True

    # Rule 3: text-heavy pages carrying no image large enough to be a
    # real product photo.
    large_image_count = sum(
        1
        for width, height in image_sizes
        if width >= LARGE_IMAGE_MIN_SIDE
        and height >= LARGE_IMAGE_MIN_SIDE
    )

    if large_image_count == 0:
        word_count = len(normalized_text.split())

        if word_count >= TEXT_HEAVY_WORD_THRESHOLD:
            return True

    return False


def extract_pdf_images(pdf_path, output_dir):
    """
    Extract embedded images from a PDF.

    Important:
    - Keeps the ORIGINAL embedded image dimensions.
    - Does not apply width/height/aspect-ratio rejection to individual
      images -- see should_skip_page() for the page-level filter that
      runs before any image on a non-product page reaches this.
    - Deduplicates the same PDF xref.
    - Records every page where the image occurs.
    - Does NOT decide whether an image is a product/tile.
      Product detection and cropping are handled later by Gemini/pipeline.
    """

    pdf_path = Path(pdf_path)
    output_dir = Path(output_dir)

    if not pdf_path.exists():
        raise FileNotFoundError(
            f"PDF not found: {pdf_path}"
        )

    output_dir.mkdir(
        parents=True,
        exist_ok=True
    )

    extracted = []

    document = pymupdf.open(str(pdf_path))

    # xref -> extracted record
    # One embedded image can appear on multiple pages.
    seen_xrefs = {}

    try:
        for page_index in range(len(document)):
            page = document[page_index]
            page_number = page_index + 1

            image_list = page.get_images(full=True)

            image_sizes = [
                (image_info[2], image_info[3])
                for image_info in image_list
                if image_info and len(image_info) >= 4
            ]

            if should_skip_page(
                page_number,
                page.get_text("text"),
                image_sizes,
            ):
                print(
                    f"Skipping page {page_number}: "
                    f"not a product page (page-level filtering)."
                )
                continue

            for image_index, image_info in enumerate(
                image_list,
                start=1
            ):
                if not image_info:
                    continue

                xref = image_info[0]

                if not xref:
                    continue

                # ----------------------------------------------------
                # SAME EMBEDDED IMAGE / XREF
                # ----------------------------------------------------
                # Do not write the same physical embedded image again.
                # Instead, record the additional page occurrence.
                if xref in seen_xrefs:
                    existing = seen_xrefs[xref]

                    existing.setdefault(
                        "pages",
                        []
                    )

                    if page_number not in existing["pages"]:
                        existing["pages"].append(page_number)

                    existing.setdefault(
                        "occurrences",
                        []
                    )

                    existing["occurrences"].append({
                        "page": page_number,
                        "image_index": image_index
                    })

                    continue

                try:
                    image_data = document.extract_image(xref)

                    if not image_data:
                        continue

                    image_bytes = image_data.get("image")

                    if not image_bytes:
                        continue

                    extension = (
                        image_data.get("ext")
                        or "bin"
                    ).lower()

                    width = int(
                        image_data.get(
                            "width",
                            0
                        )
                        or 0
                    )

                    height = int(
                        image_data.get(
                            "height",
                            0
                        )
                        or 0
                    )

                    # ------------------------------------------------
                    # SAFE FILENAME
                    # ------------------------------------------------
                    filename = (
                        f"{pdf_path.stem}"
                        f"_page_{page_number}"
                        f"_image_{image_index}"
                        f".{extension}"
                    )

                    output_path = (
                        output_dir / filename
                    )

                    output_path.write_bytes(
                        image_bytes
                    )

                    record = {
                        "path": str(output_path),
                        "page": page_number,
                        "pages": [page_number],
                        "xref": xref,
                        "image_index": image_index,
                        "width": width,
                        "height": height,
                        "extension": extension,
                        "occurrences": [
                            {
                                "page": page_number,
                                "image_index": image_index
                            }
                        ]
                    }

                    seen_xrefs[xref] = record
                    extracted.append(record)

                except Exception as error:
                    print(
                        f"Could not extract image "
                        f"xref={xref}, "
                        f"page={page_number}: "
                        f"{error}"
                    )

    finally:
        document.close()

    return extracted