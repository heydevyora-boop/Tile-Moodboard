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


# A rectified surface smaller than this fraction of the source image's
# area is not a usable swatch -- it is a sliver of wall between two
# cupboards, and upscaling it would only magnify compression artefacts.
MIN_REGION_AREA_FRACTION = 0.02

# The clean sub-rectangle must keep at least this much of the rectified
# surface. Below it, occluders dominate the region and whatever is left
# is too fragmentary to represent the tile.
MIN_CLEAN_AREA_FRACTION = 0.25

# Preferred pixel floor for a saved swatch, matched to the extractor's
# existing MIN_IMAGE_WIDTH/MIN_IMAGE_HEIGHT so this stage cannot emit
# something the caller would immediately discard.
MIN_OUTPUT_SIDE_PX = 200

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


def extract_tile_region(image_bgr, quad, occluders=None):
    """Rectifies one candidate region and returns a clean tile-only crop.

    Returns (crop_bgr, info) on success, or (None, info) when the region
    cannot yield a usable swatch. info always carries `stage` naming the
    step that ended it and `reason` explaining why, so the caller can log
    a per-candidate decision without re-deriving any of this.
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

    if area_fraction < MIN_REGION_AREA_FRACTION:
        info["stage"] = "region_area"
        info["reason"] = (
            f"region covers {area_fraction:.1%} of the image, "
            f"below the {MIN_REGION_AREA_FRACTION:.0%} minimum"
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

    info["occluders"] = len(projected)

    clean = largest_clean_rectangle(width, height, projected)
    if clean is None:
        info["stage"] = "occlusion"
        info["reason"] = "occluders cover the whole region"
        return None, info

    x1, y1, x2, y2 = clean
    clean_width = x2 - x1
    clean_height = y2 - y1

    clean_fraction = (clean_width * clean_height) / region_area if region_area else 0.0
    info["clean_area_fraction"] = round(clean_fraction, 4)

    if clean_fraction < MIN_CLEAN_AREA_FRACTION:
        info["stage"] = "occlusion"
        info["reason"] = (
            f"only {clean_fraction:.1%} of the region is unobstructed, "
            f"below the {MIN_CLEAN_AREA_FRACTION:.0%} minimum"
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

    info["stage"] = "extracted"
    info["crop_size"] = (clean_width, clean_height)

    return rectified[y1:y2, x1:x2].copy(), info
