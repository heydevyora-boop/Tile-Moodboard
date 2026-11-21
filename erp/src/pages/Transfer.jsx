import { useRef, useState } from 'react';
import StatusPill from '../components/StatusPill.jsx';
import Modal from '../components/Modal.jsx';
import { Failed, FieldErrors } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { qty, stamp } from '../lib/format.js';

/* ============================================================
   IMPORT MANAGEMENT — CONNECTED
   ============================================================
   Upload the catalogue sheet, see exactly what would happen,
   then decide. Nothing is written to the Product Master until
   the preview has been confirmed.

   Nothing on this screen is mocked. Where something is not
   available — the live Google Sheets connection — it says so and
   offers no button.
   ============================================================ */

const BATCH_TONE = {
  CREATED: 'info', READING: 'info', VALIDATING: 'info', PREVIEW_READY: 'warn',
  IMPORTING: 'warn', COMPLETED: 'ok', COMPLETED_WITH_ERRORS: 'warn',
  FAILED: 'danger', CANCELLED: 'inert',
};

const ROW_TONE = {
  PENDING: 'info', VALID: 'ok', IMPORTED: 'ok',
  SKIPPED_DUPLICATE: 'inert', SKIPPED_EXISTING: 'inert',
  INCOMPLETE: 'warn', REVIEW_REQUIRED: 'warn',
  REJECTED: 'danger', FAILED: 'danger',
};

const ROW_LABEL = {
  PENDING: 'Pending', VALID: 'Will import', IMPORTED: 'Imported',
  SKIPPED_DUPLICATE: 'Duplicate', SKIPPED_EXISTING: 'Already here',
  INCOMPLETE: 'Incomplete', REVIEW_REQUIRED: 'Needs review',
  REJECTED: 'Rejected', FAILED: 'Failed',
};

const RECONCILIATION_TONE = { PASSED: 'ok', FAILED: 'danger', UNVERIFIED: 'warn', NOT_RUN: 'info' };

export default function Transfer() {
  const [tab, setTab] = useState('import');
  const [openBatchId, setOpenBatchId] = useState(null);

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            Loading the catalogue pipeline&rsquo;s output into the ERP. The
            spreadsheet is an interim source, not a second Product Master:
            everything comes in one way, once, and the ERP keeps the record.
          </p>
        </div>
      </div>

      <div className="viewbar">
        <button className={'viewtab' + (tab === 'import' ? ' is-on' : '')} onClick={() => setTab('import')}>
          New import
        </button>
        <button className={'viewtab' + (tab === 'history' ? ' is-on' : '')} onClick={() => setTab('history')}>
          Import history
        </button>
        <button className={'viewtab' + (tab === 'export' ? ' is-on' : '')} onClick={() => setTab('export')}>
          Export
        </button>
      </div>

      {tab === 'import' && <NewImport onOpenBatch={setOpenBatchId} />}
      {tab === 'history' && <History onOpenBatch={setOpenBatchId} />}
      {tab === 'export' && <ExportNotBuilt />}

      {openBatchId && <BatchDetail id={openBatchId} onClose={() => setOpenBatchId(null)} />}
    </>
  );
}

/* ── export: honestly not built ──────────────────────────────── */

function ExportNotBuilt() {
  return (
    <div className="panel placeholder">
      <span className="placeholder-flag">Not built in this phase</span>
      <h2>Export</h2>
      <p className="placeholder-purpose">
        This phase built the import engine. Export — taking a dated snapshot of
        the Product Master out as a spreadsheet — has not been implemented, and
        the buttons the earlier prototype showed for it have been removed rather
        than left looking functional.
      </p>
      <p className="placeholder-note">
        The rule it will keep when it is built is the one the import already
        keeps: an export is a <em>read-only, dated snapshot</em>, never a
        round-trip. A spreadsheet that can be edited and loaded back would make
        it a second Product Master, and two places that both decide a price will
        disagree.
      </p>
    </div>
  );
}

/* ── choosing a source and uploading ─────────────────────────── */

function NewImport({ onOpenBatch }) {
  const sources = useApi(() => api.imports.sources(), []);
  const fileInput = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [inspection, setInspection] = useState(null);
  const [file, setFile] = useState(null);

  if (sources.error) return <Failed error={sources.error} onRetry={sources.reload} />;

  const excel = sources.data?.sources.find((s) => s.type === 'EXCEL_UPLOAD');
  const sheets = sources.data?.sources.find((s) => s.type === 'GOOGLE_SHEETS');

  const choose = async (chosen) => {
    setFile(chosen);
    setInspection(null);
    setError(null);
    if (!chosen) return;
    setBusy(true);
    try { setInspection(await api.imports.inspect(chosen)); }
    catch (err) { setError(err); }
    finally { setBusy(false); }
  };

  const upload = async () => {
    setBusy(true); setError(null);
    try {
      const { batchId } = await api.imports.upload(file);
      onOpenBatch(batchId);
      setFile(null);
      setInspection(null);
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) { setError(err); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <div className="grid-2">
        {/* ── Excel: the path that works ──────────────────── */}
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Excel or CSV upload</h2>
              <p>Tested end to end</p>
            </div>
            <StatusPill tone="ok">Available</StatusPill>
          </div>
          <div className="panel-body stack">
            <p className="tiny muted">
              Open the catalogue Google Sheet, choose the <strong>MASTER</strong> tab, then
              File → Download → Microsoft Excel. Upload the file here.
              {excel && <> Up to {Math.round(excel.maxBytes / 1048576)} MB; {excel.accepts.join(', ')}.</>}
            </p>

            <div className="field">
              <label htmlFor="imp-file">Spreadsheet</label>
              <input
                id="imp-file"
                ref={fileInput}
                className="input"
                type="file"
                accept=".xlsx,.xlsm,.csv"
                onChange={(e) => choose(e.target.files?.[0] ?? null)}
              />
            </div>

            {error && <FieldErrors error={error} />}

            {inspection && (
              <div className={'notice ' + (inspection.analysis.hasEssentials ? 'notice-info' : 'notice-warn')}>
                <span aria-hidden="true">●</span>
                <div>
                  <strong>
                    {inspection.sheetName} — {qty(inspection.rowCount)} row(s),{' '}
                    {inspection.analysis.recognised} of {inspection.analysis.expected} known columns.
                  </strong>
                  {!inspection.analysis.hasEssentials && (
                    <div style={{ marginTop: 4 }}>
                      This does not look like the MASTER tab: Brand, Product Name and a size
                      column are what the importer needs, and at least one is absent. You can
                      still upload it — every row will simply be reported as incomplete.
                    </div>
                  )}
                  {inspection.analysis.unknownColumns.length > 0 && (
                    <div className="tiny" style={{ marginTop: 4 }}>
                      Columns the ERP does not know, and will ignore:{' '}
                      {inspection.analysis.unknownColumns.slice(0, 6).join(', ')}
                      {inspection.analysis.unknownColumns.length > 6 && ' …'}
                    </div>
                  )}
                </div>
              </div>
            )}

            <button className="btn btn-primary" disabled={!file || busy} onClick={upload}>
              {busy ? 'Reading…' : 'Read and preview'}
            </button>
            <p className="tiny muted">
              Reading does not import anything. You will see exactly what would happen
              and have to confirm it.
            </p>
          </div>
        </section>

        {/* ── Sheets: honestly unavailable ────────────────── */}
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Connected Google Sheet</h2>
              <p>Not available in this environment</p>
            </div>
            <StatusPill tone="inert">Unavailable</StatusPill>
          </div>
          <div className="panel-body stack">
            <div className="notice notice-warn">
              <span aria-hidden="true">●</span>
              <div>
                <strong>Not connected, and never tested against the live spreadsheet.</strong>{' '}
                The importer knows the MASTER tab&rsquo;s real column list — it was read out of
                the extraction pipeline&rsquo;s own source — but no credentials and no spreadsheet
                id are configured here, so nothing has ever been read from it.
              </div>
            </div>
            {sheets?.missingConfiguration?.length > 0 && (
              <div>
                <p className="kpi-label" style={{ marginBottom: 6 }}>Missing configuration</p>
                <ul className="tiny" style={{ margin: 0, paddingLeft: 18 }}>
                  {sheets.missingConfiguration.map((m) => <li key={m}><code>{m}</code></li>)}
                </ul>
              </div>
            )}
            <p className="tiny muted">
              Until it is configured and verified, use the Excel export on the left —
              it reads the same columns and is tested.
            </p>
            {/* Deliberately no button. One that always fails is
                worse than none. */}
          </div>
        </section>
      </div>

      {sources.data && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>What the source does not carry</h2>
              <p>Why an imported product arrives without these</p>
            </div>
          </div>
          <div className="panel-body">
            <div className="detail-grid">
              {Object.entries(sources.data.fieldsNotInSource).map(([field, why]) => (
                <div className="detail-row" key={field} style={{ gridColumn: '1 / -1' }}>
                  <span className="detail-label">{field}</span>
                  <span className="detail-value" style={{ textAlign: 'left', fontWeight: 400, maxWidth: '72ch' }}>
                    {why}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

/* ── history ─────────────────────────────────────────────────── */

function History({ onOpenBatch }) {
  const list = useApi(() => api.imports.batches({ pageSize: 50 }), []);
  if (list.error) return <Failed error={list.error} onRetry={list.reload} />;

  const rows = list.data?.rows ?? [];

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Every import ever run</h2>
          <p>Never deleted — where a product came from has to stay answerable</p>
        </div>
        <button className="btn btn-sm" onClick={list.reload}>Refresh</button>
      </div>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Batch</th><th>Source</th><th>When</th>
              <th className="right">Read</th><th className="right">Imported</th>
              <th className="right">Dup</th><th className="right">Incomplete</th>
              <th className="right">Review</th><th className="right">Failed</th>
              <th>Reconciliation</th><th>Status</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id}>
                <td><span className="sku">{b.batchNo}</span></td>
                <td>
                  {b.sourceRef}
                  <div className="tiny muted">{b.sourceSheet}</div>
                </td>
                <td className="tiny">{stamp(b.startedAt)}</td>
                <td className="right num">{qty(b.sourceRowsRead)}</td>
                <td className="right num">{qty(b.counts.imported)}</td>
                <td className="right num">{qty(b.counts.duplicate + b.counts.existing)}</td>
                <td className="right num">{qty(b.counts.incomplete)}</td>
                <td className="right num">{qty(b.counts.review)}</td>
                <td className="right num">{qty(b.counts.failed)}</td>
                <td>
                  <StatusPill tone={RECONCILIATION_TONE[b.reconciliation]} title={b.reconciliationNote ?? undefined}>
                    {b.reconciliation}
                  </StatusPill>
                </td>
                <td><StatusPill tone={BATCH_TONE[b.status]}>{b.status.replace(/_/g, ' ')}</StatusPill></td>
                <td className="right">
                  <button className="btn btn-sm" onClick={() => onOpenBatch(b.id)}>Open</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !list.loading && (
              <tr><td colSpan={12} className="muted">Nothing imported yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="table-foot">
        <span>{list.data?.total ?? 0} batch(es){list.loading && ' · refreshing'}</span>
      </div>
    </section>
  );
}

/* ── one batch: preview, confirm, retry ──────────────────────── */

function BatchDetail({ id, onClose }) {
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [includeReviewed, setIncludeReviewed] = useState(false);

  const preview = useApi(() => api.imports.preview(id, { pageSize: 200, status: filter || undefined }), [id, filter]);

  const act = async (fn) => {
    setBusy(true); setError(null);
    try { await fn(); await preview.reload(); }
    catch (err) { setError(err); }
    finally { setBusy(false); }
  };

  const data = preview.data;
  const batch = data?.batch;
  const summary = data?.summary;
  const canImport = batch && ['PREVIEW_READY', 'COMPLETED_WITH_ERRORS'].includes(batch.status);
  const hasFailed = (batch?.counts.failed ?? 0) > 0;

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={batch ? 'Batch ' + batch.batchNo : 'Loading…'}
      subtitle={batch ? batch.sourceRef + (batch.sourceSheet ? ' · ' + batch.sourceSheet : '') : ''}
      footer={batch && (
        <>
          <a className="btn" href={api.imports.errorReportUrl(id)}>Download error report</a>
          {hasFailed && (
            <button className="btn" disabled={busy} onClick={() => act(() => api.imports.retry(id))}>
              Retry {batch.counts.failed} failed row(s)
            </button>
          )}
          {canImport && (summary?.willBeImported > 0 || includeReviewed) && (
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => act(() => api.imports.confirm(id, { includeReviewed }))}
            >
              {busy ? 'Importing…' : 'Import ' + (summary?.willBeImported ?? 0)
                + (includeReviewed ? ' + ' + (summary?.requiringReview ?? 0) + ' reviewed' : '') + ' row(s)'}
            </button>
          )}
          <button className="btn" onClick={onClose}>Close</button>
        </>
      )}
    >
      {preview.error && <FieldErrors error={preview.error} />}
      {error && <FieldErrors error={error} />}
      {!data && !preview.error && <p className="muted">Reading the batch…</p>}

      {data && (
        <>
          <div className="summary-strip" style={{ marginBottom: 12 }}>
            <div><span className="kpi-label">Rows read</span><strong className="num">{qty(summary.sourceRowsRead)}</strong></div>
            <div><span className="kpi-label">Will import</span><strong className="num">{qty(summary.willBeImported)}</strong></div>
            <div><span className="kpi-label">Will not</span><strong className="num">{qty(summary.willNotBeImported)}</strong></div>
            <div>
              <span className="kpi-label">Reconciliation</span>
              <StatusPill tone={RECONCILIATION_TONE[batch.reconciliation]}>{batch.reconciliation}</StatusPill>
            </div>
            <div>
              <span className="kpi-label">Status</span>
              <StatusPill tone={BATCH_TONE[batch.status]}>{batch.status.replace(/_/g, ' ')}</StatusPill>
            </div>
          </div>

          {batch.reconciliationNote && (
            <div className={'notice ' + (batch.reconciliation === 'FAILED' ? 'notice-danger' : 'notice-warn')}>
              <span aria-hidden="true">●</span>
              <div><strong>{batch.reconciliation}.</strong> {batch.reconciliationNote}</div>
            </div>
          )}

          {summary.sourceCompleteness === 'UNVERIFIED' && (
            <div className="notice notice-warn">
              <span aria-hidden="true">●</span>
              <div>
                <strong>Source completeness unverified.</strong> The source did not report how
                many rows it holds, so whether everything was read cannot be confirmed.
              </div>
            </div>
          )}

          <div className="viewbar" style={{ marginTop: 0 }}>
            {[
              ['', 'All', summary.sourceRowsRead],
              ['VALID', 'Will import', summary.willBeImported],
              ['IMPORTED', 'Imported', batch.counts.imported],
              ['INCOMPLETE', 'Incomplete', summary.missingMandatory],
              ['REVIEW_REQUIRED', 'Needs review', summary.requiringReview],
              ['SKIPPED_DUPLICATE', 'Duplicates', summary.exactDuplicates],
              ['SKIPPED_EXISTING', 'Already here', summary.existingProducts],
              ['FAILED', 'Failed', batch.counts.failed],
            ].filter(([, , n]) => n > 0 || filter === '').map(([value, label, n]) => (
              <button
                key={label}
                className={'viewtab' + (filter === value ? ' is-on' : '')}
                onClick={() => setFilter(value)}
              >
                {label}<span className="num">{n}</span>
              </button>
            ))}
          </div>

          {summary.requiringReview > 0 && canImport && (
            <label className="tiny" style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
              <input type="checkbox" checked={includeReviewed} onChange={(e) => setIncludeReviewed(e.target.checked)} />
              I have looked at the {summary.requiringReview} row(s) needing review and want them imported too
            </label>
          )}

          <div className="table-scroll" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th className="right">Row</th><th>Brand</th><th>Product</th>
                  <th>Size</th><th>Colour</th><th>Status</th><th>Problem</th><th>Result</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="right num">{r.sourceRowNumber}</td>
                    <td>{r.summary.brand ?? <span className="muted">—</span>}</td>
                    <td className="wrap">{r.summary.name ?? <span className="muted">—</span>}</td>
                    <td>{r.summary.size ?? <span className="muted">—</span>}</td>
                    <td>{r.summary.colour ?? <span className="muted">—</span>}</td>
                    <td><StatusPill tone={ROW_TONE[r.status]}>{ROW_LABEL[r.status]}</StatusPill></td>
                    <td className="wrap tiny" style={{ maxWidth: 340 }}>
                      {r.errors.map((e, i) => (
                        <div key={i}>
                          <strong>{e.field}</strong>: {e.message}
                        </div>
                      ))}
                      {r.lastError && <div style={{ color: 'var(--err)' }}>{r.lastError}</div>}
                    </td>
                    <td className="tiny">
                      {r.createdProduct
                        ? <span className="sku">{r.createdProduct.sku}</span>
                        : r.matchedProduct
                          ? <>matched <span className="sku">{r.matchedProduct.sku}</span></>
                          : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="tiny muted" style={{ marginTop: 10 }}>
            No stock is created by an import. Loading a product says the studio sells it,
            not how many are on the shelf — stock arrives through the inventory ledger.
            Product heads are left unset: the source&rsquo;s &ldquo;Catalog&rdquo; is the PDF a
            product was found in, not a series.
          </p>
        </>
      )}
    </Modal>
  );
}
