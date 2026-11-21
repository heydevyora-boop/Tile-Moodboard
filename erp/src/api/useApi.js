import { useCallback, useEffect, useRef, useState } from 'react';

/* ============================================================
   FETCHING, WITHOUT A LIBRARY
   ============================================================
   The ERP has four screens that load from the API. A data-fetching
   library would be a larger dependency than the code it replaces,
   so this is the small honest version: loading, error, data, a
   reload, and the one thing hand-rolled fetching usually gets
   wrong -- a slow response from an abandoned query overwriting a
   fast one from the current query.
   ============================================================ */

export function useApi(fn, deps = [], { skip = false } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: !skip });
  // Bumped on every run; a response from an older run is dropped.
  const run = useRef(0);

  const reload = useCallback(() => {
    if (skip) { setState({ data: null, error: null, loading: false }); return; }
    const id = run.current + 1;
    run.current = id;
    setState((s) => ({ ...s, loading: true, error: null }));

    Promise.resolve(fn())
      .then((data) => { if (run.current === id) setState({ data, error: null, loading: false }); })
      .catch((error) => { if (run.current === id) setState({ data: null, error, loading: false }); });
    // fn is rebuilt every render; the caller's deps say when it
    // genuinely changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skip, ...deps]);

  useEffect(reload, [reload]);

  return { ...state, reload };
}
