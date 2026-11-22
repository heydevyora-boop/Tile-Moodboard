import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import Modal from '../components/Modal.jsx';
import { Failed, FieldErrors } from '../components/ApiState.jsx';
import PurchaseOrderForm from '../components/PurchaseOrderForm.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { money, qty, day, stamp } from '../lib/format.js';
import { PO_STATUS, GST_TREATMENT } from '../data/purchaseStatus.js';

/* ============================================================
   PURCHASE ORDERS
   ============================================================
   RAISING ONE MOVES NO STOCK. Approving one moves no stock. The
   screen says so, because the single most common misreading of a
   purchase module is that an approved order means the goods are
   in. They are in when a goods receipt says they are.
   ============================================================ */

export default function PurchaseOrders() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');
  const statusParam = params.get('status') || 'all';

  const [search, setSearch] = useState('');
  const [supplierId, setSupplierId] = useState('all');
  const [warehouseId, setWarehouseId] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [creating, setCreating] = useState(false);
  const [acting, setActing] = useState(null);   // { kind, order }
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => ({
    search: search || undefined,
    status: statusParam,
    supplierId,
    warehouseId,
    from: from || undefined,
    to: to || undefined,
    page,
    pageSize,
  }), [search, statusParam, supplierId, warehouseId, from, to, page, pageSize]);

  const list = useApi(() => api.purchaseOrders.list(query), [JSON.stringify(query)]);
  const detail = useApi(() => api.purchaseOrders.get(openId), [openId], { skip: !openId });
  const suppliers = useApi(() => api.suppliers.options(), []);
  const warehouses = useApi(() => api.reference.warehouses(), []);

  const setStatus = (value) => {
    const n = new URLSearchParams(params);
    if (value === 'all') n.delete('status'); else n.set('status', value);
    setParams(n, { replace: true });
    setPage(1);
  };
  const open = (id) => { const n = new URLSearchParams(params); n.set('open', id); setParams(n, { replace: true }); };
  const closeDetail = () => { const n = new URLSearchParams(params); n.delete('open'); setParams(n, { replace: true }); };

  const reset = (fn) => (v) => { fn(v); setPage(1); };

  const act = async () => {
    setBusy(true);
    setError(null);
    try {
      const { kind, order } = acting;
      if (kind === 'submit') await api.purchaseOrders.submit(order.id);
      if (kind === 'approve') await api.purchaseOrders.approve(order.id);
      if (kind === 'cancel') await api.purchaseOrders.cancel(order.id, reason);
      if (kind === 'close') await api.purchaseOrders.close(order.id, reason);
      setActing(null);
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
      key: 'orderNo',
      label: 'Order',
      width: 140,
      sortable: false,
      render: (o) => <span className="sku">{o.orderNo}</span>,
    },
    {
      key: 'supplier',
      label: 'Supplier',
      sortable: false,
      render: (o) => (
        <>
          <strong>{o.supplier?.name}</strong>
          <div className="tiny muted">
            {o.warehouse?.name} · {GST_TREATMENT[o.gst?.treatment]?.label ?? o.gst?.treatment}
          </div>
        </>
      ),
    },
    { key: 'orderDate', label: 'Raised', width: 112, sortable: false, render: (o) => day(o.orderDate) },
    {
      key: 'expectedDate',
      label: 'Expected',
      width: 118,
      sortable: false,
      render: (o) => {
        if (!o.expectedDate) return <span className="muted">—</span>;
        const late = new Date(o.expectedDate) < new Date()
          && ['APPROVED', 'PARTIALLY_RECEIVED'].includes(o.status);
        return (
          <>
            {day(o.expectedDate)}
            {late && <div className="tiny" style={{ color: 'var(--danger)' }}>overdue</div>}
          </>
        );
      },
    },
    {
      key: 'lineCount',
      label: 'Lines',
      align: 'right',
      width: 76,
      sortable: false,
      render: (o) => <span className="num">{qty(o.lineCount ?? 0)}</span>,
    },
    {
      key: 'receiptCount',
      label: 'Receipts',
      align: 'right',
      width: 90,
      sortable: false,
      render: (o) => (o.receiptCount
        ? <span className="num">{qty(o.receiptCount)}</span>
        : <span className="muted">—</span>),
    },
    {
      key: 'grandTotal',
      label: 'Value',
      align: 'right',
      width: 128,
      sortable: false,
      render: (o) => (
        <>
          <strong className="num">{money(o.totals.grandTotal)}</strong>
          <div className="tiny muted num">{money(o.totals.taxTotal)} tax</div>
        </>
      ),
    },
    {
      key: 'status',
      label: 'State',
      width: 150,
      sortable: false,
      render: (o) => {
        const s = PO_STATUS[o.status] ?? { label: o.status, tone: 'info' };
        return <StatusPill tone={s.tone} title={s.note}>{s.label}</StatusPill>;
      },
    },
    {
      key: 'actions',
      label: '',
      width: 96,
      sortable: false,
      render: (o) => <button className="btn btn-sm" onClick={() => open(o.id)}>Open</button>,
    },
  ];

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;

  const d = detail.data;

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            What the studio has agreed to buy. <strong>None of this is stock.</strong>{' '}
            An order &mdash; even an approved one &mdash; is a commitment, not a
            delivery; the inventory figures change only when a{' '}
            <Link to="/goods-receipts">goods receipt</Link> is posted against it.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setCreating(true)}>New purchase order</button>
        </div>
      </div>

      <div className="viewbar">
        {[['all', 'Everything'], ...Object.entries(PO_STATUS).map(([k, v]) => [k, v.label])].map(([k, label]) => (
          <button
            key={k}
            className={'viewtab' + (statusParam === k ? ' is-on' : '')}
            onClick={() => setStatus(k)}
          >
            {label}
          </button>
        ))}
      </div>

      <DataTable
        rows={list.data?.rows ?? []}
        columns={columns}
        rowKey={(o) => o.id}
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
        searchPlaceholder="Search order number, supplier, product…"
        emptyTitle="No purchase orders"
        emptyNote="Nothing matches these filters."
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

      {/* ── create ── */}
      {creating && (
        <PurchaseOrderForm
          onClose={() => setCreating(false)}
          onSaved={(created) => { setCreating(false); list.reload(); open(created.id); }}
        />
      )}

      {/* ── one order ── */}
      <Modal
        open={Boolean(openId)}
        wide
        onClose={closeDetail}
        title={d ? d.orderNo : 'Purchase order'}
        subtitle={d ? d.supplier.name + ' → ' + d.warehouse.name : ''}
        footer={(
          <>
            <button className="btn" onClick={closeDetail}>Close</button>
            {d?.allowed.submit && (
              <button className="btn" onClick={() => { setActing({ kind: 'submit', order: d }); setError(null); }}>
                Submit for approval
              </button>
            )}
            {d?.allowed.cancel && (
              <button className="btn" onClick={() => { setActing({ kind: 'cancel', order: d }); setError(null); }}>
                Cancel order
              </button>
            )}
            {d?.allowed.close && (
              <button className="btn" onClick={() => { setActing({ kind: 'close', order: d }); setError(null); }}>
                Close short
              </button>
            )}
            {d?.allowed.receive && (
              <Link className="btn" to={'/goods-receipts?po=' + d.id}>Receive goods</Link>
            )}
            {d?.allowed.approve && (
              <button className="btn btn-primary"
                onClick={() => { setActing({ kind: 'approve', order: d }); setError(null); }}>
                Approve
              </button>
            )}
          </>
        )}
      >
        {detail.loading && <p className="muted">Reading from the database…</p>}
        {detail.error && <FieldErrors error={detail.error} />}
        {d && (
          <>
            <div className="notice notice-info">
              <span aria-hidden="true">●</span>
              <div>
                <strong>{PO_STATUS[d.status]?.label}.</strong> {PO_STATUS[d.status]?.note}
                {d.receiptCount > 0 && <> {d.receiptCount} receipt(s) posted against it.</>}
              </div>
            </div>

            <div className="summary-strip">
              <div><span className="kpi-label">Raised</span><strong>{day(d.orderDate)}</strong></div>
              <div><span className="kpi-label">Expected</span><strong>{d.expectedDate ? day(d.expectedDate) : '—'}</strong></div>
              <div><span className="kpi-label">Terms</span><strong>{d.paymentTerms ?? '—'}</strong></div>
              <div><span className="kpi-label">By</span><strong>{d.createdBy ?? '—'}</strong></div>
              <div><span className="kpi-label">Approved by</span><strong>{d.approvedBy ?? '—'}</strong></div>
            </div>

            <p className="tiny muted" style={{ marginTop: 10 }}>
              <strong>{GST_TREATMENT[d.gst.treatment]?.label}.</strong>{' '}
              {GST_TREATMENT[d.gst.treatment]?.note}{' '}
              Supplier state {d.gst.supplierStateCode ?? '—'}, place of supply{' '}
              {d.gst.placeOfSupplyCode ?? '—'}. Frozen on this order: a later address
              change cannot alter the tax on it.
            </p>

            <table className="table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>#</th><th>Code</th><th>Product</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Rate</th>
                  <th style={{ textAlign: 'right' }}>Disc.</th>
                  <th style={{ textAlign: 'right' }}>Taxable</th>
                  <th style={{ textAlign: 'right' }}>GST</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th style={{ textAlign: 'right' }}>Received</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.lineNo}</td>
                    <td><span className="sku">{l.sku}</span></td>
                    <td>
                      {l.name}
                      {l.hsnCode && <div className="tiny muted">HSN {l.hsnCode}</div>}
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(l.quantity)} {l.uom?.toLowerCase()}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{money(l.unitPrice)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {l.discountAmount > 0 ? money(l.discountAmount) : <span className="muted">—</span>}
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}>{money(l.taxableValue)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {money(l.taxAmount)}
                      <div className="tiny muted">{l.taxRate}%</div>
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}><strong>{money(l.lineTotal)}</strong></td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {qty(l.receivedQuantity)}
                      {l.outstandingQuantity > 0 && (
                        <div className="tiny" style={{ color: 'var(--warn)' }}>{qty(l.outstandingQuantity)} due</div>
                      )}
                      {l.rejectedQuantity > 0 && (
                        <div className="tiny" style={{ color: 'var(--danger)' }}>{qty(l.rejectedQuantity)} rejected</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="summary-strip" style={{ marginTop: 12 }}>
              <div><span className="kpi-label">Gross</span><strong className="num">{money(d.totals.subTotal)}</strong></div>
              <div><span className="kpi-label">Discount</span><strong className="num">{money(d.totals.discountTotal)}</strong></div>
              <div><span className="kpi-label">Taxable</span><strong className="num">{money(d.totals.taxableTotal)}</strong></div>
              {d.gst.treatment === 'INTER_STATE'
                ? <div><span className="kpi-label">IGST</span><strong className="num">{money(d.totals.igstTotal)}</strong></div>
                : (
                  <>
                    <div><span className="kpi-label">CGST</span><strong className="num">{money(d.totals.cgstTotal)}</strong></div>
                    <div><span className="kpi-label">SGST</span><strong className="num">{money(d.totals.sgstTotal)}</strong></div>
                  </>
                )}
              <div><span className="kpi-label">Grand total</span><strong className="num">{money(d.totals.grandTotal)}</strong></div>
            </div>

            {d.receipts.length > 0 && (
              <>
                <h4 style={{ margin: '18px 0 6px' }}>Goods receipts</h4>
                <table className="table">
                  <thead><tr><th>Receipt</th><th>Date</th><th>Supplier doc</th><th>By</th><th>State</th></tr></thead>
                  <tbody>
                    {d.receipts.map((r) => (
                      <tr key={r.id}>
                        <td><Link className="sku" to={'/goods-receipts?open=' + r.id}>{r.grnNo}</Link></td>
                        <td className="tiny">{day(r.receiptDate)}</td>
                        <td className="tiny">{r.supplierDocNo ?? '—'}</td>
                        <td className="tiny">{r.receivedBy ?? '—'}</td>
                        <td className="tiny">{r.status.toLowerCase()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {d.cancelReason && (
              <p className="tiny muted" style={{ marginTop: 12 }}>
                Cancelled by {d.cancelledBy} on {stamp(d.cancelledAt)}: {d.cancelReason}
              </p>
            )}
            {d.closeReason && (
              <p className="tiny muted" style={{ marginTop: 12 }}>
                Closed by {d.closedBy} on {stamp(d.closedAt)}: {d.closeReason}
              </p>
            )}
          </>
        )}
      </Modal>

      {/* ── confirm a transition ── */}
      <Modal
        open={Boolean(acting)}
        onClose={() => { setActing(null); setError(null); }}
        title={acting ? ({
          submit: 'Submit for approval',
          approve: 'Approve',
          cancel: 'Cancel order',
          close: 'Close short',
        }[acting.kind] + ' — ' + acting.order.orderNo) : ''}
        footer={(
          <>
            <button className="btn" onClick={() => setActing(null)} disabled={busy}>Back</button>
            <button className="btn btn-primary" onClick={act} disabled={busy}>
              {busy ? 'Working…' : 'Confirm'}
            </button>
          </>
        )}
      >
        <FieldErrors error={error} />
        {acting?.kind === 'approve' && (
          <>
            <p>
              This commits the studio to buying {money(acting.order.totals.grandTotal)} from{' '}
              {acting.order.supplier.name}, and the order may then be sent to them.
            </p>
            <p className="tiny muted">
              <strong>No stock moves.</strong> Approving says what will be bought, not
              what has arrived. The inventory figures change when the goods are
              received and a receipt is posted.
            </p>
          </>
        )}
        {acting?.kind === 'submit' && (
          <p>The order goes forward for approval and can no longer be edited freely.</p>
        )}
        {acting?.kind === 'cancel' && (
          <>
            <p>
              Cancelling says this order never happened. It is allowed only because
              nothing has been received against it.
            </p>
            <div className="field">
              <label htmlFor="po-reason">Reason</label>
              <input id="po-reason" className="input" value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Supplier cannot meet the date." />
            </div>
          </>
        )}
        {acting?.kind === 'close' && (
          <>
            <p>
              Closing finishes the order off at whatever has arrived. Unlike
              cancelling, it does not claim the order never happened &mdash; it
              records that the studio has stopped waiting.
            </p>
            <div className="field">
              <label htmlFor="po-close">Reason</label>
              <input id="po-close" className="input" value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Supplier cannot supply the balance." />
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
