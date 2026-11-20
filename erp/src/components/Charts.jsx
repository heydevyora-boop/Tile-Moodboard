/* ============================================================
   CHARTS, DRAWN BY HAND
   ============================================================
   Three shapes, in plain SVG: a trend line, a bar comparison and a
   share-of-total donut. A charting library would add a few hundred
   kilobytes and its own visual language to a prototype that needs
   three charts and has a palette of its own.

   Rules kept throughout:
     - colour is never the only carrier; every series is labelled;
     - axes start at zero, so a bar's length means what it looks
       like it means;
     - each chart is readable at a phone's width.
   ============================================================ */

const GOLD = '#8A6A3B';
const GOLD_SOFT = 'rgba(138, 106, 59, 0.14)';
const LINE = '#E7DFD1';
const MUTED = '#8B8177';

const money = (n) => '₹' + Math.round(n).toLocaleString('en-IN');

/* ── trend line ──────────────────────────────────────────────── */

export function LineChart({ series, height = 190, format = money, label = 'Value' }) {
  const w = 560;
  const h = height;
  const pad = { t: 14, r: 14, b: 26, l: 54 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;

  if (!series.length) return <p className="muted tiny">No data for this period.</p>;

  // The scale starts at zero. A line chart cropped to its own range
  // can turn a 3% wobble into a cliff, which is the most common way
  // a dashboard misleads the person reading it.
  const max = Math.max(...series.map((d) => d.value), 1);
  const x = (i) => pad.l + (series.length === 1 ? iw / 2 : (i / (series.length - 1)) * iw);
  const y = (v) => pad.t + ih - (v / max) * ih;

  const path = series.map((d, i) => (i ? 'L' : 'M') + x(i) + ' ' + y(d.value)).join(' ');
  const area = path + ' L' + x(series.length - 1) + ' ' + (pad.t + ih) + ' L' + x(0) + ' ' + (pad.t + ih) + ' Z';
  const ticks = [0, 0.5, 1].map((f) => f * max);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="chart" role="img" aria-label={label + ' over time'}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke={LINE} strokeWidth="1" />
          <text x={pad.l - 8} y={y(t) + 3.5} textAnchor="end" fontSize="9.5" fill={MUTED}>
            {format(t)}
          </text>
        </g>
      ))}

      <path d={area} fill={GOLD_SOFT} />
      <path d={path} fill="none" stroke={GOLD} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

      {series.map((d, i) => (
        <circle key={d.label} cx={x(i)} cy={y(d.value)} r="2.6" fill={GOLD}>
          <title>{d.label + ': ' + format(d.value)}</title>
        </circle>
      ))}

      {/* Every label would collide at this width; one in three reads. */}
      {series.map((d, i) => (i % Math.ceil(series.length / 6) === 0 ? (
        <text key={d.label} x={x(i)} y={h - 8} textAnchor="middle" fontSize="9.5" fill={MUTED}>
          {d.label}
        </text>
      ) : null))}
    </svg>
  );
}

/* ── bars ────────────────────────────────────────────────────── */

export function BarChart({ series, height = 200, format = (n) => String(n), label = 'Comparison' }) {
  const w = 560;
  const h = height;
  const pad = { t: 12, r: 14, b: 44, l: 54 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;

  if (!series.length) return <p className="muted tiny">No data for this period.</p>;

  const max = Math.max(...series.map((d) => d.value), 1);
  const band = iw / series.length;
  const bw = Math.min(42, band * 0.6);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="chart" role="img" aria-label={label}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={pad.l} x2={w - pad.r} y1={pad.t + ih - f * ih} y2={pad.t + ih - f * ih} stroke={LINE} />
          <text x={pad.l - 8} y={pad.t + ih - f * ih + 3.5} textAnchor="end" fontSize="9.5" fill={MUTED}>
            {format(f * max)}
          </text>
        </g>
      ))}

      {series.map((d, i) => {
        const bh = (d.value / max) * ih;
        const bx = pad.l + i * band + (band - bw) / 2;
        return (
          <g key={d.label}>
            <rect
              x={bx} y={pad.t + ih - bh} width={bw} height={Math.max(bh, 1)}
              rx="3" fill={d.tone || GOLD} opacity={d.dim ? 0.42 : 1}
            >
              <title>{d.label + ': ' + format(d.value)}</title>
            </rect>
            <text
              x={bx + bw / 2} y={h - 26} textAnchor="middle" fontSize="9.5" fill={MUTED}
            >
              {d.label.length > 11 ? d.label.slice(0, 10) + '…' : d.label}
            </text>
            <text x={bx + bw / 2} y={h - 13} textAnchor="middle" fontSize="9" fill={MUTED} opacity="0.8">
              {format(d.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ── share of total ──────────────────────────────────────────── */

export function DonutChart({ slices, total, centreLabel, format = (n) => String(n) }) {
  const size = 168;
  const r = 66;
  const stroke = 22;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  const sum = total ?? slices.reduce((s, x) => s + x.value, 0);

  let offset = 0;

  return (
    <div className="donut-wrap">
      <svg viewBox={`0 0 ${size} ${size}`} className="donut" role="img" aria-label={centreLabel}>
        <circle cx={c} cy={c} r={r} fill="none" stroke={LINE} strokeWidth={stroke} />
        {slices.map((s) => {
          const frac = sum > 0 ? s.value / sum : 0;
          const dash = frac * circumference;
          const el = (
            <circle
              key={s.label}
              cx={c} cy={c} r={r}
              fill="none"
              stroke={s.tone}
              strokeWidth={stroke}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${c} ${c})`}
            >
              <title>{s.label + ': ' + format(s.value)}</title>
            </circle>
          );
          offset += dash;
          return el;
        })}
        <text x={c} y={c - 2} textAnchor="middle" fontSize="20" fontFamily="'Playfair Display', serif" fill="#1A1512">
          {format(sum)}
        </text>
        <text x={c} y={c + 14} textAnchor="middle" fontSize="9" fill={MUTED}>
          {centreLabel}
        </text>
      </svg>

      {/* The legend carries the numbers, so the chart never depends
          on a hover that a touchscreen cannot do. */}
      <ul className="donut-legend">
        {slices.map((s) => (
          <li key={s.label}>
            <span className="swatch" style={{ background: s.tone, borderColor: s.tone }} />
            {s.label}
            <strong className="num">{format(s.value)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}
