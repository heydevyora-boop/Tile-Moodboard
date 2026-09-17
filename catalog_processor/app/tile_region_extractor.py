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


def deduplicate_regions(regions, overlap_limit=REGION_OVERLAP_LIMIT):
    """Drops detections that describe a surface already covered.

    A detector asked for "every tiled surface" will happily return the
    same wall five times with slightly different corners, and each copy
    would otherwise be rectified, saved and sent for classification --
    five API calls and five identical swatches for one tile.

    `regions` is expected in the detector's confidence order, so the
    first sighting of a surface is the best-scored one and is the copy
    that survives. Returns (kept, dropped), where each dropped entry is
    (region, index_of_the_region_it_duplicates).
    """
    kept = []
    dropped = []

    for region in regions:
        box = quad_bounds(region["quad"])

        duplicate_of = None
        for position, existing in enumerate(kept, start=1):
            if _box_iou(box, quad_bounds(existing["quad"])) >= overlap_limit:
                duplicate_of = position
                break

        if duplicate_of is None:
            kept.append(region)
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

    normalized, note = normalize_quad(quad, source_width, source_height)
    if normalized is None:
        info["reason"] = f"degenerate region geometry -- {note}"
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
