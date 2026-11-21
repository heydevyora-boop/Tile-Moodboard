/* ============================================================
   WHAT A SCREEN SHOWS WHILE IT IS WAITING, OR WHEN IT FAILED
   ============================================================
   Shared so that every connected screen fails the same way, and
   so that "the API is not running" is a sentence with the fix in
   it rather than a red box.
   ============================================================ */

export function Loading({ what = 'Loading' }) {
  return (
    <div className="panel">
      <div className="empty">
        <h3>{what}…</h3>
        <p>Reading from the ERP database.</p>
      </div>
    </div>
  );
}

export function Failed({ error, onRetry }) {
  const unreachable = error?.code === 'API_UNREACHABLE';
  return (
    <div className="panel">
      <div className="empty">
        <h3>{unreachable ? 'The ERP API is not running' : 'That did not work'}</h3>
        <p>{error?.message}</p>
        {unreachable && (
          <p className="tiny muted" style={{ marginTop: 10 }}>
            In a second terminal: <code>cd erp &amp;&amp; npm run api</code>
          </p>
        )}
        {onRetry && (
          <button className="btn" style={{ marginTop: 14 }} onClick={onRetry}>Try again</button>
        )}
      </div>
    </div>
  );
}

/** Field-level errors from the server, under the form that caused them. */
export function FieldErrors({ error }) {
  if (!error) return null;

  if (error.candidates) {
    return (
      <div className="notice notice-warn">
        <span aria-hidden="true">●</span>
        <div>
          <strong>{error.message}</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {error.candidates.map((c) => (
              <li key={c.id}>
                {c.name}
                {c.variantCount !== undefined && <> — {c.variantCount} variant(s)</>}
                {c.sku && <> — {c.sku}</>}
                {c.score !== undefined && <span className="muted"> ({Math.round(c.score * 100)}% alike)</span>}
              </li>
            ))}
          </ul>
          <p style={{ margin: '8px 0 0' }} className="tiny">
            If this really is a different product, save again and it will be created.
          </p>
        </div>
      </div>
    );
  }

  if (error.fields?.length) {
    return (
      <div className="notice notice-danger">
        <span aria-hidden="true">●</span>
        <div>
          <strong>{error.message}</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {error.fields.map((f) => <li key={f.field}><code>{f.field}</code> — {f.message}</li>)}
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="notice notice-danger">
      <span aria-hidden="true">●</span>
      <div>{error.message}</div>
    </div>
  );
}
