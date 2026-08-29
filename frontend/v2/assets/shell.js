/**
 * Casa de Aurum v2 — shared app shell.
 * Renders the role-aware sidebar + wires sign-out, using the real
 * authenticated user from CasaApi (backend role, not a hardcoded demo).
 *
 * Access model: STAFF gets the moodboard/print-board tool only. ADMIN and
 * OWNER share one merged "Admin Panel" — the backend still distinguishes
 * them (a few routes are OWNER-only, e.g. API keys), but there is no
 * separate Owner UI/nav; both roles see the same admin pages and nav.
 *
 * <script src="../assets/api-client.js"></script>
 * <script src="assets/shell.js"></script>
 * <script>
 *   CasaShell.init({ current: 'tool-dashboard.html' });                          // staff tool page
 *   CasaShell.init({ current: 'admin-dashboard.html', allowedRoles: ['ADMIN','OWNER'] }); // admin-tier page
 * </script>
 */
(function () {
  'use strict';

  const ROLE_LABEL = { OWNER: 'Admin Panel', ADMIN: 'Admin Panel', STAFF: 'User Panel' };
  const ROLE_HOME = { OWNER: 'admin-dashboard.html', ADMIN: 'admin-dashboard.html', STAFF: 'tool-dashboard.html' };

  const ADMIN_NAV = [
    { group: 'Overview' },
    { href: 'admin-dashboard.html', label: 'Dashboard' },
    { group: 'Catalog Pipeline' },
    { href: 'admin-extraction-status.html', label: 'Extraction Status' },
    { href: 'admin-catalog-detail.html', label: 'Catalog Detail' },
    { href: 'admin-product-data.html', label: 'Product Data' },
    { href: 'admin-catalog-extractor.html', label: 'Extractor Settings' },
    { group: 'Generations' },
    { href: 'admin-generation-history.html', label: 'Generation History' },
    { href: 'admin-generated-scenes.html', label: 'Generated Scenes' },
    { group: 'Tool Config' },
    { href: 'admin-mood-board.html', label: 'Mood Board Config' },
    { href: 'admin-print-board.html', label: 'Print Board Config' },
    { group: 'AI Control' },
    { href: 'design-rules-setup.html', label: 'System Instructions' },
    { href: 'reference-image-library.html', label: 'Reference Library' },
    { href: 'version-history.html', label: 'Prompt Versions' },
    { href: 'admin-design-rules.html', label: 'Rules & Filters' },
    { href: 'owner-ai-test.html', label: 'AI Test Mode' },
    { group: 'Governance' },
    { href: 'admin-users.html', label: 'Users & Staff' },
    { href: 'admin-api-keys.html', label: 'API & Integrations' },
    { group: 'Monitoring' },
    { href: 'admin-logs.html', label: 'System Logs' },
    { href: 'admin-analytics.html', label: 'Analytics' },
  ];

  const NAV = {
    STAFF: [
      { group: 'Moodboard' },
      { href: 'tool-dashboard.html', label: 'Dashboard' },
      { href: 'moodboard-wizard.html', label: 'New Moodboard' },
      { href: 'moodboard-results.html', label: 'Results' },
      { href: 'scene-angles.html', label: 'Scene & Angles' },
      { href: 'print-board-designer.html', label: 'Print Board' },
    ],
    // ADMIN and OWNER are one tier in the UI — same nav, same pages.
    ADMIN: ADMIN_NAV,
    OWNER: ADMIN_NAV,
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderSidebar(user, current) {
    const roleName = user.role || 'STAFF';
    const nav = NAV[roleName] || NAV.STAFF;
    const panelLabel = ROLE_LABEL[roleName] || 'User Panel';

    const navHtml = nav.map((item) => {
      if (item.group) {
        return `<div class="navgroup">${escapeHtml(item.group)}</div>`;
      }
      const active = item.href === current ? ' active' : '';
      return `<a class="navlink${active}" href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`;
    }).join('');

    const initials = (CasaApi.initials ? CasaApi.initials(user.name) : (user.name || '?').slice(0, 2)).toUpperCase();

    return `
      <aside class="casa-sidebar">
        <div class="brand">
          <div class="name">CASA DE A<em>U</em>RUM</div>
          <div class="panel">${escapeHtml(panelLabel)}</div>
        </div>
        <nav>${navHtml}</nav>
        <div class="userbox">
          <div class="avatar">${escapeHtml(initials)}</div>
          <div class="who">
            <div class="n">${escapeHtml(user.name || 'Unknown')}</div>
            <div class="r">${escapeHtml(roleName)}</div>
          </div>
          <button class="signout" id="casaSignOut" title="Sign out">Sign out</button>
        </div>
      </aside>`;
  }

  function renderRestricted(user) {
    const home = ROLE_HOME[user.role] || 'login.html';
    document.body.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F1ECE1;font-family:'Inter',sans-serif;padding:24px;">
        <div style="max-width:420px;text-align:center;background:#fff;border:1px solid rgba(34,29,24,0.14);border-radius:3px;padding:40px 32px;">
          <div style="font-family:'Fraunces',serif;font-weight:600;font-size:20px;color:#1A1611;margin-bottom:10px;">You don't have access to this page</div>
          <p style="font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:#78705F;line-height:1.6;margin:0 0 20px;">Your account (${escapeHtml(user.role || 'unknown role')}) doesn't have permission to view this screen. Backend access is admin-only — staff use the moodboard tool.</p>
          <a href="${escapeHtml(home)}" style="display:inline-block;font-weight:600;font-size:13px;background:#1A1611;color:#F1ECE1;padding:11px 20px;border-radius:2px;">Go to your dashboard →</a>
        </div>
      </div>`;
  }

  /**
   * CasaShell.init({ current, allowedRoles })
   *   current: this page's own filename, for nav active-state highlighting.
   *   allowedRoles: optional array of role names permitted to view this
   *     page (e.g. ['ADMIN','OWNER']). Omit to allow any authenticated role
   *     (used by the staff tool pages, which everyone can use).
   *
   * Unlike CasaApi.requireAuth(allowedRoles), a role mismatch here never
   * alert()s or redirects into a page that may not exist in v2 — it swaps
   * in an inline "no access" screen with a link back to the caller's own
   * dashboard.
   */
  async function init(opts) {
    opts = opts || {};
    const user = await CasaApi.requireAuth(); // no allowedRoles — we gate ourselves below

    if (opts.allowedRoles && !opts.allowedRoles.includes(user.role)) {
      renderRestricted(user);
      return new Promise(() => {}); // never resolves — page is done, nothing else should run
    }

    let root = document.getElementById('casa-shell-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'casa-shell-root';
      document.body.insertBefore(root, document.body.firstChild);
    }

    const mainContent = document.getElementById('casa-main-content');
    const innerHtml = mainContent ? mainContent.innerHTML : '';

    root.className = 'casa-shell';
    root.innerHTML = renderSidebar(user, opts.current || '') +
      `<div class="casa-main"><div class="casa-main-inner" id="casa-main-inner">${innerHtml}</div></div>`;

    if (mainContent) mainContent.remove();

    const signOut = document.getElementById('casaSignOut');
    if (signOut) {
      signOut.addEventListener('click', () => CasaApi.auth.logout());
    }

    return user;
  }

  function initials(name) {
    return CasaApi.initials ? CasaApi.initials(name) : (name || '?').slice(0, 2).toUpperCase();
  }

  window.CasaShell = { init, NAV, ROLE_LABEL, ROLE_HOME, escapeHtml, initials };
})();
