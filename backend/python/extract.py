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
import threading
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


# ---------------------------------------------------------------------------
# Room/lifestyle photo rejection
#
# The goal: keep flat product swatches (the tile surface itself, including
# highlighter/decor tiles), reject staged photos of finished rooms -- a tile
# shown installed on a bathroom wall or floor, with fixtures, plants and
# furniture in frame. Catalog pages routinely carry both.
#
# This deliberately looks INSIDE the image rather than only at how it sits
# on the page. An earlier version judged purely on geometry (skip anything
# covering >55% of the page, or stretched wider than 3.5:1) and that was
# wrong in a way worth recording: catalogs very commonly devote a whole page
# to ONE product, printing the swatch full-bleed. Those pages' swatches are
# geometrically indistinguishable from a full-page room photo -- both fill
# the page -- so the area rule discarded the real tile on essentially every
# such page. On a 139-page catalog of exactly that layout it threw away all
# but 8 tiles. Page geometry simply does not carry the information needed to
# make this call; the pixels do.
# ---------------------------------------------------------------------------

BANNER_ASPECT_RATIO = 4.5       # beyond this it's a rule/banner strip, never a tile photo
PAGE_DOMINANT_FRACTION = 0.85   # covers essentially the whole page (see classify_image_content)

# What actually separates a tile surface from a photo of a room is how
# UNIFORM it is across its own area. A tile -- however busy or colourful its
# pattern -- repeats the same handful of colours everywhere on the swatch;
# every part of it looks statistically like every other part. A room photo is
# assembled from unrelated regions: a white basin, a green plant, a wooden
# stool, daylight through a window, a dark corner. So the test is not "is
# this image busy or colourful" but "do different parts of it look like
# different things".
#
# Two signals, measured on a coarse grid of regions:
#
#   colour_variation -- how much the regions differ in HUE, with brightness
#     divided out. This is the primary signal.
#   brightness_variation -- how much the regions differ in lighting. On its
#     own this is not sufficient (a tile with a deliberate dark-to-light
#     gradient trips it), so it only ever acts as corroboration.
#
# Two other signals were measured and deliberately REJECTED, because on real
# catalog artwork they point the wrong way:
#
#   - Edge density: a geometric-patterned highlighter tile measured 0.40,
#     HIGHER than every room photo tested (0.03-0.09). Filtering on "busy"
#     would delete precisely the highlighter/decor tiles this extractor most
#     needs to keep.
#   - Saturation: a vivid blue decor tile measured 0.74 against ~0.03 for the
#     room photos. Filtering on "colourful" would delete every coloured
#     decor tile in the catalog.
#
# Both are recorded here so they don't get "helpfully" reintroduced later.
#
# THRESHOLDS BELOW ARE CALIBRATED ON REAL DATA, NOT SYNTHETIC ARTWORK -- this
# matters and is worth recording in detail. The first version of this
# function was tuned against tile images drawn by hand for a test suite:
# clean, flat, computer-generated swatches with none of the shadow,
# reflection, and lighting falloff a real studio photo of a tile naturally
# carries. Run against an actual 139-page catalog, that version measured
# colour_variation across 113 genuine product photos as: min 0.0102, median
# 0.0295, mean 0.0376, max 0.1744 -- and the "strong, no corroboration
# needed" cutoff had been set to 0.020. 89% of real product photos exceeded
# it. The result was not a few misses; it was near-total data loss on a
# one-product-per-page catalog (pages 1-114 of 139 survived as ~0 tiles).
#
# The values below sit above that entire observed real-photo range. This
# necessarily means the classifier now catches only the most extreme
# lifestyle/room photos by colour alone -- a deliberate trade given the
# asymmetry of the two failure modes: a room photo that slips through costs
# one manual delete in the review step that already exists (Product Data
# already supports Edit/Delete per tile); a real product wrongly rejected
# here is silently gone, discovered only much later as a mysteriously
# missing/placeholder tile, exactly as happened before this recalibration.
ROOM_COLOUR_VARIATION = 0.10        # regions differ in hue -> unrelated objects in frame
ROOM_COLOUR_VARIATION_STRONG = 0.20   # so multi-coloured it needs no corroboration
ROOM_BRIGHTNESS_VARIATION = 0.30    # regions differ in lighting (corroborating only) -- real
                                     # product photos measured up to 0.2184 here too (a page
                                     # with pronounced shadow/reflection), so this needs real
                                     # clearance above that, not just above colour_variation's


def measure_image_content(image_bytes):
    """Region-level uniformity statistics for one rendered image. Returns
    None if the image can't be read or the optional analysis dependencies
    aren't importable -- callers treat that as "no opinion" and keep the
    image.

    Analysis runs on a downscaled copy: this is a question about the image's
    coarse composition, not its fine detail, so bounding the working size
    keeps the cost flat regardless of how large the rendered crop was.
    """
    try:
        import io

        import numpy as np
        from PIL import Image

        with Image.open(io.BytesIO(image_bytes)) as source:
            source = source.convert('RGB')
            source.thumbnail((256, 256))
            pixels = np.asarray(source, dtype=np.float32) / 255.0
    except Exception:  # noqa: BLE001 -- unreadable/undecodable image, or Pillow/numpy missing
        return None

    if pixels.ndim != 3 or min(pixels.shape[:2]) < 16:
        return None

    cells = 8
    height, width = pixels.shape[:2]
    cell_h, cell_w = height // cells, width // cells
    if cell_h < 1 or cell_w < 1:
        return None

    trimmed = pixels[: cell_h * cells, : cell_w * cells, :]
    # Mean colour of each of the 8x8 regions.
    region_colours = trimmed.reshape(cells, cell_h, cells, cell_w, 3).mean(axis=(1, 3))

    region_luma = region_colours.mean(axis=2)
    brightness_variation = float(region_luma.std())

    # Dividing each region's colour by its own brightness leaves only its
    # hue/chromaticity, so a tile that merely shades from light to dark
    # doesn't register as "different regions" -- only one that genuinely
    # changes colour does.
    chromaticity = region_colours / (region_luma[:, :, None] + 1e-6)
    colour_variation = float(chromaticity.reshape(-1, 3).std(axis=0).mean())

    return {
        'colour_variation': colour_variation,
        'brightness_variation': brightness_variation,
    }


def classify_image_content(image_bytes, image_rect, page_rect):
    """Decide whether a rendered placement is a room/lifestyle photo rather
    than a tile surface.

    Returns (is_room_photo, reason) -- reason carries the measured numbers,
    so a wrong call can be diagnosed from the run's warnings instead of
    guessed at.

    Errs deliberately towards keeping images. A false reject loses a real
    product from the catalog silently; a false keep leaves an obvious room
    photo for staff to delete during the review step that already exists.
    Those costs are not symmetric, so the thresholds sit well clear of the
    values measured on real tile artwork.
    """
    if image_rect:
        ix0, iy0, ix1, iy1 = image_rect
        width, height = ix1 - ix0, iy1 - iy0
        if width > 0 and height > 0:
            aspect_ratio = max(width, height) / min(width, height)
            if aspect_ratio > BANNER_ASPECT_RATIO:
                return True, f"banner/rule strip (aspect ratio {aspect_ratio:.1f}:1)"

    metrics = measure_image_content(image_bytes)
    if metrics is None:
        return False, ''

    colour_variation = metrics['colour_variation']
    brightness_variation = metrics['brightness_variation']

    page_area = page_rect.width * page_rect.height
    covers_page = False
    if image_rect and page_area > 0:
        ix0, iy0, ix1, iy1 = image_rect
        covers_page = ((ix1 - ix0) * (iy1 - iy0)) / page_area > PAGE_DOMINANT_FRACTION

    measured = (
        f"colour spread {colour_variation:.4f}, "
        f"lighting spread {brightness_variation:.4f}"
    )

    # Unmistakably multi-coloured composition -- stands on its own.
    if colour_variation > ROOM_COLOUR_VARIATION_STRONG:
        return True, (
            f"reads as a room/lifestyle photo rather than a tile surface "
            f"(clearly unrelated colours across the frame; {measured})"
        )

    # Mildly multi-coloured: needs uneven lighting to agree before rejecting,
    # unless it's the page's full-bleed hero image, where a single signal is
    # already enough to make it the likelier reading.
    if colour_variation > ROOM_COLOUR_VARIATION and (
        covers_page or brightness_variation > ROOM_BRIGHTNESS_VARIATION
    ):
        return True, (
            f"reads as a room/lifestyle photo rather than a tile surface "
            f"(varied colours and lighting across the frame; {measured})"
        )

    return False, measured


# ---------------------------------------------------------------------------
# Semantic tile validation (Gemini vision)
#
# WHY THIS EXISTS, when classify_image_content above already filters:
# classify_image_content's only real signal is how much the image's regions
# differ in HUE. That is blind, by construction, to a tonally monochromatic
# room -- a beige kitchen with a beige slab worktop, beige cabinetry and a
# beige splashback is colour-UNIFORM, so it reads as a flat tile surface.
# Measured on exactly that case: colour spread 0.0083, which is LOWER than
# 112 of the 113 genuine product photos recorded in
# test_extract_tile_classification.py (whose minimum is 0.0102). The two
# populations are not merely close there, they are inverted, so no threshold
# on that metric can separate them -- rejecting 0.0083 would reject
# essentially the whole catalog. A signal that understands image CONTENT,
# not image statistics, is the only thing that can make this call.
#
# Deliberately NOT imported from catalog_processor/app/gemini_service.py,
# which implements the same contract: backend/ and catalog_processor/ deploy
# as separate serverless functions with separate dependency sets, so that
# module is not importable from here. It also raises at import time when the
# key is absent, which would turn a missing key into a hard crash of the
# whole extraction rather than a degraded run.
#
# Runs AFTER the free filters (size, page-template, content statistics,
# duplicate hash) so the paid call is only ever made on candidates that
# survived everything cheaper.
# ---------------------------------------------------------------------------

GEMINI_MODEL = os.getenv('GEMINI_MODEL', 'gemini-3.1-flash-lite')

# The codebase's own documented confidence bands (gemini_service.py) read
# 0.90-1.00 "extremely clear", 0.75-0.89 "strong", 0.50-0.74 "uncertain".
# Anything below "strong" is treated as unsure and therefore rejected.
SEMANTIC_MIN_CONFIDENCE = 0.75

# Smallest crop worth keeping, as a fraction of the image's own width/height.
# Guards against a degenerate bbox collapsing a real tile to a few pixels.
MIN_CROP_FRACTION = 0.10

TILE_VALIDATION_PROMPT = """You are validating one image taken from a tile
manufacturer's product catalog. Decide whether it shows the TILE PRODUCT
ITSELF, or something else.

APPROVE (is_product_image = true) only when the image is essentially the
tile/product surface on its own: a flat swatch, a product close-up, or a
studio shot of the tile face. The tile surface must dominate the frame.

REJECT (is_product_image = false) when the image is any of:
- a room or lifestyle scene (kitchen, bathroom, bedroom, living room)
- a tile shown installed on a wall, floor, island, counter or splashback
- people or models
- furniture, cabinets, countertops, sanitaryware or appliances
- an architectural scene, room render or installation photograph
- a promotional or marketing composition
- an image dominated by branding, logos or marketing text
- a screenshot of a catalog page, or a collage of several products
- any image where the tile is only visible in the background

The single most common error is approving a room photo because the tile is
installed in it and the photo's colours are muted and uniform. A muted,
evenly-toned kitchen or bathroom is STILL a room photo. Judge what the image
DEPICTS, not how colourful it is.

Do not use the product name, size or brand text to decide. Judge only the
visual content.

product_bbox: when approving, give the tight bounds of the tile surface
within the image, normalised 0.0-1.0 as {x1, y1, x2, y2}. If the whole image
is already the tile, return {x1: 0, y1: 0, x2: 1, y2: 1}. Return null when
rejecting.

confidence: your certainty about the classification, 0.0-1.0.

reason: one short phrase naming what you actually saw.

Return ONLY valid JSON."""

TILE_VALIDATION_SCHEMA = {
    'type': 'OBJECT',
    'properties': {
        'is_product_image': {'type': 'BOOLEAN'},
        'confidence': {'type': 'NUMBER'},
        'reason': {'type': 'STRING'},
        'product_bbox': {
            'type': 'OBJECT',
            'nullable': True,
            'properties': {
                'x1': {'type': 'NUMBER'},
                'y1': {'type': 'NUMBER'},
                'x2': {'type': 'NUMBER'},
                'y2': {'type': 'NUMBER'},
            },
            'required': ['x1', 'y1', 'x2', 'y2'],
        },
    },
    'required': ['is_product_image', 'confidence', 'reason'],
}


class SemanticTileValidator:
    """Gemini-backed "is this actually the tile, or a photo of a room?" check.

    FAIL-CLOSED: production requires that ONLY a real, confidently-verified
    tile/product image is ever saved. That bar applies uniformly to every
    way this check can fail to produce a confirmation -- a missing API key
    is not treated differently from a low-confidence answer, an unreadable
    response, or an exhausted quota. All of them mean "this candidate was
    not confirmed as the product", so all of them reject. There is no
    inert/pass-through mode: `enabled=False` (no key configured) causes
    every verdict() call to reject, exactly like every other unavailable
    path below. `enabled` is reported by the caller purely so a run where
    every candidate is being rejected for lack of a key -- rather than
    because those candidates are genuinely bad -- is diagnosable from the
    output instead of silently reading as "this catalog had no tiles".

    Quota handling mirrors catalog_processor/app/gemini_service.py: the first
    429/RESOURCE_EXHAUSTED trips a process-local latch and no further calls
    are made, rather than burning the rest of the catalog against an API that
    is already refusing -- every remaining candidate in this run rejects
    immediately without a network call.
    """

    def __init__(self, api_key):
        self.enabled = bool(api_key)
        self._api_key = api_key
        self._client = None
        self._quota_exhausted = False

    def _get_client(self):
        if self._client is None:
            from google import genai
            self._client = genai.Client(api_key=self._api_key)
        return self._client

    @staticmethod
    def _is_quota_error(error):
        for attribute in ('code', 'status_code'):
            if getattr(error, attribute, None) == 429:
                return True
        message = str(error).upper()
        return any(marker in message for marker in (
            '429', 'RESOURCE_EXHAUSTED', 'QUOTA EXCEEDED',
            'RATE LIMIT', 'RATE_LIMIT', 'TOO MANY REQUESTS',
        ))

    def verdict(self, image_bytes):
        """Returns (approved, reason, bbox).

        bbox is a normalised (x1, y1, x2, y2) tuple or None.

        Anything short of a confident "yes, this is the product" is a
        rejection -- no configured key, an unreadable response, a
        low-confidence answer, a transient API error, and an exhausted quota
        all return approved=False. That is the fail-closed posture this gate
        was asked for: a wrong tile image is worse than a missing one, so an
        image this validator could not positively confirm is never saved,
        including when it could not even ask.
        """
        if not self.enabled:
            return False, (
                'semantic validation unavailable (GEMINI_API_KEY not configured) '
                '-- cannot confirm this is the actual product, needs review'
            ), None

        if self._quota_exhausted:
            return False, 'Gemini quota exhausted earlier in this run -- needs review', None

        from google.genai import types

        try:
            response = self._get_client().models.generate_content(
                model=GEMINI_MODEL,
                contents=[
                    types.Part.from_text(text=TILE_VALIDATION_PROMPT),
                    types.Part.from_bytes(data=image_bytes, mime_type='image/png'),
                ],
                config=types.GenerateContentConfig(
                    response_mime_type='application/json',
                    response_schema=TILE_VALIDATION_SCHEMA,
                    # Classification, not composition -- the same image must
                    # get the same verdict on every run.
                    temperature=0.0,
                ),
            )
        except Exception as error:  # noqa: BLE001 -- see docstring: never fail open
            if self._is_quota_error(error):
                self._quota_exhausted = True
                return False, 'Gemini quota/rate limit hit -- needs review', None
            return False, f'Gemini validation failed ({error}) -- needs review', None

        try:
            parsed = json.loads(response.text)
        except Exception:  # noqa: BLE001 -- unparseable answer is not a confirmation
            return False, 'Gemini returned an unreadable verdict -- needs review', None

        reason = str(parsed.get('reason') or '').strip() or 'no reason given'

        try:
            confidence = float(parsed.get('confidence') or 0.0)
        except (TypeError, ValueError):
            confidence = 0.0

        if not bool(parsed.get('is_product_image')):
            return False, f'not a tile/product image: {reason}', None

        if confidence < SEMANTIC_MIN_CONFIDENCE:
            return False, (
                f'tile/product classification too uncertain to trust '
                f'(confidence {confidence:.2f} < {SEMANTIC_MIN_CONFIDENCE}): {reason}'
            ), None

        return True, f'{reason} (confidence {confidence:.2f})', _parse_bbox(parsed.get('product_bbox'))


def _parse_bbox(raw):
    """Normalised bbox as a tuple, or None if it's absent/malformed/degenerate."""
    if not isinstance(raw, dict):
        return None
    try:
        box = tuple(float(raw[key]) for key in ('x1', 'y1', 'x2', 'y2'))
    except (KeyError, TypeError, ValueError):
        return None
    x1, y1, x2, y2 = box
    if not all(0.0 <= value <= 1.0 for value in box):
        return None
    if x2 - x1 < MIN_CROP_FRACTION or y2 - y1 < MIN_CROP_FRACTION:
        return None
    return box


def crop_to_product_bbox(image_bytes, bbox):
    """Crops to the tile surface the validator located.

    Pure extraction -- it only ever selects a sub-rectangle of pixels that
    are already there. Nothing is scaled, stretched, padded or generated, so
    the tile's colour, pattern, texture and proportions are exactly the
    catalog's own. Returns the image unchanged if the crop would be a no-op
    or anything goes wrong.
    """
    if not bbox:
        return image_bytes

    x1, y1, x2, y2 = bbox
    if (x1, y1, x2, y2) == (0.0, 0.0, 1.0, 1.0):
        return image_bytes

    try:
        import io

        from PIL import Image

        with Image.open(io.BytesIO(image_bytes)) as source:
            source.load()
            width, height = source.size
            # Rounded, not truncated: int() always floors, so a bound that
            # lands on 489.999 instead of 490 silently shaves a pixel off
            # the tile and skews its proportions.
            box = (
                round(x1 * width), round(y1 * height),
                round(x2 * width), round(y2 * height),
            )
            if box[2] - box[0] < 1 or box[3] - box[1] < 1:
                return image_bytes
            buffer = io.BytesIO()
            source.crop(box).save(buffer, 'PNG')
            return buffer.getvalue()
    except Exception:  # noqa: BLE001 -- a failed crop must not lose the tile
        return image_bytes


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

DRIVE_SHEETS_SCOPES = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets',
]


class CloudUploader:
    """Wraps Drive upload + Sheet append. Falls back to a no-op if no
    credentials are configured, so the rest of the script doesn't need to
    branch on credential availability everywhere.

    Two auth modes, mutually exclusive -- pass exactly one:

    - service_account_key_path: a service account JSON key. IMPORTANT:
      service accounts have NO Drive storage quota of their own (this is a
      Google Cloud platform limitation, not a permissions setting) -- every
      upload will fail with a 403 "Service Accounts do not have storage
      quota" UNLESS the destination is a Shared Drive (a Google Workspace
      feature) or the service account is impersonating a real user via
      domain-wide delegation (also requires Workspace admin access). On a
      regular free/personal Google account, this mode cannot work at all.
    - oauth_client_secret_path: an OAuth 2.0 "Desktop app" client secret
      JSON (downloaded from Google Cloud Console -> APIs & Services ->
      Credentials -> Create Credentials -> OAuth client ID -> Desktop app).
      This opens a one-time browser sign-in as a real Google account, and
      every file/row created afterward is owned by -- and counted against
      the storage of -- that real account, exactly like using Drive
      normally. The resulting token is cached to oauth_token_cache_path so
      later runs don't need to open a browser again, only refreshing
      silently in the background until that cached token itself expires or
      is revoked.
    """

    def __init__(self, service_account_key_path, drive_folder_name, sheet_name,
                 oauth_client_secret_path=None, oauth_token_cache_path=None):
        self.drive_folder_name = drive_folder_name
        self.sheet_name = sheet_name
        self._drive = None
        self._sheet = None
        self._folder_id = None
        self._creds = None
        self._oauth_token_cache_path = oauth_token_cache_path or os.path.join(
            os.path.dirname(os.path.abspath(__file__)), 'oauth_token.json'
        )
        # googleapiclient's Resource objects (what build() returns) wrap an
        # httplib2.Http transport that is documented as NOT thread-safe --
        # concurrent calls sharing one Resource instance across threads can
        # silently fail, hang, or interfere with each other's requests. Kept
        # even though uploads currently run strictly sequentially (not from
        # a thread pool) -- see _drive_for_this_thread -- so it's safe if
        # that ever changes back without anyone having to remember this.
        self._thread_local = threading.local()

        service_account_enabled = bool(service_account_key_path and os.path.isfile(service_account_key_path))
        oauth_enabled = bool(oauth_client_secret_path and os.path.isfile(oauth_client_secret_path))
        self.enabled = service_account_enabled or oauth_enabled

        if service_account_enabled:
            self._init_service_account_client(service_account_key_path)
        elif oauth_enabled:
            self._init_oauth_client(oauth_client_secret_path)

    def _init_service_account_client(self, key_path):
        from google.oauth2.service_account import Credentials
        from googleapiclient.discovery import build
        import gspread

        creds = Credentials.from_service_account_file(key_path, scopes=DRIVE_SHEETS_SCOPES)
        self._creds = creds
        self._drive = build('drive', 'v3', credentials=creds)  # used by the main thread only (folder lookup, Sheets setup)
        gc = gspread.authorize(creds)

        try:
            self._sheet = gc.open(self.sheet_name).sheet1
        except gspread.SpreadsheetNotFound:
            self._sheet = None  # caller can decide whether to create one

        self._folder_id = self._find_or_create_folder(self.drive_folder_name)

    def _init_oauth_client(self, client_secret_path):
        from google.oauth2.credentials import Credentials as UserCredentials
        from google.auth.transport.requests import Request
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
        import gspread

        creds = None
        if os.path.isfile(self._oauth_token_cache_path):
            try:
                creds = UserCredentials.from_authorized_user_file(self._oauth_token_cache_path, DRIVE_SHEETS_SCOPES)
            except Exception:  # noqa: BLE001 -- a corrupt/stale cache just means signing in again below
                creds = None

        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                log_progress(
                    "Opening a browser for one-time Google sign-in "
                    "(needed once -- future runs reuse the cached token)..."
                )
                flow = InstalledAppFlow.from_client_secrets_file(client_secret_path, DRIVE_SHEETS_SCOPES)
                creds = flow.run_local_server(port=0)
            with open(self._oauth_token_cache_path, 'w') as f:
                f.write(creds.to_json())

        self._creds = creds
        self._drive = build('drive', 'v3', credentials=creds)
        gc = gspread.authorize(creds)

        try:
            self._sheet = gc.open(self.sheet_name).sheet1
        except gspread.SpreadsheetNotFound:
            self._sheet = None

        self._folder_id = self._find_or_create_folder(self.drive_folder_name)

    def _drive_for_this_thread(self):
        """Returns a Drive client private to the calling thread -- see the
        thread-safety note on self._thread_local above."""
        client = getattr(self._thread_local, 'drive', None)
        if client is None:
            from googleapiclient.discovery import build
            client = build('drive', 'v3', credentials=self._creds)
            self._thread_local.drive = client
        return client

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
        """Uploads a local image to Drive and returns a shareable URL.

        Safe to call concurrently from multiple threads -- uses
        _drive_for_this_thread() rather than the shared self._drive, since
        the latter is only safe from a single thread (see the note on
        self._thread_local in __init__).
        """
        if not self.enabled:
            return None
        from googleapiclient.http import MediaFileUpload

        drive = self._drive_for_this_thread()
        media = MediaFileUpload(local_path, mimetype='image/png')
        file = drive.files().create(
            body={'name': filename, 'parents': [self._folder_id]},
            media_body=media,
            fields='id',
        ).execute()
        file_id = file['id']
        drive.permissions().create(fileId=file_id, body={'role': 'reader', 'type': 'anyone'}).execute()
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


REPEATING_TEMPLATE_MIN_PAGES = 5  # same position on this many distinct pages -> page furniture
REPEATING_TEMPLATE_BUCKET_PT = 2.0  # position tolerance, in points (see find_repeating_template_rects)


def find_repeating_template_rects(doc):
    """Pre-scans every page's image placements (positions only -- no
    rendering, no pixel work) and returns the set of bucketed positions that
    recur across many distinct pages.

    Exists to catch a failure mode the pixel-content classifier structurally
    cannot: a per-page letterhead graphic, brand badge, or certification
    stamp. These are flat, evenly-lit, and low in colour variance --
    exactly what a real tile swatch also looks like -- so no amount of
    tuning classify_image_content's thresholds can separate them from a
    genuine product photo by content alone. Found via a real 139-page
    catalog: a "COMPANY" badge and a "LUXOTIC PLUS" mark each printed at
    one exact position on more than a dozen separate pages, both surviving
    the content classifier and getting inserted as fabricated products.

    TWO conditions are required, and the second one matters as much as the
    first. Position recurrence ALONE is not evidence of page furniture:
    catalogs very commonly lay products out on a fixed grid, so a real
    product slot also lands at the same coordinates page after page. A
    position-only version of this function deleted an entire catalog's
    product range for exactly that reason (585 tile candidates down to 25),
    which is the same class of over-rejection this module has now hit
    twice. What actually separates the two cases is WHAT is drawn there:

      - a stamped badge is the same image every time, so every page draws
        it from the same PDF image object (one xref);
      - a grid slot holds a different product on each page, so each page
        draws a different xref into it.

    So a position is page furniture only when it recurs across many pages
    AND every one of those pages draws the identical image resource there.
    A genuine slot cycling through different products is never excluded,
    however rigid the layout. (A slot that really does repeat one identical
    image is a true duplicate anyway, and the rendered-crop hash downstream
    catches it.)
    """
    position_pages = {}  # bucketed rect -> set of page numbers it appeared on
    position_xrefs = {}  # bucketed rect -> set of image xrefs drawn there

    for page_num in range(doc.page_count):
        page = doc[page_num]
        for img in page.get_images(full=True):
            xref = img[0]
            try:
                rects = page.get_image_rects(xref)
            except Exception:  # noqa: BLE001 -- some malformed PDFs raise here
                continue
            for rect in rects:
                # PyMuPDF's own re-rendering of "the same" placement across
                # pages can differ by a fraction of a point (floating-point
                # noise in page content streams), so bucket rather than
                # comparing exact floats -- tight enough that two distinct
                # products never coincidentally collide, loose enough to
                # recognise the same stamped badge every time it recurs.
                bucket = tuple(round(c / REPEATING_TEMPLATE_BUCKET_PT) for c in rect)
                position_pages.setdefault(bucket, set()).add(page_num)
                position_xrefs.setdefault(bucket, set()).add(xref)

    return {
        bucket for bucket, pages in position_pages.items()
        if len(pages) >= REPEATING_TEMPLATE_MIN_PAGES
        and len(position_xrefs[bucket]) == 1
    }


def extract(pdf_path, brand, output_dir, uploader):
    doc = fitz.open(pdf_path)
    total_pages = doc.page_count
    log_progress(f"Opened PDF -- {total_pages} page(s)")

    template_rects = find_repeating_template_rects(doc)
    if template_rects:
        log_progress(
            f"Found {len(template_rects)} page-template position(s) (logo/badge/certification "
            f"mark repeated across {REPEATING_TEMPLATE_MIN_PAGES}+ pages) -- excluding those"
        )

    os.makedirs(output_dir, exist_ok=True)

    tiles = []
    warnings = []
    pages_with_no_images = 0
    duplicate_images_skipped = 0
    semantic_rejections = 0
    seen_image_hashes = {}  # sha256 -> first filename that had it, for the warning message

    validator = SemanticTileValidator(os.getenv('GEMINI_API_KEY'))
    if validator.enabled:
        log_progress(
            f"Semantic tile validation ON ({GEMINI_MODEL}) -- images that are not "
            "confidently the tile product itself will be reported, not saved"
        )
    else:
        # FAIL-CLOSED: production requires that ONLY a confidently-verified
        # real tile image is ever saved, and a missing key means that
        # confirmation can never be obtained -- so every candidate that
        # reaches this gate is rejected, and this run WILL extract zero
        # tiles. Stated outright, at the top of the run, rather than left to
        # be inferred from an empty result: an operator watching progress
        # scroll by needs to know in the first line why, not discover it
        # after a multi-hundred-page catalog finishes with nothing saved.
        log_progress(
            "ERROR -- GEMINI_API_KEY is not set. Semantic tile validation cannot "
            "run, and per the fail-closed requirement no candidate can be "
            "confirmed as the real product without it. EVERY extracted image in "
            "this run will be rejected (0 tiles saved) until the key is configured."
        )
        warnings.append(
            "GEMINI_API_KEY is not configured -- semantic tile validation could not "
            "run, so no candidate image could be confirmed as the actual product. "
            "All candidates were rejected rather than saved unverified."
        )

    # Each tile's image is uploaded to Drive synchronously, immediately
    # after it's extracted, before moving on to the next image -- a
    # deliberate ordering guarantee (no background pool, no batching): the
    # tradeoff is that a large catalog's total run time is roughly the sum
    # of every image's own Drive round-trip, since nothing overlaps.
    sheet_rows = []

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

                # Page furniture (a logo/badge/certification mark stamped at
                # the same spot on many pages) -- see find_repeating_template_rects.
                # Checked before any rendering/classification work, both
                # because it's nearly free and because it's more reliable
                # than pixel content for this specific case.
                if image_rect:
                    bucket = tuple(round(c / REPEATING_TEMPLATE_BUCKET_PT) for c in image_rect)
                    if bucket in template_rects:
                        warnings.append(
                            f"Page {page_num + 1} image {image_index}: skipped -- this position "
                            f"repeats across {REPEATING_TEMPLATE_MIN_PAGES}+ pages of the catalog, "
                            f"reading as a fixed page-template element (logo/badge/certification "
                            f"mark) rather than a distinct product"
                        )
                        continue

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

                # Reject staged room/bathroom photos, keeping only flat tile
                # surfaces (base, highlighter, decor). This runs on the
                # rendered pixels -- see classify_image_content -- because
                # the question "is this a tile or a photo of a room?" cannot
                # be answered from the image's size and position on the page
                # alone: a catalog page devoted to one product prints that
                # tile just as large as a hero room shot.
                is_room_photo, classification_note = classify_image_content(
                    image_bytes, image_rect, page.rect
                )
                if is_room_photo:
                    warnings.append(
                        f"Page {page_num + 1} image {image_index}: skipped -- {classification_note}"
                    )
                    continue

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

                # Last gate, and the only one that judges what the image
                # actually DEPICTS rather than how its pixels are
                # distributed -- see SemanticTileValidator. Placed here so
                # the paid call is only made for candidates that already
                # survived every free filter above, including the duplicate
                # hash, rather than once per placement on the page.
                #
                # Rejection means the image is NOT saved and no tile row is
                # produced for it: a room photo stored as a product is worse
                # than a gap the warnings below make visible.
                approved, verdict_reason, product_bbox = validator.verdict(image_bytes)
                if not approved:
                    semantic_rejections += 1
                    warnings.append(
                        f"Page {page_num + 1} image {image_index}: not saved -- {verdict_reason}"
                    )
                    continue

                # Tighten to the tile surface the validator located. Selects
                # a sub-rectangle of existing pixels only -- never scales,
                # pads or synthesises (see crop_to_product_bbox).
                if product_bbox:
                    image_bytes = crop_to_product_bbox(image_bytes, product_bbox)

                name = guess_name(detection_text, brand, page_num + 1, image_index)
                filename = f"{slugify(brand)}-p{page_num + 1}-{image_index}.{ext}"
                local_path = os.path.join(output_dir, filename)

                with open(local_path, 'wb') as f:
                    f.write(image_bytes)

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

                # Upload THIS image to Drive now and wait for it to finish
                # before moving on to the next image -- a deliberate
                # ordering guarantee, not an optimization. Each Drive
                # upload is a real network round-trip (create-file call,
                # then a second make-public call), so this is the slowest
                # correct way to do it -- that tradeoff is intentional here.
                if uploader.enabled:
                    try:
                        image_url = uploader.upload_image(local_path, filename)
                        tile['imageUrl'] = image_url
                        tile['imageStorage'] = 'drive'
                        sheet_rows.append([
                            tile['name'], brand, tile['size'] or '', tile['finish'] or '',
                            tile['type'], tile['colorTone'] or '', tile['bestRoom'] or '',
                            tile['productCode'] or '', image_url or '',
                        ])
                        log_progress(f"Page {page_num + 1}/{total_pages}: uploaded {filename} to Drive")
                    except Exception as e:  # noqa: BLE001 -- one failed upload shouldn't lose the rest
                        message = f"Drive upload failed for {filename}: {e}"
                        warnings.append(message)
                        # Also printed live (not just recorded for the final
                        # RESULT_JSON) -- a run where every upload is
                        # silently failing (e.g. the Drive folder was never
                        # shared with the service account) would otherwise
                        # look identical, second by second, to one that's
                        # working, all the way until it finishes 60+ pages
                        # later.
                        log_progress(f"ERROR -- {message}")

    doc.close()

    if pages_with_no_images:
        warnings.append(f"{pages_with_no_images} page(s) had no images and were skipped")

    if sheet_rows:
        log_progress(f"Appending {len(sheet_rows)} row(s) to Sheet...")
        try:
            uploader.append_rows(sheet_rows)
        except Exception as e:  # noqa: BLE001 -- images are already uploaded either way
            warnings.append(f"Sheet append failed: {e}")

    log_progress(
        f"Done -- {len(tiles)} tile candidate(s) extracted from {total_pages} page(s), "
        f"{duplicate_images_skipped} duplicate(s) skipped, "
        f"{semantic_rejections} rejected as not-the-tile"
    )

    # A run where every candidate was rejected (an expired key, a missing
    # key, an exhausted quota, a catalog whose images all genuinely fail)
    # otherwise reads as "this catalog simply had no tiles". Said plainly
    # instead -- this fires whether the rejections came from the validator
    # actively disapproving images or from it being unavailable to run at
    # all, since fail-closed makes both paths end in the same outcome.
    if semantic_rejections and not tiles:
        log_progress(
            "ERROR -- every candidate image was rejected "
            f"({'semantic validation is unavailable' if not validator.enabled else 'by semantic validation'}). "
            "Check the warnings for the reason before assuming the catalog is empty."
        )

    return {
        'totalPages': total_pages,
        'tilesExtracted': len(tiles),
        'tiles': tiles,
        'warnings': warnings,
        'duplicateImagesSkipped': duplicate_images_skipped,
        'semanticRejections': semantic_rejections,
        'semanticValidation': 'on' if validator.enabled else 'unavailable',
        'storageMode': 'drive' if uploader.enabled else 'local',
    }


def main():
    parser = argparse.ArgumentParser(description='Casa de Aurum catalog extractor')
    parser.add_argument('--pdf', required=True, help='Path to the catalog PDF')
    parser.add_argument('--brand', required=True, help='Brand name (used for naming + Sheet rows)')
    parser.add_argument('--catalog-id', default=None, help='Backend Catalog row id, echoed back for correlation')
    parser.add_argument('--output-dir', default='./extracted', help='Where to save extracted images locally')
    parser.add_argument(
        '--service-account-key', default=None,
        help='Path to a Google service account JSON key. NOTE: service accounts have no Drive '
             'storage quota of their own and cannot upload at all unless the destination is a '
             'Shared Drive (Google Workspace) -- on a regular free/personal Google account, use '
             '--oauth-client-secret instead.',
    )
    parser.add_argument(
        '--oauth-client-secret', default=None,
        help='Path to an OAuth 2.0 "Desktop app" client secret JSON (Google Cloud Console -> '
             'APIs & Services -> Credentials -> Create Credentials -> OAuth client ID -> Desktop '
             'app). Opens a one-time browser sign-in as a real Google account -- use this on a '
             'regular free/personal account where --service-account-key cannot work. Mutually '
             'exclusive with --service-account-key.',
    )
    parser.add_argument(
        '--oauth-token-cache', default=None,
        help='Where to cache the OAuth token after first sign-in, so later runs reuse it instead '
             'of opening a browser again (default: oauth_token.json next to this script).',
    )
    parser.add_argument('--drive-folder', default='CasaDeAurum', help='Google Drive folder name for uploads')
    parser.add_argument('--sheet-name', default='CasaDeAurum Tiles', help='Google Sheet name to append rows to')
    args = parser.parse_args()

    started_at = time.time()

    if not os.path.isfile(args.pdf):
        result = {'success': False, 'catalogId': args.catalog_id, 'error': f"PDF not found: {args.pdf}"}
        print(f"RESULT_JSON: {json.dumps(result)}")
        sys.exit(1)

    if args.service_account_key and args.oauth_client_secret:
        result = {
            'success': False, 'catalogId': args.catalog_id,
            'error': '--service-account-key and --oauth-client-secret are mutually exclusive -- pass at most one.',
        }
        print(f"RESULT_JSON: {json.dumps(result)}")
        sys.exit(1)

    try:
        uploader = CloudUploader(
            args.service_account_key, args.drive_folder, args.sheet_name,
            oauth_client_secret_path=args.oauth_client_secret,
            oauth_token_cache_path=args.oauth_token_cache,
        )
        if uploader.enabled:
            auth_mode = 'OAuth (your Google account)' if args.oauth_client_secret else 'service account'
            log_progress(f"Google credentials found ({auth_mode}) -- uploading to Drive + Sheets")
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
