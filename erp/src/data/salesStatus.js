/* ============================================================
   HOW THE SALES STATUSES ARE WORDED AND COLOURED
   ============================================================
   One table per document, read by every sales screen, the same
   convention as data/purchaseStatus.js. The keys are the
   database's own enum values.
   ============================================================ */

export const QUOTATION_STATUS = {
  DRAFT: { label: 'Draft', tone: 'inert', note: 'Not sent yet. Editable.' },
  SENT: { label: 'Sent', tone: 'info', note: 'Given to the customer, awaiting a decision.' },
  ACCEPTED: { label: 'Accepted', tone: 'ok', note: 'The customer agreed to it. Ready to convert.' },
  REJECTED: { label: 'Rejected', tone: 'danger', note: 'The customer declined it.' },
  EXPIRED: { label: 'Expired', tone: 'inert', note: 'Past its validity date.' },
  CONVERTED: { label: 'Converted', tone: 'ok', note: 'A sales order was raised from it.' },
  CANCELLED: { label: 'Cancelled', tone: 'inert', note: 'Withdrawn before any decision.' },
};

export const SO_STATUS = {
  DRAFT: { label: 'Draft', tone: 'inert', note: 'Not placed yet. Editable.' },
  PENDING_APPROVAL: { label: 'Pending approval', tone: 'warn', note: 'Raised, awaiting a decision.' },
  CONFIRMED: { label: 'Confirmed', tone: 'info', note: 'Committed to the customer. No stock has moved.' },
  PARTIALLY_RESERVED: { label: 'Partly reserved', tone: 'warn', note: 'Some lines are still unreserved.' },
  RESERVED: { label: 'Reserved', tone: 'ok', note: 'Every line is reserved, ready to dispatch.' },
  PARTIALLY_DISPATCHED: { label: 'Partly dispatched', tone: 'warn', note: 'Some lines are still outstanding.' },
  FULLY_DISPATCHED: { label: 'Fully dispatched', tone: 'ok', note: 'Every line has shipped in full.' },
  CLOSED: { label: 'Closed', tone: 'info', note: 'Finished with, short of the full quantity.' },
  CANCELLED: { label: 'Cancelled', tone: 'inert', note: 'Called off before anything shipped.' },
};

export const SI_STATUS = {
  DRAFT: { label: 'Draft', tone: 'inert' },
  POSTED: { label: 'Posted', tone: 'ok', note: 'A claim for payment. No stock moved by this document.' },
  CANCELLED: { label: 'Cancelled', tone: 'inert' },
};

export const DC_STATUS = {
  DRAFT: { label: 'Draft', tone: 'inert' },
  DISPATCHED: { label: 'Dispatched', tone: 'ok', note: 'Stock was moved by this challan.' },
  CANCELLED: { label: 'Cancelled', tone: 'inert' },
};

export const SR_STATUS = {
  DRAFT: { label: 'Draft', tone: 'inert' },
  POSTED: { label: 'Posted', tone: 'ok' },
  CANCELLED: { label: 'Cancelled', tone: 'inert' },
};

export const DISPOSITION = {
  ACCEPTED_GOOD: { label: 'Accepted — good', tone: 'ok', note: 'Back to sellable stock.' },
  DAMAGED: { label: 'Damaged', tone: 'warn', note: 'Physically back, but held as damaged stock.' },
  REJECTED: { label: 'Rejected', tone: 'danger', note: 'Claim refused. No stock movement.' },
};

export const PAYMENT_STATUS = {
  UNPAID: { label: 'Unpaid', tone: 'warn' },
  PARTIALLY_PAID: { label: 'Partly paid', tone: 'warn' },
  PAID: { label: 'Paid', tone: 'ok' },
  OVERDUE: { label: 'Overdue', tone: 'danger' },
};

export const SALES_GST_TREATMENT = {
  INTRA_STATE: { label: 'Intra-state', note: 'Same state: CGST and SGST, half the rate each.' },
  INTER_STATE: { label: 'Inter-state', note: 'Different states: IGST at the whole rate.' },
};

export const CUSTOMER_TYPE = {
  RETAIL: 'Retail', TRADE: 'Trade', PROJECT: 'Project', INTERNAL: 'Internal',
};
