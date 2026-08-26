from pathlib import Path
import pymupdf


def extract_pdf_images(pdf_path, output_dir):
    """
    Extract embedded images from a PDF.

    Important:
    - Keeps the ORIGINAL embedded image dimensions.
    - Does not apply width/height/aspect-ratio rejection.
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