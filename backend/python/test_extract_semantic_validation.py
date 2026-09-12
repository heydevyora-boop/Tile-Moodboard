"""
test_extract_semantic_validation.py

Tests for the semantic tile gate in extract.py -- the check that decides
whether a surviving candidate image actually DEPICTS the tile product, or a
room the tile happens to be installed in.

WHY THIS GATE EXISTS, measured rather than asserted:

classify_image_content's only real signal is how much an image's regions
differ in HUE. A modern catalog lifestyle shot -- beige slab worktop, beige
cabinetry, beige splashback -- is tonally monochromatic, so it is
colour-UNIFORM and reads as a flat tile surface. The muted kitchen fixture
below measures a colour spread of roughly 0.008, which is LOWER than 112 of
the 113 genuine product photos recorded in
test_extract_tile_classification.py (minimum 0.0102).

That inversion is the whole point: the two populations do not merely overlap
on this metric, they are the wrong way round, so NO threshold can separate
them. test_statistical_filter_provably_cannot_catch_this pins that down, so
that anyone tempted to "just tune the threshold" instead of keeping this gate
can see why that cannot work before they try it. Tuning that number is
exactly what caused near-total catalog data loss twice before -- see the
module docstring of test_extract_tile_classification.py.

POSTURE: fail closed, uniformly. Production requires that ONLY a real,
confidently-confirmed tile/product image is ever saved. A wrong tile image
is worse than a missing one, so anything short of a confident "yes, this is
the product" -- a low confidence score, an unreadable answer, an API error,
an exhausted quota, or no GEMINI_API_KEY configured at all -- results in the
image NOT being saved. A missing key is not a special pass-through case: it
means confirmation could not be obtained, which is exactly the condition
every other branch here also rejects on. A deployment with no key configured
extracts zero tiles, and extract() logs that loudly rather than letting the
run look like "this catalog simply had no tiles".

No network and no API key are needed here -- the Gemini client is stubbed, so
these tests assert the gate's decision logic, not Gemini's judgement.
"""

import io
import json
import math
import random

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFilter

from extract import (
    SEMANTIC_MIN_CONFIDENCE,
    SemanticTileValidator,
    classify_image_content,
    crop_to_product_bbox,
    measure_image_content,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

PAGE_W, PAGE_H = 595.0, 842.0


class _Rect:
    def __init__(self, width, height):
        self.width = width
        self.height = height


PAGE = _Rect(PAGE_W, PAGE_H)
FULL_BLEED = (0.0, 0.0, PAGE_W, PAGE_H)
GRID = (60.0, 120.0, 300.0, 360.0)


def _png(image):
    buffer = io.BytesIO()
    image.save(buffer, 'PNG')
    return buffer.getvalue()


def _photographic(image, sigma=6):
    pixels = np.asarray(image, dtype=np.float32)
    pixels += np.random.normal(0, sigma, pixels.shape)
    return Image.fromarray(np.clip(pixels, 0, 255).astype('uint8')).filter(
        ImageFilter.GaussianBlur(0.4)
    )


def muted_kitchen_photo():
    """The reported failure: a modern beige kitchen with a large-format
    marble-look slab on the island and splashback. Tonally monochromatic,
    which is precisely why the statistical filter keeps it."""
    random.seed(41)
    np.random.seed(41)
    image = Image.new('RGB', (700, 700), (208, 200, 188))
    draw = ImageDraw.Draw(image)
    draw.rectangle([0, 0, 700, 300], fill=(214, 207, 196))    # slab splashback
    draw.rectangle([0, 300, 700, 430], fill=(198, 188, 174))  # counter run
    draw.rectangle([0, 430, 700, 700], fill=(186, 176, 162))  # cabinetry
    draw.rectangle([120, 450, 580, 690], fill=(176, 166, 152),
                   outline=(160, 150, 138), width=3)
    draw.rectangle([300, 300, 420, 320], fill=(190, 182, 170))  # sink lip
    for vein_x in range(0, 700, 90):
        points, x = [(vein_x, 0)], vein_x
        for y in range(0, 300, 22):
            x += random.randint(-12, 12)
            points.append((x, y))
        draw.line(points, fill=(196, 188, 176), width=2)
    draw.ellipse([470, 240, 520, 300], fill=(198, 190, 178))  # tap
    return _photographic(image)


def plain_tile_swatch():
    """A genuine product swatch, for the must-keep side of every test."""
    random.seed(51)
    np.random.seed(51)
    field = np.full((700, 700, 3), 205.0) + np.random.normal(0, 5, (700, 700, 3))
    return Image.fromarray(np.clip(field, 0, 255).astype('uint8'))


# ---------------------------------------------------------------------------
# Stub Gemini client
# ---------------------------------------------------------------------------

class _StubResponse:
    def __init__(self, text):
        self.text = text


class _StubModels:
    def __init__(self, payload=None, error=None, raw_text=None):
        self._payload = payload
        self._error = error
        self._raw_text = raw_text
        self.call_count = 0

    def generate_content(self, **kwargs):  # noqa: ARG002 -- signature parity
        self.call_count += 1
        if self._error is not None:
            raise self._error
        if self._raw_text is not None:
            return _StubResponse(self._raw_text)
        return _StubResponse(json.dumps(self._payload))


class _StubClient:
    def __init__(self, **kwargs):
        self.models = _StubModels(**kwargs)


def _validator_with(**kwargs):
    """A validator wired to a stubbed Gemini client. Returns (validator,
    stub_models) so tests can assert on how many calls were actually made."""
    validator = SemanticTileValidator('test-key')
    client = _StubClient(**kwargs)
    validator._client = client
    return validator, client.models


APPROVED = {
    'is_product_image': True,
    'confidence': 0.95,
    'reason': 'flat ceramic tile swatch',
    'product_bbox': {'x1': 0, 'y1': 0, 'x2': 1, 'y2': 1},
}

REJECTED_KITCHEN = {
    'is_product_image': False,
    'confidence': 0.93,
    'reason': 'kitchen interior with island and cabinetry',
    'product_bbox': None,
}


# ---------------------------------------------------------------------------
# The regression case
# ---------------------------------------------------------------------------

def test_statistical_filter_provably_cannot_catch_this():
    """The measurement that justifies the whole gate.

    The kitchen photo is MORE colour-uniform than a real product photo, so
    the statistical filter keeps it -- and any threshold low enough to reject
    it would reject the genuine catalog too. Documented as an executable fact
    so it is not rediscovered by tuning the threshold a third time.
    """
    kitchen = _png(muted_kitchen_photo())
    kitchen_spread = measure_image_content(kitchen)['colour_variation']

    # The floor of the 113 real product photos in the sibling test module.
    real_product_photo_minimum = 0.0102

    assert kitchen_spread < real_product_photo_minimum, (
        f"kitchen measured {kitchen_spread:.4f}, expected below the real-product "
        f"floor {real_product_photo_minimum} -- if this no longer holds, the "
        "premise for the semantic gate has changed and should be re-measured"
    )

    for size_name, rect in (('full-bleed', FULL_BLEED), ('grid', GRID)):
        is_room_photo, _ = classify_image_content(kitchen, rect, PAGE)
        assert not is_room_photo, (
            f"the statistical filter unexpectedly caught the kitchen at {size_name}; "
            "this test documents that it cannot -- re-verify the gate's premise"
        )


def test_kitchen_lifestyle_photo_is_rejected_by_the_semantic_gate():
    """The bug, end to end: the image the statistical filter keeps must be
    rejected here, and must carry a reason naming what was actually seen."""
    validator, _ = _validator_with(payload=REJECTED_KITCHEN)

    approved, reason, bbox = validator.verdict(_png(muted_kitchen_photo()))

    assert approved is False
    assert bbox is None
    assert 'kitchen' in reason.lower()


def test_genuine_tile_swatch_is_still_approved():
    """The gate must not be a blanket reject -- the anti-data-loss side."""
    validator, _ = _validator_with(payload=APPROVED)

    approved, reason, _ = validator.verdict(_png(plain_tile_swatch()))

    assert approved is True
    assert 'swatch' in reason.lower()


# ---------------------------------------------------------------------------
# Reject-when-unsure
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('confidence', [0.0, 0.35, 0.5, 0.74])
def test_low_confidence_product_is_rejected(confidence):
    """'Probably a tile' is not good enough: a wrong tile image is worse than
    a missing one, so anything below the strong band is not saved."""
    validator, _ = _validator_with(payload={
        'is_product_image': True,
        'confidence': confidence,
        'reason': 'possibly a tile, possibly a worktop',
        'product_bbox': None,
    })

    approved, reason, _ = validator.verdict(_png(muted_kitchen_photo()))

    assert approved is False
    assert 'uncertain' in reason.lower()


def test_confidence_at_the_threshold_is_accepted():
    """Guards the boundary itself, so the band cannot drift silently."""
    validator, _ = _validator_with(payload={
        'is_product_image': True,
        'confidence': SEMANTIC_MIN_CONFIDENCE,
        'reason': 'tile surface',
        'product_bbox': None,
    })

    approved, _, _ = validator.verdict(_png(plain_tile_swatch()))

    assert approved is True


def test_api_error_rejects_rather_than_failing_open():
    """A transient API failure must not quietly admit an unvalidated image.
    It is reported as needing review instead."""
    validator, _ = _validator_with(error=RuntimeError('connection reset'))

    approved, reason, _ = validator.verdict(_png(muted_kitchen_photo()))

    assert approved is False
    assert 'needs review' in reason.lower()


def test_unreadable_verdict_is_rejected():
    """A non-JSON answer is not a confirmation."""
    validator, _ = _validator_with(raw_text='I think that might be a tile?')

    approved, reason, _ = validator.verdict(_png(plain_tile_swatch()))

    assert approved is False
    assert 'unreadable' in reason.lower()


def test_quota_exhaustion_latches_and_stops_calling():
    """Mirrors gemini_service's quota guard: once the API says 429, the rest
    of the catalog is reported for review rather than hammering an API that
    is already refusing. The second image must cost no call at all."""
    validator, models = _validator_with(error=RuntimeError('429 RESOURCE_EXHAUSTED'))

    first_approved, first_reason, _ = validator.verdict(_png(plain_tile_swatch()))
    second_approved, second_reason, _ = validator.verdict(_png(plain_tile_swatch()))

    assert first_approved is False
    assert 'quota' in first_reason.lower()

    assert second_approved is False
    assert 'quota' in second_reason.lower()
    assert models.call_count == 1, (
        f"expected the quota latch to prevent a second API call, got "
        f"{models.call_count} calls"
    )


def test_validator_without_api_key_rejects_fail_closed():
    """Production requirement: ONLY a confidently-verified real tile image
    may ever be saved. A missing key means that confirmation can never be
    obtained, so it is treated the same as every other "could not confirm"
    path -- not as a special pass-through. This applies even to a genuine
    tile swatch: without a key, nothing can be confirmed, tile or not.
    """
    validator = SemanticTileValidator(None)

    assert validator.enabled is False

    approved, reason, bbox = validator.verdict(_png(plain_tile_swatch()))

    assert approved is False
    assert bbox is None
    assert 'gemini_api_key' in reason.lower()


def test_validator_without_api_key_rejects_every_candidate_type():
    """Fail-closed must not depend on what the image actually shows -- both
    an obvious room photo and a clean product swatch are rejected alike when
    validation cannot run at all."""
    validator = SemanticTileValidator(None)

    kitchen_approved, _, _ = validator.verdict(_png(muted_kitchen_photo()))
    swatch_approved, _, _ = validator.verdict(_png(plain_tile_swatch()))

    assert kitchen_approved is False
    assert swatch_approved is False


# ---------------------------------------------------------------------------
# Cropping -- extraction only, never synthesis
# ---------------------------------------------------------------------------

def test_crop_selects_real_pixels_and_never_invents_any():
    """The crop must be a pure sub-rectangle of the source: the cropped
    region has to match the original's pixels exactly, with nothing scaled,
    padded or generated."""
    source = plain_tile_swatch()
    original = _png(source)

    cropped_bytes = crop_to_product_bbox(original, (0.25, 0.25, 0.75, 0.75))

    with Image.open(io.BytesIO(cropped_bytes)) as cropped:
        cropped = cropped.convert('RGB')
        assert cropped.size == (350, 350)
        expected = source.convert('RGB').crop((175, 175, 525, 525))
        assert np.array_equal(np.asarray(cropped), np.asarray(expected)), (
            "cropped pixels differ from the source region -- the crop must "
            "select existing pixels, never resample or synthesise them"
        )


def test_crop_preserves_a_non_square_aspect_ratio():
    """A 3:1 band must stay 3:1 -- tiles are not all square and the product's
    real proportions must survive."""
    original = _png(plain_tile_swatch())

    cropped_bytes = crop_to_product_bbox(original, (0.0, 0.4, 0.9, 0.7))

    with Image.open(io.BytesIO(cropped_bytes)) as cropped:
        width, height = cropped.size
    assert (width, height) == (630, 210)
    assert math.isclose(width / height, 3.0, rel_tol=0.02)


def test_full_frame_bbox_returns_the_image_untouched():
    """A clean swatch already fills its frame; it must pass through byte-for-
    byte rather than being needlessly re-encoded."""
    original = _png(plain_tile_swatch())

    assert crop_to_product_bbox(original, (0.0, 0.0, 1.0, 1.0)) is original
    assert crop_to_product_bbox(original, None) is original


@pytest.mark.parametrize('bad_bbox', [
    {'x1': 0, 'y1': 0, 'x2': 0.05, 'y2': 1},      # degenerately narrow
    {'x1': 0, 'y1': 0, 'x2': 1, 'y2': 0.02},      # degenerately short
    {'x1': -0.2, 'y1': 0, 'x2': 1, 'y2': 1},      # out of range
    {'x1': 0, 'y1': 0},                           # malformed
    'not a box',                                  # wrong type
])
def test_degenerate_bboxes_are_ignored(bad_bbox):
    """A malformed or collapsing box must never shrink a real tile to a
    sliver -- the gate drops the box and keeps the full image."""
    validator, _ = _validator_with(payload={
        'is_product_image': True,
        'confidence': 0.95,
        'reason': 'tile surface',
        'product_bbox': bad_bbox,
    })

    approved, _, bbox = validator.verdict(_png(plain_tile_swatch()))

    assert approved is True
    assert bbox is None


def test_unreadable_image_bytes_survive_cropping():
    """A failed crop must return the original rather than losing the tile."""
    assert crop_to_product_bbox(b'not an image', (0.1, 0.1, 0.9, 0.9)) == b'not an image'
