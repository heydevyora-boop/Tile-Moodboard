/* Casa de Aurum — shared notification system (Module 20)
   Include after api-client.js. Provides window.CasaNotify with:
     CasaNotify.success(message)
     CasaNotify.error(message)
     CasaNotify.processing(message) -> handle { update(msg), success(msg), error(msg), dismiss() }
     CasaNotify.exportReady(message, { url, label }) -> a success toast with an "Open" action
   No HTML changes needed per-page — the toast stack is injected lazily on first use.
*/
(function () {
  const STYLE_ID = 'casa-notify-styles';
  const CONTAINER_ID = 'casa-notify-stack';

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${CONTAINER_ID} {
        position: fixed; bottom: 20px; right: 20px; z-index: 9999;
        display: flex; flex-direction: column; gap: 10px;
        max-width: 360px; pointer-events: none;
      }
      .casa-toast {
        pointer-events: auto;
        background: #fff; border-radius: 3px; box-shadow: 0 12px 30px rgba(26,22,17,0.2);
        padding: 12px 14px; display: flex; align-items: flex-start; gap: 10px;
        font-family: 'Inter', sans-serif; font-size: 13px; line-height: 1.4; color: #221D18;
        border-left: 3px solid #78705F;
        opacity: 0; transform: translateY(8px);
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
      .casa-toast.casa-toast-in { opacity: 1; transform: translateY(0); }
      .casa-toast.casa-toast-success { border-left-color: #7A9165; }
      .casa-toast.casa-toast-error { border-left-color: #9C4B2C; }
      .casa-toast.casa-toast-processing { border-left-color: #AD8348; }
      .casa-toast .casa-toast-icon { font-size: 15px; line-height: 1; flex-shrink: 0; margin-top: 1px; }
      .casa-toast .casa-toast-body { flex: 1; min-width: 0; word-wrap: break-word; }
      .casa-toast .casa-toast-action {
        display: inline-block; margin-top: 6px; font-family: 'IBM Plex Mono', monospace;
        font-size: 11.5px; font-weight: 600; color: #AD8348; text-decoration: underline; cursor: pointer;
      }
      .casa-toast .casa-toast-close {
        flex-shrink: 0; cursor: pointer; color: #B7AB94; font-size: 15px; line-height: 1; padding: 0 2px;
      }
      .casa-toast .casa-toast-close:hover { color: #4B443A; }
      .casa-toast-spinner {
        width: 13px; height: 13px; border-radius: 50%; flex-shrink: 0; margin-top: 2px;
        border: 2px solid #E9E2D3; border-top-color: #AD8348;
        animation: casa-toast-spin 0.7s linear infinite;
      }
      @keyframes casa-toast-spin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);
  }

  function ensureContainer() {
    ensureStyles();
    let container = document.getElementById(CONTAINER_ID);
    if (!container) {
      container = document.createElement('div');
      container.id = CONTAINER_ID;
      document.body.appendChild(container);
    }
    return container;
  }

  const ICONS = { success: '\u2713', error: '\u2715', processing: null };

  function buildToast(type, message) {
    const el = document.createElement('div');
    el.className = `casa-toast casa-toast-${type}`;

    if (type === 'processing') {
      const spinner = document.createElement('div');
      spinner.className = 'casa-toast-spinner';
      el.appendChild(spinner);
    } else {
      const icon = document.createElement('div');
      icon.className = 'casa-toast-icon';
      icon.style.color = type === 'success' ? '#7A9165' : '#9C4B2C';
      icon.textContent = ICONS[type];
      el.appendChild(icon);
    }

    const body = document.createElement('div');
    body.className = 'casa-toast-body';
    body.textContent = message;
    el.appendChild(body);

    const close = document.createElement('div');
    close.className = 'casa-toast-close';
    close.textContent = '\u00d7';
    close.addEventListener('click', () => removeToast(el));
    el.appendChild(close);

    return { el, body };
  }

  function removeToast(el) {
    el.classList.remove('casa-toast-in');
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 200);
  }

  function show(type, message, opts) {
    opts = opts || {};
    const container = ensureContainer();
    const built = buildToast(type, message);
    container.appendChild(built.el);
    requestAnimationFrame(() => built.el.classList.add('casa-toast-in'));

    if (opts.autoDismissMs) {
      setTimeout(() => removeToast(built.el), opts.autoDismissMs);
    }

    return built;
  }

  function success(message) {
    show('success', message, { autoDismissMs: 4000 });
  }

  function error(message) {
    show('error', message, { autoDismissMs: 6000 });
  }

  /** Returns a handle for a long-running action — update it as the action progresses, then resolve to success/error. */
  function processing(message) {
    const built = show('processing', message);
    let resolved = false;

    return {
      update(newMessage) {
        if (resolved) return;
        built.body.textContent = newMessage;
      },
      success(finalMessage) {
        if (resolved) return;
        resolved = true;
        removeToast(built.el);
        success(finalMessage);
      },
      error(finalMessage) {
        if (resolved) return;
        resolved = true;
        removeToast(built.el);
        error(finalMessage);
      },
      dismiss() {
        if (resolved) return;
        resolved = true;
        removeToast(built.el);
      },
    };
  }

  /** A success toast with an inline "Open" action — for a completed export (PDF/PNG/Drive link). */
  function exportReady(message, opts) {
    opts = opts || {};
    const container = ensureContainer();
    const built = buildToast('success', message);
    container.appendChild(built.el);

    if (opts.url) {
      const action = document.createElement('a');
      action.className = 'casa-toast-action';
      action.href = opts.url;
      action.target = '_blank';
      action.rel = 'noopener';
      action.textContent = opts.label || 'Open';
      built.body.appendChild(document.createElement('br'));
      built.body.appendChild(action);
    }

    requestAnimationFrame(() => built.el.classList.add('casa-toast-in'));
    setTimeout(() => removeToast(built.el), 8000); // exports get a longer window since there's an action to click
  }

  window.CasaNotify = { success: success, error: error, processing: processing, exportReady: exportReady };
})();
