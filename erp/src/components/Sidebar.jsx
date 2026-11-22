import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { MODULES, GROUP_ORDER } from '../data/modules.js';

/* ============================================================
   THE SIDEBAR
   ============================================================
   Twenty-four flat items is a wall. Grouped under eight quiet
   labels, the same twenty-four are scannable -- and the groups
   match how the work actually divides: what we sell, what we
   hold, what we buy, what we sell on, what the website sees, who
   may touch it.

   IT SCROLLS, AND THAT IS THE RIGHT ANSWER NOW. Through step 5
   the whole nav fitted a 900px laptop screen, and a test held it
   to that. Step 6 added seven purchase screens; twenty-four
   items need about 1060px, and the ways to force them into 900
   are all worse than scrolling -- type too small to scan,
   padding too tight to click accurately, or modules hidden
   behind a disclosure nobody opens.

   So the nav scrolls below roughly 1060px, and the active item
   scrolls ITSELF into view on every navigation. The failure
   scrolling would otherwise cause is not the scrollbar; it is
   landing on Purchase History and seeing no highlight anywhere,
   with no idea where you are.
   ============================================================ */

export default function Sidebar({ open, onNavigate }) {
  const nav = useRef(null);
  const { pathname } = useLocation();

  useEffect(() => {
    const active = nav.current?.querySelector('.nav-item.is-active');
    if (!active) return;
    // `nearest` so a nav that already shows the item does not
    // jump; only an off-screen one moves.
    active.scrollIntoView({ block: 'nearest' });
  }, [pathname]);

  return (
    <aside className={'sidebar' + (open ? ' is-open' : '')}>
      <div className="sidebar-brand">
        <span className="sidebar-mark">DV</span>
        <span className="sidebar-name">
          De&rsquo;vyora
          <small>ERP</small>
        </span>
      </div>

      <nav className="sidebar-nav" aria-label="Modules" ref={nav}>
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
