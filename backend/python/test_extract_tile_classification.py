"""
test_extract_tile_classification.py

Offline tests for extract.py's tile-vs-room-photo classification.

No PDF fixtures on disk, no Google APIs, no network -- every image is drawn
synthetically here so the test states its own assumptions in full.

What this pins down, and why it exists
--------------------------------------
The extractor must keep flat product swatches (base, highlighter, decor) and
reject staged photos of finished rooms. An earlier implementation decided
this purely from how big the image was on the page -- anything covering more
than 55% of the page was assumed to be a room photo. That silently deleted
almost an entire catalog: catalogs very commonly devote a whole page to ONE
product and print the swatch full-bleed, so on a 139-page catalog of that
layout only 8 tiles survived.

So the central property under test is: **the same tile artwork must be kept
whether it is printed small in a grid or full-bleed across the page.** Page
geometry must not decide it. Every tile case below is therefore run at three
print sizes.

The second property is the mirror image: a room photo must be rejected at
those same sizes, so the classifier isn't just passing everything.
"""

import io
import math
import random

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFilter

from extract import classify_image_content


# ---------------------------------------------------------------------------
# Page geometry
# ---------------------------------------------------------------------------

PAGE_W, PAGE_H = 595.0, 842.0


class _Rect:
    """Stands in for PyMuPDF's page.rect (only .width/.height are read)."""

    def __init__(self, width, height):
        self.width = width
        self.height = height


PAGE = _Rect(PAGE_W, PAGE_H)

# The three print sizes every tile is checked at. FULL_BLEED and LARGE are
# the two the old area-based rule discarded outright.
FULL_BLEED = (0.0, 0.0, PAGE_W, PAGE_H)
LARGE = (30.0, 60.0, 565.0, 650.0)
GRID = (60.0, 120.0, 300.0, 360.0)
PRINT_SIZES = [('full-bleed', FULL_BLEED), ('large', LARGE), ('grid', GRID)]


def _png(image):
    buffer = io.BytesIO()
    image.save(buffer, 'PNG')
    return buffer.getvalue()


def _photographic(image, sigma=9):
    """Adds the sensor noise and micro-texture that a real photograph carries
    everywhere and flat catalog artwork does not."""
    pixels = np.asarray(image, dtype=np.float32)
    pixels += np.random.normal(0, sigma, pixels.shape)
    noisy = Image.fromarray(np.clip(pixels, 0, 255).astype('uint8'))
    return noisy.filter(ImageFilter.GaussianBlur(0.4))


# ---------------------------------------------------------------------------
# Tile artwork -- all of this must survive at every print size
# ---------------------------------------------------------------------------

def marble_tile():
    """Veined beige marble: soft organic veining, neutral palette."""
    random.seed(0)
    np.random.seed(0)
    field = np.full((700, 700, 3), 214.0) + np.random.normal(0, 4, (700, 700, 3))
    image = Image.fromarray(np.clip(field, 0, 255).astype('uint8'))
    draw = ImageDraw.Draw(image)
    for _ in range(14):
        x, y = random.randint(0, 700), random.randint(0, 700)
        points = [(x, y)]
        for _ in range(28):
            x += random.randint(-26, 26)
            y += random.randint(-26, 26)
            points.append((x, y))
        draw.line(points, fill=(198, 190, 176), width=3)
    return image.filter(ImageFilter.GaussianBlur(1.4))


def wood_plank_tile():
    """Wood-effect plank: warm, directional grain."""
    random.seed(3)
    field = np.zeros((700, 700, 3))
    for y in range(700):
        base = 150 + 26 * math.sin(y / 9.0) + random.gauss(0, 5)
        field[y, :, 0] = base + 26
        field[y, :, 1] = base - 6
        field[y, :, 2] = base - 40
    image = Image.fromarray(np.clip(field, 0, 255).astype('uint8'))
    return image.filter(ImageFilter.GaussianBlur(0.8))


def patterned_highlighter():
    """Geometric highlighter tile -- deliberately the most EDGE-DENSE image in
    this file. It measures busier than any of the room photos below, which is
    why edge density is not used as a signal: filtering on "busy" would delete
    exactly this product."""
    image = Image.new('RGB', (700, 700), (226, 220, 206))
    draw = ImageDraw.Draw(image)
    for gy in range(0, 700, 70):
        for gx in range(0, 700, 70):
            draw.rectangle([gx + 6, gy + 6, gx + 64, gy + 64], outline=(150, 138, 120), width=3)
            draw.line([gx + 6, gy + 6, gx + 64, gy + 64], fill=(168, 156, 138), width=2)
            draw.line([gx + 64, gy + 6, gx + 6, gy + 64], fill=(168, 156, 138), width=2)
    return image


def blue_decor_tile():
    """Vivid blue decor tile -- deliberately the most SATURATED image in this
    file, far more so than any room photo. This is why saturation is not used
    as a signal either."""
    image = Image.new('RGB', (700, 700), (58, 104, 168))
    draw = ImageDraw.Draw(image)
    for gy in range(0, 700, 88):
        for gx in range(0, 700, 88):
            draw.ellipse([gx + 10, gy + 10, gx + 78, gy + 78], outline=(232, 238, 246), width=5)
            draw.ellipse([gx + 30, gy + 30, gx + 58, gy + 58], fill=(236, 240, 248))
    return image


def gradient_tile():
    """Charcoal tile shading light-to-dark across its face -- uneven lighting
    on its own must not be enough to reject a tile."""
    np.random.seed(5)
    ramp = np.linspace(40, 150, 700)[None, :].repeat(700, 0)
    field = np.stack([ramp, ramp, ramp], axis=2) + np.random.normal(0, 3, (700, 700, 3))
    return Image.fromarray(np.clip(field, 0, 255).astype('uint8'))


def mosaic_tile():
    """Small-format mosaic: many small cells in mixed earthy tones."""
    random.seed(7)
    image = Image.new('RGB', (700, 700), (210, 200, 186))
    draw = ImageDraw.Draw(image)
    for gy in range(0, 700, 35):
        for gx in range(0, 700, 35):
            tone = random.choice([
                (206, 192, 172), (186, 170, 148), (224, 214, 198), (166, 150, 130),
            ])
            draw.rectangle([gx + 3, gy + 3, gx + 31, gy + 31], fill=tone)
    return image


TILE_ARTWORK = [
    ('marble base', marble_tile),
    ('wood plank', wood_plank_tile),
    ('patterned highlighter', patterned_highlighter),
    ('blue decor', blue_decor_tile),
    ('dark gradient', gradient_tile),
    ('mosaic', mosaic_tile),
]


# ---------------------------------------------------------------------------
# Room photography -- all of this must be rejected at every print size
# ---------------------------------------------------------------------------

def bathroom_photo():
    """Staged bathroom: basin, tap, window, plant, towel."""
    random.seed(11)
    np.random.seed(11)
    image = Image.new('RGB', (700, 700), (198, 190, 178))
    draw = ImageDraw.Draw(image)
    draw.rectangle([0, 0, 700, 150], fill=(238, 236, 230))
    draw.rectangle([0, 560, 700, 700], fill=(120, 110, 98))
    draw.rectangle([430, 60, 660, 430], fill=(250, 250, 245), outline=(60, 60, 60), width=5)
    for x in range(440, 660, 40):
        draw.line([x, 60, x, 430], fill=(80, 80, 80), width=3)
    draw.rectangle([60, 300, 250, 560], fill=(245, 245, 242), outline=(70, 70, 70), width=5)
    draw.ellipse([90, 250, 220, 330], fill=(252, 252, 250), outline=(60, 60, 60), width=4)
    draw.rectangle([150, 180, 162, 260], fill=(40, 40, 40))
    draw.ellipse([300, 430, 420, 560], fill=(46, 120, 52))
    for angle in range(0, 360, 22):
        draw.line(
            [360, 495,
             360 + 90 * math.cos(math.radians(angle)),
             495 + 90 * math.sin(math.radians(angle))],
            fill=(38, 102, 44), width=7,
        )
    draw.rectangle([560, 470, 660, 600], fill=(70, 130, 180))
    return _photographic(image)


def shower_photo():
    """Shower enclosure: glass screen, tiled wall, fittings, plant, mat."""
    random.seed(13)
    np.random.seed(13)
    image = Image.new('RGB', (700, 700), (186, 176, 162))
    draw = ImageDraw.Draw(image)
    for y in range(0, 700, 60):
        draw.line([0, y, 700, y], fill=(150, 140, 126), width=3)
    for x in range(0, 700, 120):
        draw.line([x, 0, x, 700], fill=(150, 140, 126), width=3)
    draw.rectangle([380, 0, 700, 700], fill=(214, 226, 228))
    draw.line([380, 0, 380, 700], fill=(50, 50, 50), width=9)
    draw.rectangle([60, 80, 110, 300], fill=(190, 190, 195))
    draw.ellipse([40, 60, 140, 110], fill=(210, 210, 215), outline=(60, 60, 60), width=4)
    draw.rectangle([500, 520, 660, 660], fill=(30, 90, 60))
    draw.rectangle([120, 600, 300, 680], fill=(200, 120, 80))
    return _photographic(image)


def neutral_room_photo():
    """The hard case: a beige-on-beige minimal bathroom with almost no colour
    variety, which is the closest a room photo gets to reading as a tile."""
    random.seed(17)
    np.random.seed(17)
    image = Image.new('RGB', (700, 700), (206, 196, 182))
    draw = ImageDraw.Draw(image)
    draw.rectangle([0, 0, 700, 120], fill=(232, 226, 214))
    draw.rectangle([0, 540, 700, 700], fill=(150, 140, 126))
    draw.rectangle([420, 140, 680, 470], fill=(226, 220, 208), outline=(120, 112, 100), width=4)
    draw.rectangle([70, 320, 260, 540], fill=(238, 232, 222), outline=(130, 122, 110), width=4)
    draw.ellipse([100, 270, 230, 350], fill=(248, 246, 242), outline=(110, 104, 94), width=4)
    draw.rectangle([160, 200, 172, 280], fill=(70, 66, 60))
    draw.rectangle([300, 470, 420, 540], fill=(178, 166, 150))
    return _photographic(image)


ROOM_PHOTOGRAPHY = [
    ('bathroom', bathroom_photo),
    ('shower', shower_photo),
    ('neutral beige room', neutral_room_photo),
]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('artwork_name,build_artwork', TILE_ARTWORK)
@pytest.mark.parametrize('size_name,image_rect', PRINT_SIZES)
def test_tile_artwork_is_kept_at_every_print_size(
    artwork_name, build_artwork, size_name, image_rect,
):
    """A tile is a tile whether it's printed in a grid or full-bleed.

    This is the regression the whole module exists for: judging by page area
    threw away every product on a one-product-per-page catalog.
    """
    is_room_photo, reason = classify_image_content(
        _png(build_artwork()), image_rect, PAGE,
    )
    assert not is_room_photo, (
        f"{artwork_name} tile printed {size_name} was discarded as a room photo: {reason}"
    )


@pytest.mark.parametrize('photo_name,build_photo', ROOM_PHOTOGRAPHY)
@pytest.mark.parametrize('size_name,image_rect', PRINT_SIZES)
def test_room_photography_is_rejected_at_every_print_size(
    photo_name, build_photo, size_name, image_rect,
):
    """The mirror of the above -- proof the classifier still rejects, rather
    than having been loosened into accepting everything."""
    is_room_photo, reason = classify_image_content(
        _png(build_photo()), image_rect, PAGE,
    )
    assert is_room_photo, (
        f"{photo_name} room photo printed {size_name} was kept as a tile "
        f"(measured {reason})"
    )


def test_banner_strips_are_rejected_regardless_of_content():
    """A page-width rule/banner is never a product, whatever pixels it holds
    -- caught on shape before the content analysis runs at all."""
    banner_rect = (0.0, 0.0, PAGE_W, 90.0)
    is_room_photo, reason = classify_image_content(_png(marble_tile()), banner_rect, PAGE)
    assert is_room_photo
    assert 'banner' in reason


def test_unreadable_image_is_kept_rather_than_dropped():
    """Fail open. If the image can't be analysed, keeping it costs a review
    click; dropping it loses a real product from the catalog silently."""
    is_room_photo, reason = classify_image_content(b'not an image at all', GRID, PAGE)
    assert not is_room_photo
    assert reason == ''


def test_tile_and_room_measurements_stay_well_separated():
    """Guards the margin, not just the verdicts.

    If a future tweak leaves the thresholds technically passing but with the
    two populations nearly touching, that's a latent regression -- the next
    real-world catalog would land in the gap. Fails while the verdicts above
    would still be green.
    """
    from extract import measure_image_content

    tile_colour_spread = [
        measure_image_content(_png(build()))['colour_variation']
        for _, build in TILE_ARTWORK
    ]
    room_colour_spread = [
        measure_image_content(_png(build()))['colour_variation']
        for _, build in ROOM_PHOTOGRAPHY
    ]

    worst_tile = max(tile_colour_spread)
    closest_room = min(room_colour_spread)

    assert closest_room > worst_tile * 2.0, (
        "tile and room colour-spread populations have drifted together "
        f"(busiest tile {worst_tile:.4f}, plainest room {closest_room:.4f}) -- "
        "the classifier still passes but has lost its safety margin"
    )
