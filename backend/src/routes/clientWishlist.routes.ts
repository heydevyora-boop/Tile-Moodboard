/**
 * De'vyora Client Wishlist.
 *
 * Client-facing, no login -- the token in the URL is the credential:
 *   POST   /client-wishlists/register                       start a wishlist
 *   GET    /client-wishlists/:token                         read my own
 *   POST   /client-wishlists/:token/items                   heart a room
 *   DELETE /client-wishlists/:token/items/:imageId          unheart one
 *   POST   /client-wishlists/:token/submit                   send it to the studio
 *   GET    /client-wishlists/browse/themes                  the nine, plus Others
 *   GET    /client-wishlists/browse/images?themeId=          a theme's rooms
 *
 * Studio-facing, behind the login:
 *   GET    /client-wishlists/studio/all?status=             what clients have sent
 *   GET    /client-wishlists/studio/:id                     one in full
 *
 * THE PUBLIC ROUTES ARE DECLARED ABOVE router.use(authenticate)
 * DELIBERATELY, the same pattern and the same reasoning as
 * moodBoard.routes.ts's /shared/:token: a client walking into the
 * showroom has no account and no JWT, so the unguessable token stands
 * in for one. Nothing here reveals more than the client's own wishlist.
 *
 * `browse/` and `studio/` are literal prefixes so neither can ever be
 * mistaken for a token or an id by the ':token' route below them --
 * Express matches in declaration order, so the static paths come first.
 */

import { Router } from 'express';
import { authenticate, authorize } from '@middlewares/auth';
import { validate } from '@middlewares/validate';
import {
  clientWishlistRateLimiter,
  clientRegistrationRateLimiter,
} from '@middlewares/rateLimiters';
import * as controller from '@controllers/clientWishlist.controller';
import {
  registerClientSchema,
  wishlistItemSchema,
  clientImagesQuerySchema,
} from '@validators/clientWishlist.validators';

const router = Router();

// ---- public, token-scoped ----------------------------------------

router.get('/browse/themes', clientWishlistRateLimiter, controller.themes);
router.get(
  '/browse/images',
  clientWishlistRateLimiter,
  validate(clientImagesQuerySchema, 'query'),
  controller.images,
);

router.post(
  '/register',
  clientRegistrationRateLimiter,
  validate(registerClientSchema),
  controller.register,
);

router.get('/:token', clientWishlistRateLimiter, controller.getWishlist);
router.post(
  '/:token/items',
  clientWishlistRateLimiter,
  validate(wishlistItemSchema),
  controller.addItem,
);
router.delete('/:token/items/:imageId', clientWishlistRateLimiter, controller.removeItem);
router.delete('/:token/items', clientWishlistRateLimiter, controller.removeItem);
router.post('/:token/submit', clientWishlistRateLimiter, controller.submit);

// ---- studio, behind the login ------------------------------------

router.use(authenticate);

/**
 * OWNER AND ADMIN ONLY, and by role rather than by permission.
 *
 * Chunk 2 gated these on customers:read, which the seeded STAFF role
 * also holds -- so every member of floor staff could have read every
 * client's selection and phone number. A client register is the
 * studio's own book, so it is gated the way the other owner-only
 * surfaces already are (admin, settings, api keys, integrations):
 * authorize(), on the role itself. No new permission is introduced,
 * so no role has to be re-seeded for this to work.
 */
router.use('/studio', authorize('OWNER', 'ADMIN'));

router.get('/studio/all', controller.list);
router.get('/studio/:id', controller.getOne);

/* Build or finish a client's Drive folder. A write, so it is a POST,
 * and it is idempotent: when nothing is outstanding it changes
 * nothing and says so. */
router.post('/studio/:id/drive-sync', controller.driveSync);

export default router;
