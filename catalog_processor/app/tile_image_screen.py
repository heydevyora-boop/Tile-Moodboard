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

One rule, because one rule is what the measurements supported.

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

    return True, f"one tile surface (colour spread {spread:.4f})"


def screen_tile_file(path) -> Tuple[bool, str]:
    """The same check, reading the crop from disk."""
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        return True, "could not be read -- kept"
    return screen_tile_image(image)
