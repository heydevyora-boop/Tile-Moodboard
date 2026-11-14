/**
 * Physical Sample Placement & Barcode Tracking.
 *
 *   GET    /samples/availability                 the four states
 *   GET    /samples/colours?productId=           one product's colours
 *   POST   /samples/colours                      add a colour / set its state
 *   POST   /samples/colours/:colourId/sample     register the piece (multipart)
 *   GET    /samples/by-barcode/:code             ONE SCAN, ONE ANSWER
 *   GET    /samples/contents?cassetteNo=&panelNo= what is in a cassette
 *   GET    /samples/:id/history                  everywhere it has been
 *   DELETE /samples/:id                          take it off the panel
 *   POST   /samples/:id/relocation-requests      ask to move it
 *   GET    /samples/relocation-requests          the Admin's queue
 *   POST   /samples/relocation-requests/:id/approve
 *   POST   /samples/relocation-requests/:id/reject
 *
 * THREE GATES, AND WHY EACH IS WHERE IT IS.
 *
 * Reads use `tiles:read`, which Owner, Admin and Staff all hold: a
 * scanner in a staff member's hand is the whole point of the feature,
 * and a gate they failed would make the module useless on the floor.
 *
 * Registering, removing and changing a colour use `tiles:write`, which
 * Owner and Admin hold: these are catalogue facts.
 *
 * Deciding a move uses authorize('OWNER','ADMIN') -- a ROLE gate, the
 * same one admin, settings and the client register already use. The
 * ASKING sits on `tiles:read` on purpose: staff are the ones who
 * actually move samples, and a request changes nothing until it is
 * approved. The gate that protects the shelf is on the approval.
 *
 * No new permission string is introduced, so no role has to be
 * re-seeded for any of this to work -- the lesson of the Owner whose
 * ["*"] was not matched by a named-permission check.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { AppError } from '@utils/AppError';
import { authenticate, authorize, requirePermission } from '@middlewares/auth';
import { validate } from '@middlewares/validate';
import { uploadReferenceImage } from '@middlewares/uploadReferenceImage';
import * as controller from '@controllers/sample.controller';
import {
  upsertColourSchema,
  registerSampleSchema,
  relocationRequestSchema,
  decisionSchema,
  rejectionSchema,
  bulkRegisterSchema,
  removalRequestSchema,
  sampleListQuerySchema,
  coloursQuerySchema,
  requestsQuerySchema,
  contentsQuerySchema,
} from '@validators/sample.validators';

const router = Router();

router.use(authenticate);

// ── static paths first, or ':id' would swallow them ──────────────

router.get('/availability', requirePermission('tiles:read'), controller.availabilityOptions);

router.get(
  '/colours',
  requirePermission('tiles:read'),
  validate(coloursQuerySchema, 'query'),
  controller.listColours,
);
router.post(
  '/colours',
  requirePermission('tiles:write'),
  validate(upsertColourSchema),
  controller.upsertColour,
);

/* The photograph rides in as multipart, so the existing reference-image
   upload middleware is reused whole: memoryStorage (Vercel keeps no
   disk), the same mime allowlist, the same size limit. The service
   checks the actual bytes on top of that. */
router.post(
  '/colours/:colourId/sample',
  requirePermission('tiles:write'),
  uploadReferenceImage,
  validate(registerSampleSchema),
  controller.registerSample,
);

/* DUPLICATE FOR OTHER COLOURS -- one photograph, several samples, each
   still its own record. Declared before '/:id' like every other static
   path here. */
router.post(
  '/colours/bulk',
  requirePermission('tiles:write'),
  uploadReferenceImage,
  validate(bulkRegisterSchema),
  controller.registerForColours,
);

router.get('/by-barcode/:code', requirePermission('tiles:read'), controller.byBarcode);

/* The Sample Placement screen's own listing: searchable, filterable and
   paged, because a showroom's sample library gets long. */
router.get(
  '/',
  requirePermission('tiles:read'),
  validate(sampleListQuerySchema, 'query'),
  controller.listSamples,
);

router.get(
  '/contents',
  requirePermission('tiles:read'),
  validate(contentsQuerySchema, 'query'),
  controller.contents,
);

// ── the Admin's queue, before '/:id' ─────────────────────────────

router.get(
  '/relocation-requests',
  authorize('OWNER', 'ADMIN'),
  validate(requestsQuerySchema, 'query'),
  controller.listRequests,
);
router.post(
  '/relocation-requests/:id/approve',
  authorize('OWNER', 'ADMIN'),
  validate(decisionSchema),
  controller.approve,
);
router.post(
  '/relocation-requests/:id/reject',
  authorize('OWNER', 'ADMIN'),
  validate(rejectionSchema),
  controller.reject,
);

// ── one sample ───────────────────────────────────────────────────

router.get('/:id/history', requirePermission('tiles:read'), controller.history);

router.post(
  '/:id/relocation-requests',
  requirePermission('tiles:read'),
  validate(relocationRequestSchema),
  controller.requestRelocation,
);

/* REMOVAL IS A REQUEST, NOT A DELETE.
 *
 * There is deliberately no DELETE route on a sample. Taking one off the
 * shelf changes an existing placement, so it goes through the same
 * Admin approval as a move -- and approving it marks the sample
 * REMOVED while keeping its id, its barcode and its whole history, so
 * the piece can be put back later through an ordinary placement
 * request. Nothing in this module deletes a sample record. */
router.post(
  '/:id/removal-requests',
  requirePermission('tiles:read'),
  validate(removalRequestSchema),
  controller.requestRemoval,
);

/**
 * A MISSING TABLE, EXPLAINED RATHER THAN NUMBERED.
 *
 * vercel.json's buildCommand is `prisma generate` alone, so a deploy
 * ships this module and none of its four tables until somebody runs the
 * migration. Prisma answers P2021, the global handler turns any code it
 * does not recognise into "Database request error (P2021)", and that is
 * what reached the owner's screen -- a number that names neither the
 * cause nor the cure, on every screen of the feature at once.
 *
 * The De'vyora Library already learned this and says so in words
 * (library.service.describeStorageFailure). This is the same answer for
 * the same question, given once for the whole router rather than
 * wrapped around every call in it.
 *
 * Registered AFTER the routes, so it only ever sees their errors;
 * anything it does not recognise goes on to the global handler
 * untouched.
 */
router.use((error: unknown, _req: Request, _res: Response, next: NextFunction) => {
  const code = (error as { code?: string } | null)?.code;

  if (code === 'P2021' || code === 'P2022') {
    next(AppError.badRequest(
      'The physical-sample tables have not been created in this database yet. Run '
      + '`cd backend && npx prisma migrate deploy` against it \u2014 this project\u2019s '
      + 'build runs `prisma generate` only, so a deployment does not create them.',
    ));
    return;
  }

  next(error);
});

export default router;
