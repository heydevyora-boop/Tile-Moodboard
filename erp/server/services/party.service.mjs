import * as customers from './customer.service.mjs';
import * as suppliers from './supplier.service.mjs';

/* ============================================================
   PARTIES — A THIN SEARCH OVER TWO SEPARATE TABLES
   ============================================================
   The brief's Step 8 asks for "customer search, supplier search,
   party details, party transaction history... reuse the existing
   Party model wherever applicable." There is no Party model in
   this schema, and there never has been one in any step so far:
   Customer and Supplier are deliberately separate tables, with
   separate registrations, terms and histories, because the same
   company buying from the studio and selling to it is two
   relationships, not one row that would collapse the difference.
   That decision predates this step and is not reopened by it.

   So this file is exactly what the chosen scope says: a SEARCH
   SURFACE over both, reusing customer.service.mjs and
   supplier.service.mjs completely unchanged. It invents no new
   table, no new model, and no merged identity between a customer
   and a supplier that happen to share a name.

   search() IS NOT A TRUE GLOBAL PAGINATION over the combined set.
   It asks each service for up to `pageSize` rows of its own,
   tags each with partyType, and merges the two lists by name.
   That is the right shape for "find this party, whichever side
   of the ledger they are on" -- the question this endpoint
   actually answers -- and the wrong shape for "page 7 of every
   party in the system", which nothing in this ERP currently asks
   for. Documented here and in the API reference rather than
   built past what was asked.
   ============================================================ */

export async function search({ search: term, type, page = 1, pageSize = 25 } = {}) {
  const take = Math.min(Math.max(Number(pageSize) || 25, 1), 100);

  const [customerRows, supplierRows] = await Promise.all([
    type === 'SUPPLIER' ? { rows: [] } : customers.list({ search: term, page: 1, pageSize: take }),
    type === 'CUSTOMER' ? { rows: [] } : suppliers.list({ search: term, page: 1, pageSize: take }),
  ]);

  const merged = [
    ...customerRows.rows.map((c) => ({ partyType: 'CUSTOMER', id: c.id, code: c.code, name: c.name, gstin: c.gstin, isActive: c.isActive, contact: c.contact })),
    ...supplierRows.rows.map((s) => ({ partyType: 'SUPPLIER', id: s.id, code: s.code, name: s.name, gstin: s.gstin, isActive: s.isActive, contact: s.contact })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const total = merged.length;
  const start = (Math.max(Number(page) || 1, 1) - 1) * take;

  return {
    rows: merged.slice(start, start + take),
    page: Math.max(Number(page) || 1, 1),
    pageSize: take,
    total,
    pageCount: Math.max(1, Math.ceil(total / take)),
  };
}

/** One party, read from whichever table it actually lives in. */
export async function get(partyType, id) {
  if (partyType === 'CUSTOMER') return { partyType, ...(await customers.get(id)) };
  if (partyType === 'SUPPLIER') return { partyType, ...(await suppliers.get(id)) };
  throw new Error('partyType must be CUSTOMER or SUPPLIER.');
}

/** A party's own transaction history, from its own service -- not
 *  reimplemented here, just dispatched to the right one. */
export async function history(partyType, id, query) {
  if (partyType === 'CUSTOMER') return { partyType, ...(await customers.history(id, query)) };
  if (partyType === 'SUPPLIER') return { partyType, ...(await suppliers.history(id, query)) };
  throw new Error('partyType must be CUSTOMER or SUPPLIER.');
}
