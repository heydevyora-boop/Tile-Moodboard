/**
 * What a client is allowed to send.
 *
 * Deliberately small. A registration is a name and perhaps a number; a
 * selection is an image id and NOTHING ELSE -- no theme, no title, no
 * url -- because clientWishlist.service reads all of that from the
 * library itself. A browser that sends extra fields has them ignored
 * rather than trusted.
 */

import { z } from 'zod';

export const registerClientSchema = z.object({
  // Required, and the same bounds the studio's own customer form uses,
  // so a client and a staff-entered customer cannot differ in what
  // counts as a name.
  name: z.string().trim().min(1, 'Please enter a name.').max(120),
  // Optional, as asked: a client who will not leave a number still
  // gets a wishlist.
  phone: z.string().trim().max(30).optional().or(z.literal('')),
});

export const wishlistItemSchema = z.object({
  imageId: z.string().trim().min(1, 'Choose a room first.').max(200),
});

export const clientImagesQuerySchema = z.object({
  themeId: z.string().trim().max(60).optional(),
});

export type RegisterClientBody = z.infer<typeof registerClientSchema>;
export type WishlistItemBody = z.infer<typeof wishlistItemSchema>;
