import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import Modal from '../components/Modal.jsx';
import { Failed, FieldErrors } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { qty, stamp } from '../lib/format.js';

/* ============================================================
   THE STOCK LEDGER — THE RECORD ITSELF
   ============================================================
   Every other inventory figure in this system is derived from
   this table. It is append-only, enforced by database triggers:
   no row here has ever been edited or deleted, and the database
   refuses both outright rather than trusting the application not
   to try.

   So there is no Edit button and no Delete button on this screen.
   A mistake is corrected by REVERSING it, which posts the
   opposite movement linked to the original, and the stock card
   then shows the error and the correction side by side. That is
   what a ledger is for.
   ============================================================ */

const MOVEMENT = {
  INWARD: { label: 'Inward', tone: 'ok' },
  OUTWARD: { label: 'Outward', tone: 'info' },
  ADJUSTMENT_INCREASE: { label: 'Adjustment up', tone: 'warn' },
  ADJUSTMENT_DECREASE: { label: 'Adjustment down', tone: 'warn' },
  TRANSFER_IN: { label: 'Transfer in', tone: 'info' },
  TRANSFER_OUT: { label: 'Transfer out', tone: 'info' },
  RESERVATION: { label: 'Reserved', tone: 'inert' },
  RESERVATION_RELEASE: { label: 'Reservation released', tone: 'inert' },
  DAMAGE: { label: 'Damaged', tone: 'danger' },
  DAMAGE_RECOVERY: { label: 'Damage recovered', tone: 'ok' },
};

const REASON_LABEL = {
  OPENING_STOCK: 'Opening stock',
  PURCHASE_RECEIPT: 'Purchase receipt',
  PURCHASE_RETURN: 'Returned to supplier',
  SALES_DISPATCH: 'Sales dispatch',
  SALES_RETURN: 'Customer return',
  SAMPLE_ISSUE: 'Sample issued',
  DAMAGE: 'Damage',
  DAMAGE_RECOVERY: 'Damage recovered',
  STOCK_COUNT_CORRECTION: 'Stock count correction',
  WAREHOUSE_TRANSFER: 'Warehouse transfer',
  RESERVATION: 'Reserved',
  RESERVATION_RELEASE: 'Reservation released',
  OTHER: 'Other',
};

export default function StockLedger() {
  const [params, setParams] = useSearchParams();
  const sku = params.get('sku') || '';

  const [search, setSearch] = useState('');
  const [movementType, setMovementType] = useState('all');
  const [warehouseId, setWarehouseId] = useState('all');
  const [referenceNo, setReferenceNo] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [reversing, setReversing] = useState(null);
  const [reversalRemarks, setReversalRemarks] = useState('');
  const [reversalError, setReversalError] = useState(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => ({
    sku: sku || undefined,
    search: search || undefined,
    movementType,
    warehouseId,
    referenceNo: referenceNo || undefined,
    from: from || undefined,
    to: to || undefined,
    page,
    pageSize,
  }), [sku, search, movementType, warehouseId, referenceNo, from, to, page, pageSize]);

  const list = useApi(() => api.inventory.ledger(query), [JSON.stringify(query)]);
  const warehouses = useApi(() => api.reference.warehouses(), []);
  /* When one product is pinned, the screen is a stock card and the
     closing balance is worth stating on its own. */
  const card = useApi(
    () => api.inventory.list({ search: sku, pageSize: 20 }),
    [sku],
    { skip: !sku },
  );

  const reset = (fn) => (value) => { fn(value); setPage(1); };

  const clearProduct = () => {
    const next = new URLSearchParams(params);
    next.delete('sku');
    setParams(next, { replace: true });
    setPage(1);
  };

  const reverse = async () => {
    setBusy(true);
    setReversalError(null);
    try {
      await api.inventory.reverse(reversing.id, reversalRemarks.trim() || undefined);
      setReversing(null);
      setReversalRemarks('');
      list.reload();
      card.reload();
    } catch (err) {
      setReversalError(err);
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    {
      key: 'entryNo',
      label: 'Entry',
      width: 76,
      sortable: false,
      render: (m) => <span className="sku">{m.entryNo}</span>,
    },
    {
      key: 'at',
      label: 'When',
      width: 148,
      sortable: false,
      render: (m) => (
        <>
          {stamp(m.at)}
          {m.recordedAt && m.recordedAt.slice(0, 10) !== m.at.slice(0, 10) && (
            <div className="tiny muted">entered {stamp(m.recordedAt)}</div>
          )}
        </>
      ),
    },
    {
      key: 'productName',
      label: 'Product',
      sortable: false,
      render: (m) => (
        <>
          <strong>{m.productName}</strong>
          <div className="sku">{m.sku} · {m.warehouseCode}</div>
        </>
      ),
    },
    {
      key: 'movementType',
      label: 'Movement',
      width: 160,
      sortable: false,
      render: (m) => {
        const spec = MOVEMENT[m.movementType] ?? { label: m.movementType, tone: 'info' };
        return (
          <>
            <StatusPill tone={spec.tone}>{spec.label}</StatusPill>
            <div className="tiny muted">{REASON_LABEL[m.reason] ?? m.reason}</div>
          </>
        );
      },
    },
    {
      key: 'referenceNo',
      label: 'Document',
      width: 128,
      sortable: false,
      render: (m) => (m.referenceNo
        ? <span className="sku">{m.referenceNo}</span>
        : <span className="muted">—</span>),
    },
    {
      key: 'quantity',
      label: 'Quantity',
      align: 'right',
      width: 96,
      sortable: false,
      render: (m) => (
        <span className="num">
          {m.direction === 'OUT' ? '−' : m.direction === 'IN' ? '+' : ''}{qty(m.quantity)}
        </span>
      ),
    },
    {
      key: 'balanceBefore',
      label: 'Was',
      align: 'right',
      width: 82,
      sortable: false,
      render: (m) => <span className="num muted">{qty(m.balanceBefore)}</span>,
    },
    {
      key: 'balanceAfter',
      label: 'Became',
      align: 'right',
      width: 90,
      sortable: false,
      render: (m) => <strong className="num">{qty(m.balanceAfter)}</strong>,
    },
    {
      key: 'held',
      label: 'Reserved / damaged',
      align: 'right',
      width: 150,
      sortable: false,
      render: (m) => (
        <span className="tiny num muted">
          {qty(m.reservedAfter)} / {qty(m.damagedAfter)}
        </span>
      ),
    },
    {
      key: 'remarks',
      label: 'Remarks',
      width: 200,
      sortable: false,
      render: (m) => (m.remarks
        ? <span className="tiny">{m.remarks}</span>
        : <span className="muted">—</span>),
    },
    {
      key: 'performedBy',
      label: 'By',
      width: 120,
      sortable: false,
      render: (m) => m.performedBy ?? <span className="muted">—</span>,
    },
    {
      key: 'reverse',
      label: '',
      width: 92,
      sortable: false,
      render: (m) => (m.reversalOfEntryId
        /* A reversal cannot itself be reversed from here. Doing so
           is a third movement that re-does the second, and at that
           point the right record is an adjustment with a reason,
           not a chain of undos. */
        ? <span className="tiny muted" title={'Reverses entry ' + m.reversalOfEntryId}>reversal</span>
        : (
          <button className="btn btn-sm" onClick={() => { setReversing(m); setReversalError(null); }}>
            Reverse
          </button>
        )),
    },
  ];

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;

  const held = (card.data?.rows ?? []);

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            Every stock movement the ERP has recorded, newest first. The ledger is
            append-only and the database enforces it: these rows cannot be edited
            or deleted, by this screen or by anything else. A mistake is corrected
            by reversing it, and both entries stay visible.
          </p>
        </div>
      </div>

      {sku && (
        <div className="notice notice-info">
          <span aria-hidden="true">●</span>
          <div>
            <strong>Stock card for {sku}.</strong>
            {held.length > 0 && (
              <>
                {' '}
                {held.map((r) => r.warehouse?.name + ': ' + qty(r.physical) + ' on hand, '
                  + qty(r.available) + ' sellable').join(' · ')}
              </>
            )}
            {' '}
            <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={clearProduct}>
              Show every product
            </button>
          </div>
        </div>
      )}

      <DataTable
        rows={list.data?.rows ?? []}
        columns={columns}
        rowKey={(m) => m.id}
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
        search={search}
        onSearch={reset(setSearch)}
        searchPlaceholder="Search product code or name…"
        emptyTitle="No movements"
        emptyNote="Nothing matches these filters."
        filters={(
          <>
            <select
              className="select"
              value={movementType}
              onChange={(e) => reset(setMovementType)(e.target.value)}
              aria-label="Movement type"
            >
              <option value="all">Every movement</option>
              {Object.entries(MOVEMENT).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
            <select
              className="select"
              value={warehouseId}
              onChange={(e) => reset(setWarehouseId)(e.target.value)}
              aria-label="Warehouse"
            >
              <option value="all">All warehouses</option>
              {(warehouses.data?.rows ?? []).map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
            <input
              className="input"
              value={referenceNo}
              onChange={(e) => reset(setReferenceNo)(e.target.value)}
              placeholder="Document no."
              aria-label="Document number"
              style={{ width: 140 }}
            />
            <input
              className="input"
              type="date"
              value={from}
              onChange={(e) => reset(setFrom)(e.target.value)}
              aria-label="From"
              style={{ width: 142 }}
            />
            <input
              className="input"
              type="date"
              value={to}
              onChange={(e) => reset(setTo)(e.target.value)}
              aria-label="To"
              style={{ width: 142 }}
            />
          </>
        )}
      />

      <Modal
        open={Boolean(reversing)}
        onClose={() => { setReversing(null); setReversalError(null); }}
        title={reversing ? 'Reverse entry ' + reversing.entryNo : 'Reverse'}
        subtitle="This does not delete anything. It posts the opposite movement, linked to the original."
        footer={(
          <>
            <button className="btn" onClick={() => setReversing(null)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={reverse} disabled={busy}>
              {busy ? 'Posting…' : 'Post the reversal'}
            </button>
          </>
        )}
      >
        <FieldErrors error={reversalError} />
        {reversing && (
          <>
            <p>
              Entry <strong>{reversing.entryNo}</strong> moved{' '}
              <strong>{qty(reversing.quantity)} {reversing.uom?.toLowerCase()}</strong> of{' '}
              <strong>{reversing.sku}</strong> at {reversing.warehouse}, taking the balance from{' '}
              {qty(reversing.balanceBefore)} to {qty(reversing.balanceAfter)}.
            </p>
            <p className="tiny muted">
              A reversal of the same size and the opposite direction will be posted.
              Both entries stay on the stock card, so the record shows what was
              recorded and what corrected it.
            </p>
            <div className="field">
              <label htmlFor="rev-remarks">Why (recommended)</label>
              <textarea
                id="rev-remarks"
                className="input"
                rows={2}
                value={reversalRemarks}
                onChange={(e) => setReversalRemarks(e.target.value)}
                placeholder="Entered against the wrong product."
              />
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
