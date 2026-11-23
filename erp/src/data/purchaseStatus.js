/* ============================================================
   HOW THE PURCHASE STATUSES ARE WORDED AND COLOURED
   ============================================================
   One table, read by every purchase screen, so a status cannot
   be called one thing on the order list and another on the
   dashboard. The keys are the database's own enum values.
   ============================================================ */

export const PO_STATUS = {
  DRAFT: { label: 'Draft', tone: 'inert', note: 'Not placed with anybody yet. Editable.' },
  PENDING_APPROVAL: { label: 'Pending approval', tone: 'warn', note: 'Raised, awaiting a decision.' },
  APPROVED: { label: 'Approved', tone: 'info', note: 'Placed with the supplier. No stock has moved.' },
  PARTIALLY_RECEIVED: { label: 'Partly received', tone: 'warn', note: 'Some lines are still outstanding.' },
  FULLY_RECEIVED: { label: 'Fully received', tone: 'ok', note: 'Every line has arrived in full.' },
  CANCELLED: { label: 'Cancelled', tone: 'inert', note: 'Called off before anything arrived.' },
  CLOSED: { label: 'Closed', tone: 'info', note: 'Finished with, short of the full quantity.' },
};

export const GRN_STATUS = {
  DRAFT: { label: 'Draft', tone: 'inert' },
  POSTED: { label: 'Posted', tone: 'ok', note: 'Stock was moved by this receipt.' },
  CANCELLED: { label: 'Cancelled', tone: 'inert' },
};

export const INVOICE_STATUS = {
  RECEIVED: { label: 'Received', tone: 'info', note: 'Recorded, not yet matched.' },
  MATCHED: { label: 'Matched', tone: 'ok', note: 'Agreed against the goods received.' },
  DISPUTED: { label: 'Disputed', tone: 'danger', note: 'Queried with the supplier.' },
  CANCELLED: { label: 'Cancelled', tone: 'inert' },
};

export const GST_TREATMENT = {
  INTRA_STATE: { label: 'Intra-state', note: 'Same state: CGST and SGST, half the rate each.' },
  INTER_STATE: { label: 'Inter-state', note: 'Different states: IGST at the whole rate.' },
  UNREGISTERED: { label: 'Unregistered', note: 'Supplier has no GSTIN, so no GST is charged.' },
};
