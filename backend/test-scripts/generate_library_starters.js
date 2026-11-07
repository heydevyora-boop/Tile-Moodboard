/**
 * The De'vyora Library's STARTER ROOMS, drawn rather than photographed.
 *
 * WHY THESE EXIST. A studio that has just deployed has an empty library:
 * nothing has been uploaded yet, and until Drive and the migration are
 * in place nothing can be. The page was therefore a grid of nine themes
 * with nothing behind any of them, which is indistinguishable from a
 * feature that does not work.
 *
 * These are reference ROOMS -- a wall elevation with its dado, its
 * feature panel, its floor and its fittings -- drawn from each theme's
 * own palette and its own characteristic pattern. They are honest about
 * what they are: a drawing, not a photograph, and the page labels them
 * STARTER so nobody mistakes one for a room the studio shot.
 *
 * They are PNG and not SVG on purpose: the Python generator validates a
 * fetched scene with Pillow, which cannot open an SVG, so an SVG
 * starter would be choosable and then fail at the one moment it
 * mattered.
 *
 * Run:  node test-scripts/generate_library_starters.js
 * Out:  frontend/img/library/<slug>-<n>.png
 */

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

const OUT = path.join(__dirname, '..', '..', 'frontend', 'img', 'library');
const W = 1200;
const H = 900;

// ── small helpers ───────────────────────────────────────────────────

const rnd = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2545f491) + 0x9e3779b9) >>> 0;
    return s / 0xffffffff;
  };
};

/**
 * Blend two colours.
 *
 * It returns HEX, and reads hex, because its own result is routinely
 * passed back into it (`mix(mix(a, b, .6), '#000', .1)`). Returning
 * `rgb(...)` meant the second call sliced "gb" out of it, parsed NaN,
 * and handed canvas an invalid fillStyle -- which canvas silently
 * IGNORES, keeping whatever colour was set before. That is how the
 * vanity came out painted in the previous fill's translucent shadow
 * and the tiled wall showed straight through it.
 */
function mix(a, b, t) {
  const hex = (v) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(v).trim());
    if (!m) throw new Error(`mix() needs #rrggbb, got ${v}`);
    return m[1];
  };
  const pa = hex(a); const pb = hex(b);
  const out = [0, 2, 4].map((i) => {
    const va = parseInt(pa.slice(i, i + 2), 16);
    const vb = parseInt(pb.slice(i, i + 2), 16);
    return Math.round(va + (vb - va) * t).toString(16).padStart(2, '0');
  });
  return `#${out.join('')}`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** An eight-point zellige star. */
function star(ctx, cx, cy, r, fill) {
  ctx.beginPath();
  for (let i = 0; i < 16; i += 1) {
    const a = (Math.PI / 8) * i - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.44;
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

// ── the wall patterns, one per theme ────────────────────────────────
//
// Each draws INTO a clipped band, so the same routine serves a dado, a
// feature panel and a floor without knowing which it is.

const PATTERNS = {
  moroccan(ctx, x, y, w, h, c, seed) {
    const r = rnd(seed);
    ctx.fillStyle = c.ground; ctx.fillRect(x, y, w, h);
    const step = 44;
    for (let gy = y - step; gy < y + h + step; gy += step) {
      for (let gx = x - step; gx < x + w + step; gx += step) {
        const odd = Math.round((gx - x) / step + (gy - y) / step) % 2 === 0;
        star(ctx, gx + step / 2, gy + step / 2, step * 0.44,
          odd ? c.deep : (r() > 0.6 ? c.accent : c.light));
      }
    }
    ctx.globalAlpha = 0.3; ctx.strokeStyle = c.light; ctx.lineWidth = 2;
    for (let gy = y; gy < y + h; gy += step) { ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x + w, gy); ctx.stroke(); }
    ctx.globalAlpha = 1;
  },

  british(ctx, x, y, w, h, c) {
    ctx.fillStyle = c.deep; ctx.fillRect(x, y, w, h);
    const bay = 74;
    for (let bx = x; bx < x + w; bx += bay) {
      ctx.fillStyle = mix(c.deep, '#000000', 0.16);
      ctx.fillRect(bx + 14, y + 16, bay - 36, h - 34);
      ctx.fillStyle = mix(c.deep, '#ffffff', 0.09);
      ctx.fillRect(bx + 20, y + 22, bay - 48, h - 46);
      ctx.fillStyle = c.deep;
      ctx.fillRect(bx + 30, y + 32, bay - 68, h - 66);
    }
    ctx.fillStyle = c.accent; ctx.fillRect(x, y, w, 7);
    ctx.fillStyle = mix(c.accent, '#000000', 0.3); ctx.fillRect(x, y + 7, w, 3);
  },

  roman_touch(ctx, x, y, w, h, c, seed) {
    const r = rnd(seed);
    ctx.fillStyle = c.ground; ctx.fillRect(x, y, w, h);
    const bw = 108; const bh = 58;
    for (let gy = y, row = 0; gy < y + h; gy += bh, row += 1) {
      const off = row % 2 ? -bw / 2 : 0;
      for (let gx = x + off; gx < x + w; gx += bw) {
        ctx.fillStyle = mix(c.ground, r() > 0.5 ? c.light : c.deep, 0.1 + r() * 0.16);
        ctx.fillRect(gx + 3, gy + 3, bw - 6, bh - 6);
        ctx.globalAlpha = 0.16; ctx.strokeStyle = c.deep; ctx.lineWidth = 1.6;
        for (let v = 0; v < 4; v += 1) {
          const vy = gy + 14 + v * 24 + r() * 8;
          ctx.beginPath(); ctx.moveTo(gx + 8, vy);
          ctx.bezierCurveTo(gx + bw * 0.35, vy - 7, gx + bw * 0.6, vy + 7, gx + bw - 8, vy);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }
  },

  floral(ctx, x, y, w, h, c, seed) {
    const r = rnd(seed);
    ctx.fillStyle = c.ground; ctx.fillRect(x, y, w, h);
    const step = 62;
    for (let gy = y - step; gy < y + h + step; gy += step) {
      for (let gx = x - step; gx < x + w + step; gx += step) {
        const cx = gx + step / 2 + (r() - 0.5) * 10;
        const cy = gy + step / 2 + (r() - 0.5) * 10;
        ctx.fillStyle = c.accent;
        for (let p = 0; p < 6; p += 1) {
          const a = (Math.PI / 3) * p;
          ctx.beginPath();
          ctx.ellipse(cx + Math.cos(a) * 20, cy + Math.sin(a) * 20, 15, 8, a, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = c.deep;
        ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.fill();
      }
    }
  },

  tropical(ctx, x, y, w, h, c, seed) {
    const r = rnd(seed);
    ctx.fillStyle = c.ground; ctx.fillRect(x, y, w, h);
    for (let i = 0; i < 44; i += 1) {
      const cx = x + r() * w; const cy = y + r() * h;
      const len = 44 + r() * 54; const a = -Math.PI / 2 + (r() - 0.5) * 1.5;
      ctx.strokeStyle = i % 3 === 0 ? c.accent : c.deep;
      ctx.lineWidth = 4; ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len); ctx.stroke();
      ctx.lineWidth = 3;
      for (let f = 0.15; f < 1; f += 0.13) {
        const px = cx + Math.cos(a) * len * f; const py = cy + Math.sin(a) * len * f;
        const fl = (1 - f) * 42;
        for (const s of [-1, 1]) {
          ctx.beginPath(); ctx.moveTo(px, py);
          ctx.lineTo(px + Math.cos(a + s * 1.0) * fl, py + Math.sin(a + s * 1.0) * fl);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }
  },

  geometrical(ctx, x, y, w, h, c) {
    ctx.fillStyle = c.ground; ctx.fillRect(x, y, w, h);
    const s = 42;
    for (let gy = y, row = 0; gy < y + h; gy += s, row += 1) {
      for (let gx = x, col = 0; gx < x + w; gx += s, col += 1) {
        const k = (row + col) % 4;
        ctx.fillStyle = k === 0 ? c.deep : k === 1 ? c.accent : k === 2 ? c.light : c.ground;
        ctx.beginPath();
        if (k % 2 === 0) { ctx.moveTo(gx, gy); ctx.lineTo(gx + s, gy); ctx.lineTo(gx, gy + s); }
        else { ctx.moveTo(gx + s, gy); ctx.lineTo(gx + s, gy + s); ctx.lineTo(gx, gy + s); }
        ctx.closePath(); ctx.fill();
      }
    }
  },

  metallic(ctx, x, y, w, h, c, seed) {
    const r = rnd(seed);
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, c.light); g.addColorStop(0.42, c.ground);
    g.addColorStop(0.58, c.accent); g.addColorStop(1, c.deep);
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 0.16;
    for (let i = 0; i < 260; i += 1) {
      ctx.strokeStyle = r() > 0.5 ? '#ffffff' : '#000000';
      ctx.lineWidth = 1;
      const lx = x + r() * w;
      ctx.beginPath(); ctx.moveTo(lx, y); ctx.lineTo(lx, y + h); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.accent;
    for (let gx = x; gx < x + w; gx += 84) ctx.fillRect(gx, y, 3, h);
  },

  rustic(ctx, x, y, w, h, c, seed) {
    const r = rnd(seed);
    ctx.fillStyle = c.ground; ctx.fillRect(x, y, w, h);
    const bw = 84; const bh = 40;
    for (let gy = y, row = 0; gy < y + h; gy += bh, row += 1) {
      const off = row % 2 ? -bw / 2 : 0;
      for (let gx = x + off; gx < x + w; gx += bw) {
        ctx.fillStyle = mix(c.ground, r() > 0.5 ? c.deep : c.accent, 0.12 + r() * 0.3);
        ctx.beginPath();
        ctx.moveTo(gx + 4 + r() * 3, gy + 4 + r() * 3);
        ctx.lineTo(gx + bw - 4 - r() * 3, gy + 3 + r() * 4);
        ctx.lineTo(gx + bw - 3 - r() * 4, gy + bh - 4 - r() * 3);
        ctx.lineTo(gx + 5 + r() * 3, gy + bh - 3 - r() * 4);
        ctx.closePath(); ctx.fill();
      }
    }
    ctx.globalAlpha = 0.1;
    for (let i = 0; i < 900; i += 1) {
      ctx.fillStyle = r() > 0.5 ? '#000' : '#fff';
      ctx.fillRect(x + r() * w, y + r() * h, 2, 2);
    }
    ctx.globalAlpha = 1;
  },

  black_white(ctx, x, y, w, h, c) {
    ctx.fillStyle = c.light; ctx.fillRect(x, y, w, h);
    const s = 34;
    for (let gy = y, row = 0; gy < y + h; gy += s, row += 1) {
      for (let gx = x, col = 0; gx < x + w; gx += s, col += 1) {
        if ((row + col) % 2 === 0) continue;
        ctx.fillStyle = (row + col) % 4 === 1 ? c.deep : c.accent;
        ctx.fillRect(gx, gy, s, s);
      }
    }
  },
};

// ── each theme's colours, taken from its stated palette ─────────────

const THEME_COLOURS = {
  british: { ground: '#EFE8D8', light: '#F6F1E4', deep: '#2F4A3C', accent: '#7A2E2E', metal: '#B08D4E' },
  roman_touch: { ground: '#E7D9BE', light: '#F4EBD8', deep: '#B2876A', accent: '#C9B189', metal: '#A8906A' },
  floral: { ground: '#F4E7E6', light: '#FBF4F2', deep: '#8BA188', accent: '#D9A6AC', metal: '#C1A98C' },
  tropical: { ground: '#E8E0CC', light: '#F5EFDF', deep: '#2E6B52', accent: '#1F7D7D', metal: '#B08A5A' },
  geometrical: { ground: '#F0EAE0', light: '#FAF6EE', deep: '#3A3A3C', accent: '#B4653C', metal: '#8C8C8E' },
  metallic: { ground: '#D8D4CE', light: '#F2EEE7', deep: '#4A4C50', accent: '#C9AE7A', metal: '#C9AE7A' },
  rustic: { ground: '#DCC6AA', light: '#EFE1CB', deep: '#9C5E3C', accent: '#C08A4A', metal: '#8A6A3B' },
  moroccan: { ground: '#EFE4CD', light: '#F7EFDC', deep: '#2B5FA8', accent: '#D9A52E', metal: '#B08D4E' },
  black_white: { ground: '#EDEAE4', light: '#F8F6F2', deep: '#1C1C1C', accent: '#6E6E6E', metal: '#9A9A9A' },
};

// ── the room ────────────────────────────────────────────────────────
//
// ONE-POINT PERSPECTIVE, because a flat elevation does not read as a
// room -- it reads as a swatch with a tap drawn on it, which is what
// the first attempt at these looked like.
//
// So the box is real: a back wall, two side walls, a floor and a
// ceiling, all converging on one vanishing point. Everything else --
// where the dado sits, how the floor tiles foreshorten, where the
// vanity stands -- is derived from that one projection, so the parts
// agree with each other instead of being placed by eye.

// A SHALLOW room, not a corridor. At 2.15 the back wall shrank to a
// postage stamp in the middle of a bland tunnel -- all the theme was on
// that wall, and the picture was mostly ceiling and side wall. At 0.85
// the back wall holds about two thirds of the frame, which is what a
// bathroom actually looks like through a camera.
const DEPTH = 0.85;
const FORESHORTEN = 1.25;    // the perspective constant; lower = wider lens

/** The y of a floor line at depth n, given the front edge y0. */
function depthY(y0, vpy, n) {
  return vpy + (y0 - vpy) * (FORESHORTEN / (FORESHORTEN + n));
}

/** The x of a vertical at frame-x x0, at depth n. */
function depthX(x0, vpx, n) {
  return vpx + (x0 - vpx) * (FORESHORTEN / (FORESHORTEN + n));
}

function drawRoom(themeId, room, variant) {
  const c = THEME_COLOURS[themeId];
  const pattern = PATTERNS[themeId];
  const seed = (themeId.length * 7919 + room.length * 31337 + variant * 104729) >>> 0;

  // A BALCONY IS NOT A BOX. It has no ceiling and no walls to speak of:
  // a parapet about chest high, the sky above it, and an outdoor floor.
  // Drawing one with the interior's ceiling and full-height side walls
  // would produce a room with a wall in the middle of it.
  const outdoor = room === 'balcony_patio';
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // The eye line. Slightly above centre, as a standing person's is.
  const vpx = W * 0.5;
  const vpy = H * 0.455;

  // The back wall, as a rectangle on the picture plane.
  const bx0 = depthX(0, vpx, DEPTH);
  const bx1 = depthX(W, vpx, DEPTH);
  const by1 = depthY(H, vpy, DEPTH);          // its foot
  const by0 = depthY(0, vpy, DEPTH);          // its head

  // ── overhead: a ceiling indoors, open sky out ──
  if (outdoor) {
    const sky = ctx.createLinearGradient(0, 0, 0, H * 0.55);
    sky.addColorStop(0, '#A8C4D8');
    sky.addColorStop(0.65, '#D6E3EA');
    sky.addColorStop(1, mix(c.light, '#ffffff', 0.7));
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = mix(c.light, '#ffffff', 0.55);
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(W, 0); ctx.lineTo(bx1, by0); ctx.lineTo(bx0, by0);
    ctx.closePath(); ctx.fill();
  }

  // ── side walls, plain: the back wall is where the theme speaks ──
  //
  // Outdoors these are the building's own returns, and they stop at the
  // parapet rather than running to the top of the frame -- otherwise
  // the sky is boxed in and it stops reading as open.
  for (const side of [0, 1]) {
    const fx = side ? W : 0;
    const bxs = side ? bx1 : bx0;
    const topFront = outdoor ? H * 0.16 : 0;
    const topBack = outdoor ? by0 + (by1 - by0) * 0.34 : by0;
    const g = ctx.createLinearGradient(fx, 0, bxs, 0);
    // The left wall catches the light, the right falls away. That one
    // difference does more for depth than any amount of detail.
    g.addColorStop(0, mix(c.ground, side ? '#000000' : '#ffffff', side ? 0.14 : 0.26));
    g.addColorStop(1, mix(c.ground, '#000000', side ? 0.05 : 0.02));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(fx, topFront); ctx.lineTo(bxs, topBack); ctx.lineTo(bxs, by1); ctx.lineTo(fx, H);
    ctx.closePath(); ctx.fill();
  }

  // ── floor, tiled in perspective ──
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, H); ctx.lineTo(bx0, by1); ctx.lineTo(bx1, by1); ctx.lineTo(W, H);
  ctx.closePath(); ctx.clip();

  ctx.fillStyle = mix(c.ground, '#000000', 0.16);
  ctx.fillRect(0, 0, W, H);

  // Rows: each one's depth steps evenly, so the SPACING foreshortens
  // on its own rather than being faked with a multiplier.
  const rows = 13;
  for (let n = 0; n < rows; n += 1) {
    const yA = depthY(H, vpy, (n / rows) * DEPTH);
    const yB = depthY(H, vpy, ((n + 1) / rows) * DEPTH);
    ctx.fillStyle = mix(c.ground, n % 2 ? c.deep : c.light, 0.08 + (n % 3) * 0.03);
    ctx.fillRect(0, yB, W, yA - yB);
  }
  // Grout, converging on the vanishing point.
  ctx.strokeStyle = mix(c.ground, '#000000', 0.26);
  ctx.lineWidth = 1.6;
  // FROM the vanishing point, not from near it. Starting these a few
  // pixels off the vp is what made the floor look subtly wrong: the
  // lines ran almost-parallel instead of converging.
  for (let i = -7; i <= 7; i += 1) {
    ctx.beginPath();
    ctx.moveTo(vpx, vpy);
    ctx.lineTo(vpx + i * (W / 5.5), H);
    ctx.stroke();
  }
  for (let n = 0; n <= rows; n += 1) {
    const y = depthY(H, vpy, (n / rows) * DEPTH);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  ctx.restore();

  // ── the back plane: a wall indoors, a parapet out ──
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  const dadoY = by0 + bh * 0.46;

  // THE PARAPET IS WHERE THE THEME SPEAKS OUTDOORS, and it is chest
  // high: it starts where a dado would END, so the pattern fills it
  // completely rather than sitting in a band with sky behind the rest.
  const planeTop = outdoor ? by0 + bh * 0.46 : by0;

  if (outdoor) {
    ctx.fillStyle = mix(c.light, '#ffffff', 0.3);
    ctx.fillRect(bx0, planeTop, bw, by1 - planeTop);

    ctx.save();
    ctx.beginPath(); ctx.rect(bx0, planeTop, bw, by1 - planeTop); ctx.clip();
    pattern(ctx, bx0, planeTop, bw, by1 - planeTop, c, seed);
    ctx.restore();

    // A coping stone along the top, which every real parapet has and
    // which is what stops it reading as a half-painted wall.
    ctx.fillStyle = mix(c.light, '#ffffff', 0.55);
    ctx.fillRect(bx0 - 6, planeTop - 11, bw + 12, 11);
    ctx.fillStyle = mix(c.light, '#000000', 0.18);
    ctx.fillRect(bx0 - 6, planeTop, bw + 12, 4);

    // A railing above it, against the sky.
    ctx.strokeStyle = c.metal; ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(bx0 + 6, planeTop - 74); ctx.lineTo(bx1 - 6, planeTop - 74);
    ctx.stroke();
    ctx.lineWidth = 3;
    for (let i = 0; i <= 14; i += 1) {
      const rx = bx0 + 6 + (bw - 12) * (i / 14);
      ctx.beginPath(); ctx.moveTo(rx, planeTop - 74); ctx.lineTo(rx, planeTop - 11); ctx.stroke();
    }

    ctx.fillStyle = mix(c.deep, '#000000', 0.25);
    ctx.fillRect(bx0, by1 - 9, bw, 9);
  } else {

  ctx.fillStyle = mix(c.light, '#ffffff', 0.3);
  ctx.fillRect(bx0, by0, bw, bh);

  ctx.save();
  if (variant === 0) {
    // A dado: the pattern below, plain above. The commonest lay-up.
    ctx.beginPath(); ctx.rect(bx0, dadoY, bw, by1 - dadoY); ctx.clip();
    pattern(ctx, bx0, dadoY, bw, by1 - dadoY, c, seed);
    ctx.restore();
    ctx.fillStyle = c.metal; ctx.fillRect(bx0, dadoY - 5, bw, 5);
  } else {
    // A feature bay behind the vanity, plain either side.
    const fx = bx0 + bw * 0.27; const fw = bw * 0.46;
    ctx.beginPath(); ctx.rect(fx, by0, fw, bh); ctx.clip();
    pattern(ctx, fx, by0, fw, bh, c, seed);
    ctx.restore();
    ctx.fillStyle = c.metal;
    ctx.fillRect(fx - 4, by0, 4, bh); ctx.fillRect(fx + fw, by0, 4, bh);
  }

  // Skirting, and the corner lines that tell the eye where the walls meet.
  ctx.fillStyle = mix(c.deep, '#000000', 0.25);
  ctx.fillRect(bx0, by1 - 9, bw, 9);
  }

  // The corners, from wherever the back plane actually starts -- the
  // ceiling line indoors, the top of the parapet out.
  ctx.strokeStyle = 'rgba(26,21,18,0.22)'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(bx0, planeTop); ctx.lineTo(bx0, by1);
  ctx.moveTo(bx1, planeTop); ctx.lineTo(bx1, by1);
  if (!outdoor) { ctx.moveTo(bx0, by0); ctx.lineTo(bx1, by0); }
  ctx.stroke();

  // ── the fittings, which are what makes it THAT room ──
  //
  // The box, the tiling and the light are the same for every room; only
  // what stands in front of the back wall changes. That is deliberate:
  // these are references for SURFACES, and a kitchen whose cabinets are
  // drawn in loving detail invites the generator to copy the cabinets
  // instead of the tiles.
  //
  // Silhouettes only, in a quiet joinery tone, with the theme showing in
  // the metal. Every one stands ON the floor with a contact shadow --
  // the first attempt floated a white pill in mid-air, which is most of
  // why it did not read as a room at all.
  const joinery = mix(c.deep, c.ground, 0.62);
  const unit = mix(joinery, '#000000', 0.1);
  const unitLight = mix(joinery, '#ffffff', 0.07);

  const ground = (cx, halfWidth) => {
    ctx.fillStyle = 'rgba(20,14,8,0.28)';
    ctx.beginPath();
    ctx.ellipse(cx, by1 + 6, halfWidth, 14, 0, 0, Math.PI * 2);
    ctx.fill();
  };

  const mirror = (cx, w, h, y, round) => {
    ctx.fillStyle = 'rgba(20,14,8,0.18)';
    roundRect(ctx, cx - w / 2 + 8, y + 10, w, h, round); ctx.fill();
    const glass = ctx.createLinearGradient(cx - w / 2, y, cx + w / 2, y + h);
    glass.addColorStop(0, mix(c.light, '#ffffff', 0.75));
    glass.addColorStop(1, mix(c.ground, '#ffffff', 0.45));
    ctx.fillStyle = glass;
    roundRect(ctx, cx - w / 2, y, w, h, round); ctx.fill();
    ctx.strokeStyle = c.metal; ctx.lineWidth = 6;
    roundRect(ctx, cx - w / 2, y, w, h, round); ctx.stroke();
  };

  const vanity = (widthShare) => {
    const vw = bw * widthShare;
    const vx = vpx - vw / 2;
    const vTop = by1 - bh * 0.30;

    ground(vpx, vw * 0.62);
    ctx.fillStyle = unit; ctx.fillRect(vx, vTop, vw, by1 - vTop);
    ctx.fillStyle = unitLight;
    ctx.fillRect(vx + 8, vTop + 10, vw / 2 - 12, by1 - vTop - 20);
    ctx.fillRect(vx + vw / 2 + 4, vTop + 10, vw / 2 - 12, by1 - vTop - 20);
    ctx.fillStyle = c.metal;
    ctx.fillRect(vx + vw / 2 - 26, vTop + (by1 - vTop) / 2 - 2, 20, 4);
    ctx.fillRect(vx + vw / 2 + 8, vTop + (by1 - vTop) / 2 - 2, 20, 4);

    // The counter's front edge: the one bit of thickness that stops it
    // reading as a sticker.
    ctx.fillStyle = '#FAF7F1'; ctx.fillRect(vx - 7, vTop - 12, vw + 14, 12);
    ctx.fillStyle = mix('#FAF7F1', '#000000', 0.16);
    ctx.fillRect(vx - 7, vTop, vw + 14, 5);

    ctx.fillStyle = '#FFFDF8';
    roundRect(ctx, vpx - vw * 0.27, vTop - 40, vw * 0.54, 32, 11); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    roundRect(ctx, vpx - vw * 0.23, vTop - 34, vw * 0.46, 18, 8); ctx.fill();

    ctx.strokeStyle = c.metal; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(vpx, vTop - 96); ctx.lineTo(vpx, vTop - 46);
    ctx.moveTo(vpx, vTop - 92); ctx.lineTo(vpx + 28, vTop - 92);
    ctx.stroke();
  };

  if (room === 'bathroom') {
    vanity(0.44);
    mirror(vpx, bw * 0.30, bh * 0.34, by0 + bh * 0.12, bw * 0.15);

  } else if (room === 'powder_room') {
    // The same room, smaller: a compact vanity and a round mirror, no
    // shower -- which is exactly how the generator describes it too.
    vanity(0.30);
    mirror(vpx, bw * 0.19, bh * 0.26, by0 + bh * 0.14, bw * 0.095);

  } else if (room === 'kitchen') {
    // A run of counter, cabinets above, and the splashback between them
    // -- the splashback IS the tiled surface, so the cabinets stop
    // short of the trim rather than covering it.
    const runW = bw * 0.78;
    const rx = vpx - runW / 2;
    const base = by1 - bh * 0.30;

    ground(vpx, runW * 0.56);
    ctx.fillStyle = unit; ctx.fillRect(rx, base, runW, by1 - base);
    ctx.fillStyle = unitLight;
    for (let i = 0; i < 4; i += 1) {
      ctx.fillRect(rx + 8 + i * (runW / 4), base + 10, runW / 4 - 14, by1 - base - 20);
    }
    ctx.fillStyle = c.metal;
    for (let i = 0; i < 4; i += 1) {
      ctx.fillRect(rx + 22 + i * (runW / 4), base + 26, runW / 4 - 42, 4);
    }

    ctx.fillStyle = '#FAF7F1'; ctx.fillRect(rx - 8, base - 13, runW + 16, 13);
    ctx.fillStyle = mix('#FAF7F1', '#000000', 0.16);
    ctx.fillRect(rx - 8, base, runW + 16, 5);

    // Sink and mixer tap.
    ctx.fillStyle = mix('#FAF7F1', '#000000', 0.3);
    roundRect(ctx, vpx - runW * 0.14, base - 9, runW * 0.28, 7, 3); ctx.fill();
    ctx.strokeStyle = c.metal; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(vpx, base - 84); ctx.lineTo(vpx, base - 16);
    ctx.quadraticCurveTo(vpx, base - 96, vpx + 34, base - 92);
    ctx.stroke();

    // Wall units, hung clear of the splashback.
    const topY = by0 + bh * 0.10;
    const topH = bh * 0.22;
    ctx.fillStyle = unit;
    ctx.fillRect(rx, topY, runW * 0.34, topH);
    ctx.fillRect(vpx + runW * 0.16, topY, runW * 0.34, topH);
    ctx.fillStyle = c.metal;
    ctx.fillRect(rx + 20, topY + topH - 16, runW * 0.34 - 40, 4);
    ctx.fillRect(vpx + runW * 0.16 + 20, topY + topH - 16, runW * 0.34 - 40, 4);

  } else if (room === 'bedroom') {
    // The bed against its feature wall, which is how the generator
    // describes a bedroom -- so the headboard sits ON the tiled plane
    // rather than in front of a blank one.
    const bedW = bw * 0.52;
    const bx = vpx - bedW / 2;
    // Low on purpose. At 0.40 the headboard covered most of the dado,
    // which is the surface this picture is a reference FOR -- the bed
    // is here for scale, not for itself.
    const headTop = by0 + bh * 0.58;
    const mattressTop = by1 - bh * 0.20;

    ground(vpx, bedW * 0.62);

    ctx.fillStyle = unit;
    roundRect(ctx, bx, headTop, bedW, by1 - headTop, 14); ctx.fill();
    ctx.fillStyle = unitLight;
    for (let i = 0; i < 3; i += 1) {
      roundRect(ctx, bx + 14 + i * (bedW / 3), headTop + 14, bedW / 3 - 24, mattressTop - headTop - 30, 9);
      ctx.fill();
    }

    ctx.fillStyle = '#F7F2E8';
    roundRect(ctx, bx - 14, mattressTop, bedW + 28, by1 - mattressTop, 10); ctx.fill();
    ctx.fillStyle = mix('#F7F2E8', c.deep, 0.18);
    ctx.fillRect(bx - 14, mattressTop + (by1 - mattressTop) * 0.55, bedW + 28, (by1 - mattressTop) * 0.45);

    // Pillows.
    ctx.fillStyle = '#FFFDF8';
    roundRect(ctx, vpx - bedW * 0.40, mattressTop - 26, bedW * 0.34, 26, 10); ctx.fill();
    roundRect(ctx, vpx + bedW * 0.06, mattressTop - 26, bedW * 0.34, 26, 10); ctx.fill();

    // Side tables and the pendants over them.
    for (const side of [-1, 1]) {
      const sx = vpx + side * (bedW / 2 + bw * 0.10);
      ctx.fillStyle = unit;
      ctx.fillRect(sx - bw * 0.05, by1 - bh * 0.16, bw * 0.10, bh * 0.16);
      ctx.strokeStyle = c.metal; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(sx, by0 + bh * 0.16); ctx.lineTo(sx, by0 + bh * 0.36); ctx.stroke();
      ctx.fillStyle = c.metal;
      roundRect(ctx, sx - 16, by0 + bh * 0.36, 32, 20, 6); ctx.fill();
    }

  } else if (room === 'balcony_patio') {
    // Outdoor seating and a planter, low and to one side -- the floor
    // and the parapet are the surfaces this is a reference FOR, so
    // nothing stands in the middle of either.
    const px = vpx + bw * 0.26;
    const pw = bw * 0.16;
    const pTop = by1 - bh * 0.22;

    ground(px, pw * 0.7);
    ctx.fillStyle = mix(c.metal, '#000000', 0.12);
    ctx.beginPath();
    ctx.moveTo(px - pw / 2, pTop);
    ctx.lineTo(px + pw / 2, pTop);
    ctx.lineTo(px + pw * 0.38, by1);
    ctx.lineTo(px - pw * 0.38, by1);
    ctx.closePath(); ctx.fill();

    // What grows in it: a few strokes, not a botanical study.
    const leaf = rnd(seed ^ 0x2f1a);
    ctx.strokeStyle = '#4E7A4A'; ctx.lineWidth = 5; ctx.lineCap = 'round';
    for (let i = 0; i < 9; i += 1) {
      const a = -Math.PI / 2 + (leaf() - 0.5) * 1.5;
      const len = 46 + leaf() * 54;
      ctx.beginPath();
      ctx.moveTo(px + (leaf() - 0.5) * pw * 0.6, pTop + 4);
      ctx.lineTo(px + Math.cos(a) * len, pTop + 4 + Math.sin(a) * len);
      ctx.stroke();
    }

    // A chair, in silhouette, on the other side.
    const cx2 = vpx - bw * 0.26;
    const seatY = by1 - bh * 0.15;
    ground(cx2, bw * 0.11);
    ctx.fillStyle = mix(c.deep, c.ground, 0.5);
    roundRect(ctx, cx2 - bw * 0.09, seatY, bw * 0.18, 12, 5); ctx.fill();
    roundRect(ctx, cx2 - bw * 0.09, seatY - bh * 0.16, 12, bh * 0.16, 5); ctx.fill();
    ctx.fillRect(cx2 - bw * 0.075, seatY + 12, 7, by1 - seatY - 12);
    ctx.fillRect(cx2 + bw * 0.065, seatY + 12, 7, by1 - seatY - 12);

  } else {
    // Drawing room: seating facing a media wall, with the tiled plane
    // behind it. Low furniture on purpose -- the wall is the subject.
    const sofaW = bw * 0.56;
    const sx = vpx - sofaW / 2;
    const seatTop = by1 - bh * 0.20;

    // Art, hung on the tiled wall.
    const aw = bw * 0.26; const ah = bh * 0.26;
    const ay = by0 + bh * 0.16;
    ctx.fillStyle = 'rgba(20,14,8,0.16)';
    ctx.fillRect(vpx - aw / 2 + 7, ay + 8, aw, ah);
    ctx.fillStyle = mix(c.light, '#ffffff', 0.6);
    ctx.fillRect(vpx - aw / 2, ay, aw, ah);
    ctx.strokeStyle = c.metal; ctx.lineWidth = 5;
    ctx.strokeRect(vpx - aw / 2, ay, aw, ah);
    ctx.fillStyle = mix(c.deep, c.ground, 0.35);
    ctx.fillRect(vpx - aw / 2 + 18, ay + 18, aw - 36, ah - 36);

    ground(vpx, sofaW * 0.60);

    ctx.fillStyle = unit;
    roundRect(ctx, sx, seatTop, sofaW, by1 - seatTop, 14); ctx.fill();
    ctx.fillStyle = unitLight;
    roundRect(ctx, sx + 12, seatTop + 10, sofaW - 24, (by1 - seatTop) * 0.5, 10); ctx.fill();
    // Cushions.
    ctx.fillStyle = mix(unitLight, '#ffffff', 0.4);
    for (let i = 0; i < 3; i += 1) {
      roundRect(ctx, sx + 22 + i * (sofaW / 3), seatTop - 20, sofaW / 3 - 40, 24, 8); ctx.fill();
    }
    // Low table, in front and therefore lower in frame.
    ctx.fillStyle = mix(c.metal, '#000000', 0.1);
    roundRect(ctx, vpx - bw * 0.14, by1 + bh * 0.10, bw * 0.28, 10, 5); ctx.fill();
    ctx.fillStyle = mix(c.metal, '#000000', 0.3);
    ctx.fillRect(vpx - bw * 0.10, by1 + bh * 0.10 + 10, 6, 26);
    ctx.fillRect(vpx + bw * 0.10 - 6, by1 + bh * 0.10 + 10, 6, 26);
  }

  // ── grading ──
  // Daylight from the left, the right falling into shadow, and a
  // vignette. This is what makes it read as photographed rather than
  // drawn, and it is deliberately gentle: the surfaces are the point.
  const lit = ctx.createLinearGradient(0, 0, W * 0.9, H);
  lit.addColorStop(0, 'rgba(255,248,232,0.34)');
  lit.addColorStop(0.45, 'rgba(255,255,255,0.02)');
  lit.addColorStop(1, 'rgba(22,14,6,0.22)');
  ctx.fillStyle = lit; ctx.fillRect(0, 0, W, H);

  const vig = ctx.createRadialGradient(vpx, vpy, H * 0.22, vpx, vpy, H * 0.95);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(26,21,18,0.40)');
  ctx.fillStyle = vig; ctx.fillRect(0, 0, W, H);

  // A little grain, so the flat fills stop looking like vector art.
  const grain = rnd(seed ^ 0x5bf03635);
  ctx.globalAlpha = 0.05;
  for (let i = 0; i < 5200; i += 1) {
    ctx.fillStyle = grain() > 0.5 ? '#ffffff' : '#000000';
    ctx.fillRect(grain() * W, grain() * H, 2, 2);
  }
  ctx.globalAlpha = 1;

  return canvas;
}

// ── run ─────────────────────────────────────────────────────────────

fs.mkdirSync(OUT, { recursive: true });
const themes = require(path.join(__dirname, '..', '..', 'shared', 'themes.json')).themes;
const rooms = require(path.join(__dirname, '..', '..', 'shared', 'rooms.json')).rooms;

// ONE PER THEME PER ROOM, not two per theme.
//
// The library is a Theme -> Room hierarchy now, so a second variant of
// the same room matters far less than having every room filled at all:
// nine themes times five rooms is forty-five cells, and thirty-six of
// them would otherwise be empty, which is the blank-page complaint
// again one level down.
//
// The dado layout is used throughout. It is the one that reads as a
// tiled room in every room type -- a floor-to-ceiling feature bay
// behind a bed or a sofa looks like a mistake rather than a scheme.
let made = 0;
const skipped = [];

for (const theme of Object.values(themes)) {
  if (!THEME_COLOURS[theme.id]) {
    skipped.push(theme.id);
    continue;
  }

  for (const room of Object.values(rooms)) {
    const file = path.join(OUT, `${theme.slug}-${room.slug}.png`);
    fs.writeFileSync(file, drawRoom(theme.id, room.id, 0).toBuffer('image/png'));
    made += 1;
  }

  const kb = Math.round(
    Object.values(rooms).reduce(
      (n, room) => n + fs.statSync(path.join(OUT, `${theme.slug}-${room.slug}.png`)).size,
      0,
    ) / 1024,
  );
  console.log(`  ${theme.label.padEnd(14)} ${Object.keys(rooms).length} rooms  ${kb}KB`);
}

if (skipped.length) {
  console.log(`\n  no colours defined, so no starters drawn: ${skipped.join(', ')}`);
}

console.log(`\n${made} starter rooms written to frontend/img/library/`);
