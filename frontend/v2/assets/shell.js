/**
 * Casa de Aurum v2 — shared app shell.
 * Renders the role-aware sidebar + wires sign-out, using the real
 * authenticated user from CasaApi (backend role, not a hardcoded demo).
 *
 * <script src="assets/api-client.js"></script>
 * <script src="assets/shell.js"></script>
 * <script>
 *   CasaShell.init({ current: 'tool-dashboard.html', allowedRoles: ['STAFF','ADMIN','OWNER'] });
 * </script>
 */
(function () {
  'use strict';

  const ROLE_LABEL = { OWNER: 'Owner Panel', ADMIN: 'Admin Panel', STAFF: 'User Panel' };

  const NAV = {
    STAFF: [
      { group: 'Moodboard' },
      { href: 'tool-dashboard.html', label: 'Dashboard' },
      { href: 'moodboard-wizard.html', label: 'New Moodboard' },
      { href: 'moodboard-results.html', label: 'Results' },
      { href: 'scene-angles.html', label: 'Scene & Angles' },
      { href: 'print-board-designer.html', label: 'Print Board' },
    ],
    ADMIN: [
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
      { group: 'Monitoring' },
      { href: 'admin-logs.html', label: 'System Logs' },
      { href: 'admin-analytics.html', label: 'Analytics' },
    ],
    OWNER: [
      { group: 'Overview' },
      { href: 'owner-dashboard.html', label: 'Dashboard' },
      { group: 'AI Control' },
      { href: 'design-rules-setup.html', label: 'System Instructions' },
      { href: 'reference-image-library.html', label: 'Reference Library' },
      { href: 'version-history.html', label: 'Prompt Versions' },
      { href: 'admin-design-rules.html', label: 'Rules & Filters' },
      { href: 'owner-ai-test.html', label: 'AI Test Mode' },
      { group: 'Governance' },
      { href: 'admin-users.html', label: 'Users & Staff' },
      { href: 'admin-api-keys.html', label: 'API & Integrations' },
    ],
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderSidebar(user, current) {
    const roleName = user.role?.name || 'STAFF';
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

  async function init(opts) {
    opts = opts || {};
    const user = await CasaApi.requireAuth(opts.allowedRoles);

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

  window.CasaShell = { init, NAV, ROLE_LABEL, escapeHtml };
})();
