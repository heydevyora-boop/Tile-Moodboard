import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal.jsx';
import { FieldErrors } from './ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';

/* ============================================================
   ADD OR EDIT A VARIANT
   ============================================================
   The form changes with the category: a tile is asked for its
   thickness and surface, a GRC panel for its projection and
   material. The rules come from the API, not from a copy kept
   here, so a new category needs no frontend change.

   Every rejection the server returns is shown against its field.
   "Validation failed" with nothing named is the message that
   wastes the most time in this business.
   ============================================================ */

const EMPTY = {
  name: '', brandId: '', categoryId: '', headId: '', productLineId: '',
  size: '', lengthMm: '', widthMm: '', thicknessMm: '',
  finish: '', colour: '', uom: 'BOX',
  piecesPerUnit: '', areaSqftPerUnit: '',
  purchasePrice: '', sellingPrice: '', mrp: '',
  priceBasis: 'PER_SQFT', hsnCode: '', reorderLevel: '',
  imageUrl: '', sku: '',
};

export default function ProductForm({ product, brands, categories, onClose, onSaved }) {
  const editing = !!product;

  const [form, setForm] = useState(() => (product
    ? {
      ...EMPTY,
      ...Object.fromEntries(Object.entries({
        name: product.name,
        brandId: product.brand?.id ?? '',
        categoryId: product.category?.id ?? '',
        headId: product.productHead?.id ?? '',
        productLineId: product.productLine?.id ?? '',
        size: product.size,
        lengthMm: product.lengthMm ?? '',
        widthMm: product.widthMm ?? '',
        thicknessMm: product.thicknessMm ?? '',
        finish: product.finish ?? '',
        colour: product.colour ?? '',
        uom: product.uom,
        piecesPerUnit: product.piecesPerUnit ?? '',
        areaSqftPerUnit: product.areaSqftPerUnit ?? '',
        purchasePrice: product.purchasePrice,
        sellingPrice: product.sellingPrice,
        mrp: product.mrp ?? '',
        priceBasis: product.priceBasis,
        hsnCode: product.hsnCode ?? '',
        reorderLevel: product.reorderLevel,
        imageUrl: product.imageUrl ?? '',
      }).map(([k, v]) => [k, v === null ? '' : v])),
    }
    : EMPTY));

  const [attributes, setAttributes] = useState(() => product?.attributes ?? {});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDistinct, setConfirmDistinct] = useState(false);

  const heads = useApi(
    () => api.productHeads.list({ brandId: form.brandId, pageSize: 200 }),
    [form.brandId],
    { skip: !form.brandId },
  );
  const lines = useApi(
    () => api.productLines.list({ brandId: form.brandId, collectionId: form.headId || undefined, pageSize: 200 }),
    [form.brandId, form.headId],
    { skip: !form.brandId },
  );

  const category = categories.find((c) => c.id === form.categoryId);
  const rules = category?.rules ?? null;

  // A near-match must be confirmed deliberately, so a second
  // attempt after an unrelated edit does not sneak past the check.
  useEffect(() => { setConfirmDistinct(false); }, [form.name, form.colour, form.size, form.finish]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const fieldError = useMemo(() => {
    const map = {};
    for (const f of error?.fields ?? []) map[f.field] = f.message;
    return map;
  }, [error]);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    // Blanks are omitted rather than sent as "": an empty string
    // is not the same as "no value given", and the server would
    // have to guess which one was meant.
    const body = {};
    for (const [key, value] of Object.entries(form)) {
      if (value === '' || value === null) continue;
      if (key === 'sku' && editing) continue;   // never renumber
      body[key] = value;
    }
    if (Object.keys(attributes).length > 0) body.attributes = attributes;
    if (confirmDistinct) body.confirmDistinct = true;

    try {
      if (editing) await api.products.update(product.id, body);
      else await api.products.create(body);
      onSaved();
    } catch (err) {
      setError(err);
      // The server returned candidates; ticking through once more
      // means "yes, I looked, it is different".
      if (err.code === 'NEEDS_HUMAN_REVIEW') setConfirmDistinct(true);
    } finally {
      setSaving(false);
    }
  };

  const Field = ({ name, label, children, hint }) => (
    <div className="field">
      <label htmlFor={'f-' + name}>
        {label}
        {rules?.required?.includes(label) && <span style={{ color: 'var(--err)' }}> *</span>}
      </label>
      {children}
      {fieldError[name] && <span className="tiny" style={{ color: 'var(--err)' }}>{fieldError[name]}</span>}
      {hint && !fieldError[name] && <span className="tiny muted">{hint}</span>}
    </div>
  );

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={editing ? 'Edit ' + product.sku : 'New product'}
      subtitle={editing
        ? 'The SKU cannot change: stock movements and order lines already quote it.'
        : 'A variant under a brand and a product head. Its SKU is generated on save.'}
      footer={(
        <>
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : (confirmDistinct ? 'Yes, create it anyway' : 'Save')}
          </button>
        </>
      )}
    >
      <FieldErrors error={error} />

      <form onSubmit={submit} className="stack">
        <div className="grid-2">
          <Field name="brandId" label="Brand">
            <select id="f-brandId" className="select" value={form.brandId} onChange={set('brandId')}>
              <option value="">Choose a brand…</option>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>

          <Field
            name="headId"
            label="Product head / series"
            hint={form.brandId
              ? 'Grey, Brown and Blue of one series all sit under one head.'
              : 'Choose a brand first.'}
          >
            <select id="f-headId" className="select" value={form.headId} onChange={set('headId')} disabled={!form.brandId}>
              <option value="">No series</option>
              {(heads.data?.rows ?? []).map((h) => (
                <option key={h.id} value={h.id}>{h.name} ({h.variantCount})</option>
              ))}
            </select>
          </Field>

          <Field
            name="productLineId"
            label="Product"
            hint={form.brandId
              ? 'A Matte and a Glossy of the same slab are two variants of one Product.'
              : 'Choose a brand first.'}
          >
            <select id="f-productLineId" className="select" value={form.productLineId} onChange={set('productLineId')} disabled={!form.brandId}>
              <option value="">No product (ungrouped)</option>
              {(lines.data?.rows ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.variantCount})</option>
              ))}
            </select>
          </Field>

          <Field name="name" label="Product name">
            <input id="f-name" className="input" value={form.name} onChange={set('name')} />
          </Field>

          <Field name="categoryId" label="Category" hint={rules ? rules.label : undefined}>
            <select id="f-categoryId" className="select" value={form.categoryId} onChange={set('categoryId')}>
              <option value="">Choose a category…</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>

          <Field name="size" label="Size" hint="As printed on the box, e.g. 600x1200mm">
            <input id="f-size" className="input" value={form.size} onChange={set('size')} />
          </Field>
          <Field name="thicknessMm" label="Thickness">
            <input id="f-thicknessMm" className="input" value={form.thicknessMm} onChange={set('thicknessMm')} />
          </Field>
          <Field name="lengthMm" label="Height">
            <input id="f-lengthMm" className="input" value={form.lengthMm} onChange={set('lengthMm')} />
          </Field>
          <Field name="widthMm" label="Width">
            <input id="f-widthMm" className="input" value={form.widthMm} onChange={set('widthMm')} />
          </Field>
          <Field name="colour" label="Colour">
            <input id="f-colour" className="input" value={form.colour} onChange={set('colour')} />
          </Field>
          <Field name="finish" label="Finish">
            <input id="f-finish" className="input" value={form.finish} onChange={set('finish')} />
          </Field>
          <Field name="uom" label="Unit of measurement">
            <select id="f-uom" className="select" value={form.uom} onChange={set('uom')}>
              {['BOX', 'PIECE', 'SQFT', 'SQM', 'SET'].map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </Field>
          <Field name="piecesPerUnit" label="Pieces per unit">
            <input id="f-piecesPerUnit" className="input" value={form.piecesPerUnit} onChange={set('piecesPerUnit')} />
          </Field>
          <Field name="areaSqftPerUnit" label="Sqft per unit">
            <input id="f-areaSqftPerUnit" className="input" value={form.areaSqftPerUnit} onChange={set('areaSqftPerUnit')} />
          </Field>
          <Field name="priceBasis" label="Prices are">
            <select id="f-priceBasis" className="select" value={form.priceBasis} onChange={set('priceBasis')}>
              {['PER_SQFT', 'PER_BOX', 'PER_PIECE', 'PER_SQM'].map((b) => (
                <option key={b} value={b}>{b.replace('PER_', 'per ').toLowerCase()}</option>
              ))}
            </select>
          </Field>
          <Field name="purchasePrice" label="Purchase price">
            <input id="f-purchasePrice" className="input" value={form.purchasePrice} onChange={set('purchasePrice')} />
          </Field>
          <Field name="sellingPrice" label="Selling price">
            <input id="f-sellingPrice" className="input" value={form.sellingPrice} onChange={set('sellingPrice')} />
          </Field>
          <Field name="mrp" label="MRP">
            <input id="f-mrp" className="input" value={form.mrp} onChange={set('mrp')} />
          </Field>
          <Field name="reorderLevel" label="Reorder level">
            <input id="f-reorderLevel" className="input" value={form.reorderLevel} onChange={set('reorderLevel')} />
          </Field>
          <Field name="imageUrl" label="Main image URL">
            <input id="f-imageUrl" className="input" value={form.imageUrl} onChange={set('imageUrl')} />
          </Field>

          {!editing && (
            <Field
              name="sku"
              label="SKU"
              hint="Leave blank and one is generated. Fill it in only to match a code already printed on a shelf or quoted by a supplier."
            >
              <input id="f-sku" className="input" value={form.sku} onChange={set('sku')} placeholder="generated" />
            </Field>
          )}
        </div>

        {/* The fields this category has and tiles do not. */}
        {rules?.allowedAttributes?.length > 0 && (
          <div>
            <p className="kpi-label" style={{ marginBottom: 8 }}>
              {rules.label} attributes
            </p>
            <div className="grid-2">
              {rules.allowedAttributes.map((key) => (
                <div className="field" key={key}>
                  <label htmlFor={'a-' + key}>
                    {key}
                    {rules.required.some((r) => r.toLowerCase() === key.toLowerCase()
                      || r.toLowerCase().replace(/\s/g, '') === key.toLowerCase()) && (
                      <span style={{ color: 'var(--err)' }}> *</span>
                    )}
                  </label>
                  <input
                    id={'a-' + key}
                    className="input"
                    value={attributes[key] ?? ''}
                    onChange={(e) => setAttributes((a) => {
                      const next = { ...a };
                      if (e.target.value === '') delete next[key];
                      else next[key] = e.target.value;
                      return next;
                    })}
                  />
                  {fieldError['attributes.' + key] && (
                    <span className="tiny" style={{ color: 'var(--err)' }}>{fieldError['attributes.' + key]}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {rules && (
          <p className="tiny muted">
            Required for a {rules.label.toLowerCase()}: {rules.required.join(', ')}.
          </p>
        )}
      </form>
    </Modal>
  );
}
