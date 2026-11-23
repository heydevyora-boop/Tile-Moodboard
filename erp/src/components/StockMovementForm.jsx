import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal.jsx';
import { FieldErrors } from './ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { qty } from '../lib/format.js';

/* ============================================================
   RECORDING A MOVEMENT
   ============================================================
   One form behind Inward, Outward and Adjustment, because the
   three post the same kind of record through the same service and
   differ only in direction, in which reasons make sense, and in
   whether an explanation is compulsory.

   IT CARRIES AN IDEMPOTENCY KEY, minted when the dialog opens.
   Press Save twice, or lose the connection and press it again,
   and the second request is refused by the database as a
   duplicate rather than posting the movement twice. The key is
   replaced only after a movement is actually accepted, so a
   corrected and resubmitted form is a new movement and a
   resubmitted identical one is not.

   It also shows the stock that is really there, for the product
   and warehouse chosen, BEFORE anything is posted -- so "not
   enough stock" is visible on the form rather than arriving as a
   rejection after Save.
   ============================================================ */

const REASONS = {
  in: [
    ['PURCHASE_RECEIPT', 'Purchase receipt'],
    ['SALES_RETURN', 'Customer return'],
    ['OTHER', 'Other'],
  ],
  out: [
    ['SALES_DISPATCH', 'Sales dispatch'],
    ['SAMPLE_ISSUE', 'Sample issued'],
    ['PURCHASE_RETURN', 'Returned to supplier'],
    ['OTHER', 'Other'],
  ],
  adjust: [
    ['STOCK_COUNT_CORRECTION', 'Stock count correction'],
    ['DAMAGE', 'Damage found'],
    ['SAMPLE_ISSUE', 'Sample issued, never recorded'],
    ['OTHER', 'Other'],
  ],
};

function newKey() {
  // crypto.randomUUID is in every browser this app supports; the
  // fallback is for a non-secure origin, where it is absent.
  return (globalThis.crypto?.randomUUID?.())
    ?? ('form-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}

export default function StockMovementForm({ mode, open, onClose, onPosted, fixedWarehouseId }) {
  const [sku, setSku] = useState('');
  const [warehouseId, setWarehouseId] = useState(fixedWarehouseId ?? '');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState(REASONS[mode][0][0]);
  const [direction, setDirection] = useState('OUT');
  const [referenceNo, setReferenceNo] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [remarks, setRemarks] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [posted, setPosted] = useState(null);

  const warehouses = useApi(() => api.reference.warehouses(), []);
  const [lookup, setLookup] = useState('');

  /* The product list behind the SKU box, narrowed as you type.
     Debounced, because a request per keystroke on a catalogue
     search is a load test nobody asked for. */
  useEffect(() => {
    const t = setTimeout(() => setLookup(sku.trim()), 250);
    return () => clearTimeout(t);
  }, [sku]);

  const matches = useApi(
    () => api.products.list({ search: lookup, pageSize: 12 }),
    [lookup],
    { skip: lookup.length < 2 },
  );

  /* What is really on the shelf for this combination. Read from
     the same projection the Inventory screen shows, so the form
     and the screen can never disagree. */
  const chosen = useMemo(
    () => (matches.data?.rows ?? []).find((p) => p.sku.toUpperCase() === sku.trim().toUpperCase()),
    [matches.data, sku],
  );

  const onHand = useApi(
    () => api.inventory.list({ search: sku.trim(), warehouseId, pageSize: 5 }),
    [sku.trim(), warehouseId],
    { skip: !chosen || !warehouseId },
  );
  const here = (onHand.data?.rows ?? []).find(
    (r) => r.sku.toUpperCase() === sku.trim().toUpperCase() && r.warehouse?.id === warehouseId,
  );

  // Default to the one warehouse, where there is only one; nobody
  // should have to choose from a list of one.
  useEffect(() => {
    if (fixedWarehouseId) { setWarehouseId(fixedWarehouseId); return; }
    const list = warehouses.data?.rows ?? [];
    if (!warehouseId && list.length === 1) setWarehouseId(list[0].id);
  }, [warehouses.data, warehouseId, fixedWarehouseId]);

  const reset = () => {
    setSku(''); setQuantity(''); setReferenceNo(''); setUnitCost(''); setRemarks('');
    setReason(REASONS[mode][0][0]);
    setDirection('OUT');
    setError(null);
    setIdempotencyKey(newKey());
  };

  const close = () => { reset(); setPosted(null); onClose(); };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = {
        product: sku.trim(),
        warehouseId,
        quantity,
        remarks: remarks.trim() || undefined,
        referenceNo: referenceNo.trim() || undefined,
        idempotencyKey,
      };

      const result = mode === 'adjust'
        ? await api.inventory.adjust({ ...body, direction, reason, remarks: remarks.trim() })
        : mode === 'in'
          ? await api.inventory.inward({ ...body, reason, unitCost: unitCost === '' ? undefined : unitCost })
          : await api.inventory.outward({ ...body, reason });

      setPosted(result);
      /* A NEW KEY ONLY NOW. The movement is on the ledger, so the
         next one the clerk records is genuinely a different
         movement and must not be refused as a duplicate. */
      setIdempotencyKey(newKey());
      setSku(''); setQuantity(''); setReferenceNo(''); setUnitCost(''); setRemarks('');
      onPosted?.(result);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const title = mode === 'in' ? 'Record a receipt'
    : mode === 'out' ? 'Record an issue'
      : 'Post an adjustment';

  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      subtitle={mode === 'adjust'
        ? 'Corrects a balance, and says why. The reason is what somebody reads in six months.'
        : 'Posted to the append-only stock ledger. It cannot be edited afterwards — only reversed.'}
      footer={(
        <>
          <button type="button" className="btn" onClick={close}>Close</button>
          <button
            type="submit"
            form="movement-form"
            className="btn btn-primary"
            disabled={saving || !sku.trim() || !warehouseId || !quantity}
          >
            {saving ? 'Posting…' : 'Post movement'}
          </button>
        </>
      )}
    >
      {posted && (
        <div className="notice notice-ok">
          <span aria-hidden="true">●</span>
          <div>
            <strong>Entry {posted.entryNo} posted for {posted.sku}.</strong>
            <div className="tiny" style={{ marginTop: 4 }}>
              On hand {qty(posted.before.onHand)} &rarr; {qty(posted.after.onHand)}
              {' · '}can be sold {qty(posted.before.available)} &rarr; {qty(posted.after.available)}
            </div>
          </div>
        </div>
      )}

      <FieldErrors error={error} />

      <form id="movement-form" onSubmit={submit} className="stack">
        <div className="grid-2">
          <div className="field">
            <label htmlFor="m-sku">Product code</label>
            <input
              id="m-sku"
              className="input"
              list="movement-product-list"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder="DV-1001"
              autoComplete="off"
              required
            />
            <datalist id="movement-product-list">
              {(matches.data?.rows ?? []).map((p) => (
                <option key={p.id} value={p.sku}>{p.name}</option>
              ))}
            </datalist>
            <span className="tiny muted">
              {chosen
                ? [chosen.name, chosen.brand?.name, 'per ' + chosen.uom].filter(Boolean).join(' · ')
                : 'Type at least two characters to search the Product Master.'}
            </span>
          </div>

          <div className="field">
            <label htmlFor="m-warehouse">Warehouse</label>
            <select
              id="m-warehouse"
              className="select"
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              disabled={Boolean(fixedWarehouseId)}
              required
            >
              <option value="">Choose…</option>
              {(warehouses.data?.rows ?? []).map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
            {/* WHAT IS REALLY THERE, before anything is posted. An
                outward that cannot succeed should be visible on the
                form, not arrive as a rejection after Save. */}
            <span className="tiny muted">
              {here
                ? 'Holding ' + qty(here.physical) + ' here, ' + qty(here.available) + ' of it sellable.'
                : 'Deactivated warehouses are not listed: no movement can be posted against one.'}
            </span>
          </div>
        </div>

        <div className="grid-2">
          <div className="field">
            <label htmlFor="m-qty">Quantity</label>
            <input
              id="m-qty"
              className="input"
              type="number"
              min="0.001"
              step="0.001"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
            />
            <span className="tiny muted">
              Always positive. The direction comes from the movement, never from a minus sign.
            </span>
          </div>

          <div className="field">
            <label htmlFor="m-reason">Reason</label>
            <select
              id="m-reason"
              className="select"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              {REASONS[mode].map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </div>
        </div>

        {mode === 'adjust' && (
          <div className="field">
            <label htmlFor="m-direction">Direction</label>
            <select
              id="m-direction"
              className="select"
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
            >
              <option value="IN">Increase &mdash; more was found than the system shows</option>
              <option value="OUT">Decrease &mdash; less was found than the system shows</option>
            </select>
          </div>
        )}

        {mode !== 'adjust' && (
          <div className="grid-2">
            <div className="field">
              <label htmlFor="m-ref">Document number</label>
              <input
                id="m-ref"
                className="input"
                value={referenceNo}
                onChange={(e) => setReferenceNo(e.target.value)}
                placeholder={mode === 'in' ? 'Supplier invoice or GRN' : 'Delivery note or order'}
              />
            </div>

            {mode === 'in' ? (
              <div className="field">
                <label htmlFor="m-cost">Unit cost</label>
                <input
                  id="m-cost"
                  className="input"
                  type="number"
                  min="0"
                  step="0.01"
                  value={unitCost}
                  onChange={(e) => setUnitCost(e.target.value)}
                />
                <span className="tiny muted">
                  Recorded against the movement. No figure on these screens is valued
                  from it yet &mdash; the studio has not chosen a valuation method &mdash;
                  but every method needs it, and it cannot be reconstructed later.
                </span>
              </div>
            ) : <div />}
          </div>
        )}

        <div className="field">
          <label htmlFor="m-remarks">{mode === 'adjust' ? 'Why (required)' : 'Remarks'}</label>
          <textarea
            id="m-remarks"
            className="input"
            rows={2}
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            required={mode === 'adjust'}
            placeholder={mode === 'adjust'
              ? 'Counted on the 21st: two boxes fewer than the system showed.'
              : 'Optional'}
          />
        </div>
      </form>
    </Modal>
  );
}
