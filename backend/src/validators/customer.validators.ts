import { z } from 'zod';

export const createCustomerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().email().optional().or(z.literal('')),
  preferredStyle: z.string().trim().toUpperCase().max(40).optional(),
  preferredRoom: z.string().trim().toUpperCase().max(40).optional(),
  budget: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const updateCustomerSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().max(30).optional(),
    email: z.string().trim().email().optional().or(z.literal('')),
    preferredStyle: z.string().trim().toUpperCase().max(40).optional(),
    preferredRoom: z.string().trim().toUpperCase().max(40).optional(),
    budget: z.string().trim().max(40).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });

export const listCustomersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().optional(),
});

export const addFavoriteSchema = z.object({
  tileId: z.string().min(1),
  note: z.string().trim().max(500).optional(),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;
export type AddFavoriteInput = z.infer<typeof addFavoriteSchema>;
