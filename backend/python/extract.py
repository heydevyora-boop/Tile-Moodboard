#!/usr/bin/env python3
"""
Casa de Aurum -- Catalog Extractor (Part 1 of the build guide)

Reads a brand's tile catalog PDF, pulls out candidate tile images and
best-effort metadata (size, finish, type, color, room, product code),
and emits a single JSON result on stdout for the Node backend
(src/services/catalogExtractor.service.ts, via src/utils/pythonRunner.ts)
to persist into Postgres.

Two operating modes, chosen automatically based on whether Google
credentials are configured:

  - LOCAL mode (default, no credentials): extracted tile images are saved
    to --output-dir on disk. Used for local development and is what this
    script is tested against, since this environment has no route to
    Google's APIs.
  - DRIVE mode (--service-account-key points at a real key file): images
    are uploaded to Google Drive and get shareable URLs; rows are also
    appended to a Google Sheet, matching the original build guide's
    "Google Sheet as tile database" design for staff who want a
    spreadsheet view to hand-correct before publishing.

Output contract (stdout):
  - Zero or more lines prefixed "PROGRESS:" -- human-readable progress,
    streamed live by pythonRunner.ts's onLine callback.
  - Exactly one line prefixed "RESULT_JSON:" as the last line -- the
    machine-readable result. Node parses only this line; everything else
    on stdout is for human/log consumption.

Exit code 0 on success (even if zero tiles were found -- that's a valid,
reportable outcome, not a crash). Non-zero only on unrecoverable errors
(bad PDF, missing file, etc.) -- see RESULT_JSON.success for the
authoritative pass/fail signal either way.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import traceback
import unicodedata

try:
    import pymupdf as fitz  # PyMuPDF's new import name
except ImportError:
    import fitz  # fall back to the deprecated but still-working name

# ---------------------------------------------------------------------------
# Heuristic tagging -- this is intentionally a best-effort first pass.
# Per the build guide, staff review and correct extracted rows before they
# go live (Admin Catalog Extractor page shows a review step), so this
# doesn't need to be perfect, just a useful starting point.
# ---------------------------------------------------------------------------

SIZE_PATTERN = re.compile(r'(\d{2,4})\s*[xX\u00d7]\s*(\d{2,4})\s*(mm|cm)?', re.IGNORECASE)

FINISH_KEYWORDS = [
    'Matte', 'Matt', 'Glossy', 'Gloss', 'Polished', 'Sugar', 'Anti-Slip',
    'Antislip', 'Textured', 'Satin', 'Rustic', 'Metallic', 'Honed', 'Lappato',
]

TYPE_KEYWORDS = {
    'HIGHLIGHTER': ['highlighter', 'highlight'],
    'BORDER': ['border', 'listello', 'strip'],
    'ACCENT': ['accent', 'decor', 'decorative'],
    'LARGE_FORMAT_BASE': ['large format', 'slab'],
}

ROOM_KEYWORDS = {
    'Bathroom': ['bathroom', 'washroom', 'toilet'],
    'Kitchen': ['kitchen', 'backsplash'],
    'Living Room': ['living room', 'living', 'hall'],
    'Bedroom': ['bedroom'],
}

COLOR_KEYWORDS = [
    'White', 'Beige', 'Grey', 'Gray', 'Black', 'Brown', 'Cream', 'Ivory',
    'Terracotta', 'Blue', 'Green', 'Pink', 'Gold', 'Bronze', 'Silver', 'Rose',
]

PRODUCT_CODE_PATTERN = re.compile(r'\b([A-Z]{2,6}-\d{3,6})\b')


def detect_size(text):
    m = SIZE_PATTERN.search(text)
    if not m:
        return None
    unit = m.group(3) or 'mm'
    return f"{m.group(1)}x{m.group(2)}{unit}"


def detect_one_of(text, keywords):
    lower = text.lower()
    for kw in keywords:
        if kw.lower() in lower:
            return kw
    return None


def detect_type(text):
    lower = text.lower()
    for tile_type, keywords in TYPE_KEYWORDS.items():
        for kw in keywords:
            if kw in lower:
                return tile_type
    return 'BASE'


def detect_room(text):
    lower = text.lower()
    for room, keywords in ROOM_KEYWORDS.items():
        for kw in keywords:
            if kw in lower:
                return room
    return None


def detect_product_code(text):
    m = PRODUCT_CODE_PATTERN.search(text)
    return m.group(1) if m else None


def guess_name(text, brand, page_num, image_index):
    for line in text.splitlines():
        cleaned = line.strip()
        # A plausible "name" line: not too short, not pure numbers/symbols,
        # not obviously a size/spec line.
        if 3 <= len(cleaned) <= 60 and re.search(r'[A-Za-z]{3,}', cleaned) and not SIZE_PATTERN.match(cleaned):
            return cleaned
    return f"{brand} -- Page {page_num} Tile {image_index}"


def slugify(value):
    value = unicodedata.normalize('NFKD', value).encode('ascii', 'ignore').decode('ascii')
    value = re.sub(r'[^\w\s-]', '', value).strip().lower()
    return re.sub(r'[\s-]+', '-', value)


# ---------------------------------------------------------------------------
# Bounding-box proximity matching -- ties a detected name/attributes to the
# specific image nearest it on the page, instead of applying one page-wide
# guess to every image on that page. Catalog pages routinely show more than
# one tile (e.g. a "Decor & Base" pair side by side); without this, every
# image on the page was tagged with the same name/type/finish, so the tile
# a staff member saw under a given name could actually be a different
# product's photo entirely.
# ---------------------------------------------------------------------------

MAX_LABEL_DISTANCE_PT = 260  # generous enough for a title above + spec line below a photo


def get_text_blocks(page):
    """Text spans on the page with their bounding boxes, in reading order.

    Deliberately span-level, not block/line-level: PyMuPDF's block grouping
    merges same-row captions that are far apart horizontally (e.g. a
    "Decor" label under the left tile and a "Base" label under the right
    tile end up in one block/line of text) because it groups by vertical
    proximity, not by column. Spans keep each label's own bbox, which is
    what lets a caption be matched to the specific image below/above it
    instead of whichever image happens to be nearest on the page.
    """
    raw = page.get_text('dict')
    spans = []
    for block in raw.get('blocks', []):
        if block.get('type') != 0:  # 0 = text block, 1 = image block
            continue
        for line in block.get('lines', []):
            for span in line.get('spans', []):
                text = span.get('text', '').strip()
                if text:
                    spans.append({'bbox': tuple(span['bbox']), 'text': text})
    return spans


def render_image_crop(page, rect, dpi=300):
    """Rasterizes exactly what's visibly printed inside `rect` on the page --
    the real tile swatch as the catalog shows it -- rather than the raw
    embedded PDF image resource.

    This matters because `doc.extract_image(xref)` (the old approach) hands
    back the ENTIRE embedded image object, byte for byte. Catalog PDFs
    routinely reuse a single larger image resource (a shared texture sheet,
    a background pattern) across several different swatch boxes, positioning
    or clipping different portions of it per box via the page's content
    stream. Extracting the raw resource ignores that positioning/clipping
    entirely, so two visually different tiles that happen to share an
    underlying image resource extract as the exact same bytes -- e.g. a
    highlighter tile's floral-patterned box extracting as its neighboring
    base tile's plain surface, because both draw from the same source image.
    Rendering the page itself at this rect sidesteps that: it's a pixel-exact
    photo of what a person looking at the catalog page actually sees in that
    box, independent of how the underlying PDF resources are shared.
    """
    zoom = dpi / 72
    matrix = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=matrix, clip=fitz.Rect(rect), alpha=False)
    return pix.tobytes('png'), pix.width, pix.height


def text_near_image(image_rect, text_blocks, max_distance=MAX_LABEL_DISTANCE_PT):
    """Text blocks near an image's rect, closest first. A block directly
    above or below the image (a caption/title) ranks ahead of one merely
    nearby but off to the side, since that's how catalog layouts caption
    a photo."""
    ix0, iy0, ix1, iy1 = image_rect
    scored = []
    for block in text_blocks:
        bx0, by0, bx1, by1 = block['bbox']
        if by0 >= iy1:
            vgap = by0 - iy1  # block sits below the image
        elif by1 <= iy0:
            vgap = iy0 - by1  # block sits above the image
        else:
            vgap = 0  # vertically overlapping the image's row
        if vgap > max_distance:
            continue
        horizontally_aligned = min(bx1, ix1) - max(bx0, ix0) > 0
        scored.append((vgap, 0 if horizontally_aligned else 1, block))
    scored.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in scored]


# ---------------------------------------------------------------------------
# Google Drive / Sheets (only exercised when credentials are configured)
# ---------------------------------------------------------------------------

class CloudUploader:
    """Wraps Drive upload + Sheet append. Falls back to a no-op if no
    service account key is configured, so the rest of the script doesn't
    need to branch on credential availability everywhere."""

    def __init__(self, service_account_key_path, drive_folder_name, sheet_name):
        self.enabled = bool(service_account_key_path and os.path.isfile(service_account_key_path))
        self.drive_folder_name = drive_folder_name
        self.sheet_name = sheet_name
        self._drive = None
        self._sheet = None
        self._folder_id = None

        if self.enabled:
            self._init_clients(service_account_key_path)

    def _init_clients(self, key_path):
        from google.oauth2.service_account import Credentials
        from googleapiclient.discovery import build
        import gspread

        scopes = [
            'https://www.googleapis.com/auth/drive',
            'https://www.googleapis.com/auth/spreadsheets',
        ]
        creds = Credentials.from_service_account_file(key_path, scopes=scopes)
        self._drive = build('drive', 'v3', credentials=creds)
        gc = gspread.authorize(creds)

        try:
            self._sheet = gc.open(self.sheet_name).sheet1
        except gspread.SpreadsheetNotFound:
            self._sheet = None  # caller can decide whether to create one

        self._folder_id = self._find_or_create_folder(self.drive_folder_name)

    def _find_or_create_folder(self, name):
        query = f"name='{name}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
        results = self._drive.files().list(q=query, fields='files(id, name)').execute()
        files = results.get('files', [])
        if files:
            return files[0]['id']
        folder = self._drive.files().create(
            body={'name': name, 'mimeType': 'application/vnd.google-apps.folder'},
            fields='id',
        ).execute()
        return folder['id']

    def upload_image(self, local_path, filename):
        """Uploads a local image to Drive and returns a shareable URL."""
        if not self.enabled:
            return None
        from googleapiclient.http import MediaFileUpload

        media = MediaFileUpload(local_path, mimetype='image/png')
        file = self._drive.files().create(
            body={'name': filename, 'parents': [self._folder_id]},
            media_body=media,
            fields='id',
        ).execute()
        file_id = file['id']
        self._drive.permissions().create(fileId=file_id, body={'role': 'reader', 'type': 'anyone'}).execute()
        return f"https://drive.google.com/uc?id={file_id}"

    def append_row(self, row):
        if not self.enabled or self._sheet is None:
            return
        self._sheet.append_row(row)

    def append_rows(self, rows):
        """Appends many rows in a single Sheets API call instead of one call
        per row -- Sheets' own append_rows batch endpoint does this in one
        request, avoiding N separate round-trips for N tiles."""
        if not self.enabled or self._sheet is None or not rows:
            return
        self._sheet.append_rows(rows)


# ---------------------------------------------------------------------------
# Main extraction
# ---------------------------------------------------------------------------

def log_progress(message):
    print(f"PROGRESS: {message}", flush=True)


def extract(pdf_path, brand, output_dir, uploader):
    doc = fitz.open(pdf_path)
    total_pages = doc.page_count
    log_progress(f"Opened PDF -- {total_pages} page(s)")

    os.makedirs(output_dir, exist_ok=True)

    tiles = []
    warnings = []
    pages_with_no_images = 0
    duplicate_images_skipped = 0
    seen_image_hashes = {}  # sha256 -> first filename that had it, for the warning message

    # Drive uploads are submitted to this pool as soon as each tile's image
    # is saved locally -- one page at a time, in reading order -- rather
    # than either (a) uploading inline and blocking on the network before
    # moving to the next image/page (the original design: correct but slow,
    # since a 60-page catalog then spends most of its wall-clock time
    # waiting on Google's API serially), or (b) collecting every tile from
    # every page first and only starting uploads once local extraction is
    # entirely done (a later revision: fast, but silent for the whole
    # multi-minute local-extraction phase and then silent again during one
    # big batch upload at the end, so it looks stalled).
    #
    # Submitting per-page, non-blockingly, gets both: each page's uploads
    # start running in the background while the NEXT page's local
    # extraction (fast, CPU-only) proceeds immediately -- overlapping
    # network wait time with real work exactly like a fully-deferred batch
    # would -- while still printing a progress line per page as its uploads
    # are kicked off, so the run visibly keeps moving instead of going
    # quiet for a long stretch.
    upload_pool = None
    upload_futures = []  # (tile_dict, Future) pairs, in extraction order
    if uploader.enabled:
        from concurrent.futures import ThreadPoolExecutor
        upload_pool = ThreadPoolExecutor(max_workers=8)

    for page_num in range(total_pages):
        page = doc[page_num]
        page_text = page.get_text()
        images = page.get_images(full=True)

        if not images:
            pages_with_no_images += 1
            continue

        log_progress(f"Page {page_num + 1}/{total_pages}: {len(images)} image(s) found")

        text_blocks = get_text_blocks(page)

        tile_counter = 0

        for img in images:
            xref = img[0]
            try:
                base_image = doc.extract_image(xref)
            except Exception as e:  # noqa: BLE001 -- a single bad image shouldn't kill the whole run
                warnings.append(f"Page {page_num + 1} image (xref {xref}): could not extract ({e})")
                continue

            try:
                image_rects = page.get_image_rects(xref)
            except Exception:  # noqa: BLE001 -- some malformed PDFs raise here
                image_rects = []

            # Every on-page placement of this image resource is its own tile
            # candidate, not just the first one. Catalog PDFs commonly reuse
            # one embedded image resource across several swatch boxes (e.g.
            # a shared texture sheet), positioning/clipping a different
            # portion of it per box -- treating only image_rects[0] would
            # silently drop every other swatch drawn from that same
            # resource. Falls back to a single placeholder "no known
            # position" placement when the PDF gives us no rects at all.
            placements = image_rects if image_rects else [None]

            for placement_rect in placements:
                tile_counter += 1
                image_index = tile_counter
                image_rect = tuple(placement_rect) if placement_rect else None

                # Scope name/attribute detection to the text physically near
                # THIS placement, not the whole page -- a page showing two
                # tiles side by side (e.g. a "Decor & Base" pair) must not
                # tag both images with whichever text happened to be first
                # on the page. Falls back to whole-page text only if nothing
                # is found near the image, which keeps single-tile-per-page
                # catalogs (the common case) working exactly as before.
                if image_rect:
                    nearby_blocks = text_near_image(image_rect, text_blocks)
                    scoped_text = '\n'.join(b['text'] for b in nearby_blocks[:8])
                else:
                    scoped_text = ''
                detection_text = scoped_text if scoped_text.strip() else page_text

                detected_size = detect_size(detection_text)
                detected_finish = detect_one_of(detection_text, FINISH_KEYWORDS)
                detected_type = detect_type(detection_text)
                detected_room = detect_room(detection_text)
                detected_color = detect_one_of(detection_text, COLOR_KEYWORDS)
                detected_code = detect_product_code(detection_text)

                # Prefer rendering exactly what's visibly printed in this
                # placement's box (see render_image_crop's docstring for why
                # the raw embedded resource can be the wrong pixels here).
                # Only falls back to the raw resource when there's no
                # placement rect to render from, or rendering itself fails.
                if image_rect:
                    try:
                        image_bytes, px_width, px_height = render_image_crop(page, image_rect)
                        ext = 'png'
                    except Exception as e:  # noqa: BLE001 -- fall back rather than losing the tile
                        warnings.append(
                            f"Page {page_num + 1} image {image_index}: crop render failed, "
                            f"using raw embedded image instead ({e})"
                        )
                        image_bytes = base_image['image']
                        ext = base_image.get('ext', 'png')
                        px_width = base_image.get('width', 0)
                        px_height = base_image.get('height', 0)
                else:
                    image_bytes = base_image['image']
                    ext = base_image.get('ext', 'png')
                    px_width = base_image.get('width', 0)
                    px_height = base_image.get('height', 0)

                # Skip tiny images (likely logos/icons, not product photos) --
                # a real product photo is virtually never under ~120px.
                if px_width < 120 or px_height < 120:
                    continue

                # Duplicate detection: the same photo sometimes appears more
                # than once in a catalog (e.g. reused across a product's
                # "also available in" section, or a repeated section banner
                # that slipped past the size filter). An exact byte hash
                # catches true duplicates without being fooled by
                # similar-but-different product photos, which a fuzzy/
                # perceptual hash would risk doing. Hashing the rendered crop
                # (not the raw resource) means two placements that genuinely
                # show the same pixels are still caught as duplicates, while
                # two placements that merely share an underlying resource but
                # crop different regions of it are correctly kept as distinct
                # tiles.
                image_hash = hashlib.sha256(image_bytes).hexdigest()
                if image_hash in seen_image_hashes:
                    duplicate_images_skipped += 1
                    warnings.append(
                        f"Page {page_num + 1} image {image_index}: identical to an earlier image "
                        f"({seen_image_hashes[image_hash]}) — skipped as a duplicate"
                    )
                    continue
                seen_image_hashes[image_hash] = f"page {page_num + 1}"

                name = guess_name(detection_text, brand, page_num + 1, image_index)
                filename = f"{slugify(brand)}-p{page_num + 1}-{image_index}.{ext}"
                local_path = os.path.join(output_dir, filename)

                with open(local_path, 'wb') as f:
                    f.write(image_bytes)

                # Drive upload + Sheet append are deliberately NOT done here,
                # inline per image -- see the parallel upload pass below.
                # Doing them here would mean every image pays its own
                # network round-trip serially before the next image can even
                # start being processed.
                tile = {
                    'name': name,
                    'size': detected_size,
                    'finish': detected_finish,
                    'type': detected_type,
                    'colorTone': detected_color,
                    'bestRoom': detected_room,
                    'productCode': detected_code,
                    'sourcePage': page_num + 1,
                    'imageBbox': list(image_rect) if image_rect else None,
                    'imageStorage': 'local',
                    'imageUrl': None,
                    'imageLocalPath': local_path,
                }
                tiles.append(tile)

                # Kick off this tile's Drive upload now, in the background --
                # doesn't block the rest of this page or the next one.
                if upload_pool is not None:
                    future = upload_pool.submit(uploader.upload_image, local_path, filename)
                    upload_futures.append((tile, future))

        if upload_pool is not None and upload_futures:
            log_progress(f"Page {page_num + 1}/{total_pages}: {len(upload_futures)} image(s) queued for Drive upload so far")

    doc.close()

    if pages_with_no_images:
        warnings.append(f"{pages_with_no_images} page(s) had no images and were skipped")

    # -----------------------------------------------------------------
    # Collect the background uploads submitted per-page above. Local
    # extraction is fully done by this point, so any upload that hasn't
    # finished yet just gets waited on here -- but most of them will
    # already be done or nearly done, since they've been running in the
    # background since their page was processed rather than starting only
    # now.
    # -----------------------------------------------------------------

    if upload_pool is not None:
        if upload_futures:
            log_progress(f"Waiting on {len(upload_futures)} Drive upload(s) to finish...")

        sheet_rows = []
        for tile, future in upload_futures:
            filename = os.path.basename(tile['imageLocalPath'])
            try:
                image_url = future.result()
            except Exception as e:  # noqa: BLE001 -- one failed upload shouldn't lose the rest
                warnings.append(f"Drive upload failed for {filename}: {e}")
                continue
            tile['imageUrl'] = image_url
            tile['imageStorage'] = 'drive'
            sheet_rows.append([
                tile['name'], brand, tile['size'] or '', tile['finish'] or '',
                tile['type'], tile['colorTone'] or '', tile['bestRoom'] or '',
                tile['productCode'] or '', image_url or '',
            ])

        upload_pool.shutdown(wait=True)

        if sheet_rows:
            log_progress(f"Appending {len(sheet_rows)} row(s) to Sheet...")
            try:
                uploader.append_rows(sheet_rows)
            except Exception as e:  # noqa: BLE001 -- images are already uploaded either way
                warnings.append(f"Sheet append failed: {e}")

    log_progress(f"Done -- {len(tiles)} tile candidate(s) extracted from {total_pages} page(s), {duplicate_images_skipped} duplicate(s) skipped")

    return {
        'totalPages': total_pages,
        'tilesExtracted': len(tiles),
        'tiles': tiles,
        'warnings': warnings,
        'duplicateImagesSkipped': duplicate_images_skipped,
        'storageMode': 'drive' if uploader.enabled else 'local',
    }


def main():
    parser = argparse.ArgumentParser(description='Casa de Aurum catalog extractor')
    parser.add_argument('--pdf', required=True, help='Path to the catalog PDF')
    parser.add_argument('--brand', required=True, help='Brand name (used for naming + Sheet rows)')
    parser.add_argument('--catalog-id', default=None, help='Backend Catalog row id, echoed back for correlation')
    parser.add_argument('--output-dir', default='./extracted', help='Where to save extracted images locally')
    parser.add_argument('--service-account-key', default=None, help='Path to a Google service account JSON key')
    parser.add_argument('--drive-folder', default='CasaDeAurum', help='Google Drive folder name for uploads')
    parser.add_argument('--sheet-name', default='CasaDeAurum Tiles', help='Google Sheet name to append rows to')
    args = parser.parse_args()

    started_at = time.time()

    if not os.path.isfile(args.pdf):
        result = {'success': False, 'catalogId': args.catalog_id, 'error': f"PDF not found: {args.pdf}"}
        print(f"RESULT_JSON: {json.dumps(result)}")
        sys.exit(1)

    try:
        uploader = CloudUploader(args.service_account_key, args.drive_folder, args.sheet_name)
        if uploader.enabled:
            log_progress("Google credentials found -- uploading to Drive + Sheets")
        else:
            log_progress("No Google credentials configured -- saving images locally only")

        extraction = extract(args.pdf, args.brand, args.output_dir, uploader)

        result = {
            'success': True,
            'catalogId': args.catalog_id,
            'brand': args.brand,
            'durationSeconds': round(time.time() - started_at, 2),
            **extraction,
        }
        print(f"RESULT_JSON: {json.dumps(result)}")
        sys.exit(0)

    except Exception as e:  # noqa: BLE001 -- top-level guard so we always emit valid RESULT_JSON
        result = {
            'success': False,
            'catalogId': args.catalog_id,
            'error': str(e),
            'traceback': traceback.format_exc(),
        }
        print(f"RESULT_JSON: {json.dumps(result)}")
        sys.exit(1)


if __name__ == '__main__':
    main()
