import { useMemo, useState } from 'react';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import KpiCard from '../components/KpiCard.jsx';
import Modal from '../components/Modal.jsx';
import { SYNC_EVENTS, SYNC_STATUS } from '../data/operations.js';
import { PRODUCTS } from '../data/ledger.js';
import { DEMO_TODAY } from '../data/catalogue.js';
import { qty, stamp, since } from '../lib/format.js';

/* ============================================================
   WEBSITE SYNC
   ============================================================
   The direction is the whole point of this screen, and it is
   stated on every row rather than implied: the ERP owns cost,
   price, stock and status, and it PUSHES them. The website is
   told. A row flowing the other way would not be a routine event
   to list -- it would mean the website had edited something the
   ERP owns, which is a conflict to resolve.
   ============================================================ */

export default function SyncStatus() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [retrying, setRetrying] = useState(null);

  const rows = useMemo(
    () => SYNC_EVENTS.filter((e) => status === 'all' || e.status === status),
    [status],
  );

  const failed = SYNC_EVENTS.filter((e) => e.status === 'failed');
  const pending = SYNC_EVENTS.filter((e) => e.status === 'pending');
  const notListed = PRODUCTS.filter((p) => !p.onWebsite && p.status !== 'draft');

  const columns = [
    {
      key: 'at',
      label: 'When',
      width: 150,
      render: (e) => (
        <>
          {stamp(e.at)}
          <div className="tiny muted">{since(e.at, DEMO_TODAY)}</div>
        </>
      ),
    },
    {
      key: 'productName',
      label: 'Product',
      render: (e) => (
        <>
          <strong>{e.productName}</strong>
          <div className="sku">{e.productCode}</div>
        </>
      ),
    },
    { key: 'what', label: 'Change', width: 260 },
    {
      key: 'direction',
      label: 'Direction',
      width: 130,
      render: () => <span className="tiny muted">ERP → website</span>,
    },
    {
      key: 'attempts',
      label: 'Attempts',
      align: 'right',
      width: 92,
      render: (e) => <span className="num">{e.attempts}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      width: 120,
      value: (e) => SYNC_STATUS[e.status].label,
      render: (e) => <StatusPill tone={SYNC_STATUS[e.status].tone}>{SYNC_STATUS[e.status].label}</StatusPill>,
    },
    /* The retry sits immediately after the status, not at the far
       end of the row. Behind a 300px error column it was off the
       edge of the panel -- reachable only by scrolling sideways past
       the very text that explains why you would press it. */
    {
      key: 'act',
      label: '',
      sortable: false,
      width: 86,
      render: (e) => (e.status === 'failed'
        ? (
          <button
            className="btn btn-sm"
            onClick={(ev) => { ev.stopPropagation(); setRetrying(e); }}
          >
            Retry
          </button>
        )
        : null),
    },
    {
      key: 'error',
      label: 'Why it failed',
      width: 300,
      render: (e) => (e.error
        ? <span style={{ color: 'var(--danger)' }}>{e.error}</span>
        : <span className="muted">—</span>),
    },
  ];

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            Every change the ERP has pushed to the De&rsquo;vyora website, and
            whether it landed. The ERP is the master for cost, price, stock and
            status — the website is told what changed here, and nothing flows
            back the other way.
          </p>
        </div>
      </div>

      <div className="grid-4">
        <KpiCard
          label="Failed"
          value={qty(failed.length)}
          tone={failed.length ? 'danger' : undefined}
          note="the website did not accept these"
        />
        <KpiCard
          label="Pending"
          value={qty(pending.length)}
          tone={pending.length ? 'warn' : undefined}
          note="queued, not yet pushed"
        />
        <KpiCard
          label="Synced"
          value={qty(SYNC_EVENTS.length - failed.length - pending.length)}
          note="landed on the website"
        />
        <KpiCard
          label="Not listed"
          value={qty(notListed.length)}
          tone={notListed.length ? 'warn' : undefined}
          note="active products the website does not show"
        />
      </div>

      {failed.length > 0 && (
        <div className="notice notice-danger" style={{ marginTop: 16 }}>
          <span aria-hidden="true">●</span>
          <div>
            <strong>{failed.length} change(s) have not reached the website.</strong>{' '}
            Until they do, the site is showing a price or a stock figure the ERP
            has already changed. The reasons are on each row — one of them,
            &ldquo;the row was changed there since the last sync&rdquo;, is the
            case worth deciding on before this is built: the ERP owns these
            fields, so an edit made on the website is a conflict, not an update.
          </div>
        </div>
      )}

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(e) => e.id}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search product, change, error…"
        initialSort={{ key: 'at', dir: 'desc' }}
        emptyTitle="No sync events"
        emptyNote="Nothing matches this status or search."
        filters={(
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="all">All statuses</option>
            {Object.entries(SYNC_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        )}
      />

      <Modal
        open={!!retrying}
        onClose={() => setRetrying(null)}
        title="Retry is a prototype here"
        subtitle={retrying ? retrying.productName + ' · ' + retrying.id : ''}
        footer={<button className="btn btn-primary" onClick={() => setRetrying(null)}>Understood</button>}
      >
        <p>
          This button is here so the retry flow can be reviewed — where it
          lives, what it says, what happens to the row. It does not call the
          website, because there is no integration behind this build.
        </p>
        {retrying && (
          <p className="tiny muted">
            The failure to design around is this one:{' '}
            <em>{retrying.error}</em> — after {retrying.attempts} attempts.
            Worth deciding: does a retry re-send the current value, or the value
            as it was when the change was queued? They differ, and only the
            first is safe.
          </p>
        )}
      </Modal>
    </>
  );
}
