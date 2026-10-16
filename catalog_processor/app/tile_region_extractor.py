"""Isolates a flat tile/material surface out of a wider photograph.

The catalog pipeline's other stages judge a WHOLE image: it is a tile
product or it is not. That cannot serve a page whose only view of a tile
is a bathroom photo -- the tile is genuinely there, wrapped in fixtures
and furniture that must not reach a Tile row.

This module does the geometry for that case, and only the geometry. A
caller supplies a candidate region (where a tile surface is, as a
quadrilateral) plus any occluders sitting on top of it; what comes back
is a flat, rectangular, occluder-free piece of that surface, or None when
no such piece is big enough to be worth keeping.

Two deliberate choices:

Occluders are AVOIDED, never painted over. Erasing a sofa means inventing
the pixels behind it, and an invented tile pattern is worse than no tile
at all. A swatch does not need the whole surface -- it needs a clean
piece of it -- so this searches for the largest sub-rectangle that no
occluder touches and keeps only real pixels. The rest of the pipeline
already takes this posture (see crop_image_to_validated_bbox).

Perspective correction runs BEFORE that search, so a tiled wall shot at
an angle becomes a flat plane whose tiles are square again, and the clean
rectangle is found in that flattened space rather than in the skewed
original.

Nothing here decides whether the result IS a tile. That judgement stays
with the semantic validator, which re-examines whatever this produces.
"""

from __future__ import annotations

import cv2
import numpy as np


# WHY THERE IS NO SOURCE-RELATIVE AREA GATE
#
# There used to be one: a region under 2% of the source image's area was
# rejected outright. It threw away real products. A catalog page that
# lays six tile samples out on one sheet gives each sample about 1% of
# that sheet, so all six were refused for being "too small" while each
# was a perfectly good 200x200px swatch.
#
# The size that matters is the candidate's OWN size in pixels -- that is
# what decides whether a usable swatch can be cut from it. How large the
# page around it happened to be says nothing about the tile. So the
# thresholds below are absolute, and the source-relative fraction is
# still computed and reported as a signal for the log, but never
# rejects anything by itself.
#
# This is not the same as having no area validation: a 40x40px speck
# still fails, on its own dimensions.

# Smallest unobstructed area that can still yield a usable swatch. A
# region that is mostly hidden behind a sofa can still hand over a clean
# 200x200 piece of tile, and that piece is a better product image than
# nothing at all -- so the test is whether what remains is big enough,
# not what proportion of the region it represents.
MIN_CLEAN_PIXELS = 130 * 130

# A candidate whose bounding box covers at least this much of a
# COMPOSED source (a rendered catalog page) is a region-detection
# failure, not a surface. A page carries margins, text, headings and
# usually several elements; no single material surface spans all of it.
#
# Two things produce such a candidate, and both are generic -- neither
# depends on any catalog's layout:
#   - the detector genuinely returns the whole frame as the surface
#   - a coordinate-space misread: _to_pixels clamps every fraction into
#     [0, 1], so out-of-range values land exactly on the frame edges and
#     the quad collapses to the full image
#
# Deliberately NOT applied to embedded images. There the source is
# already one element off the page, and a full-frame candidate is the
# right answer for a standalone product shot.
MAX_PAGE_SOURCE_COVERAGE = 0.92

# An occluder box covering at least this much of the region is treated as
# a detector error rather than an object on the tile -- see the note at
# the point of use in extract_tile_region. Set high on purpose: a genuine
# sofa across a floor covers a lot, and must still count.
OCCLUDER_MAX_COVERAGE = 0.85

# Smallest rectified surface worth trying to cut a swatch out of.
#
# It must never exceed MIN_CLEAN_PIXELS. The clean area is a SUBSET of
# the region, so a region floor above it rejects candidates that would
# have passed the real test -- a 128x170 sample died here, at 21,760px
# against a 22,500px floor, while comfortably clearing the 16,900px one
# that actually decides. Tying them together makes that impossible.
MIN_REGION_PIXELS = MIN_CLEAN_PIXELS

# Pixel floor for the SHORTER side of a saved swatch.
#
# Two numbers gate size now, and they do different jobs: this one asks
# "can the pattern still be read across the narrow direction", and
# MIN_CLEAN_PIXELS asks "is there enough tile here at all". A candidate
# has to satisfy both, which is what lets a long thin strip of tile --
# 1075x110 in the catalog logs, a perfectly usable sample -- through,
# while a 70x154 sliver is refused for being too narrow to read and a
# 96x96 chip is refused on area.
#
# 96 rather than 150 because at 150 that 1075x110 strip was rejected on
# its narrow side alone, with 118,000 pixels of clean tile in it.
MIN_OUTPUT_SIDE_PX = 96

# Small-but-valid crops are enlarged to roughly this, so downstream
# consumers get a usable image. Lanczos resampling of the real pixels:
# it interpolates what was photographed and invents no pattern. Capped
# by SAFE_UPSCALE_LIMIT because past that it is just blur.
UPSCALE_TARGET_SIDE_PX = 200
SAFE_UPSCALE_LIMIT = 2.0

# ...but a flat 200px floor is wrong when the SOURCE is small: a 320px
# catalog thumbnail cannot yield a 200px clean rectangle once occluders
# are removed, so a real tile gets discarded for being small relative to
# nothing. The effective floor is therefore scaled to the source and only
# ever RELAXED from MIN_OUTPUT_SIDE_PX, never tightened -- a large source
# is held to exactly the same 200px it is today.
MIN_OUTPUT_SIDE_FRACTION = 0.20

# Below this a crop is too small to read as a tile pattern at any source
# size, so the relative rule never descends past it.
MIN_OUTPUT_SIDE_FLOOR_PX = 96

# A TILE IS NOT A SLIVER -- AND THIS PATH HAD NO SUCH RULE AT ALL.
#
# The embedded-image route has refused extreme slivers since it was
# written (is_thin_strip_image in main_step6_complete.py, same 8.0).
# The region-mining route never did: it checked AREA (MIN_CLEAN_PIXELS)
# and each SIDE (effective_min_side), both of which a long thin strip
# passes comfortably. So a 150x1600 ribbon cut out of a page -- a
# grout line, a page rule, the edge of a frame -- was a 240,000-pixel
# crop with both sides over the floor, and it reached Drive as a
# product. That is the cut-off image this rule exists to stop.
#
# WHERE THE BAR IS, AND WHY IT IS NOT 8.0.
#
# 8.0 was the obvious choice -- the sibling path's own figure -- and it
# is WRONG here, which the suite proved immediately: a 1075x110 strip
# (9.8:1) is a documented real sample from this catalog's logs, a thin
# product photographed whole, and MIN_OUTPUT_SIDE_PX exists partly to
# keep it. A listello, a border, a pencil liner IS long and thin. So
# the honest range:
#
#   widest real region on this catalog's pages  :  5.93:1  (a size label;
#                                                   actual products 2:1)
#   documented usable thin product              :  9.8:1
#   the ribbon that reached Drive as a product  : ~14:1    (estimated off
#                                                   the screenshot, see below)
#
# 12.0 sits 22% above the worst good case and ~15% below the bad one.
# Both margins are real but neither is generous, so this is the number
# most likely to need revisiting -- and the ~14:1 end is an estimate
# from a screenshot of the file, not a measurement of the file itself,
# which was not reachable from here. If a ribbon ever survives this,
# the crop's own pixels (does the product continue past the edge?) are
# the better question than its proportions.
REGION_MAX_ASPECT_RATIO = 12.0


def effective_min_side(source_width, source_height):
    """Smallest acceptable crop side for a source of this size."""
    relative = int(min(source_width, source_height) * MIN_OUTPUT_SIDE_FRACTION)
    return max(MIN_OUTPUT_SIDE_FLOOR_PX, min(MIN_OUTPUT_SIDE_PX, relative))

# Resolution of the occupancy grid used to search for the clean
# rectangle. 160x160 keeps the search at roughly 25k cells -- accurate to
# well under a percent of the surface, and fast enough to run per region.
OCCUPANCY_GRID = 160


def _order_quad(quad: np.ndarray) -> np.ndarray:
    """Orders four corners as top-left, top-right, bottom-right, bottom-left.

    Corner order decides what the rectified output looks like, and a
    detector has no reason to return a consistent winding. Sorting by the
    coordinate sum finds the two extreme corners (TL smallest, BR
    largest); the difference y-x separates the other two.
    """
    points = np.asarray(quad, dtype=np.float32).reshape(4, 2)

    total = points.sum(axis=1)
    diff = np.diff(points, axis=1).reshape(-1)

    return np.array(
        [
            points[np.argmin(total)],   # top-left
            points[np.argmin(diff)],    # top-right
            points[np.argmax(total)],   # bottom-right
            points[np.argmax(diff)],    # bottom-left
        ],
        dtype=np.float32,
    )


def normalize_quad(quad, image_width, image_height):
    """Repairs a detected quad into one this module can actually use.

    Detectors return geometry that is *nearly* right far more often than
    they return geometry that is wrong: a corner a few pixels outside the
    frame, an inverted or rotated winding, float noise that makes an edge
    a hair shorter than zero. Discarding those loses real tiles, so each
    is corrected here rather than rejected.

    What is NOT repaired is a quad with no area -- fewer than three
    distinct corners, or a bounding box thinner than a pixel. There is no
    surface there to correct towards.

    Returns (points, note) with points as a list of four clamped (x, y)
    pairs, or (None, reason) when the quad is genuinely unusable. `note`
    describes any correction applied, for the caller's log.
    """
    try:
        points = np.asarray(quad, dtype=np.float64).reshape(4, 2)
    except (ValueError, TypeError):
        return None, "quad is not four (x, y) corners"

    if not np.all(np.isfinite(points)):
        return None, "quad contains non-finite coordinates"

    clamped = np.empty_like(points)
    clamped[:, 0] = np.clip(points[:, 0], 0.0, float(image_width))
    clamped[:, 1] = np.clip(points[:, 1], 0.0, float(image_height))

    notes = []
    if not np.allclose(clamped, points, atol=0.5):
        notes.append("clamped to image bounds")

    # Distinctness is measured at whole-pixel resolution: two corners
    # half a pixel apart describe an edge no crop can represent.
    distinct = {(round(float(x)), round(float(y))) for x, y in clamped}
    if len(distinct) < 3:
        return None, f"quad collapses to {len(distinct)} distinct corner(s)"

    span_x = float(clamped[:, 0].max() - clamped[:, 0].min())
    span_y = float(clamped[:, 1].max() - clamped[:, 1].min())

    if span_x < 1.0 or span_y < 1.0:
        return None, (
            f"quad bounding box is {span_x:.1f}x{span_y:.1f}px -- no area"
        )

    return [(float(x), float(y)) for x, y in clamped], ", ".join(notes)


def describe_quad(quad):
    """Renders a quad as rounded (x, y) pairs for a log line."""
    try:
        points = np.asarray(quad, dtype=np.float64).reshape(-1, 2)
    except (ValueError, TypeError):
        return repr(quad)

    return [(round(float(x), 1), round(float(y), 1)) for x, y in points]


def quad_bounds(quad):
    """Axis-aligned integer (x1, y1, x2, y2) enclosing the quad."""
    points = np.asarray(quad, dtype=np.float64).reshape(-1, 2)
    return (
        int(np.floor(points[:, 0].min())),
        int(np.floor(points[:, 1].min())),
        int(np.ceil(points[:, 0].max())),
        int(np.ceil(points[:, 1].max())),
    )


def _box_iou(first, second):
    """Intersection-over-union of two (x1, y1, x2, y2) boxes."""
    ax1, ay1, ax2, ay2 = first
    bx1, by1, bx2, by2 = second

    overlap_width = min(ax2, bx2) - max(ax1, bx1)
    overlap_height = min(ay2, by2) - max(ay1, by1)

    if overlap_width <= 0 or overlap_height <= 0:
        return 0.0

    overlap = overlap_width * overlap_height
    union = ((ax2 - ax1) * (ay2 - ay1)
             + (bx2 - bx1) * (by2 - by1)
             - overlap)

    return overlap / union if union > 0 else 0.0


# Above this overlap two detections are describing the same surface.
# Set well clear of the incidental overlap between a wall and the floor
# meeting it, which share an edge but almost no area.
REGION_OVERLAP_LIMIT = 0.55

# Grid side length for the perceptual content signature below. 12x12x3
# (colour) -- coarse enough that averaging into each cell smooths away
# compression and re-rasterization noise, fine enough to keep genuinely
# different tile colourways apart.
CONTENT_SIGNATURE_GRID = 12

# Two crops are treated as the SAME physical surface when their colour
# thumbnails differ, on average, by at most this fraction of the 0-255
# range.
#
# Measured, not guessed: the SAME tile pushed through this pipeline's
# two real rasterization paths -- WEBP re-encode at IMAGE_QUALITY (85)
# for the embedded route, versus a page render at PAGE_RENDER_DPI (200)
# then perspective-rectified for the render route -- differs by roughly
# 0.001-0.002 here. A visibly different but similar-toned product
# (e.g. two beige colourways of different tiles) measured 0.05 and up.
# 0.03 sits well clear of both: an order of magnitude above realistic
# pipeline noise, comfortably below the signal from an actually
# different product, so it does not (re)introduce a false merge between
# two distinct tiles that happen to share a similar palette -- which is
# exactly the failure mode a looser threshold would risk trading in for
# fixing cross-route duplicates.
CONTENT_SIGNATURE_MAX_DIFFERENCE = 0.03


def content_signature(image_bgr):
    """Perceptual fingerprint of a crop, robust to how it was rasterized.

    A low-resolution COLOUR thumbnail: downsample to a small grid with
    area averaging, which is the same operation a real near-duplicate
    detector uses because it is insensitive to the exact pixel values --
    JPEG/WEBP recompression, a different render DPI, a slightly
    different perspective-correction and mild blur all get smoothed out
    by the averaging, which an exact byte hash cannot tolerate.

    Colour, not greyscale: an earlier version compared luminance only
    and matched two DIFFERENT tile colourways that happened to share the
    same light/dark checkerboard pattern with different hues -- exactly
    the kind of pair (same format, different colour) a real catalog
    shows side by side. Keeping the colour channels is what tells them
    apart.

    Returns a tuple of floats (comparable with signatures_match).
    """
    small = cv2.resize(
        image_bgr, (CONTENT_SIGNATURE_GRID, CONTENT_SIGNATURE_GRID),
        interpolation=cv2.INTER_AREA,
    ).astype(np.float32)
    return tuple(small.flatten().tolist())


def signatures_match(first, second,
                     max_difference_fraction=CONTENT_SIGNATURE_MAX_DIFFERENCE):
    """True when two content_signature() results describe the same surface."""
    if first is None or second is None or len(first) != len(second):
        return False
    total = len(first)
    mean_difference = sum(abs(a - b) for a, b in zip(first, second)) / total
    return (mean_difference / 255.0) <= max_difference_fraction


def _bbox_crop(image_bgr, quad):
    """Raw axis-aligned crop of a quad's bounding box, or None if empty.

    Deliberately not perspective-rectified -- this is only used to
    verify "is this the same surface as that other candidate", not to
    produce output, so the cheap crop is enough and avoids doing the
    real rectification work twice per candidate.
    """
    height, width = image_bgr.shape[:2]
    x1, y1, x2, y2 = quad_bounds(quad)
    x1, x2 = max(0, min(width, x1)), max(0, min(width, x2))
    y1, y2 = max(0, min(height, y1)), max(0, min(height, y2))
    if x2 - x1 < 4 or y2 - y1 < 4:
        return None
    return image_bgr[y1:y2, x1:x2]


def deduplicate_regions(regions, image_bgr=None, overlap_limit=REGION_OVERLAP_LIMIT):
    """Drops detections that describe a surface already covered.

    A detector asked for "every tiled surface" will happily return the
    same wall five times with slightly different corners, and each copy
    would otherwise be rectified, saved and sent for classification --
    five API calls and five identical swatches for one tile.

    Geometry alone is not enough to call two candidates duplicates.
    Adjacent-but-distinct tiles laid out on one page can have detector
    quads that overlap by a wide margin -- imprecise geometry, not a
    repeated surface -- and dropping on IoU alone silently discarded a
    real, distinct tile. So when `image_bgr` is supplied, an overlap at
    or above `overlap_limit` is only treated as a duplicate once the two
    candidates' actual pixels also look like the same surface
    (content_signature). Two different tile designs that happen to
    overlap geometrically are then correctly kept as two candidates.

    Without `image_bgr` (no pixels available yet) this falls back to the
    original geometry-only rule, so any caller that cannot supply the
    source image keeps the previous behaviour rather than silently
    losing its safety net.

    `regions` is expected in the detector's confidence order, so the
    first sighting of a surface is the best-scored one and is the copy
    that survives. Returns (kept, dropped), where each dropped entry is
    (region, index_of_the_region_it_duplicates).
    """
    kept = []
    dropped = []
    kept_crop_signatures = []

    for region in regions:
        box = quad_bounds(region["quad"])
        region_signature = None

        duplicate_of = None
        for position, existing in enumerate(kept, start=1):
            if _box_iou(box, quad_bounds(existing["quad"])) < overlap_limit:
                continue

            if image_bgr is None:
                duplicate_of = position
                break

            if region_signature is None:
                crop = _bbox_crop(image_bgr, region["quad"])
                region_signature = content_signature(crop) if crop is not None else False

            existing_signature = kept_crop_signatures[position - 1]

            # A crop too small to verify (degenerate box) falls back to
            # the geometry-only call rather than assuming distinctness
            # it cannot support.
            if region_signature is False or existing_signature is False:
                duplicate_of = position
                break

            if signatures_match(region_signature, existing_signature):
                duplicate_of = position
                break

        if duplicate_of is None:
            kept.append(region)
            if image_bgr is not None:
                if region_signature is None:
                    crop = _bbox_crop(image_bgr, region["quad"])
                    region_signature = content_signature(crop) if crop is not None else False
                kept_crop_signatures.append(region_signature)
        else:
            dropped.append((region, duplicate_of))

    return kept, dropped


def rectify_quad(image_bgr: np.ndarray, quad) -> np.ndarray | None:
    """Flattens the quadrilateral region of image_bgr into a rectangle.

    The output is sized from the quad's own edge lengths (longest opposing
    pair per axis), so the tile keeps roughly the pixel density it had in
    the source rather than being stretched or shrunk to a fixed size.
    Returns None when the quad is degenerate.
    """
    ordered = _order_quad(quad)
    top_left, top_right, bottom_right, bottom_left = ordered

    width = int(round(max(
        np.linalg.norm(top_right - top_left),
        np.linalg.norm(bottom_right - bottom_left),
    )))
    height = int(round(max(
        np.linalg.norm(bottom_left - top_left),
        np.linalg.norm(bottom_right - top_right),
    )))

    if width < 2 or height < 2:
        return None

    destination = np.array(
        [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]],
        dtype=np.float32,
    )

    try:
        transform = cv2.getPerspectiveTransform(ordered, destination)
        return cv2.warpPerspective(
            image_bgr,
            transform,
            (width, height),
            flags=cv2.INTER_AREA,
            # A quad that reaches the image edge samples a fraction of a
            # pixel beyond it, and the default border fill is BLACK -- so
            # every such swatch came out with a black seam down one side.
            # Replicating the edge pixel keeps the border the colour of
            # the tile it belongs to. This copies a real neighbouring
            # pixel rather than inventing pattern, so the tile's own
            # appearance is untouched.
            borderMode=cv2.BORDER_REPLICATE,
        )
    except cv2.error:
        return None


def project_points(quad, points):
    """Maps points from source-image space into rectified space.

    Occluders are located on the original photograph, but the clean
    rectangle is searched for on the flattened surface, so their corners
    have to travel through the same homography.
    """
    ordered = _order_quad(quad)
    top_left, top_right, bottom_right, bottom_left = ordered

    width = max(
        np.linalg.norm(top_right - top_left),
        np.linalg.norm(bottom_right - bottom_left),
    )
    height = max(
        np.linalg.norm(bottom_left - top_left),
        np.linalg.norm(bottom_right - top_right),
    )

    destination = np.array(
        [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]],
        dtype=np.float32,
    )

    transform = cv2.getPerspectiveTransform(ordered, destination)

    source = np.asarray(points, dtype=np.float32).reshape(-1, 1, 2)
    return cv2.perspectiveTransform(source, transform).reshape(-1, 2)


def largest_clean_rectangle(width, height, occluders):
    """Largest axis-aligned rectangle touching none of the occluders.

    Works on a coarse occupancy grid via the standard
    largest-rectangle-in-a-histogram scan: for each row, every column
    holds the run of free cells ending at that row, and the maximal
    rectangle under that histogram is the best rectangle whose bottom
    edge sits on this row. Taking the best across all rows gives the
    global maximum.

    Occluder cells are marked by flooring the start and ceiling the end,
    so a partly covered cell counts as covered -- the swatch stays clean
    at the cost of a fractionally smaller crop.

    Returns (x1, y1, x2, y2) in pixels, or None if nothing is free.
    """
    if width < 1 or height < 1:
        return None

    columns = min(OCCUPANCY_GRID, max(1, int(width)))
    rows = min(OCCUPANCY_GRID, max(1, int(height)))

    cell_width = width / columns
    cell_height = height / rows

    free = np.ones((rows, columns), dtype=bool)

    for occluder in occluders or []:
        ox1, oy1, ox2, oy2 = occluder
        if ox2 <= ox1 or oy2 <= oy1:
            continue

        col_start = max(0, int(np.floor(ox1 / cell_width)))
        col_end = min(columns, int(np.ceil(ox2 / cell_width)))
        row_start = max(0, int(np.floor(oy1 / cell_height)))
        row_end = min(rows, int(np.ceil(oy2 / cell_height)))

        if col_end > col_start and row_end > row_start:
            free[row_start:row_end, col_start:col_end] = False

    best_area = 0
    best = None
    heights = np.zeros(columns, dtype=np.int32)

    for row in range(rows):
        heights = np.where(free[row], heights + 1, 0)

        # Monotonic stack over a sentinel-terminated histogram.
        stack: list[int] = []
        for column in range(columns + 1):
            current = heights[column] if column < columns else 0

            while stack and heights[stack[-1]] >= current:
                bar = heights[stack.pop()]
                left = stack[-1] + 1 if stack else 0
                area = bar * (column - left)

                if area > best_area:
                    best_area = area
                    best = (left, row - bar + 1, column - 1, row)

            stack.append(column)

    if best is None or best_area <= 0:
        return None

    col_start, row_start, col_end, row_end = best

    return (
        int(np.floor(col_start * cell_width)),
        int(np.floor(row_start * cell_height)),
        int(np.ceil((col_end + 1) * cell_width)),
        int(np.ceil((row_end + 1) * cell_height)),
    )


# A design boundary has to be a STEP, not a slope. Two tile products
# butted together change appearance abruptly across a seam; a wall lit
# from one side changes just as much from end to end, but gradually.
# Comparing narrow windows either side of a candidate seam separates the
# two -- a gradient looks almost identical across a short span, a seam
# does not.
SPLIT_WINDOW_FRACTION = 0.08

# Distance (in the combined colour + edge-density space below) that a
# seam must exceed. Tuned so two visibly different tile products split
# and one product under uneven lighting does not.
SPLIT_MIN_STEP = 22.0

# Neither piece of a split may be slimmer than this fraction of the
# candidate, so a sliver at one edge is never mistaken for a product.
SPLIT_MIN_PIECE_FRACTION = 0.22


def _dominant_period(signal):
    """Length of the repeating unit in a profile, or 0 if not periodic.

    A tiled surface is periodic BY DEFINITION -- that is what makes it a
    tile -- so its profile swings between grout and face every cell. To
    a step detector each of those swings looks exactly like a seam
    between two products, and an unsmoothed detector duly cuts a plain
    tiled wall into pieces. Finding the period is what lets the next
    step average it away.

    Autocorrelation of the mean-removed signal; the first clear peak is
    the cell size.
    """
    centred = signal - signal.mean()
    if not np.any(centred):
        return 0

    correlation = np.correlate(centred, centred, mode="full")
    correlation = correlation[len(centred) - 1:]

    if correlation[0] <= 0:
        return 0

    correlation = correlation / correlation[0]

    high = min(len(correlation) - 1, max(8, len(centred) // 4))
    if high <= 4:
        return 0

    window = correlation[4:high]
    if window.size == 0:
        return 0

    peak = int(np.argmax(window)) + 4

    # A weak peak means the surface is not really periodic (a plain
    # wall, a slab); there is then nothing to average away.
    return peak if correlation[peak] > 0.2 else 0


def _slice_profile(image_bgr, axis):
    """Per-slice [B, G, R, edge-density] features along one axis.

    axis=0 profiles columns (a vertical seam), axis=1 profiles rows.
    Edge density carries the cases colour alone misses: two tiles in the
    same colourway but different formats differ in how much grout line
    per unit area they show.

    The profile is smoothed over whole tile periods before it is
    returned, so the tile's own grid cannot read as a design change.
    """
    grey = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    edges = np.abs(cv2.Laplacian(grey, cv2.CV_32F, ksize=3))

    reduce_axis = 0 if axis == 0 else 1

    colour = image_bgr.astype(np.float32).mean(axis=reduce_axis)
    edge = edges.mean(axis=reduce_axis).reshape(-1, 1)
    profile = np.hstack([colour, edge])

    period = _dominant_period(profile[:, :3].mean(axis=1))
    if period < 2:
        return profile

    # Average over two whole periods: one leaves the result sensitive to
    # where the window happens to start relative to the grout.
    span = min(period * 2, max(2, profile.shape[0] // 3))
    kernel = np.ones(span, dtype=np.float32) / span

    smoothed = np.empty_like(profile)
    for column in range(profile.shape[1]):
        smoothed[:, column] = np.convolve(
            profile[:, column], kernel, mode="same",
        )

    # Convolution tapers at the two ends, which invents a step there.
    # Trimming is not an option (positions must stay comparable), so the
    # ends are held at the first and last fully-covered value.
    edge_pad = span // 2 + 1
    if smoothed.shape[0] > 2 * edge_pad:
        smoothed[:edge_pad] = smoothed[edge_pad]
        smoothed[-edge_pad:] = smoothed[-edge_pad - 1]

    return smoothed


def _best_seam(profile):
    """Strongest step in a profile: (position, strength).

    Returns (None, 0.0) when the profile is too short to judge.
    """
    length = profile.shape[0]
    window = max(4, int(length * SPLIT_WINDOW_FRACTION))
    margin = max(window, int(length * SPLIT_MIN_PIECE_FRACTION))

    if length < 2 * margin + 2:
        return None, 0.0

    best_position = None
    best_strength = 0.0

    for position in range(margin, length - margin):
        before = profile[position - window:position].mean(axis=0)
        after = profile[position:position + window].mean(axis=0)
        strength = float(np.linalg.norm(after - before))

        if strength > best_strength:
            best_strength = strength
            best_position = position

    return best_position, best_strength


# TWO PRODUCTS WITH THE PAGE SHOWING BETWEEN THEM.
#
# When a detector quad spans two tiles, the catalog page itself runs
# between them: a band that is perfectly uniform from one edge of the
# crop to the other. A single product never has one -- even a plain tile
# carries sensor noise, and a patterned tile's own grout lines are far
# too narrow to qualify.
#
# A gutter is BARE PAGE: brighter than the product, and flat.
#
# Finding it by flatness alone does not work, and the first version of
# this tried exactly that. On a plain cream tile the PRODUCT's own
# columns are flat too (measured: column std 0.50 at low texture, 1.42 at
# higher), so the whole crop reads as one uniform run edge to edge, the
# band never separates from it, and nothing is split. That is why a
# two-tile image with a white stripe down the middle kept reaching Drive
# even after the splitter was added.
#
# Brightness is what actually distinguishes them. A catalog page is
# lighter than the products printed on it, so a gutter column sits well
# above the median column of the crop AND is flat down its length.
#
# Verified across 26 cases: smooth tiles at five different texture
# levels with and without a gap, a checkerboard tile, two tiles of
# DIFFERENT colours either side of a gap, a marble-like tile, and every
# real product and real two-tile crop in single_catalog/. All 26
# separated correctly, with no false cut on any single product.
#
# Assumes the page is lighter than the product, which is true of every
# catalog seen here. A dark-background catalog would need the mirror of
# this test.
GUTTER_MAX_COLUMN_STD = 3.0
GUTTER_MIN_BRIGHTNESS_DELTA = 6.0
MIN_GUTTER_FRACTION = 0.015
MIN_GUTTER_PIECE_FRACTION = 0.12


def _page_runs(mean, std, span):
    """Interior runs that read as bare page: brighter than the product
    and flat down their length."""
    middle = float(np.median(mean))
    is_page = (mean >= middle + GUTTER_MIN_BRIGHTNESS_DELTA) & (
        std <= GUTTER_MAX_COLUMN_STD
    )

    runs, start = [], None
    for index, flag in enumerate(is_page):
        if flag and start is None:
            start = index
        elif not flag and start is not None:
            runs.append((start, index))
            start = None
    if start is not None:
        runs.append((start, len(is_page)))

    return [
        (a, b) for a, b in runs
        if a > 0 and b < span
        and (b - a) >= MIN_GUTTER_FRACTION * span
        and a >= MIN_GUTTER_PIECE_FRACTION * span
        and (span - b) >= MIN_GUTTER_PIECE_FRACTION * span
    ]


def split_at_background_gutters(image_bgr):
    """Cuts a crop at any full-span uniform band running through it.

    Returns a list of (x1, y1, x2, y2) boxes in the same shape
    split_tile_designs uses, or [] when the crop holds one product.

    This asks a geometric question the classifier is not needed for: is
    the page visible straight through this crop? If it is, the crop is
    holding more than one product and each side is extracted on its own
    rather than saved together with a white stripe down the middle.
    """
    if image_bgr is None or getattr(image_bgr, "size", 0) == 0:
        return []
    if image_bgr.ndim != 3 or min(image_bgr.shape[:2]) < 32:
        return []

    grey = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    height, width = grey.shape[:2]

    vertical = _page_runs(grey.mean(axis=0), grey.std(axis=0), width)
    if vertical:
        cuts, previous = [], 0
        for a, b in vertical:
            cuts.append((previous, 0, a, height))
            previous = b
        cuts.append((previous, 0, width, height))
        return cuts

    horizontal = _page_runs(grey.mean(axis=1), grey.std(axis=1), height)
    if horizontal:
        cuts, previous = [], 0
        for a, b in horizontal:
            cuts.append((0, previous, width, a))
            previous = b
        cuts.append((0, previous, width, height))
        return cuts

    return []


def split_tile_designs(image_bgr, max_pieces=4):
    """Cuts a candidate showing several tile designs into one box each.

    A catalog routinely shows two products butted together, or a strip
    of four. Such a frame is not a swatch of anything -- saved whole it
    would be a Tile row whose picture shows the neighbouring products
    too -- but the designs in it are real, and rejecting the candidate
    throws all of them away.

    So the frame is cut along the seams between them. Pieces are found
    by locating the strongest colour/texture STEP across the candidate
    and recursing into each side, which handles a 2-up and a 4-up alike.
    Every piece is real pixels from the original crop; nothing is
    redrawn, resampled or invented, and each still has to pass the same
    purity check on its own afterwards.

    Returns a list of (x1, y1, x2, y2) boxes in the crop's own
    coordinates, or [] when no seam is convincing enough -- in which
    case the caller keeps treating the candidate as one frame.

    LIMIT: seams are found from row and column averages, so designs laid
    out such that those averages match -- two products alternating in a
    checkerboard, say -- are invisible here and the candidate is left
    whole (and then refused by the purity gate, not saved dirty). Grids
    and strips, which is how catalogs actually lay products out, split
    correctly.
    """
    height, width = image_bgr.shape[:2]
    boxes = [(0, 0, width, height)]

    # Breadth-first: split the strongest seam anywhere in the current
    # set, then look again, until nothing is convincing or the cap is
    # reached. This finds a 4-up as two rounds of halving.
    while len(boxes) < max_pieces:
        best = None

        for index, (x1, y1, x2, y2) in enumerate(boxes):
            piece = image_bgr[y1:y2, x1:x2]
            if piece.shape[0] < 16 or piece.shape[1] < 16:
                continue

            for axis in (0, 1):
                position, strength = _best_seam(_slice_profile(piece, axis))
                if position is None or strength < SPLIT_MIN_STEP:
                    continue
                if best is None or strength > best[0]:
                    best = (strength, index, axis, position)

        if best is None:
            break

        _strength, index, axis, position = best
        x1, y1, x2, y2 = boxes.pop(index)

        if axis == 0:
            boxes.append((x1, y1, x1 + position, y2))
            boxes.append((x1 + position, y1, x2, y2))
        else:
            boxes.append((x1, y1, x2, y1 + position))
            boxes.append((x1, y1 + position, x2, y2))

    return [] if len(boxes) < 2 else boxes


# IS THIS PARENT A CATALOG PAGE, OR A PHOTOGRAPH?
#
# Three rules below reason about page LAYOUT -- that a product has page
# around it, that it does not bleed off the margin, that one product is
# one region. None of that holds inside a photograph, where every
# surface reaches the frame edge because the frame is a camera's, not a
# page's. Applying page logic there refused a tiled wall band above a
# sofa and stopped a two-tile layout being split.
#
# A page announces itself: one connected region of page colour,
# touching all four edges, with the products sitting in it. Measured
# over the real catalog pages and the synthetic photographs this repo
# tests with:
#
#     real catalog pages          0.516 .. 0.761 of the parent
#     photographs, full-frame     0.000  (no such region at all)
#
# The bar is 0.15: far below any page, and above a frame that has no
# page in it at all.
PAGE_MARGIN_MIN_SHARE = 0.15

_PAGE_LIKE_CACHE = {"key": None, "value": None}


def parent_is_a_catalog_page(image_bgr):
    """Does this parent have a page margin around its contents?"""
    key = (
        id(image_bgr), image_bgr.shape, image_bgr.dtype.str,
        int(image_bgr[::37, ::41].sum()),
    )
    if _PAGE_LIKE_CACHE["key"] == key:
        return _PAGE_LIKE_CACHE["value"]

    height, width = image_bgr.shape[:2]
    ring = max(2, int(round(min(height, width) * 0.02)))
    border = np.concatenate([
        image_bgr[:ring].reshape(-1, 3), image_bgr[-ring:].reshape(-1, 3),
        image_bgr[:, :ring].reshape(-1, 3), image_bgr[:, -ring:].reshape(-1, 3),
    ])
    page = np.median(border, axis=0)

    margin = (
        np.linalg.norm(image_bgr.astype(np.float32) - page, axis=2)
        <= GROW_BACKGROUND_TOLERANCE
    ).astype(np.uint8)
    margin = cv2.morphologyEx(margin, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))

    count, labels, stats, _ = cv2.connectedComponentsWithStats(margin, 4)
    band = max(1, int(round(min(height, width) * TRIM_EDGE_BAND)))
    best = 0.0
    for index in range(1, count):
        component = labels == index
        if not (component[:band].any() and component[-band:].any()
                and component[:, :band].any() and component[:, -band:].any()):
            continue
        best = max(best, float(stats[index, 4]) / float(height * width))

    value = best >= PAGE_MARGIN_MIN_SHARE
    _PAGE_LIKE_CACHE["key"], _PAGE_LIKE_CACHE["value"] = key, value
    return value


# A HERO THAT BLEEDS OFF THE PAGE IS NOT A PRODUCT SHOT.
#
# The real 41-page Mozart catalog finally explained two complaints that
# had survived several rounds. Its COVER carries a photograph of the
# Dubai Frame -- an actual building -- running off the bottom of the
# page, and page 2 carries three moulded frames overlapping each other
# and cropped by the page edge. Regions mined from those arrive as a
# frame-shaped structure and as narrow strips of moulding, which is
# exactly what kept reaching Drive.
#
# A catalog lays its PRODUCTS out with page around them and bleeds its
# HERO artwork off the edge. Measured over every product region on all
# 41 pages of that catalog -- 215 of them -- only three touch a page
# edge at all:
#
#     0 edges   212 regions   the products
#     1 edge      1 region    the Dubai Frame on the cover
#     2 edges     1 region    page 2's cropped mouldings
#     4 edges     1 region    a full-bleed page, a different thing
#                             and left to the scene rules
#
# So one, two or three edges is refused. Four is not: an image that IS
# the product edge to edge is the normal way an embedded product
# photograph arrives.
def region_runs_off_the_page(image_bgr, box):
    """Is the product under this box a hero bleeding off the page?

    Returns (True, reason) when the region it sits on runs off one,
    two or three edges of the parent, and (False, note) otherwise --
    including whenever it cannot be told.
    """
    if not parent_is_a_catalog_page(image_bgr):
        return False, "this parent is a photograph, not a page with margins"

    try:
        count, labels, stats, scale = _page_regions(image_bgr)
    except Exception as exc:  # noqa: BLE001 -- advice, never fatal
        return False, f"could not read the parent ({exc})"

    if count < 2:
        return False, "no product regions in the parent"

    x1, y1, x2, y2 = (int(v) for v in box)
    sx1, sy1 = int(max(0, x1) * scale), int(max(0, y1) * scale)
    sx2, sy2 = int(round(x2 * scale)), int(round(y2 * scale))
    inside = labels[sy1:max(sy1 + 1, sy2), sx1:max(sx1 + 1, sx2)]
    if inside.size == 0:
        return False, "the box falls outside the parent"
    found = inside[inside > 0]
    if found.size == 0:
        return False, "no product pixels inside the box"

    ids, counts = np.unique(found, return_counts=True)
    region = int(ids[int(np.argmax(counts))])

    height, width = labels.shape

    # ONLY A CATALOG PAGE HAS A MARGIN TO BLEED OFF.
    #
    # In a room photograph there is no page: the tiled wall reaches the
    # frame edge because every surface does, and refusing it would
    # throw away the lifestyle-shot recoveries this pipeline exists to
    # make. That is the same line the growing rule draws -- a product
    # on a page covers a small part of it (0.056 .. 0.126 measured on
    # the real catalog, 0.192 and 0.428 for the two bled heroes), while
    # a scene comes back as one region covering 0.823 of the frame.
    coverage = float(stats[region, 4]) / float(height * width)
    if coverage > GROW_MAX_PARENT_COVERAGE:
        return False, (
            f"the region covers {coverage:.0%} of the parent -- a photograph "
            f"rather than a page, so reaching the edge means nothing"
        )

    rx, ry, rw, rh = (int(v) for v in stats[region][:4])
    band = max(1, int(round(min(height, width) * TRIM_EDGE_BAND)))
    edges = (
        int(ry <= band) + int(ry + rh >= height - band)
        + int(rx <= band) + int(rx + rw >= width - band)
    )

    if 1 <= edges <= 3:
        return True, (
            f"the product here runs off {edges} edge(s) of the page -- hero "
            f"artwork bled to the margin, not a product shot"
        )
    return False, f"the product here sits inside the page ({edges} edges)"


# HOW MANY PRODUCTS ARE IN THIS CROP? ASK THE PAGE, NOT THE PIXELS IN IT.
#
# split_tile_designs looks for seams. On a panel whose own design has
# vertical structure -- a vine running up a framed blossom panel, a
# moulding with a bright highlight -- it finds them, and carves one
# product into four. Across all 41 pages of the real Mozart catalog,
# examining every whole single product on them:
#
#     cut by split_tile_designs      32 of 109   (29.4%)
#     cut by the gutter splitter      3 of 109   ( 2.8%)
#
# Nearly one product in three. Those quarters are the narrow strips of
# moulding that came back as "tiles".
#
# The page itself knows better. A product is one connected region of
# non-page colour on it, so a crop whose product pixels nearly all
# belong to ONE such region holds one product, whatever seams its
# pattern happens to show. Measured over 21 pages of that catalog: a
# quad drawn on a single product reads 1.000, and of 31 quads
# deliberately spanning two products only 4 read as one -- and those
# four are products that physically touch, so the page has no gap to
# find either.
#
# The bar is 0.95. Below it the crop may hold more than one product and
# the splitters decide as before.
SPLIT_ONE_PRODUCT_SHARE = 0.95


def crop_is_one_product(image_bgr, box):
    """Does this box hold a single product of its parent page?

    Returns (True, note) when the box's product pixels nearly all
    belong to one region of the parent, (False, note) otherwise --
    including whenever it cannot be told, so the splitters keep their
    existing behaviour by default.
    """
    if not parent_is_a_catalog_page(image_bgr):
        return False, "this parent is a photograph, not a page with margins"

    try:
        count, labels, stats, scale = _page_regions(image_bgr)
    except Exception as exc:  # noqa: BLE001 -- advice, never fatal
        return False, f"could not read the parent ({exc})"

    if count < 2:
        return False, "no product regions found in the parent"

    x1, y1, x2, y2 = (int(v) for v in box)
    sx1, sy1 = int(max(0, x1) * scale), int(max(0, y1) * scale)
    sx2, sy2 = int(round(x2 * scale)), int(round(y2 * scale))
    inside = labels[sy1:max(sy1 + 1, sy2), sx1:max(sx1 + 1, sx2)]
    if inside.size == 0:
        return False, "the box falls outside the parent"

    found = inside[inside > 0]
    if found.size == 0:
        return False, "no product pixels inside the box"

    _ids, counts = np.unique(found, return_counts=True)
    share = float(counts.max()) / float(counts.sum())
    if share >= SPLIT_ONE_PRODUCT_SHARE:
        return True, (
            f"the page shows one product here ({share:.0%} of its product "
            f"pixels are one region)"
        )
    return False, (
        f"the page shows more than one product here (largest region is "
        f"{share:.0%} of it)"
    )


# HALF A PRODUCT IS NOT A PRODUCT -- SO FINISH IT, DO NOT REFUSE IT.
#
# Mozart came back with half panels: a quad bounding part of a product,
# so the crop -- and any piece the splitter then cut from it -- held a
# fragment. What is needed to see that is not in the crop. It is in the
# PARENT, where the product plainly continues past the quad's edge.
#
# Six crop-only statistics were measured against this, and every one of
# them put a real, tightly cropped patterned tile inside the band that
# would have been refused: rectangle fill, ring variation, the share of
# the ring that is page, background edges at 8- and at 4-connectivity,
# and the contrast and texture across the quad's own boundary. The last
# came closest and still lost 8% of whole products. A rule that deletes
# one real tile in twelve is not worth having.
#
# So nothing is refused here. The quad is GROWN: find the product
# region the quad sits in and take that region's full extent. Measured
# on all three real catalog pages at image noise 0, 2, 4 and 6, a quad
# cut down to 30, 40, 55, 60 or 75 percent of a product recovers the
# SAME extent as a quad drawn exactly on it -- 276 times out of 276,
# growing 1.3x to 4.7x. Being wrong costs a slightly larger crop, never
# a lost one.
#
# Two guards hold it to the case it was measured on:
#
#   share      of the product pixels inside the quad, how many belong
#              to the one region being grown to. A real product gives
#              1.000. A quad spanning two products splits them, and a
#              full-bleed photo with no page at all gives 0.425. Below
#              0.55 this declines, and the splitter keeps its job.
#   coverage   how much of the parent that region covers. Real catalog
#              products cover 0.056 .. 0.126 of their page; a room
#              photograph, having no page to find, comes back as one
#              region covering 0.823. Above 0.50 this declines, so a
#              wall in a scene is never grown to the whole scene.
# Labelling the parent costs 1.35s at the pipeline's 200 DPI, and it is
# the SAME labelling for every candidate mined from that parent -- 16s
# of repeated work on a twelve-candidate page. One result is kept and
# reused. The fingerprint is the array's identity together with a
# sampled checksum, so a different parent cannot quietly reuse it; a
# collision, were one possible, would cost a worse crop and never a
# lost image.
_GROW_CACHE = {"key": None, "value": None}


# Labelling runs on a reduced copy. The result is only ever used to
# take a product region's bounding box, so a pixel or two at the edge
# changes nothing, and at the pipeline's 200 DPI it is the difference
# between 3.8s and a fraction of it per page.
GROW_WORKING_WIDTH = 1200


def _page_regions(image_bgr):
    """(count, labels, stats) for this parent's product regions, memoised.

    labels and stats are in the reduced frame; the caller scales.
    """
    key = (
        id(image_bgr), image_bgr.shape, image_bgr.dtype.str,
        int(image_bgr[::37, ::41].sum()),
        int(image_bgr[0, 0].sum()), int(image_bgr[-1, -1].sum()),
    )
    if _GROW_CACHE["key"] == key:
        return _GROW_CACHE["value"]

    height, width = image_bgr.shape[:2]
    scale = min(1.0, GROW_WORKING_WIDTH / float(max(1, width)))
    small = (
        image_bgr if scale >= 1.0
        else cv2.resize(image_bgr, (max(8, int(width * scale)),
                                    max(8, int(height * scale))),
                        interpolation=cv2.INTER_AREA)
    )

    small_height, small_width = small.shape[:2]
    ring = max(2, int(round(min(small_height, small_width) * 0.02)))
    border = np.concatenate([
        small[:ring].reshape(-1, 3), small[-ring:].reshape(-1, 3),
        small[:, :ring].reshape(-1, 3), small[:, -ring:].reshape(-1, 3),
    ])
    page = np.median(border, axis=0)

    product = (
        np.linalg.norm(small.astype(np.float32) - page, axis=2)
        > GROW_BACKGROUND_TOLERANCE
    ).astype(np.uint8)
    product = cv2.morphologyEx(
        product, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8),
    )
    count, labels, stats, _ = cv2.connectedComponentsWithStats(product, 8)

    value = (count, labels, stats, small_width / float(width))
    _GROW_CACHE["key"], _GROW_CACHE["value"] = key, value
    return value


GROW_MIN_REGION_SHARE = 0.55
GROW_MAX_PARENT_COVERAGE = 0.50
GROW_BACKGROUND_TOLERANCE = 18.0
GROW_MIN_GAIN = 1.08


def grow_to_whole_product(image_bgr, quad):
    """Extends a quad that cuts a product to the whole of that product.

    Returns (quad, note). The quad is replaced by the product region's
    own bounding box when the parent shows the product continuing past
    it, and handed back unchanged in every other case.
    """
    if not parent_is_a_catalog_page(image_bgr):
        return quad, "this parent is a photograph, not a page with margins"

    bx1, by1, bx2, by2 = quad_bounds(quad)
    height, width = image_bgr.shape[:2]
    box_width, box_height = bx2 - bx1, by2 - by1
    if box_width < 8 or box_height < 8:
        return quad, "box too small to grow"

    count, labels, stats, scale = _page_regions(image_bgr)
    if count < 2:
        return quad, "no product regions in the parent"

    sx1, sy1 = int(max(0, bx1) * scale), int(max(0, by1) * scale)
    sx2, sy2 = int(round(bx2 * scale)), int(round(by2 * scale))
    inside = labels[sy1:max(sy1 + 1, sy2), sx1:max(sx1 + 1, sx2)]
    if inside.size == 0:
        return quad, "box falls outside the parent"
    found = inside[inside > 0]
    if found.size == 0:
        return quad, "no product pixels inside the box"

    ids, counts = np.unique(found, return_counts=True)
    best = int(np.argmax(counts))
    share = float(counts[best]) / float(counts.sum())
    if share < GROW_MIN_REGION_SHARE:
        return quad, (
            f"the box spans more than one product ({share:.0%} in the "
            f"largest) -- leaving it for the splitter"
        )

    region = int(ids[best])
    coverage = float(stats[region, 4]) / float(labels.shape[0] * labels.shape[1])
    if coverage > GROW_MAX_PARENT_COVERAGE:
        return quad, (
            f"that region covers {coverage:.0%} of the parent -- a scene, "
            f"not a product on a page"
        )

    rx, ry, rw, rh = (int(round(v / scale)) for v in stats[region, :4])
    rx, ry = max(0, rx), max(0, ry)
    rw, rh = min(rw, width - rx), min(rh, height - ry)
    if rw < 8 or rh < 8:
        return quad, "the region is too small to be a product"

    gain = (rw * rh) / float(max(1, box_width * box_height))
    if gain < GROW_MIN_GAIN:
        return quad, "the quad already holds the whole product"

    return (
        [(rx, ry), (rx + rw, ry), (rx + rw, ry + rh), (rx, ry + rh)],
        f"the product continues past this quad -- grown {gain:.1f}x to the "
        f"whole of it ({rw}x{rh})",
    )


# ONLY THE TILE. NOT THE PAGE IT WAS PRINTED ON.
#
# A catalog does not always print its products straight. The Exotica
# pages lay them at an angle, and a detector reporting an axis-aligned
# box around a tilted tile hands back a frame that is mostly paper: two
# white triangles with a diagonal band of product between them. Three
# of the five images from that run were exactly that.
#
# The page around a product is flat and one colour, which is what makes
# this cheap: take the colour of the crop's own outer ring, mark every
# pixel far from it, and the product is the blob that is left. Three
# numbers then describe that blob, measured on this repo's own
# single_catalog products -- a moulded panel, a floral panel, a plain
# cream tile, a checkerboard tile and a synthetic highlighter strip --
# on pale and dark pages, at 0, 5, 12, 20, 35 and 45 degrees, with and
# without a drop shadow, a caption line and a clipping crop edge:
#
#   fill    how much of its own rotated bounding rectangle the blob
#           fills. A whole tile is a rectangle and fills it: 0.987 ..
#           1.000 through every rotation, shadow and caption case. A
#           crop already tight to its product has no page in the ring,
#           the mask comes out sparse, and fill falls to 0.007 .. 0.085.
#           A diagonal sliver cut by the frame is a parallelogram:
#           0.788 .. 0.815.
#   touch   how many frame edges the blob reaches. A product with page
#           around it reaches none. A product running out of the crop
#           reaches at least one. A patterned tile filling the frame
#           reaches all four, because its own pattern is what the mask
#           found.
#   second  the next blob's area as a fraction of the largest. Two
#           products in one frame give 1.000, everything else 0.000 ..
#           0.003, and two products are the gutter splitter's job.
#
# WHAT THIS DELIBERATELY DOES NOT DO IS REJECT.
#
# A sliver and a partial tile should be refused, and the first versions
# of this did refuse them. But every statistic that separated them from
# a whole tile -- ring variation, the share of the ring that is page,
# how far the background reaches around the frame -- also had a real
# patterned tile sitting inside the refusing band:
#
#   ring variation   page 0.00 .. 5.42   vs   tight product 9.49 .. 35.60
#                    but a clipped product's ring is page AND product,
#                    and lands in both
#   ring page-share  page 0.765 .. 1.000 vs   tight product 0.287 .. 0.884
#   background edges page 2 .. 4         vs   tight product 0 .. 4
#
# Each overlap means a rule built on it deletes real tiles, and the
# first attempt proved it: test_single_pdf_tile_only went from 6 tiles
# to 2 because a checkerboard tile's own pattern read as the thing to
# cut away. So this trims only what is unambiguous and leaves
# everything else exactly as it was. Whether a part-shape is a product
# is already asked, by name, in the purity verifier's
# complete_rectangle.
#
# It degrades the same way. A page carrying image noise up to sigma 7
# still trims (fill 0.997 down to 0.931); past that the page stops
# reading as flat and the crop is handed on untouched, which costs
# some background and damages nothing.
TRIM_BACKGROUND_TOLERANCE = 18.0
TRIM_MIN_RECTANGLE_FILL = 0.90
TRIM_MAX_SECOND_BLOB = 0.50
TRIM_BORDER_RING = 0.02
TRIM_EDGE_BAND = 0.004


def _product_blob(image_bgr):
    """The product in this crop, as (rect, fill, touch, second).

    Returns None when nothing can be measured.
    """
    height, width = image_bgr.shape[:2]
    if height < 16 or width < 16:
        return None

    ring = max(2, int(round(min(height, width) * TRIM_BORDER_RING)))
    border = np.concatenate([
        image_bgr[:ring].reshape(-1, 3), image_bgr[-ring:].reshape(-1, 3),
        image_bgr[:, :ring].reshape(-1, 3), image_bgr[:, -ring:].reshape(-1, 3),
    ])
    background = np.median(border, axis=0)

    distance = np.linalg.norm(
        image_bgr.astype(np.float32) - background, axis=2,
    )
    mask = (distance > TRIM_BACKGROUND_TOLERANCE).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))

    contours, _ = cv2.findContours(
        mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE,
    )
    if not contours:
        return None

    areas = sorted((cv2.contourArea(c) for c in contours), reverse=True)
    if areas[0] <= 0:
        return None

    contour = max(contours, key=cv2.contourArea)
    rect = cv2.minAreaRect(contour)
    rect_width, rect_height = rect[1]
    if rect_width < 4 or rect_height < 4:
        return None

    box = np.zeros_like(mask)
    cv2.drawContours(box, [cv2.boxPoints(rect).astype(np.int32)], 0, 1, -1)
    box_pixels = float(box.sum())
    if box_pixels <= 0:
        return None
    fill = float((mask & box).sum()) / box_pixels

    solo = np.zeros_like(mask)
    cv2.drawContours(solo, [contour], 0, 1, -1)
    band = max(1, int(round(min(height, width) * TRIM_EDGE_BAND)))
    touch = (
        int(solo[:band].any()) + int(solo[-band:].any())
        + int(solo[:, :band].any()) + int(solo[:, -band:].any())
    )

    second = areas[1] / areas[0] if len(areas) > 1 else 0.0
    return rect, fill, touch, second


def trim_to_product(image_bgr):
    """Cuts a crop down to the product in it, straightened.

    Returns (crop, info). The crop is the deskewed, tightly cropped
    product when the frame holds one whole rectangular product with
    page around it, and the image UNCHANGED in every other case --
    including the ambiguous ones. info["action"] is "trimmed" or
    "unchanged", with info["reason"] saying which test decided it.

    This never refuses an image; see the note above for why.
    """
    info = {"action": "unchanged", "reason": "nothing measurable to trim"}

    measured = _product_blob(image_bgr)
    if measured is None:
        return image_bgr, info

    rect, fill, touch, second = measured
    info.update({
        "fill": round(fill, 3), "edges_touched": touch,
        "second_blob": round(second, 3),
    })

    if second >= TRIM_MAX_SECOND_BLOB:
        info["reason"] = (
            f"a second product fills {second:.0%} as much of the frame -- "
            "leaving this for the splitter rather than keeping one of them"
        )
        return image_bgr, info

    if fill < TRIM_MIN_RECTANGLE_FILL:
        info["reason"] = (
            f"what the page-colour test found fills only {fill:.0%} of its "
            "own rectangle -- not one clean product shape, so nothing is cut"
        )
        return image_bgr, info

    if touch:
        info["reason"] = (
            f"it reaches {touch} frame edge(s) -- either the crop is already "
            "the product or the product runs out of it; either way there is "
            "no page to cut"
        )
        return image_bgr, info

    centre, (rect_width, rect_height), angle = rect
    height, width = image_bgr.shape[:2]
    rotation = cv2.getRotationMatrix2D(centre, angle, 1.0)
    straightened = cv2.warpAffine(
        image_bgr, rotation, (width, height),
        flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REPLICATE,
    )
    crop = cv2.getRectSubPix(
        straightened,
        (int(round(rect_width)), int(round(rect_height))),
        centre,
    )
    if crop is None or crop.size == 0:
        info["reason"] = "the straightened crop came out empty"
        return image_bgr, info

    info["action"] = "trimmed"
    info["reason"] = (
        f"cut the page away and straightened by {angle:.1f} degrees"
    )
    info["trimmed_size"] = (crop.shape[1], crop.shape[0])
    return crop, info


def draw_region_overlay(image_bgr, regions, destination):
    """Writes the source with every detected candidate drawn on it.

    Purely diagnostic, and opt-in: the caller only asks for this when
    TILE_REGION_DEBUG_DIR is set. It answers the question the numbers
    cannot -- whether a candidate actually sits on the material, or
    spans the whole sheet.

    `regions` is a list of (label, (x1, y1, x2, y2), accepted).
    """
    canvas = image_bgr.copy()

    for label, (x1, y1, x2, y2), accepted in regions:
        colour = (80, 200, 80) if accepted else (60, 60, 220)
        cv2.rectangle(canvas, (int(x1), int(y1)), (int(x2), int(y2)), colour, 3)
        cv2.putText(
            canvas, str(label), (int(x1) + 6, max(20, int(y1) + 24)),
            cv2.FONT_HERSHEY_SIMPLEX, 0.6, colour, 2, cv2.LINE_AA,
        )

    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(destination), canvas)
        return destination
    except Exception:  # noqa: BLE001 -- diagnostics must never break a run
        return None


def extract_tile_region(image_bgr, quad, occluders=None,
                        max_source_coverage=None):
    """Rectifies one candidate region and returns a clean tile-only crop.

    Returns (crop_bgr, info) on success, or (None, info) when the region
    cannot yield a usable swatch. info always carries `stage` naming the
    step that ended it and `reason` explaining why, so the caller can log
    a per-candidate decision without re-deriving any of this.

    `max_source_coverage` rejects a candidate whose bounding box covers
    at least that fraction of the source. Callers pass it when the
    source is a COMPOSITION rather than a single surface -- a rendered
    catalog page -- where a candidate spanning the whole frame is a
    detection failure by definition. It is left None when the source is
    an embedded image, because there a full-frame candidate is the
    normal, correct answer for a standalone product photograph.
    """
    source_height, source_width = image_bgr.shape[:2]
    source_area = float(source_height * source_width)

    info: dict = {
        "stage": "normalize",
        "reason": "",
        "quad_in": describe_quad(quad),
        "surface_source": "rectified",
    }

    # A QUAD THAT CUTS A PRODUCT IS FINISHED BEFORE IT IS USED.
    #
    # The parent still shows the rest of the product, so a half quad is
    # grown to the whole of it here, before the crop is taken and before
    # anything downstream -- the splitter included -- can cut a fragment
    # out of a fragment.
    try:
        quad, grow_note = grow_to_whole_product(image_bgr, quad)
    except Exception as exc:  # noqa: BLE001 -- an improvement, never fatal
        grow_note = f"not grown ({exc})"
    info["grow"] = grow_note

    normalized, note = normalize_quad(quad, source_width, source_height)
    if normalized is None:
        info["reason"] = f"degenerate region geometry -- {note}"
        return None, info

    # A hero bled off the page edge is refused before it is cropped.
    # Checked on the NORMALISED quad: the raw one may hold NaNs or
    # corners outside the image, which quad_bounds cannot read.
    bleeding, bleed_note = region_runs_off_the_page(
        image_bgr, quad_bounds(normalized),
    )
    info["bleed"] = bleed_note
    if bleeding:
        info["stage"] = "page_bleed"
        info["reason"] = bleed_note
        return None, info

    info["quad_normalized"] = [
        (round(x, 1), round(y, 1)) for x, y in normalized
    ]

    bx1, by1, bx2, by2 = quad_bounds(normalized)
    candidate_area = float(max(0, bx2 - bx1) * max(0, by2 - by1))
    coverage = candidate_area / source_area if source_area else 0.0
    info["bbox"] = (bx1, by1, bx2, by2)
    info["source_coverage"] = round(coverage, 4)

    if max_source_coverage is not None and coverage >= max_source_coverage:
        info["stage"] = "full_source"
        info["reason"] = (
            f"candidate covers {coverage:.1%} of the source, at or above "
            f"the {max_source_coverage:.0%} limit for a composed source -- "
            f"this is the whole page, not a material surface"
        )
        return None, info
    if note:
        info["normalize_note"] = note

    info["stage"] = "rectify"

    # Perspective correction is the preferred path -- it squares up a wall
    # shot at an angle so the tile grid reads true. But a quad that is
    # already axis-aligned, or one whose corner ordering the homography
    # cannot resolve, still describes a real surface: falling back to its
    # bounding rectangle keeps that tile instead of throwing it away for a
    # geometry technicality. The crop is of real pixels either way.
    rectified = rectify_quad(image_bgr, normalized)

    if rectified is None:
        x1, y1, x2, y2 = quad_bounds(normalized)
        x1 = max(0, min(source_width, x1))
        y1 = max(0, min(source_height, y1))
        x2 = max(0, min(source_width, x2))
        y2 = max(0, min(source_height, y2))

        if x2 - x1 < 2 or y2 - y1 < 2:
            info["reason"] = (
                "degenerate region geometry -- bounding-box fallback is "
                f"{x2 - x1}x{y2 - y1}px"
            )
            return None, info

        rectified = image_bgr[y1:y2, x1:x2].copy()
        info["surface_source"] = "bbox-fallback"
        info["bbox_fallback"] = (x1, y1, x2, y2)

        # Occluders are already in source-image space, so on this path they
        # only need translating into the crop -- there is no homography to
        # send them through.
        occluders = [
            (ox1 - x1, oy1 - y1, ox2 - x1, oy2 - y1)
            for ox1, oy1, ox2, oy2 in (occluders or [])
        ]
    height, width = rectified.shape[:2]
    info["rectified_size"] = (width, height)

    region_area = float(width * height)
    area_fraction = region_area / source_area if source_area else 0.0
    info["region_area_fraction"] = round(area_fraction, 4)

    if region_area < MIN_REGION_PIXELS:
        info["stage"] = "region_area"
        info["reason"] = (
            f"region is {width}x{height}px ({int(region_area)}px), below the "
            f"{MIN_REGION_PIXELS}px minimum -- too small to cut a swatch "
            f"from, regardless of the page size around it"
        )
        return None, info

    projected: list[tuple[float, float, float, float]] = []
    for occluder in occluders or []:
        ox1, oy1, ox2, oy2 = occluder

        if info["surface_source"] == "bbox-fallback":
            # Already translated into the crop above; there is no
            # homography on this path to send them through.
            projected.append((
                float(min(ox1, ox2)), float(min(oy1, oy2)),
                float(max(ox1, ox2)), float(max(oy1, oy2)),
            ))
            continue

        corners = project_points(
            normalized,
            [(ox1, oy1), (ox2, oy1), (ox2, oy2), (ox1, oy2)],
        )
        xs = corners[:, 0]
        ys = corners[:, 1]
        projected.append((
            float(np.min(xs)), float(np.min(ys)),
            float(np.max(xs)), float(np.max(ys)),
        ))

    # AN OCCLUDER THAT SWALLOWS THE REGION CONTRADICTS THE REGION.
    #
    # For each region the detector asserts two things at once: this quad
    # IS a tiled surface, and these boxes are objects sitting ON TOP of
    # it. A box covering essentially the whole quad cannot be both --
    # either it is the surface itself boxed by mistake, or the detector
    # boxed the entire scene. The prompt asks it to be generous with
    # occluders, so on a busy lifestyle photograph it does exactly that.
    #
    # Resolving that contradiction in the occluder's favour annihilated
    # the candidate: a real catalog page reported five tiled surfaces of
    # ~474x595 and lost all five to "occluders cover the whole region".
    #
    # It is safe to resolve it the other way instead, because this is not
    # the gate that decides what gets saved. Whatever survives here is
    # re-examined by the purity check on the FINAL crop, which rejects it
    # if it turns out to be a basin or a wall. Being permissive here can
    # only give a tile the chance to be looked at; it cannot put a dirty
    # image in the catalog.
    region_area_px = float(width * height)
    swallowing = [
        box for box in projected
        if region_area_px
        and (box[2] - box[0]) * (box[3] - box[1]) >= region_area_px * OCCLUDER_MAX_COVERAGE
    ]

    if swallowing:
        projected = [box for box in projected if box not in swallowing]
        info["occluders_ignored"] = len(swallowing)

    info["occluders"] = len(projected)

    clean = largest_clean_rectangle(width, height, projected)
    if clean is None:
        info["stage"] = "occlusion"
        info["reason"] = (
            "occluders cover the whole region"
            + (
                f" (after ignoring {len(swallowing)} box(es) that covered "
                f"the region entirely)" if swallowing else ""
            )
        )
        return None, info

    x1, y1, x2, y2 = clean
    clean_width = x2 - x1
    clean_height = y2 - y1

    clean_fraction = (clean_width * clean_height) / region_area if region_area else 0.0
    info["clean_area_fraction"] = round(clean_fraction, 4)

    if clean_width * clean_height < MIN_CLEAN_PIXELS:
        info["stage"] = "occlusion"
        info["reason"] = (
            f"the unobstructed area is {clean_width}x{clean_height}px "
            f"({clean_fraction:.1%} of the region), below the "
            f"{MIN_CLEAN_PIXELS}px minimum for a usable swatch"
        )
        return None, info

    min_side = effective_min_side(source_width, source_height)
    info["min_side"] = min_side

    if clean_width < min_side or clean_height < min_side:
        info["stage"] = "too_small"
        info["reason"] = (
            f"clean area is {clean_width}x{clean_height}px, "
            f"below the {min_side}px minimum side for a "
            f"{source_width}x{source_height} source"
        )
        return None, info

    crop = rectified[y1:y2, x1:x2].copy()

    # CUT THE PAGE AWAY BEFORE ANYTHING ELSE SEES THIS.
    #
    # The quad bounds the surface the detector reported, which on a
    # catalog that prints its products at an angle is a frame of paper
    # with the tile lying across it. Trimming here, before the upscale
    # below and before any verdict, means every later stage -- the
    # purity model included -- is looking at the product rather than at
    # the page around it. A frame holding no whole product is refused
    # outright: see trim_to_product for what separates the two.
    crop, trim = trim_to_product(crop)
    info["trim"] = trim
    if trim["action"] == "trimmed":
        clean_width, clean_height = crop.shape[1], crop.shape[0]

    # Refuse the sliver, now that the shape is final.
    #
    # Checked HERE rather than beside the size gates above because the
    # trim is what settles the crop's proportions: a frame of page
    # trimmed off a narrow product is exactly how a reasonable-looking
    # rectangle becomes a ribbon. The upscale below preserves aspect,
    # so this is the output's true shape.
    long_side = max(clean_width, clean_height)
    short_side = min(clean_width, clean_height)
    if short_side > 0:
        aspect = long_side / short_side
        if aspect > REGION_MAX_ASPECT_RATIO:
            info["stage"] = "sliver"
            info["reason"] = (
                f"{clean_width}x{clean_height}px is an extreme "
                f"{aspect:.1f}:1 sliver, not a whole product"
            )
            return None, info

    # A small crop that passed both gates is real tile, just not many
    # pixels of it. Enlarging the pixels that are there beats handing
    # downstream a 110px-tall image; it adds no detail and claims none.
    shorter = min(clean_width, clean_height)
    if shorter < UPSCALE_TARGET_SIDE_PX:
        scale = min(UPSCALE_TARGET_SIDE_PX / shorter, SAFE_UPSCALE_LIMIT)
        if scale > 1.01:
            crop = cv2.resize(
                crop,
                (int(round(clean_width * scale)),
                 int(round(clean_height * scale))),
                interpolation=cv2.INTER_LANCZOS4,
            )
            info["upscaled"] = round(scale, 2)
            info["upscaled_from"] = (clean_width, clean_height)

    info["stage"] = "extracted"
    info["crop_size"] = (clean_width, clean_height)
    info["output_size"] = (crop.shape[1], crop.shape[0])

    return crop, info


# WHY THERE IS NO "STRICTER" VERSION OF THE NUMBER ABOVE.
#
# The obvious repair for siblings being merged is a tighter threshold.
# Measured against a real prepared catalog, there is no threshold that
# works. On one sheet:
#
#   same tile, embedded raster vs page render :  0.0021 .. 0.0297
#   different products, closest pair          :  0.0108
#
# The two ranges OVERLAP. Any cut-off tight enough to keep a base tile
# apart from its plain sibling is loose enough to upload the same tile
# twice, and vice versa. Appearance cannot answer "is this the same
# tile" on a catalog whose products are meant to resemble each other.
#
# So appearance stopped being the answer. Two candidates found by two
# different routes are the same tile when they cover the same area OF
# THE PAGE -- identity, not resemblance -- which both routes can state
# exactly. See page_box_for_region() and signature_already_seen() in
# main_step6_complete.py; content_signature remains the fallback for a
# caller that cannot supply page geometry.

# Two page-space boxes this far overlapped are the same physical tile
# seen twice. Generous, because the two routes bound a tile slightly
# differently -- one from the embedded raster's pixels, one from the
# rendered page's -- and a tile's own neighbours do not overlap it at
# all, so there is nothing nearby for a loose value to collide with.
PAGE_BOX_OVERLAP_LIMIT = 0.50


def box_iou(first, second):
    """Intersection-over-union of two (x0, y0, x1, y1) boxes."""
    return _box_iou(first, second)
