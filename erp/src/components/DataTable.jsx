import { useMemo, useState, useEffect } from 'react';

/* ============================================================
   ONE TABLE, USED BY EVERY SCREEN THAT LISTS ANYTHING
   ============================================================

   Search, sort, filter, page and (optionally) select. Written once
   because eight screens need all five, and eight hand-rolled
   versions is how a prototype ends up with a search box that is
   case-sensitive on one screen and not on another.

   A column is { key, label, render?, sortKey?, value?, align?,
   width?, hideBelow? }:
     value()  -- what the column is for sorting and searching
     render() -- what it looks like; defaults to value()
   Keeping the two apart is what lets a status column sort by
   severity while displaying a pill, and lets a money column sort
   numerically while displaying a formatted string.
   ============================================================ */

const PAGE_SIZES = [10, 25, 50, 100];

/* ── SERVER MODE ──────────────────────────────────────────────
   Pass `server` and the table stops searching, sorting and
   slicing: it renders exactly the rows it is given and reports
   every control back to the caller, which asks the database.

   The Product Master needs this. Fetching the whole catalogue so
   the browser can filter it works at ninety products and stops
   working at nine thousand -- by which point the fix is a rewrite
   of every screen that reads it. The markup below is identical in
   both modes, so a screen can start on mock data and move to the
   API without being redesigned.

   server = {
     total, page, pageSize, pageCount, loading,
     sort: { key, dir } | null,
     onPage(n), onPageSize(n), onSort({ key, dir }),
   }
   ────────────────────────────────────────────────────────── */

export default function DataTable({
  rows,
  columns,
  rowKey,
  server = null,
  search = '',
  searchPlaceholder = 'Search…',
  onSearch,
  filters = null,
  toolbarExtra = null,
  selectable = false,
  selected = [],
  onSelect,
  bulkActions = null,
  initialSort = null,
  emptyTitle = 'Nothing to show',
  emptyNote = 'No rows match the filters above.',
  onRowClick = null,
  pageSize: initialPageSize = 25,
}) {
  const [localSort, setLocalSort] = useState(initialSort);
  const [localPage, setLocalPage] = useState(1);
  const [localPageSize, setLocalPageSize] = useState(initialPageSize);

  // In server mode the caller owns all three.
  const sort = server ? server.sort : localSort;
  const page = server ? server.page : localPage;
  const pageSize = server ? server.pageSize : localPageSize;
  const setPage = server ? server.onPage : setLocalPage;
  const setPageSize = server ? server.onPageSize : setLocalPageSize;

  const valueOf = (col, row) => (col.value ? col.value(row) : row[col.key]);

  /* ── search ───────────────────────────────────────────────────
     Across every column's own value, so a column showing a pill is
     still searchable by the word in it. Case- and space-insensitive
     because nobody types a product code the way it is stored. */
  const searched = useMemo(() => {
    // The database already did it.
    if (server) return rows;
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => columns.some((col) => {
      const v = valueOf(col, row);
      return v != null && String(v).toLowerCase().includes(q);
    }));
  }, [rows, columns, search]);

  /* ── sort ─────────────────────────────────────────────────────
     Numbers compare as numbers and text with localeCompare, so
     "DV-1010" sorts after "DV-1009" and 1,200 after 900 -- both of
     which a naive string sort gets wrong. */
  const sorted = useMemo(() => {
    if (server) return searched;
    if (!sort) return searched;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return searched;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...searched].sort((a, b) => {
      const av = col.sortKey ? col.sortKey(a) : valueOf(col, a);
      const bv = col.sortKey ? col.sortKey(b) : valueOf(col, b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;   // blanks sink, in both directions
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
    });
  }, [searched, sort, columns]);

  // A filter or a search that shortens the list must not strand the
  // reader on a page that no longer exists.
  const pageCount = server
    ? Math.max(1, server.pageCount)
    : Math.max(1, Math.ceil(sorted.length / pageSize));
  const total = server ? server.total : sorted.length;

  useEffect(() => {
    if (!server && page > pageCount) setPage(1);
  }, [server, page, pageCount, setPage]);

  const start = (Math.min(page, pageCount) - 1) * pageSize;
  const pageRows = server ? sorted : sorted.slice(start, start + pageSize);

  const toggleSort = (col) => {
    if (col.sortable === false) return;
    const next = sort && sort.key === col.key
      ? { key: col.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
      : { key: col.key, dir: 'asc' };
    if (server) server.onSort(next); else setLocalSort(next);
  };

  /* ── selection ────────────────────────────────────────────────
     The header box acts on THE ROWS YOU CAN SEE, and says so. A
     "select all" that silently picks up 90 filtered-out rows is how
     a bulk price change hits products nobody meant to touch. */
  const pageKeys = pageRows.map(rowKey);
  const allOnPage = pageKeys.length > 0 && pageKeys.every((k) => selected.includes(k));

  const toggleAll = () => {
    if (!onSelect) return;
    onSelect(allOnPage
      ? selected.filter((k) => !pageKeys.includes(k))
      : [...new Set([...selected, ...pageKeys])]);
  };

  const toggleOne = (key) => {
    if (!onSelect) return;
    onSelect(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  };

  return (
    <div className="panel">
      {(onSearch || filters || toolbarExtra) && (
        <div className="toolbar">
          {onSearch && (
            <input
              className="input toolbar-search"
              type="search"
              value={search}
              placeholder={searchPlaceholder}
              onChange={(e) => { onSearch(e.target.value); setPage(1); }}
            />
          )}
          {filters}
          {toolbarExtra && <div className="toolbar-spacer">{toolbarExtra}</div>}
        </div>
      )}

      {selectable && selected.length > 0 && (
        <div className="bulkbar">
          <strong className="num">{selected.length}</strong>
          <span>selected</span>
          {bulkActions}
          <button className="btn btn-sm toolbar-spacer" onClick={() => onSelect([])}>
            Clear selection
          </button>
        </div>
      )}

      {server?.loading && pageRows.length === 0 ? (
        <div className="empty"><h3>Loading…</h3><p>Reading from the ERP database.</p></div>
      ) : pageRows.length === 0 ? (
        <div className="empty">
          <h3>{emptyTitle}</h3>
          <p>{emptyNote}</p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                {selectable && (
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      checked={allOnPage}
                      onChange={toggleAll}
                      aria-label={'Select the ' + pageKeys.length + ' rows on this page'}
                      title={'Selects the ' + pageKeys.length + ' rows on this page only'}
                    />
                  </th>
                )}
                {columns.map((col) => {
                  const isSorted = sort && sort.key === col.key;
                  return (
                    <th
                      key={col.key}
                      style={col.width ? { width: col.width } : undefined}
                      className={[
                        col.sortable === false ? '' : 'is-sortable',
                        isSorted ? 'is-sorted' : '',
                        col.align === 'right' ? 'right' : '',
                      ].filter(Boolean).join(' ')}
                      onClick={() => toggleSort(col)}
                    >
                      {col.label}
                      {col.sortable !== false && (
                        <span className="sort-mark" aria-hidden="true">
                          {isSorted ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'}
                        </span>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => {
                const key = rowKey(row);
                return (
                  <tr
                    key={key}
                    className={selected.includes(key) ? 'is-picked' : ''}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    style={onRowClick ? { cursor: 'pointer' } : undefined}
                  >
                    {selectable && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.includes(key)}
                          onChange={() => toggleOne(key)}
                          aria-label={'Select ' + key}
                        />
                      </td>
                    )}
                    {columns.map((col) => (
                      <td key={col.key} className={col.align === 'right' ? 'right' : ''}>
                        {col.render ? col.render(row) : valueOf(col, row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="table-foot">
        <span>
          {total === 0
            ? 'No rows'
            : 'Showing ' + (start + 1) + '–' + Math.min(start + pageSize, total)
              + ' of ' + total
              + (!server && sorted.length !== rows.length ? ' (filtered from ' + rows.length + ')' : '')}
          {server?.loading && <span className="muted"> · refreshing</span>}
        </span>

        <div className="pager">
          <select
            className="select"
            value={pageSize}
            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
            aria-label="Rows per page"
          >
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} per page</option>)}
          </select>
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(1)}>First</button>
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
          <span className="tiny muted">Page {Math.min(page, pageCount)} of {pageCount}</span>
          <button className="btn btn-sm" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>Next</button>
          <button className="btn btn-sm" disabled={page >= pageCount} onClick={() => setPage(pageCount)}>Last</button>
        </div>
      </div>
    </div>
  );
}
