/**
 * Shared left sidebar navigation for every page in the app, styled to
 * match the provided reference mockup: dark panel, "Overview / Tools /
 * Records / System" section labels, numbered tool items, an avatar card
 * in the footer, and a collapse/expand toggle (state persisted in
 * localStorage, same as a real site's "remember my sidebar preference").
 *
 * Usage, at the end of a page's <body>, after api-client.js and
 * notifications.js:
 *   <script src="assets/sidebar.js"></script>
 * then inside the page's own boot sequence, right after
 * `const currentUser = await CasaApi.requireAuth();`:
 *   Sidebar.init(currentUser, 'dashboard');   // 'dashboard' = this page's key, see NAV_SECTIONS below
 */
(function () {
  const STORAGE_KEY = 'casaSidebarCollapsed';

  // Backend access (dashboard, catalog admin, design rules, reference
  // images, users, settings, and the owner-only items below) is admin-only.
  // Staff get only the Mood Board & Print Board tool and Customers — the
  // actual floor-facing frontend — flagged `adminOnly: false` implicitly
  // by omission; everything else is `adminOnly: true`.
  const NAV_SECTIONS = [
    {
      label: 'Overview',
      items: [{ key: 'dashboard', label: 'Dashboard', href: 'dashboard.html', icon: '&#9635;', adminOnly: true }],
    },
    {
      label: 'Tools',
      numbered: true,
      items: [
        { key: 'catalog', label: 'Catalog Extractor', href: 'catalog-upload.html', icon: '&#128193;', adminOnly: true },
        { key: 'rules', label: 'Design Rules', href: 'design-rules.html', icon: '&#128220;', adminOnly: true },
        { key: 'tool', label: 'Mood Board & Print Board', href: '00-casa-de-aurum-tool-REFERENCE.html', icon: '&#9998;' },
        { key: 'images', label: 'Reference Images', href: 'reference-images.html', icon: '&#128247;', adminOnly: true },
      ],
    },
    {
      label: 'Records',
      items: [{ key: 'customers', label: 'Customers', href: '08-customer-management.html', icon: '&#128100;' }],
    },
    {
      label: 'System',
      items: [
        { key: 'users', label: 'Users & Staff', href: '03-user-staff-management.html', icon: '&#128101;', adminOnly: true },
        { key: 'apikeys', label: 'API Keys & Integrations', href: '04-api-keys-integrations.html', icon: '&#128273;', ownerOnly: true },
        { key: 'logs', label: 'System Logs', href: '05-system-logs-monitoring.html', icon: '&#128203;', ownerOnly: true },
        { key: 'analytics', label: 'Analytics', href: '06-analytics-usage-stats.html', icon: '&#128202;', ownerOnly: true },
        { key: 'settings', label: 'Settings', href: '07-application-settings.html', icon: '&#9881;', adminOnly: true },
      ],
    },
  ];

  const ROLE_LABEL = { OWNER: 'Owner', ADMIN: 'Manager', STAFF: 'Sales Staff' };

  function initials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    return parts.slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  }

  function getStoredCollapsed() {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      return false; // localStorage can throw in some privacy modes — default to expanded, never crash the page over this
    }
  }

  function setStoredCollapsed(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
    } catch {
      // Non-critical — the toggle still works for this page load even if it can't persist.
    }
  }

  function injectStyles() {
    if (document.getElementById('sidebar-styles')) return;
    const style = document.createElement('style');
    style.id = 'sidebar-styles';
    style.textContent = `
      body.has-sidebar { padding-left: 250px; }
      body.has-sidebar.sidebar-transitions { transition: padding-left .18s ease; }
      body.has-sidebar.sidebar-collapsed { padding-left: 68px; }
      #casaSidebar {
        position: fixed; top: 0; left: 0; bottom: 0; width: 250px; z-index: 40;
        background: #14110D; color: #E9E2D3; display: flex; flex-direction: column;
        font-family: var(--sans, sans-serif); overflow-x: hidden; overflow-y: auto;
        border-right: 1px solid rgba(255,255,255,0.06);
      }
      #casaSidebar.sidebar-transitions { transition: width .18s ease; }
      #casaSidebar.collapsed { width: 68px; }
      #casaSidebar .sb-topbar { display: flex; align-items: center; justify-content: space-between; padding: 20px 16px 0; }
      #casaSidebar .sb-toggle {
        width: 26px; height: 26px; flex-shrink: 0; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12);
        background: transparent; color: #B8AF9E; cursor: pointer; display: flex; align-items: center; justify-content: center;
        font-size: 13px; line-height: 1;
      }
      #casaSidebar .sb-toggle:hover { background: rgba(255,255,255,0.06); color: #F1ECE1; }
      #casaSidebar .sb-brand { padding: 14px 22px 18px; overflow: hidden; white-space: nowrap; }
      #casaSidebar.collapsed .sb-brand { padding: 14px 0 18px; text-align: center; }
      #casaSidebar .sb-brand .name { font-family: var(--display, serif); font-weight: 600; font-size: 17px; color: #F1ECE1; letter-spacing: .02em; }
      #casaSidebar.collapsed .sb-brand .name { font-size: 15px; }
      #casaSidebar .sb-brand .name em { font-style: normal; color: var(--brass-light, #D8B677); }
      #casaSidebar .sb-brand .sub { font-family: var(--mono, monospace); font-size: 9.5px; letter-spacing: .16em; text-transform: uppercase; color: #6E665A; margin-top: 4px; }
      #casaSidebar.collapsed .sb-brand .sub { display: none; }
      #casaSidebar nav { flex: 1; padding: 4px 14px 14px; }
      #casaSidebar.collapsed nav { padding: 4px 10px 14px; }
      #casaSidebar .sb-section { margin-top: 18px; }
      #casaSidebar .sb-section-label { font-family: var(--mono, monospace); font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: #5C5346; padding: 0 8px 8px; white-space: nowrap; overflow: hidden; }
      #casaSidebar.collapsed .sb-section-label { text-align: center; text-overflow: clip; }
      #casaSidebar a.sb-link {
        display: flex; align-items: center; gap: 9px; padding: 8px 8px; border-radius: 3px;
        color: #B8AF9E; font-size: 13px; text-decoration: none; margin-bottom: 1px; position: relative; white-space: nowrap;
      }
      #casaSidebar.collapsed a.sb-link { justify-content: center; padding: 9px 4px; }
      #casaSidebar a.sb-link .sb-num { font-family: var(--mono, monospace); font-size: 10.5px; color: #6E665A; width: 16px; flex-shrink: 0; text-align: center; }
      #casaSidebar a.sb-link .sb-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--sage, #7A9165); flex-shrink: 0; }
      #casaSidebar a.sb-link .sb-icon { display: none; font-size: 14px; flex-shrink: 0; }
      #casaSidebar.collapsed a.sb-link .sb-icon { display: inline-block; }
      #casaSidebar.collapsed a.sb-link .sb-num,
      #casaSidebar.collapsed a.sb-link .sb-dot,
      #casaSidebar.collapsed a.sb-link .sb-label { display: none; }
      #casaSidebar a.sb-link:hover { background: rgba(255,255,255,0.05); color: #F1ECE1; }
      #casaSidebar a.sb-link.on { background: rgba(173,131,72,0.14); color: #F1ECE1; font-weight: 600; }
      #casaSidebar a.sb-link.on::before { content: ''; position: absolute; left: -14px; top: 8px; bottom: 8px; width: 2px; background: var(--brass, #AD8348); }
      #casaSidebar.collapsed a.sb-link.on::before { left: 0; }
      #casaSidebar a.sb-link.on .sb-num { color: var(--brass-light, #D8B677); }
      #casaSidebar .sb-foot { padding: 14px; border-top: 1px solid rgba(255,255,255,0.06); display: flex; align-items: center; gap: 10px; overflow: hidden; }
      #casaSidebar.collapsed .sb-foot { padding: 14px 8px; justify-content: center; }
      #casaSidebar .sb-avatar { width: 34px; height: 34px; border-radius: 50%; background: var(--brass, #AD8348); color: #14110D; display: flex; align-items: center; justify-content: center; font-family: var(--mono, monospace); font-weight: 600; font-size: 12.5px; flex-shrink: 0; }
      #casaSidebar .sb-foot-info { flex: 1; min-width: 0; }
      #casaSidebar.collapsed .sb-foot-info, #casaSidebar.collapsed .sb-signout { display: none; }
      #casaSidebar .sb-user { color: #E9E2D3; font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #casaSidebar .sb-role { font-family: var(--mono, monospace); font-size: 10.5px; color: #6E665A; margin-top: 1px; }
      #casaSidebar .sb-signout { font-family: var(--mono, monospace); font-size: 10.5px; color: var(--clay, #9C4B2C); text-decoration: none; flex-shrink: 0; }
      @media (max-width: 860px) {
        body.has-sidebar, body.has-sidebar.sidebar-collapsed { padding-left: 0; }
        #casaSidebar, #casaSidebar.collapsed { position: static; width: 100%; height: auto; }
        #casaSidebar .sb-topbar { display: none; }
        #casaSidebar nav { display: flex; flex-wrap: wrap; gap: 4px; padding: 10px; }
        #casaSidebar .sb-section { margin: 0; display: contents; }
        #casaSidebar .sb-section-label { display: none; }
        #casaSidebar a.sb-link.on::before { display: none; }
        #casaSidebar a.sb-link .sb-label, #casaSidebar a.sb-link .sb-num, #casaSidebar a.sb-link .sb-dot { display: inline-block !important; }
        #casaSidebar a.sb-link .sb-icon { display: none !important; }
      }
    `;
    document.head.appendChild(style);
  }

  function buildMarkup(activeKey, isOwner, isAdmin) {
    const sections = NAV_SECTIONS.map((section, i) => {
      const items = section.items
        .filter((item) => (!item.ownerOnly || isOwner) && (!item.adminOnly || isAdmin || isOwner))
        .map((item, idx) => {
          const marker = section.numbered
            ? `<span class="sb-num">${String(idx + 1).padStart(2, '0')}</span>`
            : i === 0
              ? '<span class="sb-dot"></span>'
              : '';
          return `<a class="sb-link${item.key === activeKey ? ' on' : ''}" href="${item.href}" title="${item.label}"><span class="sb-icon">${item.icon}</span>${marker}<span class="sb-label">${item.label}</span></a>`;
        })
        .join('');
      if (!items) return '';
      return `<div class="sb-section">${section.label ? `<div class="sb-section-label">${section.label}</div>` : ''}${items}</div>`;
    }).join('');

    return `
      <div class="sb-topbar">
        <button class="sb-toggle" id="sbToggle" type="button" title="Collapse/expand sidebar">&#9776;</button>
      </div>
      <div class="sb-brand">
        <div class="name">CASA DE A<em>U</em>RUM</div>
        <div class="sub">Admin Panel</div>
      </div>
      <nav>${sections}</nav>
      <div class="sb-foot">
        <div class="sb-avatar" id="sbAvatar"></div>
        <div class="sb-foot-info">
          <div class="sb-user" id="sbUserName"></div>
          <div class="sb-role" id="sbUserRole"></div>
        </div>
        <a href="#" class="sb-signout" id="sbSignOut">Sign out</a>
      </div>
    `;
  }

  function applyCollapsed(collapsed) {
    const aside = document.getElementById('casaSidebar');
    if (aside) aside.classList.toggle('collapsed', collapsed);
    document.body.classList.toggle('sidebar-collapsed', collapsed);
  }

  function init(currentUser, activeKey) {
    injectStyles();

    const isOwner = currentUser?.role?.name === 'OWNER';
    const isAdmin = currentUser?.role?.name === 'ADMIN';
    const aside = document.createElement('aside');
    aside.id = 'casaSidebar';
    aside.innerHTML = buildMarkup(activeKey, isOwner, isAdmin);
    document.body.insertBefore(aside, document.body.firstChild);
    document.body.classList.add('has-sidebar');

    // The initial state is set with no 'sidebar-transitions' class present
    // yet, so it applies instantly — no animation on page load, ever. The
    // transition class gets added right after, on the next frame, so a
    // real click on the toggle (which happens later, by definition) does
    // animate smoothly, while navigating between pages never does.
    applyCollapsed(getStoredCollapsed());
    requestAnimationFrame(() => {
      aside.classList.add('sidebar-transitions');
      document.body.classList.add('sidebar-transitions');
    });

    const toggleBtn = document.getElementById('sbToggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const collapsed = !aside.classList.contains('collapsed');
        applyCollapsed(collapsed);
        setStoredCollapsed(collapsed);
      });
    }

    const avatarEl = document.getElementById('sbAvatar');
    const nameEl = document.getElementById('sbUserName');
    const roleEl = document.getElementById('sbUserRole');
    if (avatarEl) avatarEl.textContent = initials(currentUser?.name);
    if (nameEl) nameEl.textContent = currentUser?.name ?? '';
    if (roleEl) roleEl.textContent = ROLE_LABEL[currentUser?.role?.name] || currentUser?.role?.name || '';

    const signOut = document.getElementById('sbSignOut');
    if (signOut) {
      signOut.addEventListener('click', (e) => {
        e.preventDefault();
        window.CasaApi?.auth?.logout();
      });
    }
  }

  window.Sidebar = { init };
})();
