import { NavLink } from 'react-router-dom';
import { MODULES, GROUP_ORDER } from '../data/modules.js';

/* ============================================================
   THE SIDEBAR
   ============================================================
   Fifteen flat items is a wall. Grouped under six quiet labels,
   the same fifteen are scannable -- and the groups match how the
   work actually divides: what we sell, what we hold, what moves in
   and out, what the website sees, who may touch it.
   ============================================================ */

export default function Sidebar({ open, onNavigate }) {
  return (
    <aside className={'sidebar' + (open ? ' is-open' : '')}>
      <div className="sidebar-brand">
        <span className="sidebar-mark">DV</span>
        <span className="sidebar-name">
          De&rsquo;vyora
          <small>ERP</small>
        </span>
      </div>

      <nav className="sidebar-nav" aria-label="Modules">
        {GROUP_ORDER.map((group) => {
          const items = MODULES.filter((m) => m.group === group);
          if (items.length === 0) return null;
          return (
            <div className="nav-group" key={group}>
              <p className="nav-group-label">{group}</p>
              {items.map((m) => (
                <NavLink
                  key={m.to}
                  to={m.to}
                  end={m.to === '/'}
                  className={({ isActive }) => 'nav-item' + (isActive ? ' is-active' : '')}
                  onClick={onNavigate}
                >
                  <span className="nav-item-label">{m.label}</span>
                  {/* What is real and what is not, said in the nav
                      rather than discovered by clicking. A screen
                      full of convincing demo data looks exactly
                      like a working one until somebody tries to
                      save. */}
                  {m.status === 'planned' && <span className="nav-flag">planned</span>}
                  {m.status === 'live' && <span className="nav-flag is-live">live</span>}
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>

      {/* WHAT THIS BUILD IS. Stated in the furniture, not in a
          README nobody opens -- so no reviewer mistakes a screen of
          plausible numbers for the studio's real stock. */}
      <div className="sidebar-foot">
        <span className="sidebar-foot-dot" />
        <div>
          <strong>Part connected</strong>
          Screens marked <em>live</em> read and write the ERP database.
          The rest still run on demo data and save nothing.
        </div>
      </div>
    </aside>
  );
}
