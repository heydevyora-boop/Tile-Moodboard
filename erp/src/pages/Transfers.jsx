import { useMemo, useState } from 'react';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import Modal from '../components/Modal.jsx';
import { Failed, FieldErrors } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { qty, stamp } from '../lib/format.js';

/* ============================================================
   WAREHOUSE TRANSFERS
   ============================================================
   ONE TRANSFER, TWO LINKED MOVEMENTS, ONE REFERENCE.

   A transfer is not two unrelated movements that happen to be the
   same size. Both the outward at the source and the inward at the
   destination carry the same transfer reference, and the database
   compares them: a transfer whose two sides disagree is stock
   lost between two of the studio's own doors, and the
   reconciliation report names it.

       DRAFT ──dispatch──▶ IN TRANSIT ──receive──▶ COMPLETED

   Total company stock is on hand PLUS in transit, and that figure
   does not change at any step: on dispatch the source's on-hand
   falls and the destination's in-transit rises by the same
   amount, and on receipt the reverse. Nothing is ever counted in
   two places.

   A transfer cancelled while IN TRANSIT sends the stock back to
   the source, because the lorry turned round and those boxes have
   to belong somewhere. A COMPLETED one cannot be cancelled: send
   it back as a new transfer, which is what would actually happen.
   ============================================================ */

const STATUS = {
  DRAFT: { label: 'Draft', tone: 'inert', note: 'Entered. Nothing has moved.' },
  IN_TRANSIT: { label: 'In transit', tone: 'warn', note: 'Left the source, not yet received.' },
  COMPLETED: { label: 'Completed', tone: 'ok', note: 'Received at the destination.' },
  CANCELLED: { label: 'Cancelled', tone: 'info', note: 'Called off. Any stock dispatched went back.' },
};

export default function Transfers() {
  const [status, setStatus] = useState('all');
  const [warehouseId, setWarehouseId] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [openId, setOpenId] = useState(null);
  const [drafting, setDrafting] = useState(false);
  const [confirming, setConfirming] = useState(null);  // { action, transfer }

  const [draft, setDraft] = useState({ fromWarehouseId: '', toWarehouseId: '', notes: '', lines: [] });
  const [lineSku, setLineSku] = useState('');
  const [lineQty, setLineQty] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => ({ status, warehouseId, page, pageSize }),
    [status, warehouseId, page, pageSize]);

  const list = useApi(() => api.warehouses.transfers(query), [JSON.stringify(query)]);
  const warehouses = useApi(() => api.warehouses.list({ isActive: true, pageSize: 100 }), []);
  const detail = useApi(() => api.warehouses.transfer(openId), [openId], { skip: !openId });

  const matches = useApi(
    () => api.products.list({ search: lineSku.trim(), pageSize: 10 }),
    [lineSku.trim()],
    { skip: lineSku.trim().length < 2 },
  );

  const addLine = () => {
    const product = (matches.data?.rows ?? [])
      .find((p) => p.sku.toUpperCase() === lineSku.trim().toUpperCase());
    if (!product || !(Number(lineQty) > 0)) return;
    setDraft({
      ...draft,
      lines: [...draft.lines, {
        productId: product.id, sku: product.sku, name: product.name,
        quantity: Number(lineQty), uom: product.uom,
      }],
    });
    setLineSku('');
    setLineQty('');
  };

  const createDraft = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.warehouses.createTransfer({
        fromWarehouseId: draft.fromWarehouseId,
        toWarehouseId: draft.toWarehouseId,
        notes: draft.notes || undefined,
        lines: draft.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, uom: l.uom })),
      });
      setDrafting(false);
      setDraft({ fromWarehouseId: '', toWarehouseId: '', notes: '', lines: [] });
      list.reload();
      setOpenId(created.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const act = async () => {
    setBusy(true);
    setError(null);
    try {
      const { action, transfer } = confirming;
      if (action === 'dispatch') await api.warehouses.dispatch(transfer.id);
      if (action === 'receive') await api.warehouses.receive(transfer.id);
      if (action === 'cancel') await api.warehouses.cancelTransfer(transfer.id, reason.trim() || undefined);
      setConfirming(null);
      setReason('');
      list.reload();
      if (openId) detail.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    {
      key: 'transferNo',
      label: 'Transfer',
      width: 140,
      sortable: false,
      render: (t) => <span className="sku">{t.transferNo}</span>,
    },
    {
      key: 'route',
      label: 'From → to',
      sortable: false,
      render: (t) => (
        <>
          <strong>{t.from?.name}</strong> → <strong>{t.to?.name}</strong>
          <div className="tiny muted">{t.lineCount} line(s)</div>
        </>
      ),
    },
    {
      key: 'status',
      label: 'State',
      width: 140,
      sortable: false,
      render: (t) => {
        const s = STATUS[t.status] ?? { label: t.status, tone: 'info' };
        return <StatusPill tone={s.tone} title={s.note}>{s.label}</StatusPill>;
      },
    },
    {
      key: 'createdAt',
      label: 'Raised',
      width: 148,
      sortable: false,
      render: (t) => (
        <>
          {stamp(t.createdAt)}
          <div className="tiny muted">{t.createdBy ?? '—'}</div>
        </>
      ),
    },
    {
      key: 'dispatchedAt',
      label: 'Dispatched',
      width: 148,
      sortable: false,
      render: (t) => (t.dispatchedAt
        ? <>{stamp(t.dispatchedAt)}<div className="tiny muted">{t.dispatchedBy ?? '—'}</div></>
        : <span className="muted">—</span>),
    },
    {
      key: 'receivedAt',
      label: 'Received',
      width: 148,
      sortable: false,
      render: (t) => (t.receivedAt
        ? <>{stamp(t.receivedAt)}<div className="tiny muted">{t.receivedBy ?? '—'}</div></>
        : <span className="muted">—</span>),
    },
    {
      key: 'actions',
      label: '',
      width: 250,
      sortable: false,
      render: (t) => (
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-sm" onClick={() => setOpenId(t.id)}>Open</button>
          {t.status === 'DRAFT' && (
            <button className="btn btn-sm" onClick={() => { setConfirming({ action: 'dispatch', transfer: t }); setError(null); }}>
              Dispatch
            </button>
          )}
          {t.status === 'IN_TRANSIT' && (
            <button className="btn btn-sm" onClick={() => { setConfirming({ action: 'receive', transfer: t }); setError(null); }}>
              Receive
            </button>
          )}
          {(t.status === 'DRAFT' || t.status === 'IN_TRANSIT') && (
            <button className="btn btn-sm" onClick={() => { setConfirming({ action: 'cancel', transfer: t }); setError(null); }}>
              Cancel
            </button>
          )}
        </div>
      ),
    },
  ];

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;

  const active = (warehouses.data?.rows ?? []);
  const canCreate = draft.fromWarehouseId && draft.toWarehouseId
    && draft.fromWarehouseId !== draft.toWarehouseId && draft.lines.length > 0;

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            Stock moving between the studio&rsquo;s own locations. Each transfer is
            one reference carrying both sides of the move, so the database can check
            that what left the source is exactly what arrived — and total company
            stock stays the same at every step of the journey.
          </p>
        </div>
        <div className="page-actions">
          <button
            className="btn btn-primary"
            onClick={() => { setDrafting(true); setError(null); }}
            disabled={active.length < 2}
            title={active.length < 2 ? 'A transfer needs two active warehouses.' : undefined}
          >
            New transfer
          </button>
        </div>
      </div>

      {active.length < 2 && (
        <div className="notice notice-info">
          <span aria-hidden="true">●</span>
          <div>
            There is only one active warehouse, so there is nowhere to transfer to.
            The lifecycle below is built and tested; it has nothing to do until a
            second location exists.
          </div>
        </div>
      )}

      <DataTable
        rows={list.data?.rows ?? []}
        columns={columns}
        rowKey={(t) => t.id}
        server={{
          total: list.data?.total ?? 0,
          page,
          pageSize,
          pageCount: list.data?.pageCount ?? 1,
          loading: list.loading,
          sort: null,
          onPage: setPage,
          onPageSize: (n) => { setPageSize(n); setPage(1); },
          onSort: () => {},
        }}
        emptyTitle="No transfers"
        emptyNote="Nothing has been moved between warehouses yet."
        filters={(
          <>
            <select
              className="select"
              value={status}
              onChange={(e) => { setStatus(e.target.value); setPage(1); }}
              aria-label="State"
            >
              <option value="all">Every state</option>
              {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select
              className="select"
              value={warehouseId}
              onChange={(e) => { setWarehouseId(e.target.value); setPage(1); }}
              aria-label="Warehouse"
            >
              <option value="all">Any warehouse</option>
              {active.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </>
        )}
      />

      {/* ── raise a transfer ── */}
      <Modal
        open={drafting}
        wide
        onClose={() => setDrafting(false)}
        title="New transfer"
        subtitle="Saving this records the intent only. Nothing moves until it is dispatched."
        footer={(
          <>
            <button className="btn" onClick={() => setDrafting(false)} disabled={busy}>Cancel</button>
            <button
              className="btn btn-primary"
              form="transfer-form"
              type="submit"
              disabled={busy || !canCreate}
            >
              {busy ? 'Saving…' : 'Save as draft'}
            </button>
          </>
        )}
      >
        <FieldErrors error={error} />
        <form id="transfer-form" onSubmit={createDraft} className="stack">
          <div className="grid-2">
            <div className="field">
              <label htmlFor="t-from">From</label>
              <select
                id="t-from"
                className="select"
                value={draft.fromWarehouseId}
                onChange={(e) => setDraft({ ...draft, fromWarehouseId: e.target.value })}
                required
              >
                <option value="">Choose…</option>
                {active.map((w) => (
                  <option key={w.id} value={w.id}>{w.name} — {qty(w.available)} sellable</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="t-to">To</label>
              <select
                id="t-to"
                className="select"
                value={draft.toWarehouseId}
                onChange={(e) => setDraft({ ...draft, toWarehouseId: e.target.value })}
                required
              >
                <option value="">Choose…</option>
                {active
                  .filter((w) => w.id !== draft.fromWarehouseId)
                  .map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
          </div>

          <div className="field">
            <label>Lines</label>
            {draft.lines.length === 0
              ? <p className="tiny muted">Nothing added yet.</p>
              : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Code</th><th>Product</th>
                      <th style={{ textAlign: 'right' }}>Quantity</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {draft.lines.map((l, i) => (
                      <tr key={l.productId + ':' + i}>
                        <td><span className="sku">{l.sku}</span></td>
                        <td>{l.name}</td>
                        <td className="num" style={{ textAlign: 'right' }}>
                          {qty(l.quantity)} {l.uom?.toLowerCase()}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => setDraft({
                              ...draft,
                              lines: draft.lines.filter((_, j) => j !== i),
                            })}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>

          <div className="grid-3">
            <div className="field">
              <label htmlFor="t-sku">Product code</label>
              <input
                id="t-sku"
                className="input"
                list="transfer-product-list"
                value={lineSku}
                onChange={(e) => setLineSku(e.target.value)}
                autoComplete="off"
              />
              <datalist id="transfer-product-list">
                {(matches.data?.rows ?? []).map((p) => (
                  <option key={p.id} value={p.sku}>{p.name}</option>
                ))}
              </datalist>
            </div>
            <div className="field">
              <label htmlFor="t-qty">Quantity</label>
              <input
                id="t-qty"
                className="input"
                type="number"
                min="0.001"
                step="0.001"
                value={lineQty}
                onChange={(e) => setLineQty(e.target.value)}
              />
            </div>
            <div className="field">
              <label>&nbsp;</label>
              <button type="button" className="btn" onClick={addLine}>Add line</button>
            </div>
          </div>

          <div className="field">
            <label htmlFor="t-notes">Notes</label>
            <input
              id="t-notes"
              className="input"
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              placeholder="Replenishing the Morbi display stock."
            />
          </div>
        </form>
      </Modal>

      {/* ── dispatch / receive / cancel ── */}
      <Modal
        open={Boolean(confirming)}
        onClose={() => { setConfirming(null); setError(null); }}
        title={confirming
          ? ({ dispatch: 'Dispatch', receive: 'Receive', cancel: 'Cancel' }[confirming.action]
            + ' ' + confirming.transfer.transferNo)
          : ''}
        footer={(
          <>
            <button className="btn" onClick={() => setConfirming(null)} disabled={busy}>Close</button>
            <button className="btn btn-primary" onClick={act} disabled={busy}>
              {busy ? 'Working…' : 'Confirm'}
            </button>
          </>
        )}
      >
        <FieldErrors error={error} />
        {confirming?.action === 'dispatch' && (
          <>
            <p>
              The stock leaves <strong>{confirming.transfer.from?.name}</strong> now and is
              held as in transit against <strong>{confirming.transfer.to?.name}</strong>.
            </p>
            <p className="tiny muted">
              Company-wide stock does not change: a lorry is not a shelf, so the
              boxes stop being sellable at the source without becoming sellable at
              the destination. If the source does not have them, this is refused.
            </p>
          </>
        )}
        {confirming?.action === 'receive' && (
          <>
            <p>
              The stock arrives at <strong>{confirming.transfer.to?.name}</strong> and becomes
              sellable there.
            </p>
            <p className="tiny muted">
              Signed for by you, under your name. A transfer one person can both
              dispatch and receive unnoticed is not a control, so both names are
              recorded.
            </p>
          </>
        )}
        {confirming?.action === 'cancel' && (
          <>
            <p>
              {confirming.transfer.status === 'IN_TRANSIT'
                ? 'This transfer has already been dispatched, so the stock goes back to '
                  + confirming.transfer.from?.name + ' as its own movement.'
                : 'Nothing has moved, so this only closes the draft.'}
            </p>
            <div className="field">
              <label htmlFor="t-reason">Reason</label>
              <input
                id="t-reason"
                className="input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Lorry turned round; destination could not take it."
              />
            </div>
          </>
        )}
      </Modal>

      {/* ── one transfer, and whether it adds up ── */}
      <Modal
        open={Boolean(openId)}
        wide
        onClose={() => setOpenId(null)}
        title={detail.data ? detail.data.transferNo : 'Transfer'}
        subtitle={detail.data
          ? detail.data.from?.name + ' → ' + detail.data.to?.name
          : ''}
        footer={<button className="btn" onClick={() => setOpenId(null)}>Close</button>}
      >
        {detail.loading && <p className="muted">Reading from the database…</p>}
        {detail.error && <FieldErrors error={detail.error} />}
        {detail.data && (
          <>
            {/* The two sides, compared by the database rather than
                asserted here. */}
            {detail.data.movement && (
              <div className={'notice ' + (detail.data.movement.balanced ? 'notice-ok' : 'notice-danger')}>
                <span aria-hidden="true">●</span>
                <div>
                  {detail.data.movement.balanced
                    ? <strong>Both sides of this transfer agree.</strong>
                    : <strong>The two sides of this transfer do not agree.</strong>}
                  <div className="tiny" style={{ marginTop: 4 }}>
                    {qty(detail.data.movement.dispatched)} dispatched ·{' '}
                    {qty(detail.data.movement.receivedAtDestination)} received at the destination
                    {detail.data.movement.returnedToSource > 0 && (
                      <> · {qty(detail.data.movement.returnedToSource)} returned to the source</>
                    )}
                    {detail.data.movement.stillInTransit > 0 && (
                      <> · {qty(detail.data.movement.stillInTransit)} still in transit</>
                    )}
                  </div>
                </div>
              </div>
            )}

            <p className="tiny muted">
              {STATUS[detail.data.status]?.note}
              {detail.data.notes && <> · {detail.data.notes}</>}
            </p>

            <table className="table">
              <thead>
                <tr>
                  <th>#</th><th>Code</th><th>Product</th>
                  <th style={{ textAlign: 'right' }}>Sent</th>
                  <th style={{ textAlign: 'right' }}>Received</th>
                </tr>
              </thead>
              <tbody>
                {detail.data.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.lineNo}</td>
                    <td><span className="sku">{l.sku}</span></td>
                    <td>{l.name}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(l.quantity)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {l.receivedQuantity > 0 ? qty(l.receivedQuantity) : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Modal>
    </>
  );
}
