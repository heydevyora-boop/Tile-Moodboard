"""
A last look at an extracted tile image before it can reach a mood board.

WHY THIS IS SEPARATE FROM EXTRACTION

Extraction decides what region of a catalog page is a product. This
decides whether the picture it produced is fit to be shown to a client
and handed to the image generator as "this is the tile". Those are
different questions, and this one is asked later: after the crop exists,
before backend_sync makes it a combination candidate. Nothing here
changes how a region is found or cut.

WHAT IT REFUSES, AND WHY ONLY THAT

Two rules, each one the survivor of a set of candidates measured against
real stock.

A tile surface -- however busy, dark or colourful its pattern -- is one
material photographed flat, so the CHROMA of the frame barely moves from
corner to corner. A photograph of a room, or a crop out of a large
pictorial mural, holds several materials at once under different light,
and its chroma moves a great deal.

Measured over 44 real extracted tiles (24 mined fresh from real catalog
page renders, 20 from earlier runs) against the catalog owner's own
rejected examples:

    worst real tile          0.0312   (59.webp, a warm multi-tone decor)
    ---------------- bar at 0.047 ----------------
    a room/lifestyle photo   0.0707
    a crop of a face mural   0.1254

The bar sits 1.51x above the worst real tile and 1.50x below the nearest
rejection, with nothing in between.

SECOND: TWO MATERIALS IN ONE FRAME

The crop the catalog owner found as a "highlight" was split corner to
corner -- flat brown on one side of a straight diagonal, marble on the
other. One tile, plain or busy, looks like the same material on both
sides of any line drawn through it. So every straight cut through the
frame is scored by how unlike its two halves are, in colour and in
grain, and the worst cut is the answer.

Measured over the same 47 real tiles against that defect:

    worst real tile          0.350   (59.webp; next worst is 0.144)
    ---------------- bar at 0.49 ----------------
    flat navy beside marble  0.684
    flat brown beside marble 0.895

1.40x clear on each side. An earlier attempt scored the largest flat
colour block instead and was thrown away: a plain tile is one flat block
with a straight edge, so it scored 0.849 where the defects scored 0.641
and 0.469 -- inverted.

WHAT IT DELIBERATELY DOES NOT REFUSE

Two of the owner's four examples are not caught, and are left alone
rather than guessed at:

  - a real tile printed at an angle on the page, with paper and catalog
    text around it;
  - a corner of a frame/moulding render with a blank page wedge in it.

Three heuristics were built for those and all three were discarded for
overlapping with real products:

  - brightness spread: the offending daisy tile scores 0.202 tilted and
    0.205 once rectified into a perfectly good square swatch. It
    measures the tile's own contrast, not the defect, so it would have
    rejected every dark-ground decor in the catalog.
  - visible paper: plain light tiles score up to 0.596 while those two
    examples score 0.122 and 0.000 -- inverted.
  - axis alignment: real tiles run 0.18 to 0.99, no separation at all.

Refusing on a signal that overlaps real stock costs more than letting
these two through. They need more examples before a rule can be fitted.
"""

from __future__ import annotations

from typing import Tuple

import cv2
import numpy as np


# The chroma spread at which a frame stops reading as one tile surface.
# See the measurements in the module docstring: 1.51x above the worst
# real tile seen, 1.50x below the nearest rejection.
SCENE_CHROMA_SPREAD = 0.047

# The point at which the two sides of some straight cut stop looking
# like the same material. 1.40x above the worst real tile measured,
# 1.40x below the nearest split crop.
SPLIT_MATERIAL_DISTANCE = 0.49

# Cuts are tried every this many degrees through the frame's centre.
SPLIT_ANGLE_STEP = 10

# The frame is read at this size: small enough that grain averages out,
# large enough that a real boundary survives.
SPLIT_GRID = 128

# A cut that leaves either side smaller than this is not a split, it is
# a corner being shaved off.
SPLIT_MIN_SIDE_SHARE = 0.07

# The frame is reduced to this grid before measuring, so the number means
# the same thing for a 200px swatch and a 2000px slab, and so a single
# speck of grout cannot move it.
CHROMA_GRID = 8


def scene_chroma_spread(image_bgr: np.ndarray) -> float:
    """How far the frame's colour wanders, independent of brightness.

    Dividing each cell by its own luma is what makes this a question
    about materials rather than about lighting or how dark the tile is --
    which is exactly the trap a brightness measure falls into.
    """
    if image_bgr is None or getattr(image_bgr, "size", 0) == 0:
        return 0.0

    side = CHROMA_GRID * 8
    small = cv2.resize(
        image_bgr, (side, side), interpolation=cv2.INTER_AREA,
    ).astype(np.float32)

    region = small.reshape(
        CHROMA_GRID, 8, CHROMA_GRID, 8, 3,
    ).mean(axis=(1, 3))

    luma = region.mean(axis=2)
    chroma = region / (luma[:, :, None] + 1e-6)

    return float(chroma.reshape(-1, 3).std(axis=0).mean())


def split_material_distance(image_bgr: np.ndarray) -> float:
    """The worst straight cut: how unlike its two halves are.

    Colour and grain are weighed equally. Colour alone misses a split
    between two materials of similar tone; grain alone misses a split
    between two equally smooth ones.
    """
    if image_bgr is None or getattr(image_bgr, "size", 0) == 0:
        return 0.0

    small = cv2.resize(
        image_bgr, (SPLIT_GRID, SPLIT_GRID), interpolation=cv2.INTER_AREA,
    ).astype(np.float32)

    grey = cv2.cvtColor(
        small.astype(np.uint8), cv2.COLOR_BGR2GRAY,
    ).astype(np.float32)
    grain = cv2.blur(np.abs(grey - cv2.blur(grey, (7, 7))), (7, 7))

    rows, cols = np.mgrid[0:SPLIT_GRID, 0:SPLIT_GRID].astype(np.float32)
    centre = (SPLIT_GRID - 1) / 2.0
    floor = SPLIT_MIN_SIDE_SHARE * SPLIT_GRID * SPLIT_GRID

    worst = 0.0
    for degrees in range(0, 180, SPLIT_ANGLE_STEP):
        angle = np.deg2rad(degrees)
        near = (
            (cols - centre) * np.cos(angle)
            + (rows - centre) * np.sin(angle)
        ) > 0
        far = ~near

        if near.sum() < floor or far.sum() < floor:
            continue

        colour = float(np.linalg.norm(
            small[near].mean(axis=0) - small[far].mean(axis=0),
        )) / 255.0

        near_grain = float(grain[near].mean())
        far_grain = float(grain[far].mean())
        texture = (
            abs(near_grain - far_grain)
            / (max(near_grain, far_grain) + 1e-6)
        )

        worst = max(worst, 0.5 * colour + 0.5 * texture)

    return worst


def screen_tile_image(image_bgr: np.ndarray) -> Tuple[bool, str]:
    """(keep, reason). `keep` is False only when the measurement says so.

    A frame that cannot be read at all is kept: this is a last look, not
    a second extraction, and it must never drop a product because it
    could not measure it.
    """
    if image_bgr is None or getattr(image_bgr, "size", 0) == 0:
        return True, "nothing to measure -- kept"

    spread = scene_chroma_spread(image_bgr)

    if spread >= SCENE_CHROMA_SPREAD:
        return False, (
            f"reads as a room photo or a crop out of a larger picture, "
            f"not one tile surface (colour spread {spread:.4f}, "
            f"bar {SCENE_CHROMA_SPREAD})"
        )

    split = split_material_distance(image_bgr)

    if split >= SPLIT_MATERIAL_DISTANCE:
        return False, (
            f"two different materials meet along a straight line in this "
            f"frame -- half of it is another product (split distance "
            f"{split:.3f}, bar {SPLIT_MATERIAL_DISTANCE})"
        )

    return True, (
        f"one tile surface (colour spread {spread:.4f}, "
        f"split distance {split:.3f})"
    )


def screen_tile_file(path) -> Tuple[bool, str]:
    """The same check, reading the crop from disk."""
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        return True, "could not be read -- kept"
    return screen_tile_image(image)
