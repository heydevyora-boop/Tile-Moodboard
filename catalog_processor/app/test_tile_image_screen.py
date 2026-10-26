"""The last look before a tile can reach a mood board.

Every number here was measured on real pixels -- 44 extracted tiles and
the catalog owner's own rejected examples -- not chosen to make the test
pass. The fixtures rebuild the measured cases from their statistics so
the suite runs anywhere, and the real figures are stated beside them.
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.tile_image_screen import (  # noqa: E402
    SCENE_CHROMA_SPREAD,
    SPLIT_MATERIAL_DISTANCE,
    scene_chroma_spread,
    screen_tile_image,
    split_material_distance,
)

PASS = []


def check(label, ok, detail=""):
    PASS.append((label, ok, detail))
    return ok


def one_material(seed, base=(150, 150, 150), grain=26):
    """A tile: one material, lit evenly, pattern as busy as you like."""
    rng = np.random.default_rng(seed)
    img = np.zeros((320, 320, 3), np.uint8)
    for y in range(0, 320, 40):
        for x in range(0, 320, 40):
            shade = rng.integers(-grain, grain + 1)
            img[y:y + 40, x:x + 40] = np.clip(np.array(base) + shade, 0, 255)
    return img


def dark_ground_decor():
    """The daisy: a near-black ground under a bright cream pattern.

    Measured 0.202 brightness spread tilted on the page and 0.205 once
    rectified into a clean swatch -- which is why brightness was thrown
    out. Its colour spread is what this screen reads instead.
    """
    rng = np.random.default_rng(7)
    img = np.full((320, 320, 3), 48, np.uint8)
    for _ in range(26):
        cx, cy = rng.integers(20, 300, size=2)
        cv_r = int(rng.integers(16, 34))
        yy, xx = np.ogrid[:320, :320]
        petal = (xx - cx) ** 2 + (yy - cy) ** 2 <= cv_r ** 2
        img[petal] = np.clip(np.array([206, 214, 222]) + rng.integers(-16, 17), 0, 255)
    return img


def several_materials(seed):
    """A room, or a crop out of a pictorial mural: materials that are
    genuinely different colours, side by side in one frame."""
    rng = np.random.default_rng(seed)
    img = np.zeros((320, 320, 3), np.uint8)
    palette = [(40, 70, 190), (60, 170, 80), (200, 190, 60),
               (190, 90, 40), (90, 60, 160), (220, 220, 215)]
    for y in range(0, 320, 80):
        for x in range(0, 320, 80):
            colour = palette[int(rng.integers(0, len(palette)))]
            img[y:y + 80, x:x + 80] = colour
    return img


def split_frame(flat=(70, 55, 140), seed=21):
    """The defect the catalog owner found: a flat colour on one side of a
    straight diagonal, a real tile material on the other."""
    rng = np.random.default_rng(seed)
    img = one_material(seed, base=(170, 180, 195), grain=34)
    rows, cols = np.mgrid[0:320, 0:320]
    img[(cols + rows) < 320] = flat
    return img


def main():
    # --- the bar sits where the measurements put it -------------------
    check("the bar is between the worst real tile and the nearest reject",
          0.0312 < SCENE_CHROMA_SPREAD < 0.0707,
          f"bar={SCENE_CHROMA_SPREAD}")
    check("...with at least a 1.5x margin on the real-tile side",
          SCENE_CHROMA_SPREAD / 0.0312 >= 1.5,
          f"{SCENE_CHROMA_SPREAD / 0.0312:.2f}x")
    check("...and at least a 1.5x margin on the rejection side",
          0.0707 / SCENE_CHROMA_SPREAD >= 1.5,
          f"{0.0707 / SCENE_CHROMA_SPREAD:.2f}x")

    # --- a tile is kept, however it looks ------------------------------
    for seed, name, kwargs in [
        (1, "a plain grey tile", {}),
        (2, "a warm beige tile", {"base": (170, 190, 205)}),
        (3, "a busy, high-grain tile", {"grain": 70}),
        (4, "a near-black tile", {"base": (38, 40, 44)}),
    ]:
        keep, reason = screen_tile_image(one_material(seed, **kwargs))
        check(f"{name} is kept", keep, reason)

    decor = dark_ground_decor()
    keep, reason = screen_tile_image(decor)
    check("a dark-ground floral decor is kept -- the case that killed "
          "the brightness rule", keep, reason)

    # --- a scene is refused --------------------------------------------
    for seed in (11, 12, 13):
        keep, reason = screen_tile_image(several_materials(seed))
        check(f"a many-material frame (seed {seed}) is refused",
              not keep, reason)
        check("...and the reason says what it read", "colour spread" in reason)

    # --- ordering, which is the property that actually matters ---------
    tile_spread = max(scene_chroma_spread(one_material(s)) for s in range(1, 6))
    scene_spread = min(scene_chroma_spread(several_materials(s)) for s in (11, 12, 13))
    check("every tile measures below every scene",
          tile_spread < scene_spread,
          f"tiles<={tile_spread:.4f}, scenes>={scene_spread:.4f}")
    check("...and the decor sits with the tiles, not the scenes",
          scene_chroma_spread(decor) < scene_spread,
          f"decor={scene_chroma_spread(decor):.4f}")

    # --- two materials in one frame ------------------------------------
    check("the split bar is between the worst real tile and the defect",
          0.350 < SPLIT_MATERIAL_DISTANCE < 0.684,
          f"bar={SPLIT_MATERIAL_DISTANCE}")
    check("...with at least a 1.35x margin on the real-tile side",
          SPLIT_MATERIAL_DISTANCE / 0.350 >= 1.35,
          f"{SPLIT_MATERIAL_DISTANCE / 0.350:.2f}x")
    check("...and at least a 1.35x margin on the defect side",
          0.684 / SPLIT_MATERIAL_DISTANCE >= 1.35,
          f"{0.684 / SPLIT_MATERIAL_DISTANCE:.2f}x")

    for flat, name in [((70, 55, 140), "a flat navy half"),
                       ((42, 70, 120), "a flat brown half"),
                       ((238, 236, 232), "a flat pale half")]:
        keep, reason = screen_tile_image(split_frame(flat=flat))
        check(f"{name} beside a real material is refused", not keep, reason)
        check("...and the reason says half of it is another product",
              "another product" in reason or "colour spread" in reason)

    check("a whole tile is nowhere near the split bar",
          max(split_material_distance(one_material(s)) for s in range(1, 6))
          < SPLIT_MATERIAL_DISTANCE * 0.6,
          f"{max(split_material_distance(one_material(s)) for s in range(1, 6)):.3f}")
    check("a dark-ground decor is not read as a split either",
          split_material_distance(dark_ground_decor()) < SPLIT_MATERIAL_DISTANCE,
          f"{split_material_distance(dark_ground_decor()):.3f}")

    # --- it must never drop a product it could not measure -------------
    keep, reason = screen_tile_image(None)
    check("an unreadable frame is kept, not dropped", keep, reason)
    keep, reason = screen_tile_image(np.zeros((0, 0, 3), np.uint8))
    check("an empty frame is kept, not dropped", keep, reason)

    # --- size must not change the verdict ------------------------------
    import cv2
    big = cv2.resize(one_material(1), (1600, 1600), interpolation=cv2.INTER_NEAREST)
    small = cv2.resize(one_material(1), (120, 120), interpolation=cv2.INTER_AREA)
    check("the same tile reads the same at 120px and 1600px",
          abs(scene_chroma_spread(big) - scene_chroma_spread(small)) < 0.01,
          f"{scene_chroma_spread(small):.4f} vs {scene_chroma_spread(big):.4f}")

    failures = [p for p in PASS if not p[1]]
    for label, ok, detail in PASS:
        print(("  PASS  " if ok else "  FAIL  ") + label
              + (f"  [{detail}]" if detail and not ok else ""))
    print(f"\n{len(PASS) - len(failures)}/{len(PASS)} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
