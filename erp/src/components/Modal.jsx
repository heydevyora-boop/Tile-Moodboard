import { useEffect, useRef } from 'react';

/* ============================================================
   A DIALOG THAT BEHAVES LIKE ONE
   ============================================================
   Escape closes it, the backdrop closes it, focus moves into it
   when it opens and the page behind it stops scrolling. These are
   the four things a hand-rolled modal usually misses, and missing
   them is what makes a prototype feel broken in review.
   ============================================================ */

export default function Modal({ open, title, subtitle, onClose, children, footer, wide }) {
  const panel = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);

    // Keep the page behind still. Without this the backdrop scrolls
    // under the dialog on a trackpad, which reads as a glitch.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    panel.current?.focus();

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className={'modal' + (wide ? ' is-wide' : '')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
      >
        <header className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose}>
            <span aria-hidden="true">&times;</span>
            <span className="sr">Close</span>
          </button>
        </header>

        <div className="modal-body">{children}</div>

        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}
