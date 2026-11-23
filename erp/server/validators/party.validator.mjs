import { z } from 'zod';

/* ============================================================
   PARTY VALIDATION
   ============================================================ */

export const PartySearchQuery = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  type: z.enum(['CUSTOMER', 'SUPPLIER']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export const PartyTypeParam = z.enum(['CUSTOMER', 'SUPPLIER'], {
  errorMap: () => ({ message: 'partyType must be CUSTOMER or SUPPLIER.' }),
});

export const PartyHistoryQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});
