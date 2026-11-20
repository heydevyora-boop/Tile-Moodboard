/* ============================================================
   A SCREEN THAT IS HONEST ABOUT NOT BEING BUILT YET
   ============================================================
   Used for a module whose workflow the studio has not settled --
   Warehouses, as the brief itself flagged. It says what the module
   is FOR and what still has to be decided, which is useful at
   review; a blank panel saying "coming soon" is not.
   ============================================================ */

export default function Placeholder({ title, purpose, open = [] }) {
  return (
    <div className="panel placeholder">
      <span className="placeholder-flag">Planned module</span>
      <h2>{title}</h2>
      <p className="placeholder-purpose">{purpose}</p>

      {open.length > 0 && (
        <>
          <p className="placeholder-label">Decisions still open</p>
          <ul className="placeholder-list">
            {open.map((q) => <li key={q}>{q}</li>)}
          </ul>
        </>
      )}

      <p className="placeholder-note">
        Nothing is stubbed in behind this screen. It stays a placeholder
        on purpose: a transfer flow built before the studio has agreed
        how stock moves between locations would have to be unlearned.
      </p>
    </div>
  );
}
