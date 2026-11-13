/**
 * WHAT THE SHOWROOM HOLDS OF EACH COLOUR, AND HOW TO FIND IT.
 *
 * A product comes in several colours, and the studio holds each of them
 * differently -- a real cut piece on a panel, a page in a catalogue, a
 * cutout, or nothing. Before this the only way to answer "do we have
 * this in green" was to walk to the rack and look.
 *
 * TWO IDS PER COLOUR, BOTH GENERATED HERE AND BOTH UNIQUE IN THE
 * DATABASE. The sample id is the short one a person says out loud; the
 * barcode is the one a scanner reads. They are separate because one is
 * retyped by hand and the other never is, and a single value serving
 * both ends up either unreadable or unscannable. Neither is ever taken
 * from the client: a browser that could choose a barcode could point
 * two colours at one piece of tile.
 *
 * DRIVE IS NOT ALLOWED TO COST THE STUDIO A SAMPLE. The photograph goes
 * to the same Drive folder the library uses, and if that fails the
 * sample is still registered, with the reason reported. A sample
 * without a photograph is a sample you can still find; a sample that
 * was never recorded because Drive was down is not.
 */

import { Request } from 'express';
import crypto from 'crypto';
import { prisma } from '@db/connection';
import { AppError } from '@utils/AppError';
import { logActivity } from './activityLog.service';
import { googleDriveClient } from './googleDrive.service';
import * as library from './library.service';
import { isRealImageBuffer } from '@utils/fileSignature';

/** Where every sample photograph goes, inside the studio's own folder. */
export const SAMPLE_PHOTO_FOLDER = 'Physical Samples';

export type Availability =
  | 'PHYSICAL_SAMPLE'
  | 'CATALOGUE_ONLY'
  | 'CUTOUT_ONLY'
  | 'NOT_AVAILABLE';

export const AVAILABILITIES: Availability[] = [
  'PHYSICAL_SAMPLE',
  'CATALOGUE_ONLY',
  'CUTOUT_ONLY',
  'NOT_AVAILABLE',
];

/**
 * No I, O, 0 or 1 in a sample id.
 *
 * It is read off a panel in showroom light and written on paper, and
 * those four are the pairs that get misread. The barcode has no such
 * problem -- a scanner does not squint -- but it shares the alphabet so
 * that a barcode read aloud over the phone still survives.
 */
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomId(length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

/** "S-4K7QP" -- short enough to say, long enough not to collide. */
export function newSampleId(): string {
  return `S-${randomId(5)}`;
}

/**
 * "DVS-9H3K2R4M" -- the machine-readable one.
 *
 * Longer than the sample id because it is never typed, and prefixed so
 * that a scan of somebody else's barcode is recognisably not ours
 * rather than a lookup that mysteriously finds nothing.
 */
export function newBarcode(): string {
  return `DVS-${randomId(8)}`;
}

export const BARCODE_PREFIX = 'DVS-';

/**
 * The colours of one product, with what the studio holds of each.
 *
 * One query, with the sample and its current placement joined in --
 * not one query per colour. A product with twelve colours costs the
 * same as a product with one.
 */
export async function coloursForProduct(productId: string) {
  const id = String(productId ?? '').trim();
  if (!id) throw AppError.badRequest('Which product?');

  const product = await prisma.tile.findUnique({
    where: { id },
    select: { id: true, name: true, productCode: true, brandId: true },
  });
  if (!product) throw AppError.notFound('That product is not in the catalogue.');

  const colours = await prisma.productColour.findMany({
    where: { productId: id },
    orderBy: { colourName: 'asc' },
    include: {
      sample: {
        include: {
          placements: { where: { isCurrent: true }, take: 1 },
        },
      },
    },
  });

  return { product, colours: colours.map(shapeColour) };
}

/** What a colour looks like to a caller: the state, and where it is. */
export function shapeColour(colour: {
  id: string; productId: string; colourName: string; colourCode: string | null;
  availability: string; notes: string | null; createdAt: Date; updatedAt: Date;
  sample?: {
    id: string; sampleId: string; barcode: string; photoUrl: string | null;
    photoDriveFileId: string | null;
    placements?: Array<{ id: string; cassetteNo: string; panelNo: string; placedAt: Date }>;
  } | null;
}) {
  const current = colour.sample?.placements?.[0] ?? null;
  return {
    id: colour.id,
    productId: colour.productId,
    colourName: colour.colourName,
    colourCode: colour.colourCode,
    availability: colour.availability,
    notes: colour.notes,
    createdAt: colour.createdAt,
    updatedAt: colour.updatedAt,
    sample: colour.sample
      ? {
        id: colour.sample.id,
        sampleId: colour.sample.sampleId,
        barcode: colour.sample.barcode,
        photoUrl: colour.sample.photoUrl,
        hasPhoto: !!colour.sample.photoDriveFileId,
        placement: current
          ? {
            id: current.id,
            cassetteNo: current.cassetteNo,
            panelNo: current.panelNo,
            placedAt: current.placedAt,
          }
          : null,
      }
      : null,
  };
}

export interface ColourInput {
  productId: string;
  colourName: string;
  colourCode?: string;
  availability?: Availability;
  notes?: string;
}

/**
 * Add a colour to a product, or change what the studio holds of it.
 *
 * Keyed on (product, colour name), so entering the same colour twice is
 * one colour -- the second entry updates the first rather than
 * producing two rows nobody can tell apart. The unique constraint in
 * the database says the same thing, and this agrees with it rather than
 * racing it.
 */
export async function upsertColour(input: ColourInput, userId?: string, req?: Request) {
  const productId = String(input.productId ?? '').trim();
  const colourName = String(input.colourName ?? '').trim();
  if (!productId) throw AppError.badRequest('Which product?');
  if (!colourName) throw AppError.badRequest('A colour needs a name.');

  const availability = (input.availability ?? 'NOT_AVAILABLE') as Availability;
  if (!AVAILABILITIES.includes(availability)) {
    throw AppError.badRequest(
      `"${availability}" is not one of: ${AVAILABILITIES.join(', ')}.`,
    );
  }

  const product = await prisma.tile.findUnique({ where: { id: productId }, select: { id: true } });
  if (!product) throw AppError.notFound('That product is not in the catalogue.');

  const existing = await prisma.productColour.findUnique({
    where: { productId_colourName: { productId, colourName } },
    include: { sample: true },
  });

  /* A COLOUR CANNOT BE DEMOTED WHILE ITS SAMPLE IS ON A PANEL.
     Saying "catalogue only" of a colour that has a piece sitting in
     cassette 4 would leave the panel holding something the system
     believes is not there. The sample comes off the panel first. */
  if (existing?.sample && availability !== 'PHYSICAL_SAMPLE') {
    throw AppError.badRequest(
      `"${colourName}" still has a registered physical sample (${existing.sample.sampleId}). `
      + 'Remove the sample first, then change what the studio holds of this colour.',
    );
  }

  const colour = existing
    ? await prisma.productColour.update({
      where: { id: existing.id },
      data: {
        colourCode: input.colourCode?.trim() || null,
        availability,
        notes: input.notes?.trim() || null,
      },
    })
    : await prisma.productColour.create({
      data: {
        productId,
        colourName,
        colourCode: input.colourCode?.trim() || null,
        availability,
        notes: input.notes?.trim() || null,
      },
    });

  await logActivity({
    userId: userId ?? null,
    action: existing ? 'sample_colour.updated' : 'sample_colour.created',
    entityType: 'ProductColour',
    entityId: colour.id,
    metadata: { productId, colourName, availability },
    req,
  });

  return colour;
}

export interface RegisterSampleInput {
  cassetteNo: string;
  panelNo: string;
  note?: string;
}

export interface SampleRegistration {
  sample: { id: string; sampleId: string; barcode: string; photoUrl: string | null };
  placement: { id: string; cassetteNo: string; panelNo: string };
  /** Empty when the photograph is in Drive; a reason when it is not. */
  photoError: string;
}

/**
 * Register the piece that is on the panel.
 *
 * This is where a colour becomes findable: it gets its own sample id,
 * its own barcode, its first placement, and -- when Drive is willing --
 * its photograph. The colour is moved to PHYSICAL_SAMPLE in the same
 * transaction, so a sample and a colour that claims to have none cannot
 * both be true.
 *
 * THE FIRST PLACEMENT NEEDS NO APPROVAL. There is nothing to disturb
 * yet; it is a later MOVE that an Admin has to agree to. See
 * samplePlacement.service.
 */
export async function registerSample(
  colourId: string,
  input: RegisterSampleInput,
  photo?: { buffer: Buffer; mimetype: string; originalname: string },
  userId?: string,
  req?: Request,
): Promise<SampleRegistration> {
  const id = String(colourId ?? '').trim();
  const cassetteNo = String(input.cassetteNo ?? '').trim();
  const panelNo = String(input.panelNo ?? '').trim();

  if (!cassetteNo) throw AppError.badRequest('A sample needs the cassette it sits in.');
  if (!panelNo) throw AppError.badRequest('A sample needs the panel it sits on.');

  const colour = await prisma.productColour.findUnique({
    where: { id },
    include: { sample: true, product: { select: { name: true } } },
  });
  if (!colour) throw AppError.notFound('That colour is not on record.');
  if (colour.sample) {
    throw AppError.badRequest(
      `"${colour.colourName}" already has a registered sample (${colour.sample.sampleId}). `
      + 'To move it, raise a relocation request instead.',
    );
  }

  if (photo && !isRealImageBuffer(photo.buffer)) {
    throw AppError.badRequest(
      `"${photo.originalname}" is not actually a JPEG, PNG or WebP image.`,
    );
  }

  /* THE RECORD FIRST, THE PHOTOGRAPH SECOND.
     Writing the sample before touching Drive is deliberate: a studio
     whose Drive is down still gets a findable sample, and the photo is
     attached afterwards or reported as missing. The other order loses
     the sample whenever Google has a bad afternoon. */
  const created = await prisma.$transaction(async (tx) => {
    let sample = null;
    for (let attempt = 0; attempt < 5 && !sample; attempt += 1) {
      try {
        sample = await tx.physicalSample.create({
          data: { colourId: id, sampleId: newSampleId(), barcode: newBarcode() },
        });
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        // P2002 here is a sample id or barcode collision, which is rare
        // and cheap to retry -- unlike a counter, which would need a
        // lock. A collision on colourId is a different matter: that
        // colour already has a sample, and retrying cannot help.
        if (code !== 'P2002' || attempt === 4) throw error;
      }
    }
    if (!sample) throw AppError.internal('A sample id could not be allocated.');

    const placement = await tx.samplePlacement.create({
      data: {
        physicalSampleId: sample.id,
        cassetteNo,
        panelNo,
        isCurrent: true,
        placedById: userId ?? null,
        note: input.note?.trim() || null,
      },
    });

    await tx.productColour.update({
      where: { id },
      data: { availability: 'PHYSICAL_SAMPLE' },
    });

    return { sample, placement };
  });

  let photoError = '';
  if (photo) {
    try {
      const stored = await storePhoto(created.sample.sampleId, photo);
      await prisma.physicalSample.update({
        where: { id: created.sample.id },
        data: { photoDriveFileId: stored.fileId, photoUrl: stored.url },
      });
      created.sample.photoDriveFileId = stored.fileId;
      created.sample.photoUrl = stored.url;
    } catch (error) {
      photoError = describePhotoFailure(error);
    }
  }

  await logActivity({
    userId: userId ?? null,
    action: 'physical_sample.registered',
    entityType: 'PhysicalSample',
    entityId: created.sample.id,
    metadata: {
      sampleId: created.sample.sampleId,
      colourId: id,
      cassetteNo,
      panelNo,
      photo: photo ? (photoError ? 'failed' : 'stored') : 'none',
    },
    req,
  });

  return {
    sample: {
      id: created.sample.id,
      sampleId: created.sample.sampleId,
      barcode: created.sample.barcode,
      photoUrl: created.sample.photoUrl,
    },
    placement: {
      id: created.placement.id,
      cassetteNo: created.placement.cassetteNo,
      panelNo: created.placement.panelNo,
    },
    photoError,
  };
}

/**
 * The photograph, in the studio's own Drive folder.
 *
 * Inside the folder the library already uses, for the same reason the
 * client wishlists live there: with `drive.file` it is the one place
 * this credential may create anything. Nothing about the existing OAuth
 * configuration, its scopes or the service-account fallback changes.
 */
async function storePhoto(
  sampleId: string,
  photo: { buffer: Buffer; mimetype: string; originalname: string },
): Promise<{ fileId: string; url: string }> {
  if (!googleDriveClient.isConfigured()) {
    throw new Error('Google Drive is not connected');
  }

  const parent = await library.describeLibraryFolder();
  if (!parent.ok || !parent.folderId) {
    throw new Error(parent.reason || 'the studio’s Drive folder could not be opened');
  }

  const folder = await googleDriveClient.getOrCreateFolder(SAMPLE_PHOTO_FOLDER, parent.folderId);
  const extension = photo.mimetype === 'image/png' ? '.png'
    : photo.mimetype === 'image/webp' ? '.webp' : '.jpg';

  const uploaded = await googleDriveClient.uploadFile({
    name: `${sampleId}${extension}`,
    mimeType: photo.mimetype,
    content: photo.buffer,
    parentFolderId: folder.id,
  });

  // Served to a browser the same way the library's own pictures are:
  // the stored download form draws nothing in an <img>.
  return {
    fileId: uploaded.id,
    url: `https://drive.google.com/thumbnail?id=${uploaded.id}&sz=w1000`,
  };
}

/** Drive's refusals, in words that name the remedy. */
export function describePhotoFailure(error: unknown): string {
  const message = (error as { message?: string } | null)?.message || String(error);

  if (/not connected|not configured/i.test(message)) {
    return 'The sample is registered, but its photograph was not stored: the studio’s '
      + 'Google account is not connected. Connect it and add the photograph again.';
  }
  if (/insufficient|permission|forbidden|403/i.test(message)) {
    return 'The sample is registered, but Google Drive refused the photograph for want of '
      + 'permission. The connected account needs edit access to the studio’s Drive folder.';
  }
  if (/quota|storage/i.test(message)) {
    return 'The sample is registered, but Google Drive refused the photograph for want of '
      + 'storage quota.';
  }
  return `The sample is registered, but its photograph was not stored: ${message}`;
}

/**
 * ONE SCAN, ONE ANSWER.
 *
 * What the scanner at the panel calls. It returns the colour, the
 * product and where the piece is supposed to be, because that is the
 * whole question someone holding a scanner has.
 *
 * Case and surrounding whitespace are forgiven -- a scanner wedge
 * sometimes adds a newline, and a barcode read aloud comes back in
 * lower case -- but nothing else about the code is guessed at.
 */
export async function findByBarcode(code: string) {
  const value = String(code ?? '').trim().toUpperCase();
  if (!value) throw AppError.badRequest('No barcode was scanned.');

  const sample = await prisma.physicalSample.findUnique({
    where: { barcode: value },
    include: {
      colour: { include: { product: { select: { id: true, name: true, productCode: true } } } },
      placements: { where: { isCurrent: true }, take: 1 },
    },
  });

  if (!sample) {
    throw AppError.notFound(
      value.startsWith(BARCODE_PREFIX)
        ? `No sample carries the barcode ${value}. It may have been removed from the library.`
        : `${value} is not one of the studio’s barcodes.`,
    );
  }

  const current = sample.placements[0] ?? null;
  return {
    sampleId: sample.sampleId,
    barcode: sample.barcode,
    photoUrl: sample.photoUrl,
    colour: {
      id: sample.colour.id,
      colourName: sample.colour.colourName,
      colourCode: sample.colour.colourCode,
      availability: sample.colour.availability,
    },
    product: sample.colour.product,
    placement: current
      ? { cassetteNo: current.cassetteNo, panelNo: current.panelNo, placedAt: current.placedAt }
      : null,
    id: sample.id,
  };
}

/**
 * Take a sample off the panel.
 *
 * The colour drops back to NOT_AVAILABLE and the placement history is
 * kept, because "this used to be in cassette 4 until March" is still
 * worth knowing after the piece is gone.
 */
export async function removeSample(physicalSampleId: string, userId?: string, req?: Request) {
  const id = String(physicalSampleId ?? '').trim();
  const sample = await prisma.physicalSample.findUnique({
    where: { id },
    select: { id: true, sampleId: true, colourId: true },
  });
  if (!sample) throw AppError.notFound('That sample is not on record.');

  await prisma.$transaction(async (tx) => {
    await tx.samplePlacement.updateMany({
      where: { physicalSampleId: id, isCurrent: true },
      data: { isCurrent: false, endedAt: new Date() },
    });
    await tx.placementChangeRequest.updateMany({
      where: { physicalSampleId: id, status: 'PENDING' },
      data: {
        status: 'REJECTED',
        decidedById: userId ?? null,
        decidedAt: new Date(),
        decisionNote: 'The sample was removed from the library.',
      },
    });
    await tx.productColour.update({
      where: { id: sample.colourId },
      data: { availability: 'NOT_AVAILABLE' },
    });
    // The sample row goes, its placements with it by cascade -- but the
    // history above was closed off first so the activity log and any
    // report built from it still read correctly.
    await tx.physicalSample.delete({ where: { id } });
  });

  await logActivity({
    userId: userId ?? null,
    action: 'physical_sample.removed',
    entityType: 'PhysicalSample',
    entityId: id,
    metadata: { sampleId: sample.sampleId, colourId: sample.colourId },
    req,
  });

  return { removed: true, sampleId: sample.sampleId };
}
