import fitz
from pathlib import Path
import sys


# Usage:
# python extract_page.py "E:\Catalog1.pdf" 7

pdf_path = Path(sys.argv[1])
page_number = int(sys.argv[2])

if not pdf_path.exists():
    print(f"PDF not found: {pdf_path}")
    sys.exit(1)

document = fitz.open(pdf_path)

if page_number < 1 or page_number > len(document):
    print(f"Invalid page number.")
    print(f"This PDF has {len(document)} pages.")
    sys.exit(1)

# PDF pages are zero-indexed in PyMuPDF
page = document[page_number - 1]

# Render page as image
pixmap = page.get_pixmap(
    matrix=fitz.Matrix(2, 2),
    alpha=False
)

output_folder = Path("output") / pdf_path.stem
output_folder.mkdir(parents=True, exist_ok=True)

output_file = output_folder / f"page_{page_number}.png"

pixmap.save(str(output_file))

document.close()

print("Page extracted successfully!")
print(f"Source: {pdf_path}")
print(f"Page: {page_number}")
print(f"Output: {output_file}")