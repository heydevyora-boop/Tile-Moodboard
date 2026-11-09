/**
 * THE SIDEBAR'S TOGGLE.
 *
 * Six pages carry the same sidebar. Rather than six copies of this,
 * the button and the backdrop are built here and the pages only
 * include the file -- so there is one behaviour to get right and one
 * place to fix it.
 *
 * On a wide screen the sidebar stays open, as it always has, and the
 * button collapses it; that choice is remembered. On a phone the
 * sidebar used to be `display:none`, which left no way to navigate at
 * all -- it is a drawer now, closed to begin with, and the button is
 * what opens it.
 *
 * A page with no sidebar gets nothing: this does not invent one.
 */
(function () {
  'use strict';

  var PHONE = '(max-width: 860px)';
  var REMEMBERED = 'casa.sidebar.collapsed';

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    var sidebar = document.querySelector('.layout > .sidebar');
    if (!sidebar) return;

    var onPhone = function () { return window.matchMedia(PHONE).matches; };

    // Remembering a collapsed sidebar is a convenience, not state the
    // page depends on: a browser that refuses storage still works.
    function remembered() {
      try { return window.localStorage.getItem(REMEMBERED) === '1'; } catch (err) { return false; }
    }
    function remember(collapsed) {
      try { window.localStorage.setItem(REMEMBERED, collapsed ? '1' : '0'); } catch (err) { /* private window */ }
    }

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'sb-toggle';
    toggle.setAttribute('aria-label', 'Menu');
    toggle.setAttribute('aria-controls', 'casaSidebar');
    toggle.innerHTML = '<span></span><span></span><span></span>';

    var backdrop = document.createElement('div');
    backdrop.className = 'sb-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');

    if (!sidebar.id) sidebar.id = 'casaSidebar';
    document.body.appendChild(backdrop);
    document.body.appendChild(toggle);

    function apply(open) {
      document.body.classList.toggle('sb-open', open);
      document.body.classList.toggle('sb-closed', !open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Menu');
    }

    // A phone starts closed whatever was remembered -- the drawer
    // covers the page, and nobody wants to land on a covered page.
    apply(onPhone() ? false : !remembered());

    toggle.addEventListener('click', function () {
      var open = !document.body.classList.contains('sb-open');
      apply(open);
      if (!onPhone()) remember(!open);
    });

    backdrop.addEventListener('click', function () { apply(false); });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && onPhone() && document.body.classList.contains('sb-open')) {
        apply(false);
      }
    });

    // Following a link on a phone should not leave the drawer open
    // over the page that was asked for.
    sidebar.addEventListener('click', function (event) {
      if (!onPhone()) return;
      if (event.target.closest('a, button')) apply(false);
    });

    // Crossing the breakpoint -- a rotated phone, a resized window --
    // means the other set of defaults now applies.
    var phoneQuery = window.matchMedia(PHONE);
    var onChange = function (event) { apply(event.matches ? false : !remembered()); };
    if (phoneQuery.addEventListener) phoneQuery.addEventListener('change', onChange);
    else if (phoneQuery.addListener) phoneQuery.addListener(onChange);
  });
})();
