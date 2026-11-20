import { useState } from 'react';
import StatusPill from '../components/StatusPill.jsx';
import Modal from '../components/Modal.jsx';
import { USERS, ROLES } from '../data/operations.js';
import { DEMO_TODAY } from '../data/catalogue.js';
import { MODULES } from '../data/modules.js';
import { since } from '../lib/format.js';

/* WHAT EACH ROLE MAY DO, MODULE BY MODULE.
   Written out rather than described, because "Store Keeper: stock
   only" reads fine and still leaves it unclear whether they can see
   a cost price. They can see the stock they count; they cannot see
   what it cost or what it sells for, because those are the figures
   a buyer and an owner argue over. */
const ACCESS = {
  admin:   { all: 'write' },
  manager: {
    write: ['/products', '/categories', '/inventory', '/inward', '/outward', '/purchase', '/sales', '/transfer'],
    read: ['/', '/ledger', '/reports', '/sync', '/warehouses'],
  },
  store:   { write: ['/inward', '/outward'], read: ['/inventory', '/ledger'] },
  sales:   { write: ['/sales'], read: ['/', '/products', '/inventory', '/categories'] },
  viewer:  { read: MODULES.map((m) => m.to) },
};

function levelFor(role, to) {
  const a = ACCESS[role];
  if (a.all) return a.all;
  if (a.write?.includes(to)) return 'write';
  if (a.read?.includes(to)) return 'read';
  return 'none';
}

export default function Users() {
  const [open, setOpen] = useState(null);
  const [inviting, setInviting] = useState(false);

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            Who may use the ERP, and what each of them may reach. Access is per
            module and per action — a store keeper counts stock without seeing
            what it cost.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setInviting(true)}>Invite a user</button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head"><div><h2>People</h2><p>{USERS.length} accounts</p></div></div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th><th>Email</th><th>Role</th>
                <th>Last seen</th><th>Account</th><th />
              </tr>
            </thead>
            <tbody>
              {USERS.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.name}</strong></td>
                  <td className="sku">{u.email}</td>
                  <td>
                    {ROLES[u.role].label}
                    <div className="tiny muted">{ROLES[u.role].can}</div>
                  </td>
                  <td>{since(u.lastSeen, DEMO_TODAY)}</td>
                  <td>
                    {/* Disabled, not deleted. An account that recorded a
                        stock movement cannot be removed without orphaning
                        the ledger entry that names it. */}
                    <StatusPill tone={u.active ? 'ok' : 'inert'}>
                      {u.active ? 'Active' : 'Disabled'}
                    </StatusPill>
                  </td>
                  <td className="right">
                    <button className="btn btn-sm" onClick={() => setOpen(u)}>Permissions</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>What each role may reach</h2>
            <p>Read means the screen opens; write means it can be changed.</p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Module</th>
                {Object.entries(ROLES).map(([k, r]) => <th key={k} className="right">{r.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {MODULES.map((m) => (
                <tr key={m.to}>
                  <td><strong>{m.label}</strong></td>
                  {Object.keys(ROLES).map((role) => {
                    const lvl = levelFor(role, m.to);
                    return (
                      <td key={role} className="right">
                        {lvl === 'write' && <StatusPill tone="ok">Write</StatusPill>}
                        {lvl === 'read' && <StatusPill tone="info">Read</StatusPill>}
                        {lvl === 'none' && <span className="muted tiny">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Modal
        open={!!open}
        wide
        onClose={() => setOpen(null)}
        title={open ? open.name : ''}
        subtitle={open ? ROLES[open.role].label + ' · ' + open.email : ''}
        footer={<button className="btn" onClick={() => setOpen(null)}>Close</button>}
      >
        {open && (
          <>
            <p className="tiny muted">{ROLES[open.role].can}</p>
            <div className="detail-grid" style={{ marginTop: 12 }}>
              {MODULES.map((m) => {
                const lvl = levelFor(open.role, m.to);
                return (
                  <div className="detail-row" key={m.to}>
                    <span className="detail-label">{m.label}</span>
                    <span className="detail-value">
                      {lvl === 'write' && <StatusPill tone="ok">Write</StatusPill>}
                      {lvl === 'read' && <StatusPill tone="info">Read</StatusPill>}
                      {lvl === 'none' && <span className="muted tiny">No access</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Modal>

      <Modal
        open={inviting}
        onClose={() => setInviting(false)}
        title="Invite a user"
        footer={(
          <>
            <button className="btn" onClick={() => setInviting(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => setInviting(false)}>Send invitation</button>
          </>
        )}
      >
        <div className="stack">
          <div className="field">
            <label htmlFor="inv-name">Name</label>
            <input id="inv-name" className="input" placeholder="Full name" />
          </div>
          <div className="field">
            <label htmlFor="inv-email">Email</label>
            <input id="inv-email" className="input" type="email" placeholder="name@example.com" />
          </div>
          <div className="field">
            <label htmlFor="inv-role">Role</label>
            <select id="inv-role" className="select" defaultValue="viewer">
              {Object.entries(ROLES).map(([k, r]) => <option key={k} value={k}>{r.label}</option>)}
            </select>
          </div>
          <p className="tiny muted">
            Nothing is sent: this is a UI prototype. Worth deciding before it is
            built — whether ERP accounts are separate from the website&rsquo;s
            logins, or the same person signs in once for both.
          </p>
        </div>
      </Modal>
    </>
  );
}
