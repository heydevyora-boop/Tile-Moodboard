import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import Modal from '../components/Modal.jsx';
import { Failed, FieldErrors } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { money, qty, day, stamp } from '../lib/format.js';
import { GRN_STATUS } from '../data/purchaseStatus.js';

/* ============================================================
   GOODS RECEIPT — THE ONE SCREEN THAT INCREASES STOCK
   ============================================================
   Posting a receipt writes to the append-only stock ledger
   through the same service every other movement goes through,
   in one transaction. It cannot be undone afterwards: the ledger
   refuses it, which is the guarantee step 5 exists to provide.
   A receipt entered in error is corrected by a purchase return
   or a stock adjustment, and both stay visible.
   ============================================================ */

const EMPTY_LINE = { acceptedQuantity: '', damagedQuantity: '', rejectedQuantity: '', rejectionReason: '' };

export default function GoodsReceipts() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');
  const poParam = params.get('po');

  const [search, setSearch] = useState('');
  const [supplierId, setSupplierId] = useState('all');
  const [warehouseId, setWarehouseId] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [receiving, setReceiving] = useState(null);   // purchase order id
  const [entry, setEntry] = useState({});
  const [docNo, setDocNo] = useState('');
  const [receiptDate, setReceiptDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [remarks, setRemarks] = useState('');
  const [overApproved, setOverApproved] = useState(false);
  const [overReason, setOverReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => ({
    search: search || undefined,
    supplierId,
    warehouseId,
    from: from || undefined,
    to: to || undefined,
    page,
    pageSize,
  }), [search, supplierId, warehouseId, from, to, page, pageSize]);

  const list = useApi(() => api.goodsReceipts.list(query), [JSON.stringify(query)]);
  const detail = useApi(() => api.goodsReceipts.get(openId), [openId], { skip: !openId });
  const suppliers = useApi(() => api.suppliers.options(), []);
  const warehouses = useApi(() => api.reference.warehouses(), []);
  const receivable = useApi(() => api.purchaseOrders.receivable(receiving), [receiving], { skip: !receiving });
  const openOrders = useApi(
    () => api.purchaseOrders.list({ status: 'APPROVED,PARTIALLY_RECEIVED', pageSize: 100 }),
    [list.data],
  );

  // Arriving from a purchase order opens the form on it.
  useEffect(() => { if (poParam) setReceiving(poParam); }, [poParam]);

  const open = (id) => { const n = new URLSearchParams(params); n.set('open', id); setParams(n, { replace: true }); };
  const closeDetail = () => { const n = new URLSearchParams(params); n.delete('open'); setParams(n, { replace: true }); };
  const closeForm = () => {
    setReceiving(null); setEntry({}); setDocNo(''); setRemarks('');
    setOverApproved(false); setOverReason(''); setError(null);
    const n = new URLSearchParams(params); n.delete('po'); setParams(n, { replace: true });
  };

  const reset = (fn) => (v) => { fn(v); setPage(1); };

  const lineOf = (id) => entry[id] ?? EMPTY_LINE;
  const setLine = (id, patch) => setEntry({ ...entry, [id]: { ...lineOf(id), ...patch } });

  const post = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const lines = Object.entries(entry)
        .filter(([, v]) => Number(v.acceptedQuantity) > 0 || Number(v.damagedQuantity) > 0
          || Number(v.rejectedQuantity) > 0)
        .map(([purchaseOrderLineId, v]) => ({
          purchaseOrderLineId,
          acceptedQuantity: v.acceptedQuantity || 0,
          damagedQuantity: v.damagedQuantity || 0,
          rejectedQuantity: v.rejectedQuantity || 0,
          rejectionReason: v.rejectionReason || null,
        }));

      const created = await api.goodsReceipts.receive({
        purchaseOrderId: receiving,
        receiptDate,
        supplierDocNo: docNo || null,
        remarks: remarks || null,
        overReceiptApproved: overApproved || undefined,
        overReceiptReason: overApproved ? overReason : undefined,
        lines,
      });
      closeForm();
      list.reload();
      openOrders.reload();
      open(created.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    { key: 'grnNo', label: 'Receipt', width: 140, sortable: false, render: (g) => <span className="sku">{g.grnNo}</span> },
    {
      key: 'supplier',
      label: 'Supplier',
      sortable: false,
      render: (g) => (
        <>
          <strong>{g.supplier?.name}</strong>
          <div className="tiny muted">into {g.warehouse?.name}</div>
        </>
      ),
    },
    {
      key: 'order',
      label: 'Against',
      width: 140,
      sortable: false,
      render: (g) => (g.purchaseOrder
        ? <span className="sku">{g.purchaseOrder.orderNo}</span>
        : <span className="muted">—</span>),
    },
    { key: 'receiptDate', label: 'Received', width: 112, sortable: false, render: (g) => day(g.receiptDate) },
    {
      key: 'supplierDocNo',
      label: 'Supplier doc',
      width: 140,
      sortable: false,
      render: (g) => (g.supplierDocNo ? <span className="sku">{g.supplierDocNo}</span> : <span className="muted">—</span>),
    },
    {
      key: 'totalReceived',
      label: 'Quantity',
      align: 'right',
      width: 100,
      sortable: false,
      render: (g) => <strong className="num">{qty(g.totalReceived ?? 0)}</strong>,
    },
    { key: 'receivedBy', label: 'By', width: 130, sortable: false, render: (g) => g.receivedBy ?? '—' },
    {
      key: 'status',
      label: 'State',
      width: 110,
      sortable: false,
      render: (g) => {
        const s = GRN_STATUS[g.status] ?? { label: g.status, tone: 'info' };
        return <StatusPill tone={s.tone} title={s.note}>{s.label}</StatusPill>;
      },
    },
    {
      key: 'actions',
      label: '',
      width: 92,
      sortable: false,
      render: (g) => <button className="btn btn-sm" onClick={() => open(g.id)}>Open</button>,
    },
  ];

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;

  const d = detail.data;
  const r = receivable.data;

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            Goods physically arriving. <strong>This is the only purchase document
            that changes stock</strong> &mdash; not the order, not the approval, not
            the supplier&rsquo;s invoice. Each posted receipt writes its movements to
            the append-only ledger and cannot be undone afterwards.
          </p>
        </div>
        <div className="page-actions">
          <select
            className="select"
            value=""
            onChange={(e) => e.target.value && setReceiving(e.target.value)}
            aria-label="Receive against an order"
          >
            <option value="">Receive against an order…</option>
            {(openOrders.data?.rows ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.orderNo} — {o.supplier?.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {(openOrders.data?.rows ?? []).length === 0 && (
        <div className="notice notice-info">
          <span aria-hidden="true">●</span>
          <div>
            No approved order is waiting for goods. A receipt can only be posted
            against an approved or partly received order &mdash; receiving against a
            draft would create stock whose explanation contradicts itself.
          </div>
        </div>
      )}

      <DataTable
        rows={list.data?.rows ?? []}
        columns={columns}
        rowKey={(g) => g.id}
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
        searchPlaceholder="Search receipt, order, supplier doc, product…"
        emptyTitle="Nothing received yet"
        emptyNote="When goods arrive against an approved order, the receipt appears here."
        filters={(
          <>
            <select className="select" value={supplierId}
              onChange={(e) => reset(setSupplierId)(e.target.value)} aria-label="Supplier">
              <option value="all">All suppliers</option>
              {(suppliers.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select className="select" value={warehouseId}
              onChange={(e) => reset(setWarehouseId)(e.target.value)} aria-label="Warehouse">
              <option value="all">All warehouses</option>
              {(warehouses.data?.rows ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <input className="input" type="date" value={from}
              onChange={(e) => reset(setFrom)(e.target.value)} aria-label="From" style={{ width: 146 }} />
            <input className="input" type="date" value={to}
              onChange={(e) => reset(setTo)(e.target.value)} aria-label="To" style={{ width: 146 }} />
          </>
        )}
      />

      {/* ── receiving ── */}
      <Modal
        open={Boolean(receiving)}
        wide
        onClose={closeForm}
        title={r ? 'Receive against ' + r.purchaseOrder.orderNo : 'Receive goods'}
        subtitle="Posting this moves stock. It is written to the append-only ledger and cannot be undone."
        footer={(
          <>
            <button className="btn" onClick={closeForm} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" form="grn-form" type="submit" disabled={busy}>
              {busy ? 'Posting…' : 'Post receipt'}
            </button>
          </>
        )}
      >
        {receivable.loading && <p className="muted">Reading the order…</p>}
        <FieldErrors error={error} />
        {r && !r.purchaseOrder.receivable && (
          <div className="notice notice-danger">
            <span aria-hidden="true">●</span>
            <div>
              This order is {r.purchaseOrder.status.toLowerCase().replace(/_/g, ' ')}, so goods
              cannot be received against it.
            </div>
          </div>
        )}
        {r && r.purchaseOrder.receivable && (
          <form id="grn-form" onSubmit={post} className="stack">
            <div className="grid-3">
              <div className="field">
                <label htmlFor="grn-date">Receipt date</label>
                <input id="grn-date" className="input" type="date" value={receiptDate}
                  onChange={(e) => setReceiptDate(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="grn-doc">Supplier document</label>
                <input id="grn-doc" className="input" value={docNo}
                  onChange={(e) => setDocNo(e.target.value)} placeholder="Delivery note or invoice no." />
              </div>
              <div className="field">
                <label>Into</label>
                <input className="input" value={r.purchaseOrder.warehouse?.name ?? ''} disabled />
              </div>
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th>Code</th><th>Product</th>
                  <th style={{ textAlign: 'right' }}>Ordered</th>
                  <th style={{ textAlign: 'right' }}>Already in</th>
                  <th style={{ textAlign: 'right' }}>Outstanding</th>
                  <th style={{ textAlign: 'right' }}>Accepted</th>
                  <th style={{ textAlign: 'right' }}>Damaged</th>
                  <th style={{ textAlign: 'right' }}>Rejected</th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.purchaseOrderLineId}>
                    <td><span className="sku">{l.sku}</span></td>
                    <td>{l.name}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(l.orderedQuantity)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(l.receivedQuantity)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      <strong>{qty(l.outstandingQuantity)}</strong>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <input className="input" type="number" min="0" step="0.001" style={{ width: 92 }}
                        value={lineOf(l.purchaseOrderLineId).acceptedQuantity}
                        onChange={(e) => setLine(l.purchaseOrderLineId, { acceptedQuantity: e.target.value })}
                        aria-label={'Accepted for ' + l.sku} />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <input className="input" type="number" min="0" step="0.001" style={{ width: 92 }}
                        value={lineOf(l.purchaseOrderLineId).damagedQuantity}
                        onChange={(e) => setLine(l.purchaseOrderLineId, { damagedQuantity: e.target.value })}
                        aria-label={'Damaged for ' + l.sku} />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <input className="input" type="number" min="0" step="0.001" style={{ width: 92 }}
                        value={lineOf(l.purchaseOrderLineId).rejectedQuantity}
                        onChange={(e) => setLine(l.purchaseOrderLineId, { rejectedQuantity: e.target.value })}
                        aria-label={'Rejected for ' + l.sku} />
                      {Number(lineOf(l.purchaseOrderLineId).rejectedQuantity) > 0 && (
                        <input className="input" style={{ marginTop: 4, width: 92 }}
                          placeholder="reason"
                          value={lineOf(l.purchaseOrderLineId).rejectionReason}
                          onChange={(e) => setLine(l.purchaseOrderLineId, { rejectionReason: e.target.value })}
                          aria-label={'Rejection reason for ' + l.sku} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="tiny muted">
              <strong>Accepted</strong> goes into sellable stock.{' '}
              <strong>Damaged</strong> goes into stock too &mdash; the boxes are in the
              building and a stock-take would find them &mdash; but is marked damaged
              so it cannot be sold.{' '}
              <strong>Rejected</strong> was turned away at the gate: no stock movement
              is posted at all and the supplier still owes the quantity.
            </p>

            <div className="field">
              <label htmlFor="grn-remarks">Remarks</label>
              <input id="grn-remarks" className="input" value={remarks}
                onChange={(e) => setRemarks(e.target.value)} />
            </div>

            <div className="field">
              <label htmlFor="grn-over" style={{ textTransform: 'none', letterSpacing: 0 }}>
                <input id="grn-over" type="checkbox" checked={overApproved}
                  onChange={(e) => setOverApproved(e.target.checked)} />
                {' '}Accept more than was ordered
              </label>
              <span className="tiny muted">
                Refused by default. Somebody has to say so, and the reason goes in the
                audit log.
              </span>
              {overApproved && (
                <input className="input" style={{ marginTop: 6 }} value={overReason}
                  onChange={(e) => setOverReason(e.target.value)}
                  placeholder="Supplier sent a full pallet; agreed to keep it." />
              )}
            </div>
          </form>
        )}
      </Modal>

      {/* ── one receipt, and the stock it moved ── */}
      <Modal
        open={Boolean(openId)}
        wide
        onClose={closeDetail}
        title={d ? d.grnNo : 'Goods receipt'}
        subtitle={d ? d.supplier.name + ' → ' + d.warehouse.name : ''}
        footer={<button className="btn" onClick={closeDetail}>Close</button>}
      >
        {detail.loading && <p className="muted">Reading from the database…</p>}
        {detail.error && <FieldErrors error={detail.error} />}
        {d && (
          <>
            <div className="summary-strip">
              <div><span className="kpi-label">Received</span><strong>{day(d.receiptDate)}</strong></div>
              <div><span className="kpi-label">Against</span><strong>{d.purchaseOrder?.orderNo ?? '—'}</strong></div>
              <div><span className="kpi-label">Supplier doc</span><strong>{d.supplierDocNo ?? '—'}</strong></div>
              <div><span className="kpi-label">By</span><strong>{d.receivedBy ?? '—'}</strong></div>
              <div><span className="kpi-label">Posted</span><strong>{d.postedAt ? stamp(d.postedAt) : '—'}</strong></div>
            </div>

            <table className="table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Code</th><th>Product</th>
                  <th style={{ textAlign: 'right' }}>Ordered</th>
                  <th style={{ textAlign: 'right' }}>Before this</th>
                  <th style={{ textAlign: 'right' }}>Accepted</th>
                  <th style={{ textAlign: 'right' }}>Damaged</th>
                  <th style={{ textAlign: 'right' }}>Rejected</th>
                  <th style={{ textAlign: 'right' }}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l) => (
                  <tr key={l.id}>
                    <td><span className="sku">{l.sku}</span></td>
                    <td>
                      {l.name}
                      {l.rejectionReason && (
                        <div className="tiny" style={{ color: 'var(--danger)' }}>{l.rejectionReason}</div>
                      )}
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(l.orderedQuantity)}</td>
                    <td className="num muted" style={{ textAlign: 'right' }}>{qty(l.previouslyReceivedQuantity)}</td>
                    <td className="num" style={{ textAlign: 'right' }}><strong>{qty(l.acceptedQuantity)}</strong></td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {l.damagedQuantity > 0
                        ? <span style={{ color: 'var(--warn)' }}>{qty(l.damagedQuantity)}</span>
                        : <span className="muted">—</span>}
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {l.rejectedQuantity > 0
                        ? <span style={{ color: 'var(--danger)' }}>{qty(l.rejectedQuantity)}</span>
                        : <span className="muted">—</span>}
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {l.unitCost === null ? <span className="muted">—</span> : money(l.unitCost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* THE STOCK THIS ACTUALLY MOVED, read back from the
                ledger rather than asserted by the screen. */}
            <h4 style={{ margin: '18px 0 6px' }}>What it did to stock</h4>
            {d.movements.length === 0
              ? (
                <p className="tiny muted">
                  No stock movements are recorded under this receipt. For a posted
                  receipt that would be a discrepancy worth investigating.
                </p>
              )
              : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Entry</th><th>Code</th><th>Movement</th>
                      <th style={{ textAlign: 'right' }}>Quantity</th>
                      <th style={{ textAlign: 'right' }}>Was</th>
                      <th style={{ textAlign: 'right' }}>Became</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.movements.map((m) => (
                      <tr key={m.id}>
                        <td><span className="sku">{m.entryNo}</span></td>
                        <td><span className="sku">{m.sku}</span></td>
                        <td>
                          <StatusPill tone={m.movementType === 'DAMAGE' ? 'warn' : 'ok'}>
                            {m.movementType === 'DAMAGE' ? 'Marked damaged' : 'Inward'}
                          </StatusPill>
                        </td>
                        <td className="num" style={{ textAlign: 'right' }}>{qty(m.quantity)}</td>
                        <td className="num muted" style={{ textAlign: 'right' }}>{qty(m.balanceBefore)}</td>
                        <td className="num" style={{ textAlign: 'right' }}><strong>{qty(m.balanceAfter)}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            <p className="tiny muted" style={{ marginTop: 8 }}>
              Read back from the stock ledger under this receipt&rsquo;s reference, not
              recomputed from the lines above. If the two ever disagreed, this is where
              it would show.{' '}
              <Link to={'/ledger?referenceNo=' + encodeURIComponent(d.grnNo)}>See it in the ledger</Link>.
            </p>
          </>
        )}
      </Modal>
    </>
  );
}
