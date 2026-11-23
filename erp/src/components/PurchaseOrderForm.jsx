import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal.jsx';
import { FieldErrors } from './ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { money, qty } from '../lib/format.js';
import { GST_TREATMENT } from '../data/purchaseStatus.js';

/* ============================================================
   RAISING A PURCHASE ORDER
   ============================================================
   EVERY LINE IS A REAL PRODUCT. The product box searches the
   Product Master and a line is only added once a SKU matches a
   record: a typed name cannot create a product here, and cannot
   be sent as a line. That is the brief's rule and it is enforced
   again server-side, where lines are matched by product id.

   THE GST TREATMENT IS SHOWN BEFORE SAVING, worked out from the
   chosen supplier's state and the chosen warehouse's state, so
   nobody is surprised by CGST where they expected IGST. The
   server decides it again on save; this is the preview, not the
   authority.
   ============================================================ */

export default function PurchaseOrderForm({ onClose, onSaved }) {
  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [orderDate, setOrderDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [expectedDate, setExpectedDate] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [otherCharges, setOtherCharges] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([]);

  const [sku, setSku] = useState('');
  const [lookup, setLookup] = useState('');
  const [quantity, setQuantity] = useState('');
  const [rate, setRate] = useState('');
  const [discount, setDiscount] = useState('');

  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const suppliers = useApi(() => api.suppliers.options(), []);
  const warehouses = useApi(() => api.reference.warehouses(), []);

  useEffect(() => {
    const t = setTimeout(() => setLookup(sku.trim()), 250);
    return () => clearTimeout(t);
  }, [sku]);

  const matches = useApi(
    () => api.products.list({ search: lookup, pageSize: 12 }),
    [lookup],
    { skip: lookup.length < 2 },
  );

  const supplier = (suppliers.data?.rows ?? []).find((s) => s.id === supplierId);
  const warehouse = (warehouses.data?.rows ?? []).find((w) => w.id === warehouseId);

  // Default the terms from the supplier, and the warehouse when
  // there is only one. Neither should have to be typed.
  useEffect(() => { if (supplier && !paymentTerms) setPaymentTerms(supplier.paymentTerms ?? ''); },
    [supplier, paymentTerms]);
  useEffect(() => {
    const all = warehouses.data?.rows ?? [];
    if (!warehouseId && all.length === 1) setWarehouseId(all[0].id);
  }, [warehouses.data, warehouseId]);

  /* A PREVIEW of the tax treatment, computed the same way the
     server will: supplier state against the delivery warehouse's
     state. Shown so the figures are not a surprise. */
  const treatment = useMemo(() => {
    if (!supplier) return null;
    if (!supplier.gstin) return 'UNREGISTERED';
    const a = supplier.stateCode ?? (supplier.gstin ?? '').slice(0, 2);
    const b = warehouse?.stateCode;
    if (!a || !b) return null;
    return a === b ? 'INTRA_STATE' : 'INTER_STATE';
  }, [supplier, warehouse]);

  const chosen = (matches.data?.rows ?? [])
    .find((p) => p.sku.toUpperCase() === sku.trim().toUpperCase());

  const addLine = () => {
    if (!chosen || !(Number(quantity) > 0)) return;
    setLines([...lines, {
      productId: chosen.id,
      sku: chosen.sku,
      name: chosen.name,
      uom: chosen.uom,
      quantity: Number(quantity),
      unitPrice: rate === '' ? (chosen.purchasePrice ?? '') : rate,
      discountPercent: discount === '' ? 0 : Number(discount),
    }]);
    setSku('');
    setQuantity('');
    setRate('');
    setDiscount('');
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.purchaseOrders.create({
        supplierId,
        warehouseId,
        orderDate,
        expectedDate: expectedDate || null,
        paymentTerms: paymentTerms || null,
        otherCharges: otherCharges === '' ? 0 : otherCharges,
        notes: notes || null,
        lines: lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          uom: l.uom,
          unitPrice: l.unitPrice === '' ? null : l.unitPrice,
          discountPercent: l.discountPercent,
        })),
      });
      onSaved(created);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const ready = supplierId && warehouseId && lines.length > 0
    && lines.every((l) => l.unitPrice !== '' && l.unitPrice !== null);

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="New purchase order"
      subtitle="Saved as a draft. Nothing is committed and no stock moves until it is approved and then received."
      footer={(
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" form="po-form" type="submit" disabled={busy || !ready}>
            {busy ? 'Saving…' : 'Save as draft'}
          </button>
        </>
      )}
    >
      <FieldErrors error={error} />

      <form id="po-form" onSubmit={submit} className="stack">
        <div className="grid-2">
          <div className="field">
            <label htmlFor="po-supplier">Supplier</label>
            <select id="po-supplier" className="select" value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)} required>
              <option value="">Choose…</option>
              {(suppliers.data?.rows ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}{s.state ? ' — ' + s.state : ''}
                </option>
              ))}
            </select>
            <span className="tiny muted">
              {supplier
                ? (supplier.gstin ? supplier.gstin : 'No GSTIN: unregistered, so no GST is charged.')
                : 'Only active suppliers are listed.'}
            </span>
          </div>

          <div className="field">
            <label htmlFor="po-warehouse">Deliver to</label>
            <select id="po-warehouse" className="select" value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)} required>
              <option value="">Choose…</option>
              {(warehouses.data?.rows ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <span className="tiny muted">
              For goods the place of supply is where they are delivered, so this
              decides the tax with the supplier&rsquo;s state.
            </span>
          </div>
        </div>

        {treatment && (
          <div className="notice notice-info">
            <span aria-hidden="true">●</span>
            <div>
              <strong>{GST_TREATMENT[treatment].label}.</strong> {GST_TREATMENT[treatment].note}
            </div>
          </div>
        )}
        {supplier && warehouse && !treatment && (
          <div className="notice notice-warn">
            <span aria-hidden="true">●</span>
            <div>
              A GST state code is missing on the supplier or the warehouse, so the tax
              cannot be worked out. Saving will be refused rather than guessed at
              &mdash; set the code on the record first.
            </div>
          </div>
        )}

        <div className="grid-3">
          <div className="field">
            <label htmlFor="po-date">Order date</label>
            <input id="po-date" className="input" type="date" value={orderDate}
              onChange={(e) => setOrderDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="po-expected">Expected delivery</label>
            <input id="po-expected" className="input" type="date" value={expectedDate}
              onChange={(e) => setExpectedDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="po-terms">Payment terms</label>
            <input id="po-terms" className="input" value={paymentTerms}
              onChange={(e) => setPaymentTerms(e.target.value)} placeholder="30 days" />
          </div>
        </div>

        <div className="field">
          <label>Lines</label>
          {lines.length === 0
            ? <p className="tiny muted">Nothing added yet. Every line must be a product from the Product Master.</p>
            : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Code</th><th>Product</th>
                    <th style={{ textAlign: 'right' }}>Qty</th>
                    <th style={{ textAlign: 'right' }}>Rate</th>
                    <th style={{ textAlign: 'right' }}>Disc %</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.productId + ':' + i}>
                      <td><span className="sku">{l.sku}</span></td>
                      <td>{l.name}</td>
                      <td className="num" style={{ textAlign: 'right' }}>{qty(l.quantity)} {l.uom?.toLowerCase()}</td>
                      <td className="num" style={{ textAlign: 'right' }}>
                        {l.unitPrice === '' || l.unitPrice === null
                          ? <span style={{ color: 'var(--danger)' }}>rate needed</span>
                          : money(Number(l.unitPrice))}
                      </td>
                      <td className="num" style={{ textAlign: 'right' }}>{l.discountPercent || '—'}</td>
                      <td>
                        <button type="button" className="btn btn-sm"
                          onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          <span className="tiny muted">
            Tax is worked out on the server from each product&rsquo;s HSN code and
            frozen onto the order, so a later rate change cannot alter it.
          </span>
        </div>

        <div className="grid-4">
          <div className="field">
            <label htmlFor="po-sku">Product code</label>
            <input id="po-sku" className="input" list="po-product-list" value={sku}
              onChange={(e) => setSku(e.target.value)} autoComplete="off" placeholder="DV-1001" />
            <datalist id="po-product-list">
              {(matches.data?.rows ?? []).map((p) => <option key={p.id} value={p.sku}>{p.name}</option>)}
            </datalist>
            <span className="tiny muted">
              {chosen ? chosen.name : 'Type two characters to search.'}
            </span>
          </div>
          <div className="field">
            <label htmlFor="po-qty">Quantity</label>
            <input id="po-qty" className="input" type="number" min="0.001" step="0.001"
              value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="po-rate">Rate</label>
            <input id="po-rate" className="input" type="number" min="0" step="0.01"
              value={rate} onChange={(e) => setRate(e.target.value)}
              placeholder={chosen?.purchasePrice ? String(chosen.purchasePrice) : ''} />
            <span className="tiny muted">Blank uses the product&rsquo;s purchase price.</span>
          </div>
          <div className="field">
            <label htmlFor="po-disc">Discount %</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input id="po-disc" className="input" type="number" min="0" max="100" step="0.01"
                value={discount} onChange={(e) => setDiscount(e.target.value)} />
              <button type="button" className="btn" onClick={addLine} disabled={!chosen || !(Number(quantity) > 0)}>
                Add
              </button>
            </div>
          </div>
        </div>

        <div className="grid-2">
          <div className="field">
            <label htmlFor="po-other">Other charges</label>
            <input id="po-other" className="input" type="number" min="0" step="0.01"
              value={otherCharges} onChange={(e) => setOtherCharges(e.target.value)} />
            <span className="tiny muted">Freight and the like. Added after tax.</span>
          </div>
          <div className="field">
            <label htmlFor="po-notes">Notes</label>
            <input id="po-notes" className="input" value={notes}
              onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
      </form>
    </Modal>
  );
}
