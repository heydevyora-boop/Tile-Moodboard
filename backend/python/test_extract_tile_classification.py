"""
test_extract_tile_classification.py

Offline tests for extract.py's tile-vs-room-photo classification and
page-template (logo/badge) exclusion.

No PDF fixtures on disk, no Google APIs, no network -- every image is drawn
synthetically here so the test states its own assumptions in full.

Two regressions this file exists to prevent, both found the hard way against
a real 139-page catalog after fixing an earlier one:

1. PAGE-GEOMETRY REGRESSION (the original bug). An early version judged
   tile-vs-room purely by how the image sat on the page -- anything over
   55% of the page area was assumed a lifestyle shot. Catalogs commonly
   print one product full-bleed per page, so that rule discarded almost the
   entire catalog. Fixed by judging pixel content instead of page geometry.

2. SYNTHETIC-CALIBRATION REGRESSION (found immediately after "fixing" #1).
   The pixel-content thresholds were tuned against tile artwork drawn by
   hand for this test file -- clean, flat, computer-generated swatches with
   none of the shadow, reflection, or lighting falloff a real studio photo
   of a tile naturally carries. Run against the real catalog, colour
   variation measured across 113 genuine product photos as: min 0.0102,
   median 0.0295, mean 0.0376, max 0.1744 -- and the threshold had been set
   to 0.020. 89% of real product photos were rejected. Pages 1-114 of the
   139-page catalog survived as ~0 tiles.

The fix for #2 is not "tune the number a bit" -- it's a structural
admission: the two failure costs are NOT symmetric. A room photo that slips
through costs one manual delete in the review step that already exists
(Product Data supports Edit/Delete per tile). A real product wrongly
rejected here is silently gone, discovered only much later as a mysterious
placeholder image. So thresholds now sit clear of the entire real-photo
range measured above, and the tests below encode that range as a hard
regression anchor -- not just a handful of hand-drawn examples.

A third, independent bug was found in the same real run: a page badge
("COMPANY", a certification mark) printed at the exact same position on a
dozen separate pages survived the content classifier (it's flat and evenly
lit, same as a real tile) and got inserted as a fabricated product. No
amount of pixel-content tuning can fix this -- a flat badge and a flat tile
really do look alike. What doesn't look alike is behaviour: a real product
photo's position varies page to page; a stamped badge's does not. That's
find_repeating_template_rects, tested separately below.
"""

import io
import math
import random

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFilter

from extract import (
    REPEATING_TEMPLATE_MIN_PAGES,
    classify_image_content,
    find_repeating_template_rects,
    measure_image_content,
)


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

FULL_BLEED = (0.0, 0.0, PAGE_W, PAGE_H)
LARGE = (30.0, 60.0, 565.0, 650.0)
GRID = (60.0, 120.0, 300.0, 360.0)
PRINT_SIZES = [('full-bleed', FULL_BLEED), ('large', LARGE), ('grid', GRID)]


def _png(image):
    buffer = io.BytesIO()
    image.save(buffer, 'PNG')
    return buffer.getvalue()


def _photographic(image, sigma=9):
    """Sensor noise + micro-texture a real photograph carries everywhere and
    flat computer-generated artwork does not."""
    pixels = np.asarray(image, dtype=np.float32)
    pixels += np.random.normal(0, sigma, pixels.shape)
    noisy = Image.fromarray(np.clip(pixels, 0, 255).astype('uint8'))
    return noisy.filter(ImageFilter.GaussianBlur(0.4))


def _photographic_tile(base_rgb, seed, size=700):
    """A tile with the studio-photography characteristics that broke the
    first version of this classifier: soft directional lighting falloff
    (a vignette, off-centre) plus sensor noise. This is what a real product
    photo looks like; the hand-drawn fixtures below it are additionally kept
    as documentation of the original clean-artwork cases."""
    random.seed(seed)
    np.random.seed(seed)
    yy, xx = np.mgrid[0:size, 0:size]
    cx, cy = size * random.uniform(0.3, 0.7), size * random.uniform(0.2, 0.5)
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / (size * 0.9)
    vignette = 1.0 - 0.35 * np.clip(dist, 0, 1)
    field = np.array(base_rgb, dtype=np.float32)[None, None, :] * vignette[:, :, None]
    field += np.random.normal(0, 6, (size, size, 3))
    image = Image.fromarray(np.clip(field, 0, 255).astype('uint8'))
    return image.filter(ImageFilter.GaussianBlur(0.6))


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
    """The most EDGE-DENSE image in this file (measures busier than any
    room photo) -- why edge density is never used as a signal."""
    image = Image.new('RGB', (700, 700), (226, 220, 206))
    draw = ImageDraw.Draw(image)
    for gy in range(0, 700, 70):
        for gx in range(0, 700, 70):
            draw.rectangle([gx + 6, gy + 6, gx + 64, gy + 64], outline=(150, 138, 120), width=3)
            draw.line([gx + 6, gy + 6, gx + 64, gy + 64], fill=(168, 156, 138), width=2)
            draw.line([gx + 64, gy + 6, gx + 6, gy + 64], fill=(168, 156, 138), width=2)
    return image


def blue_decor_tile():
    """The most SATURATED image in this file -- why saturation is never
    used as a signal either."""
    image = Image.new('RGB', (700, 700), (58, 104, 168))
    draw = ImageDraw.Draw(image)
    for gy in range(0, 700, 88):
        for gx in range(0, 700, 88):
            draw.ellipse([gx + 10, gy + 10, gx + 78, gy + 78], outline=(232, 238, 246), width=5)
            draw.ellipse([gx + 30, gy + 30, gx + 58, gy + 58], fill=(236, 240, 248))
    return image


def gradient_tile():
    """Shades light-to-dark across its face -- uneven lighting alone must
    not be enough to reject a tile."""
    np.random.seed(5)
    ramp = np.linspace(40, 150, 700)[None, :].repeat(700, 0)
    field = np.stack([ramp, ramp, ramp], axis=2) + np.random.normal(0, 3, (700, 700, 3))
    return Image.fromarray(np.clip(field, 0, 255).astype('uint8'))


def mosaic_tile():
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


def photographic_beige_tile():
    """Realistic studio photo of a plain beige tile: vignette + sensor
    noise, no drawn pattern at all. The single closest analogue to what
    actually broke the first version of this classifier."""
    return _photographic_tile((205, 190, 168), seed=101)


def photographic_charcoal_tile():
    return _photographic_tile((70, 66, 62), seed=102)


def photographic_terracotta_tile():
    return _photographic_tile((188, 120, 84), seed=103)


TILE_ARTWORK = [
    ('marble base', marble_tile),
    ('wood plank', wood_plank_tile),
    ('patterned highlighter', patterned_highlighter),
    ('blue decor', blue_decor_tile),
    ('dark gradient', gradient_tile),
    ('mosaic', mosaic_tile),
    ('photographic beige (studio lighting)', photographic_beige_tile),
    ('photographic charcoal (studio lighting)', photographic_charcoal_tile),
    ('photographic terracotta (studio lighting)', photographic_terracotta_tile),
]


# ---------------------------------------------------------------------------
# Room photography -- must be rejected. Deliberately vivid/multi-object: see
# the module docstring for why mild room photos are no longer expected to
# be caught by content alone (that's the recalibration this file pins down).
# ---------------------------------------------------------------------------

def vivid_bathroom_photo():
    """Bright sky-lit window, warm wood vanity, saturated green plant, red
    towel, yellow accessory, near-black floor -- an unambiguous multi-object
    room, not a borderline case."""
    random.seed(23)
    np.random.seed(23)
    image = Image.new('RGB', (700, 700), (150, 140, 128))
    draw = ImageDraw.Draw(image)
    draw.rectangle([0, 0, 700, 160], fill=(120, 175, 225))
    draw.rectangle([0, 560, 700, 700], fill=(45, 40, 36))
    draw.rectangle([420, 60, 660, 430], fill=(255, 255, 250), outline=(30, 30, 30), width=6)
    draw.rectangle([60, 300, 260, 560], fill=(150, 95, 45), outline=(60, 40, 20), width=5)
    draw.ellipse([90, 250, 230, 340], fill=(250, 250, 248), outline=(40, 40, 40), width=4)
    draw.rectangle([150, 170, 164, 260], fill=(20, 20, 20))
    draw.ellipse([300, 420, 440, 560], fill=(30, 140, 50))
    for angle in range(0, 360, 18):
        draw.line(
            [370, 490,
             370 + 95 * math.cos(math.radians(angle)),
             490 + 95 * math.sin(math.radians(angle))],
            fill=(20, 120, 40), width=8,
        )
    draw.rectangle([540, 450, 660, 600], fill=(210, 60, 90))
    draw.rectangle([20, 420, 90, 560], fill=(230, 180, 40))
    return _photographic(image)


def vivid_kitchen_photo():
    """Stainless appliance, warm wood cabinetry, blue backsplash tile
    visible in frame, bright window, dark counter, red/yellow/green
    accessories -- again unambiguous, and pushed clear of the "needs
    corroboration" band so it's caught at every print size, not only when
    it happens to cover most of the page."""
    random.seed(29)
    np.random.seed(29)
    image = Image.new('RGB', (700, 700), (160, 150, 138))
    draw = ImageDraw.Draw(image)
    draw.rectangle([0, 0, 700, 140], fill=(235, 232, 224))
    draw.rectangle([0, 500, 700, 700], fill=(25, 22, 20))
    draw.rectangle([40, 140, 300, 500], fill=(150, 90, 35), outline=(60, 38, 18), width=5)
    draw.rectangle([320, 180, 660, 470], fill=(40, 110, 180))
    draw.rectangle([340, 220, 420, 300], fill=(215, 215, 220), outline=(20, 20, 20), width=4)
    draw.ellipse([460, 240, 600, 380], fill=(230, 230, 235), outline=(30, 30, 30), width=5)
    draw.rectangle([440, 30, 620, 130], fill=(255, 248, 225))
    draw.rectangle([60, 420, 220, 480], fill=(215, 30, 55))
    draw.rectangle([230, 420, 300, 480], fill=(240, 200, 30))
    draw.ellipse([500, 420, 600, 510], fill=(30, 150, 60))
    return _photographic(image)


ROOM_PHOTOGRAPHY = [
    ('vivid bathroom', vivid_bathroom_photo),
    ('vivid kitchen', vivid_kitchen_photo),
]


# ---------------------------------------------------------------------------
# Content-classification tests
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('artwork_name,build_artwork', TILE_ARTWORK)
@pytest.mark.parametrize('size_name,image_rect', PRINT_SIZES)
def test_tile_artwork_is_kept_at_every_print_size(
    artwork_name, build_artwork, size_name, image_rect,
):
    """A tile is a tile whether it's printed in a grid or full-bleed --
    page size must never decide the verdict (regression #1)."""
    is_room_photo, reason = classify_image_content(
        _png(build_artwork()), image_rect, PAGE,
    )
    assert not is_room_photo, (
        f"{artwork_name} tile printed {size_name} was discarded as a room photo: {reason}"
    )


@pytest.mark.parametrize('photo_name,build_photo', ROOM_PHOTOGRAPHY)
@pytest.mark.parametrize('size_name,image_rect', PRINT_SIZES)
def test_vivid_room_photography_is_still_rejected(
    photo_name, build_photo, size_name, image_rect,
):
    """Proof the classifier isn't a no-op after recalibration -- an
    unambiguous multi-object room photo must still be caught."""
    is_room_photo, reason = classify_image_content(
        _png(build_photo()), image_rect, PAGE,
    )
    assert is_room_photo, (
        f"{photo_name} room photo printed {size_name} was kept as a tile "
        f"(measured {reason})"
    )


def test_banner_strips_are_rejected_regardless_of_content():
    """A page-width rule/banner is never a product, whatever pixels it holds
    -- caught on shape before content analysis runs at all."""
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
    """Guards the margin, not just the verdicts -- if a future tweak leaves
    the verdicts technically passing but the two populations nearly
    touching, that's a latent regression this would still catch."""
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

    assert closest_room > worst_tile, (
        "tile and room colour-spread populations have drifted together "
        f"(busiest tile {worst_tile:.4f}, plainest room {closest_room:.4f})"
    )


def test_real_catalog_colour_spread_values_are_all_kept():
    """Hard regression anchor: the actual colour_variation values measured
    for 113 genuine product photos from a real 139-page catalog, on the
    version of this classifier that rejected 89% of them. Every one of
    these numbers must now fall BELOW the rejection threshold. This is not
    a synthetic proxy -- it is the exact data that proved the synthetic
    proxies were miscalibrated in the first place, so it stays authoritative
    over any hand-drawn fixture in this file if the two ever disagree.
    """
    from extract import ROOM_COLOUR_VARIATION_STRONG

    real_catalog_colour_spreads = [
        0.1744, 0.0398, 0.0412, 0.0196, 0.0264, 0.0253, 0.0258, 0.0250, 0.0506,
        0.0642, 0.0280, 0.0374, 0.0139, 0.0137, 0.0203, 0.0295, 0.0113, 0.0286,
        0.0277, 0.0284, 0.0281, 0.0248, 0.0759, 0.0358, 0.0371, 0.0139, 0.0228,
        0.0396, 0.0205, 0.0224, 0.0199, 0.0264, 0.0460, 0.0629, 0.0423, 0.0365,
        0.0297, 0.0297, 0.0102, 0.0191, 0.0347, 0.0255, 0.0257, 0.0230, 0.0399,
        0.0350, 0.0456, 0.0165, 0.0211, 0.0610, 0.0419, 0.0400, 0.0397, 0.0296,
        0.0223, 0.0200, 0.0279, 0.0295, 0.0264, 0.0228, 0.0213, 0.0257, 0.0235,
        0.0215, 0.1050, 0.0258, 0.0236, 0.0105, 0.0228, 0.0353, 0.0358, 0.0319,
        0.0303, 0.0386, 0.0292, 0.0221, 0.0207, 0.0239, 0.0425, 0.0394, 0.0249,
        0.0288, 0.0633, 0.0633, 0.1247, 0.0781, 0.0781, 0.0535, 0.0733, 0.0668,
        0.0212, 0.0278, 0.0215, 0.0652, 0.0601, 0.0224, 0.0212, 0.0196, 0.0923,
        0.0700, 0.0450, 0.0649, 0.0593, 0.0679, 0.0325, 0.0311, 0.0269, 0.0265,
        0.0284, 0.0299, 0.0295, 0.0627, 0.0376,
    ]

    worst = max(real_catalog_colour_spreads)
    assert worst < ROOM_COLOUR_VARIATION_STRONG, (
        f"a real product photo measured colour spread {worst}, at or above "
        f"the current rejection threshold {ROOM_COLOUR_VARIATION_STRONG} -- "
        "this exact regression (thresholds tuned on synthetic artwork only) "
        "already caused near-total catalog data loss once"
    )


# ---------------------------------------------------------------------------
# Page-template (logo/badge) detection tests
# ---------------------------------------------------------------------------

class _FakePage:
    """Stands in for a PyMuPDF Page: only get_images()/get_image_rects()
    are read by find_repeating_template_rects.

    The xref carried per image matters as much as the rect -- it is what
    distinguishes one stamped badge reused across pages from a layout slot
    holding a different product each page.
    """

    def __init__(self, images):
        # images: list of (xref, rect) for this page
        self._images = images

    def get_images(self, full=True):  # noqa: ARG002 -- matches PyMuPDF's signature
        return [(xref,) for xref, _rect in self._images]

    def get_image_rects(self, xref):
        return [rect for x, rect in self._images if x == xref]


class _FakeDoc:
    """Stands in for a PyMuPDF Document for find_repeating_template_rects,
    which only reads .page_count and indexes pages."""

    def __init__(self, pages):
        self._pages = pages

    @property
    def page_count(self):
        return len(self._pages)

    def __getitem__(self, index):
        return self._pages[index]


BADGE_RECT = (1020.0, 700.0, 1180.0, 860.0)


def test_badge_repeated_across_many_pages_is_excluded():
    """The real bug: a certification badge stamped at the same spot on 12+
    pages (always the same image resource, xref 2), alongside a genuine
    product whose position varies every page."""
    pages = []
    for i in range(12):
        product_rect = (40.0 + i * 3, 60.0, 400.0 + i * 3, 500.0)  # moves slightly each page
        pages.append(_FakePage([(100 + i, product_rect), (2, BADGE_RECT)]))

    template_rects = find_repeating_template_rects(_FakeDoc(pages))

    badge_bucket = tuple(round(c / 2.0) for c in BADGE_RECT)
    assert badge_bucket in template_rects

    for i in range(12):
        product_rect = (40.0 + i * 3, 60.0, 400.0 + i * 3, 500.0)
        product_bucket = tuple(round(c / 2.0) for c in product_rect)
        assert product_bucket not in template_rects, (
            f"page {i}'s genuine, moving product position was wrongly "
            "excluded as a repeating template element"
        )


def test_fixed_grid_slots_holding_different_products_are_kept():
    """The second over-rejection, and the reason position alone is not
    enough to call something page furniture.

    Catalogs commonly lay products out on a rigid grid: the same four slot
    coordinates on every page, each holding a DIFFERENT product. A
    position-only version of the detector classified every one of those
    slots as a repeating template element and deleted the catalog's whole
    product range -- 585 tile candidates collapsed to 25 on the real
    catalog. What distinguishes the two cases is the image resource drawn
    at the position, not the position itself: a badge is one xref reused;
    a grid slot is a different xref per page.
    """
    slots = [
        (64.9, 211.2, 312.0, 705.3),
        (339.6, 211.2, 586.7, 705.3),
        (686.2, 211.2, 933.3, 705.3),
        (960.9, 211.2, 1207.9, 705.3),
    ]

    pages = []
    next_xref = 100
    for _page in range(14):
        images = []
        for slot in slots:
            images.append((next_xref, slot))  # a different product in each slot, each page
            next_xref += 1
        images.append((2, BADGE_RECT))  # the one genuinely stamped element
        pages.append(_FakePage(images))

    template_rects = find_repeating_template_rects(_FakeDoc(pages))

    for slot in slots:
        slot_bucket = tuple(round(c / 2.0) for c in slot)
        assert slot_bucket not in template_rects, (
            f"fixed grid slot {slot} was wrongly excluded as page furniture "
            "-- it holds a different product on every page"
        )

    badge_bucket = tuple(round(c / 2.0) for c in BADGE_RECT)
    assert badge_bucket in template_rects, (
        "the genuinely stamped badge should still be excluded"
    )


def test_badge_position_recurs_with_sub_pixel_float_noise():
    """Real PyMuPDF output for "the same" badge varies by a fraction of a
    point page to page (floating-point noise in the content stream) -- the
    detector must still recognise these as one position, not many."""
    noisy_rects = [
        (1020.0 + (i % 3) * 0.004, 700.0, 1180.0 - (i % 2) * 0.003, 860.0)
        for i in range(6)
    ]
    pages = [_FakePage([(1, rect)]) for rect in noisy_rects]

    template_rects = find_repeating_template_rects(_FakeDoc(pages))

    assert len(template_rects) == 1, (
        "sub-pixel position noise across pages was NOT collapsed into a "
        f"single bucket: got {len(template_rects)} distinct buckets"
    )


def test_a_position_below_the_page_threshold_is_not_excluded():
    """A coincidence -- the same position on a couple of pages -- must not
    be enough. Real products can legitimately share a layout slot on a
    handful of pages; only many-page recurrence is page furniture."""
    below_threshold = REPEATING_TEMPLATE_MIN_PAGES - 1
    pages = [_FakePage([(1, BADGE_RECT)]) for _ in range(below_threshold)]

    template_rects = find_repeating_template_rects(_FakeDoc(pages))

    assert template_rects == set()


def test_same_position_at_different_x_is_not_merged_with_the_badge():
    """A real observed case: the badge on a 2-up spread page sits at a
    different x-offset than usual. That page's badge legitimately falls
    below the page-count threshold in its own bucket and must not
    contaminate -- or be contaminated by -- the main badge bucket."""
    pages = [_FakePage([(1, BADGE_RECT)]) for _ in range(REPEATING_TEMPLATE_MIN_PAGES)]
    shifted_rect = (BADGE_RECT[0] + 200.0, BADGE_RECT[1], BADGE_RECT[2] + 200.0, BADGE_RECT[3])
    pages.append(_FakePage([(1, shifted_rect)]))

    template_rects = find_repeating_template_rects(_FakeDoc(pages))

    main_bucket = tuple(round(c / 2.0) for c in BADGE_RECT)
    shifted_bucket = tuple(round(c / 2.0) for c in shifted_rect)
    assert main_bucket in template_rects
    assert shifted_bucket not in template_rects
