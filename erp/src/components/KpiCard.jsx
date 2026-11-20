import { Link } from 'react-router-dom';

/* ============================================================
   ONE HEADLINE FIGURE
   ============================================================
   Every KPI says three things: what it is, what it is now, and
   what to do about it. A number with no route to the rows behind
   it is a number nobody can act on, so `to` is the normal case
   and a card without one is the exception.
   ============================================================ */

export default function KpiCard({ label, value, unit, note, tone, to, delta }) {
  const body = (
    <>
      <p className="kpi-label">{label}</p>
      <p className={'kpi-value' + (tone ? ' is-' + tone : '')}>
        <span className="num">{value}</span>
        {unit && <small>{unit}</small>}
      </p>
      {(note || delta) && (
        <p className="kpi-note">
          {delta && (
            <span className={'kpi-delta is-' + (delta.dir === 'up' ? 'up' : 'down')}>
              {delta.dir === 'up' ? '▲' : '▼'} {delta.text}
            </span>
          )}
          {note}
        </p>
      )}
    </>
  );

  if (!to) return <div className="kpi">{body}</div>;
  return <Link className="kpi is-link" to={to}>{body}</Link>;
}
