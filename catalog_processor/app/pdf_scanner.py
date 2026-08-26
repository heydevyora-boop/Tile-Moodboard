from pathlib import Path


def find_all_pdfs(drive_path):
    """
    Scan the entire drive and return all PDF files.
    """

    drive = Path(drive_path)

    if not drive.exists():
        raise FileNotFoundError(
            f"Drive/path not found: {drive_path}"
        )

    pdf_files = []

    for pdf in drive.rglob("*"):
        if pdf.is_file() and pdf.suffix.lower() == ".pdf":
            pdf_files.append(pdf)

    return sorted(pdf_files)


def print_pdfs(drive_path):
    pdfs = find_all_pdfs(drive_path)

    print("\n===================================")
    print("PDF SCAN RESULT")
    print("===================================")

    print(f"Drive: {drive_path}")
    print(f"PDFs found: {len(pdfs)}")
    print()

    for index, pdf in enumerate(pdfs, start=1):
        print(f"{index}. {pdf}")

    print("===================================")

    return pdfs


if __name__ == "__main__":
    print_pdfs(r"E:\\")