import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import { moduleFor } from '../data/modules.js';

/* ============================================================
   THE APP SHELL
   ============================================================
   Sidebar, topbar and the one scrolling content column every
   screen renders into. Pages supply only their own content; the
   heading, the gutter and the mobile behaviour live here so
   fifteen screens cannot drift apart.
   ============================================================ */

export default function Shell() {
  const location = useLocation();
  const current = moduleFor(location.pathname);
  const [navOpen, setNavOpen] = useState(false);

  // On a phone the sidebar is a drawer, and a drawer that stays open
  // after you have chosen something is in the way.
  useEffect(() => { setNavOpen(false); }, [location.pathname]);

  // The title is the one thing outside the React tree that should
  // still follow the route, so a browser tab or bookmark is useful.
  useEffect(() => {
    document.title = current.label + " · De'vyora ERP";
  }, [current.label]);

  return (
    <div className="shell">
      <Sidebar open={navOpen} onNavigate={() => setNavOpen(false)} />

      {/* Tapping the dimmed page is how a drawer is dismissed on a
          phone; it is inert at desktop widths. */}
      <div
        className={'scrim' + (navOpen ? ' is-on' : '')}
        onClick={() => setNavOpen(false)}
        aria-hidden="true"
      />

      <div className="main">
        <header className="topbar">
          <button
            className="icon-btn nav-toggle"
            onClick={() => setNavOpen((v) => !v)}
            aria-expanded={navOpen}
          >
            <span aria-hidden="true">&#9776;</span>
            <span className="sr">Modules</span>
          </button>

          <div className="topbar-title">
            <h1>{current.label}</h1>
            <p>{current.group}</p>
          </div>

          <div className="topbar-right">
            {/* Deliberately inert. A search box and a bell that do
                nothing would be read as broken; a single honest
                label is not. */}
            <span className="env-pill" title="No backend is connected in this build.">
              Demo data
            </span>
            <div className="who">
              <span className="who-avatar">DV</span>
              <span className="who-text">
                Studio Admin
                <small>All modules</small>
              </span>
            </div>
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
