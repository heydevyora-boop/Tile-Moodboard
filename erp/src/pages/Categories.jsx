import { useState } from 'react';
import { Link } from 'react-router-dom';
import Modal from '../components/Modal.jsx';
import StatusPill from '../components/StatusPill.jsx';
import { Failed, FieldErrors } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { qty } from '../lib/format.js';

/* ============================================================
   CATALOGUE STRUCTURE — CONNECTED
   ============================================================
   Three tabs over one idea: the shape of the catalogue.

       Brand  ->  Product Head (series)  ->  Variant (SKU)

   Kajaria -> Neo Sapien -> Grey, Brown, Blue.

   Categories remain the commercial grouping, which is a
   different axis: a head belongs to one, and it decides which
   fields a variant must carry.
   ============================================================ */

const TABS = {
  brands: 'Brands',
  heads: 'Product Heads',
  categories: 'Categories',
};

export default function Categories() {
  const [tab, setTab] = useState('brands');

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            The shape of the catalogue: <strong>Brand → Product Head → Variant</strong>.
            Neo Sapien in Grey, Brown and Blue is one head with three variants,
            not three products — adding a colour never creates a second head.
          </p>
        </div>
      </div>

      <div className="viewbar">
        {Object.entries(TABS).map(([k, label]) => (
          <button key={k} className={'viewtab' + (tab === k ? ' is-on' : '')} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'brands' && <Brands />}
      {tab === 'heads' && <ProductHeads />}
      {tab === 'categories' && <CategoryList />}
    </>
  );
}

/* ── brands ──────────────────────────────────────────────────── */

function Brands() {
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);
  const list = useApi(() => api.brands.list({ search: search || undefined, pageSize: 200 }), [search]);

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;

  return (
    <>
      <section className="panel">
        <div className="toolbar">
          <input
            className="input toolbar-search"
            type="search"
            value={search}
            placeholder="Search brands…"
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn btn-primary toolbar-spacer" onClick={() => setEditing({})}>New brand</button>
        </div>

        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Brand</th><th>Code</th>
                <th className="right">Product heads</th><th className="right">Variants</th>
                <th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {(list.data?.rows ?? []).map((b) => (
                <tr key={b.id}>
                  <td><strong>{b.name}</strong></td>
                  <td><span className="sku">{b.code}</span></td>
                  <td className="right num">{qty(b.productHeadCount)}</td>
                  <td className="right num">{qty(b.productCount)}</td>
                  <td>
                    <StatusPill tone={b.isActive ? 'ok' : 'inert'}>
                      {b.isActive ? 'Active' : 'Inactive'}
                    </StatusPill>
                  </td>
                  <td className="right">
                    <button className="btn btn-sm" onClick={() => setEditing(b)}>Edit</button>
                  </td>
                </tr>
              ))}
              {(list.data?.rows ?? []).length === 0 && !list.loading && (
                <tr><td colSpan={6} className="muted">No brands match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="table-foot">
          <span>{list.data?.total ?? 0} brand(s){list.loading && ' · refreshing'}</span>
        </div>
      </section>

      {editing && (
        <BrandForm
          brand={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); list.reload(); }}
        />
      )}
    </>
  );
}

function BrandForm({ brand, onClose, onSaved }) {
  const [name, setName] = useState(brand?.name ?? '');
  const [isActive, setIsActive] = useState(brand?.isActive ?? true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDistinct, setConfirmDistinct] = useState(false);

  const save = async () => {
    setSaving(true); setError(null);
    try {
      if (brand) await api.brands.update(brand.id, { name, isActive });
      else await api.brands.create({ name, isActive, ...(confirmDistinct ? { confirmDistinct: true } : {}) });
      onSaved();
    } catch (err) {
      setError(err);
      if (err.code === 'NEEDS_HUMAN_REVIEW') setConfirmDistinct(true);
    } finally { setSaving(false); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={brand ? 'Edit ' + brand.name : 'New brand'}
      footer={(
        <>
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : (confirmDistinct ? 'Yes, it is a different brand' : 'Save')}
          </button>
        </>
      )}
    >
      <FieldErrors error={error} />
      <div className="stack">
        <div className="field">
          <label htmlFor="b-name">Brand name</label>
          <input id="b-name" className="input" value={name} onChange={(e) => { setName(e.target.value); setConfirmDistinct(false); }} />
          <span className="tiny muted">
            Case and spacing are ignored when checking for a duplicate:
            &ldquo;Kajaria&rdquo; and &ldquo;kajaria &rdquo; are one brand.
          </span>
        </div>
        <label className="tiny" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Active
        </label>
        {brand && (
          <p className="tiny muted">
            The brand code <span className="sku">{brand.code}</span> cannot be changed:
            it is part of every SKU already issued under this brand.
          </p>
        )}
      </div>
    </Modal>
  );
}

/* ── product heads ───────────────────────────────────────────── */

function ProductHeads() {
  const [search, setSearch] = useState('');
  const [brandId, setBrandId] = useState('all');
  const [editing, setEditing] = useState(null);
  const [openId, setOpenId] = useState(null);

  const brands = useApi(() => api.brands.list({ pageSize: 200 }), []);
  const categories = useApi(() => api.reference.categories(), []);
  const list = useApi(
    () => api.productHeads.list({ search: search || undefined, brandId: brandId === 'all' ? undefined : brandId, pageSize: 200 }),
    [search, brandId],
  );

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;

  return (
    <>
      <section className="panel">
        <div className="toolbar">
          <input
            className="input toolbar-search"
            type="search"
            value={search}
            placeholder="Search product heads…"
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="select" value={brandId} onChange={(e) => setBrandId(e.target.value)} aria-label="Brand">
            <option value="all">All brands</option>
            {(brands.data?.rows ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button className="btn btn-primary toolbar-spacer" onClick={() => setEditing({})}>New product head</button>
        </div>

        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Product head</th><th>Brand</th><th>Category</th>
                <th className="right">Variants</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {(list.data?.rows ?? []).map((h) => (
                <tr key={h.id}>
                  <td><strong>{h.name}</strong><div className="sku">{h.code}</div></td>
                  <td>{h.brand?.name}</td>
                  <td>{h.category?.name ?? <span className="muted tiny">not set</span>}</td>
                  <td className="right num">{qty(h.variantCount)}</td>
                  <td><StatusPill tone={h.isActive ? 'ok' : 'inert'}>{h.isActive ? 'Active' : 'Inactive'}</StatusPill></td>
                  <td className="right">
                    <button className="btn btn-sm" onClick={() => setOpenId(h.id)}>Variants</button>
                    {' '}
                    <button className="btn btn-sm" onClick={() => setEditing(h)}>Edit</button>
                  </td>
                </tr>
              ))}
              {(list.data?.rows ?? []).length === 0 && !list.loading && (
                <tr><td colSpan={6} className="muted">No product heads match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="table-foot">
          <span>{list.data?.total ?? 0} product head(s){list.loading && ' · refreshing'}</span>
        </div>
      </section>

      {editing && (
        <HeadForm
          head={editing.id ? editing : null}
          brands={brands.data?.rows ?? []}
          categories={categories.data?.rows ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); list.reload(); }}
        />
      )}

      {openId && <HeadVariants id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function HeadForm({ head, brands, categories, onClose, onSaved }) {
  const [name, setName] = useState(head?.name ?? '');
  const [brandId, setBrandId] = useState(head?.brand?.id ?? '');
  const [categoryId, setCategoryId] = useState(head?.category?.id ?? '');
  const [description, setDescription] = useState(head?.description ?? '');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDistinct, setConfirmDistinct] = useState(false);

  const save = async () => {
    setSaving(true); setError(null);
    const body = { name, brandId, categoryId: categoryId || null, description: description || null };
    try {
      if (head) await api.productHeads.update(head.id, body);
      else await api.productHeads.create({ ...body, ...(confirmDistinct ? { confirmDistinct: true } : {}) });
      onSaved();
    } catch (err) {
      setError(err);
      if (err.code === 'NEEDS_HUMAN_REVIEW') setConfirmDistinct(true);
    } finally { setSaving(false); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={head ? 'Edit ' + head.name : 'New product head'}
      subtitle="One head holds every colour, finish and size of a series."
      footer={(
        <>
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : (confirmDistinct ? 'Yes, it is a different series' : 'Save')}
          </button>
        </>
      )}
    >
      <FieldErrors error={error} />
      <div className="stack">
        <div className="field">
          <label htmlFor="h-brand">Brand</label>
          <select id="h-brand" className="select" value={brandId} onChange={(e) => setBrandId(e.target.value)} disabled={!!head}>
            <option value="">Choose a brand…</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          {head && <span className="tiny muted">A head cannot move brand: its variants&rsquo; SKUs carry the brand code.</span>}
        </div>
        <div className="field">
          <label htmlFor="h-name">Product head / series name</label>
          <input id="h-name" className="input" value={name} onChange={(e) => { setName(e.target.value); setConfirmDistinct(false); }} placeholder="Neo Sapien" />
        </div>
        <div className="field">
          <label htmlFor="h-cat">Category</label>
          <select id="h-cat" className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Not set</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <span className="tiny muted">Decides which fields a variant of this head must carry.</span>
        </div>
        <div className="field">
          <label htmlFor="h-desc">Description</label>
          <textarea id="h-desc" className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

function HeadVariants({ id, onClose }) {
  const head = useApi(() => api.productHeads.get(id), [id]);
  const h = head.data;

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={h ? h.brand.name + ' ' + h.name : 'Loading…'}
      subtitle={h ? h.variantCount + ' variant(s) under one head' : ''}
      footer={<button className="btn" onClick={onClose}>Close</button>}
    >
      {head.error && <FieldErrors error={head.error} />}
      {h && (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>SKU</th><th>Variant</th><th>Colour</th><th>Finish</th>
                <th>Size</th><th className="right">On hand</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {h.variants.map((v) => (
                <tr key={v.id}>
                  <td><span className="sku">{v.sku}</span></td>
                  <td><strong>{v.name}</strong></td>
                  <td>{v.colour ?? '—'}</td>
                  <td>{v.finish ?? '—'}</td>
                  <td><span className="sku">{v.size}</span></td>
                  <td className="right num">{qty(v.quantityOnHand)}</td>
                  <td><StatusPill tone={v.status === 'ACTIVE' ? 'ok' : v.status === 'DISCONTINUED' ? 'inert' : 'info'}>{v.status}</StatusPill></td>
                </tr>
              ))}
              {h.variants.length === 0 && (
                <tr><td colSpan={7} className="muted">No variants yet. Add one from the Product Master.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="tiny muted" style={{ marginTop: 10 }}>
        Each variant carries its own permanent SKU. Stock figures are read from
        the inventory ledger and cannot be changed here.{' '}
        <Link to="/products">Open the Product Master</Link> to add or edit one.
      </p>
    </Modal>
  );
}

/* ── categories ──────────────────────────────────────────────── */

function CategoryList() {
  const categories = useApi(() => api.reference.categories(), []);
  if (categories.error) return <Failed error={categories.error} onRetry={categories.reload} />;

  const rows = categories.data?.rows ?? [];
  const tops = rows.filter((c) => !c.parentId);

  return (
    <div className="grid-2">
      {tops.map((parent) => {
        const children = rows.filter((c) => c.parentId === parent.id);
        return (
          <section className="panel" key={parent.id}>
            <div className="panel-head">
              <div>
                <h2>{parent.name}</h2>
                <p>HSN {parent.hsnCode ?? '—'} · {parent.productCount} product(s)</p>
              </div>
            </div>
            <div className="panel-body stack">
              <div>
                <p className="kpi-label" style={{ marginBottom: 6 }}>A product here must have</p>
                <p className="tiny">{parent.rules.required.join(', ')}</p>
              </div>
              {children.length > 0 && (
                <div className="table-scroll">
                  <table className="table">
                    <thead>
                      <tr><th>Sub-category</th><th>HSN</th><th className="right">Products</th><th>Must have</th></tr>
                    </thead>
                    <tbody>
                      {children.map((c) => (
                        <tr key={c.id}>
                          <td><strong>{c.name}</strong></td>
                          <td><span className="sku">{c.hsnCode ?? '—'}</span></td>
                          <td className="right num">{qty(c.productCount)}</td>
                          <td className="tiny muted">{c.rules.required.join(', ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        );
      })}
      {rows.length === 0 && !categories.loading && (
        <div className="panel"><div className="empty"><h3>No categories</h3><p>Seed the database first.</p></div></div>
      )}
    </div>
  );
}
