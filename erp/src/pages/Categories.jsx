import { useState } from 'react';
import { Link } from 'react-router-dom';
import Modal from '../components/Modal.jsx';
import { CATEGORIES } from '../data/catalogue.js';
import { PRODUCTS, stockValue } from '../data/ledger.js';
import { money, qty } from '../lib/format.js';

/* Categories are the ERP's own idea. The website's Tile row has no
   category column at all -- it has a type and a best room, which
   are design facts, not commercial ones. Categories exist here for
   the things the website never had to do: group a purchase, carry
   an HSN code, report a margin by group. */

export default function Categories() {
  const [editing, setEditing] = useState(null);

  const tree = CATEGORIES.filter((c) => !c.parent).map((parent) => ({
    ...parent,
    children: CATEGORIES.filter((c) => c.parent === parent.id),
  }));

  const stats = (id) => {
    const rows = PRODUCTS.filter((p) => p.category === id);
    return {
      count: rows.length,
      boxes: rows.reduce((s, p) => s + p.stockQty, 0),
      value: stockValue(rows),
    };
  };

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            How the catalogue is grouped for buying, reporting and tax. This is
            the ERP&rsquo;s own structure — the website stores a tile&rsquo;s type
            and best room, which are design facts, and has no commercial
            grouping at all.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setEditing({ name: '' })}>New category</button>
        </div>
      </div>

      <div className="grid-2">
        {tree.map((parent) => {
          const own = stats(parent.id);
          return (
            <section className="panel" key={parent.id}>
              <div className="panel-head">
                <div>
                  <h2>{parent.name}</h2>
                  <p>HSN {parent.hsn}</p>
                </div>
                <button className="btn btn-sm" onClick={() => setEditing(parent)}>Edit</button>
              </div>

              <div className="panel-body stack">
                <div className="summary-strip" style={{ margin: 0 }}>
                  <div><span className="kpi-label">Products</span><strong className="num">{qty(own.count)}</strong></div>
                  <div><span className="kpi-label">Boxes</span><strong className="num">{qty(own.boxes)}</strong></div>
                  <div><span className="kpi-label">At cost</span><strong className="num">{money(own.value)}</strong></div>
                </div>

                {parent.children.length > 0 && (
                  <div>
                    <p className="kpi-label" style={{ marginBottom: 6 }}>Sub-categories</p>
                    {/* Every table lives in a scroll container. Without
                        one here, five columns pushed the whole page
                        sideways at phone width. */}
                    <div className="table-scroll">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>HSN</th>
                          <th className="right">Products</th>
                          <th className="right">At cost</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {parent.children.map((child) => {
                          const s = stats(child.id);
                          return (
                            <tr key={child.id}>
                              <td><strong>{child.name}</strong></td>
                              <td><span className="sku">{child.hsn}</span></td>
                              <td className="right num">{qty(s.count)}</td>
                              <td className="right num">{money(s.value)}</td>
                              <td className="right">
                                <Link className="btn btn-sm" to="/products">View</Link>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>
                  </div>
                )}

                {own.count === 0 && parent.children.length === 0 && (
                  <p className="tiny muted">
                    No products in this category yet. It is kept because the
                    studio sells it — an empty category is not a mistake.
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing && editing.name ? 'Edit ' + editing.name : 'New category'}
        footer={(
          <>
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => setEditing(null)}>Save</button>
          </>
        )}
      >
        <div className="stack">
          <div className="field">
            <label htmlFor="cat-name">Name</label>
            <input id="cat-name" className="input" defaultValue={editing?.name || ''} />
          </div>
          <div className="field">
            <label htmlFor="cat-hsn">HSN code</label>
            <input id="cat-hsn" className="input" defaultValue={editing?.hsn || ''} />
          </div>
          <div className="field">
            <label htmlFor="cat-parent">Parent</label>
            <select id="cat-parent" className="select" defaultValue={editing?.parent || ''}>
              <option value="">None — a top-level category</option>
              {CATEGORIES.filter((c) => !c.parent).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <p className="tiny muted">
            The form is here to be reviewed, not used: saving does nothing in
            this build.
          </p>
        </div>
      </Modal>
    </>
  );
}
