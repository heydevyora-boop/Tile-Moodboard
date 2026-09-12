"""
test_extract_aspect_ratio.py

Tests for the final tile aspect-ratio correction in extract.py:
parse_product_aspect_ratio() and crop_to_aspect_ratio().

WHAT THIS FIXES: a validated tile image (one that survived
classify_image_content, semantic validation, and the validator's own
product_bbox crop) still carries whatever PIXEL aspect ratio the catalog
page happened to print it at -- not the product's actual physical
proportion. An 800x2400mm plank tile photographed inside a roughly square
box on the page still saves as a roughly square image unless corrected.

The fix reuses detect_size()'s own output (already extracted, unchanged
here) rather than inventing a new dimension source, and performs a pure
centre-crop: only pixels already present in the image are kept, nothing is
scaled, stretched, padded, or generated. Only the one dimension that is
oversized relative to the product's true ratio is trimmed, and by the
minimum amount -- the other dimension survives in full.
"""

import io
import math

import numpy as np
import pytest
from PIL import Image

from extract import (
    ASPECT_RATIO_TOLERANCE,
    crop_to_aspect_ratio,
    detect_size,
    parse_product_aspect_ratio,
)


def _png(image):
    buffer = io.BytesIO()
    image.save(buffer, 'PNG')
    return buffer.getvalue()


def _solid(width, height, colour=(200, 190, 175)):
    """A uniform swatch -- content is irrelevant to these tests; only
    dimensions and pixel identity inside the crop matter."""
    return Image.new('RGB', (width, height), colour)


def _textured(width, height, seed=7):
    """Non-uniform pixels, so a pixel-identity check actually proves
    something (a uniform image would pass even if pixels were subtly
    resampled)."""
    rng = np.random.default_rng(seed)
    pixels = rng.integers(0, 255, size=(height, width, 3), dtype=np.uint8)
    return Image.fromarray(pixels, 'RGB')


# ---------------------------------------------------------------------------
# parse_product_aspect_ratio -- reuses detect_size's own output format
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('size_text,expected_ratio', [
    ('800x2400mm', 800 / 2400),   # 1:3 plank
    ('600x1200mm', 600 / 1200),   # 1:2
    ('750x300mm', 750 / 300),     # 2.5:1
    ('600x600mm', 1.0),           # square
    ('300x300cm', 1.0),
    ('1200x600MM', 1200 / 600),   # unit case must not matter
])
def test_parses_ratio_from_detect_size_output_format(size_text, expected_ratio):
    assert parse_product_aspect_ratio(size_text) == pytest.approx(expected_ratio)


def test_round_trips_through_the_real_detect_size_function():
    """Not just a format assumption -- actually calling detect_size() on
    catalog-like text and feeding its output straight through, the same way
    extract() does."""
    catalog_text = "BRILLO COLLECTION\n800 x 2400 mm\nGlossy Marble Finish"
    size = detect_size(catalog_text)
    assert size is not None

    ratio = parse_product_aspect_ratio(size)

    assert ratio == pytest.approx(800 / 2400)


@pytest.mark.parametrize('bad_input', [None, '', 'BRILLO COLLECTION', 'x2400mm', '800xmm'])
def test_undetected_or_unparseable_size_returns_none(bad_input):
    """No size detected -- or nothing sensible to parse -- must mean "don't
    touch the image", never a guessed/invented ratio."""
    assert parse_product_aspect_ratio(bad_input) is None


def test_zero_dimension_is_rejected_not_divided_by():
    assert parse_product_aspect_ratio('0x2400mm') is None
    assert parse_product_aspect_ratio('800x0mm') is None


# ---------------------------------------------------------------------------
# crop_to_aspect_ratio -- the actual pixel operation
# ---------------------------------------------------------------------------

def test_square_source_cropped_to_tall_plank_ratio():
    """800x2400mm -> ratio 1:3. A square source must narrow in width only,
    keeping the full height."""
    source = _textured(700, 700)
    cropped_bytes = crop_to_aspect_ratio(_png(source), 800 / 2400)

    with Image.open(io.BytesIO(cropped_bytes)) as cropped:
        width, height = cropped.size

    assert height == 700, "full height must be preserved when narrowing width"
    assert width < 700, "width must be trimmed to reach the 1:3 ratio"
    assert math.isclose(width / height, 800 / 2400, rel_tol=0.02)


def test_square_source_cropped_to_wide_plank_ratio():
    """2400x800mm -> ratio 3:1. A square source must shorten height only,
    keeping the full width."""
    source = _textured(700, 700)
    cropped_bytes = crop_to_aspect_ratio(_png(source), 2400 / 800)

    with Image.open(io.BytesIO(cropped_bytes)) as cropped:
        width, height = cropped.size

    assert width == 700, "full width must be preserved when shortening height"
    assert height < 700, "height must be trimmed to reach the 3:1 ratio"
    assert math.isclose(width / height, 3.0, rel_tol=0.02)


def test_already_correct_ratio_is_left_completely_unchanged():
    """If the source already has the product's proportion, the bytes must
    pass through untouched -- not merely 'close', but the identical object,
    proving no re-encode happened at all."""
    original = _png(_solid(900, 600))  # 3:2

    result = crop_to_aspect_ratio(original, 900 / 600)

    assert result is original


def test_ratio_within_tolerance_is_left_unchanged():
    """A source just inside ASPECT_RATIO_TOLERANCE of the target must not be
    trimmed for a cosmetic pixel or two of no real benefit."""
    # Target ratio 2.0; source ratio ~1.5% off -- inside the 2% tolerance.
    width, height = 812, 400  # ratio 2.03
    original = _png(_solid(width, height))

    assert abs((width / height) - 2.0) / 2.0 < ASPECT_RATIO_TOLERANCE

    result = crop_to_aspect_ratio(original, 2.0)

    assert result is original


def test_ratio_just_outside_tolerance_is_cropped():
    """The boundary case immediately past the tolerance must still act --
    guards against the tolerance silently swallowing real corrections."""
    width, height = 900, 400  # ratio 2.25, target 2.0 -> 12.5% off
    original = _png(_solid(width, height))

    result = crop_to_aspect_ratio(original, 2.0)

    assert result is not original
    with Image.open(io.BytesIO(result)) as cropped:
        assert math.isclose(cropped.size[0] / cropped.size[1], 2.0, rel_tol=0.02)


def test_crop_selects_real_pixels_and_never_invents_any():
    """The kept region's pixels must be byte-identical to the corresponding
    region of the source -- nothing resampled, scaled, or synthesised."""
    source = _textured(700, 700, seed=11)
    cropped_bytes = crop_to_aspect_ratio(_png(source), 800 / 2400)

    with Image.open(io.BytesIO(cropped_bytes)) as cropped:
        cropped_array = np.asarray(cropped.convert('RGB'))

    # Recompute the expected crop box exactly as the implementation would.
    new_width = round(700 * (800 / 2400))
    x0 = (700 - new_width) // 2
    expected = np.asarray(source.convert('RGB'))[:, x0:x0 + new_width, :]

    assert np.array_equal(cropped_array, expected), (
        "cropped pixels differ from the source region -- must be a pure "
        "sub-rectangle selection, never resampled"
    )


def test_texture_pattern_and_colour_survive_unaltered():
    """Explicit regression for the 'do not change texture/colour/pattern/
    finish' requirement: a structured pattern's kept portion must match the
    source exactly, not merely 'look similar'."""
    source = Image.new('RGB', (700, 700), (210, 200, 186))
    for y in range(0, 700, 20):
        for x in range(0, 700, 20):
            if (x // 20 + y // 20) % 2 == 0:
                for dy in range(20):
                    for dx in range(20):
                        if y + dy < 700 and x + dx < 700:
                            source.putpixel((x + dx, y + dy), (150, 120, 95))

    cropped_bytes = crop_to_aspect_ratio(_png(source), 800 / 2400)

    with Image.open(io.BytesIO(cropped_bytes)) as cropped:
        cropped_array = np.asarray(cropped.convert('RGB'))
        width = cropped.size[0]

    new_width = round(700 * (800 / 2400))
    x0 = (700 - new_width) // 2
    expected = np.asarray(source.convert('RGB'))[:, x0:x0 + new_width, :]

    assert cropped_array.shape == expected.shape
    assert np.array_equal(cropped_array, expected)


def test_no_upscaling_beyond_source_pixels():
    """An extreme target ratio must never push the kept dimension beyond
    what the source actually has (which would require inventing pixels)."""
    source = _solid(50, 700)  # already very narrow
    cropped_bytes = crop_to_aspect_ratio(_png(source), 800 / 2400)  # wants even narrower

    with Image.open(io.BytesIO(cropped_bytes)) as cropped:
        width, height = cropped.size

    assert width <= 50
    assert height <= 700


# ---------------------------------------------------------------------------
# Fail-safe behaviour -- must never lose or corrupt a validated tile
# ---------------------------------------------------------------------------

def test_no_target_ratio_is_a_no_op():
    original = _png(_solid(700, 700))
    assert crop_to_aspect_ratio(original, None) is original
    assert crop_to_aspect_ratio(original, 0) is original
    assert crop_to_aspect_ratio(original, -1.5) is original


def test_unreadable_image_bytes_survive_the_correction():
    """A failed crop must return the original bytes, never lose the tile."""
    garbage = b'not an image at all'
    assert crop_to_aspect_ratio(garbage, 800 / 2400) == garbage


def test_degenerately_small_image_is_left_unchanged():
    tiny = _png(_solid(1, 1))
    assert crop_to_aspect_ratio(tiny, 800 / 2400) == tiny
