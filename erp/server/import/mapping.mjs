/* ============================================================
   THE SOURCE, AS IT ACTUALLY IS
   ============================================================

   Read out of the existing pipeline, not assumed:
   catalog_processor/app/google_services.py, MASTER_SHEETS.
   Nothing in that file was changed, and nothing here writes to it.

   THE SHEET HAS NINE TABS. The ERP reads MASTER (tiles and
   surfaces); BRANDS and CATALOGS are reference tabs the pipeline
   maintains, and SANITARY, FAUCETS, BASINS, WC and FLUSH_PLATES
   are separate product families with their own, shorter column
   lists. Only MASTER is mapped here. The others are listed below
   so that adding one later is a mapping entry rather than a
   discovery exercise.

   ── THE THING THAT CHANGES EVERYTHING ──────────────────────

   ONE MASTER ROW IS ONE EXTRACTED IMAGE, NOT ONE PRODUCT.

   The pipeline builds its Product ID as

       make_product_id(brand, catalog, image_index)
         -> "ARCHROCK-ADOBE-COLLECTION-0001"

   -- brand, catalogue and the index of the image on the page. So
   the same physical tile photographed on two pages is two rows
   with two Product IDs, and the sheet has no way to say they are
   the same thing.

   The ERP therefore CANNOT treat a MASTER row as a variant and
   create one product per row: that would multiply the catalogue
   by however many times each tile was photographed. What it does
   instead is in duplicates.mjs -- match on the attributes that
   identify a product, and send anything ambiguous to a person.
   ============================================================ */

/** The MASTER tab's columns, in order, exactly as the pipeline writes them. */
export const MASTER_COLUMNS = [
  'Product ID', 'Brand ID', 'Brand', 'Catalog ID', 'Catalog', 'PDF Name',
  'Product Name', 'SKU / Product Code', 'Page', 'Image Index', 'Drive URL', 'Image Filename',
  'Finish Override', 'Finish Extracted', 'Finish AI', 'Finish Source', 'Resolved Finish',
  'Budget Override', 'Budget Source', 'Resolved Budget',
  'Suitable for Wall', 'Suitable for Floor', 'Bathroom Wall', 'Bathroom Floor',
  'Shower Area', 'Highlight Suitable', 'Floor / Wall', 'Application Source',
  'Dimensions', 'Length', 'Width', 'Thickness', 'Format',
  'Slip Rating', 'PEI', 'DCOF', 'Technical Notes',
  'AI Style', 'AI Color', 'AI Tone', 'AI Pattern', 'AI Veining', 'AI Contrast',
  'AI Classification Status', 'AI Classification Source',
  'Status', 'Notes',
];

/** The other tabs, for reference. Not mapped in this phase. */
export const OTHER_SHEETS = {
  BRANDS: 'Reference tab the pipeline maintains. Brand ID, Brand Name, Parent Folder, Status, Notes.',
  CATALOGS: 'Reference tab: Catalog ID, Brand ID, Brand Name, Catalog Name, PDF Name, defaults, Status.',
  SANITARY: 'A separate product family with its own 14 columns. Not mapped yet.',
  FAUCETS: 'A separate product family with its own 13 columns. Not mapped yet.',
  BASINS: 'A separate product family with its own 14 columns. Not mapped yet.',
  WC: 'A separate product family with its own 14 columns. Not mapped yet.',
  FLUSH_PLATES: 'A separate product family with its own 14 columns. Not mapped yet.',
  SETTINGS: 'Pipeline configuration. Nothing for the ERP.',
};

/**
 * WHAT THE BRIEF EXPECTED AND THE SOURCE DOES NOT HAVE.
 *
 * Stated rather than quietly defaulted. Every one of these was
 * checked against MASTER_SHEETS; none of them is a column, under
 * any spelling.
 */
export const FIELDS_ABSENT_FROM_SOURCE = {
  purchasePrice: 'No price column of any kind exists in MASTER. The extraction pipeline reads catalogues, which do not print trade prices. Prices must be entered in the ERP.',
  sellingPrice: 'Same. The ERP is the only place a price exists.',
  productHead: 'MASTER has "Catalog" — the PDF a product was found in — which is NOT a product series. A PDF may hold several series and a series may span PDFs. The head is therefore left unset on import for a person to assign; guessing it would scatter variants across heads that do not exist.',
  material: 'No column. Relevant to GRC and architectural products, which do not come through MASTER at all today.',
  unit: 'No column. Defaults to the ERP’s own BOX, which is what tile is traded in.',
  colour: 'Only "AI Color", which is a model’s reading of a photograph, carrying its own "AI Classification Status". Mapped, but flagged as AI-derived rather than stated by the supplier.',
  description: 'Closest are "Technical Notes" and "Notes", both free text. Mapped to notes, not to a product description.',
};

/** Trim, and treat the pipeline's own placeholders as absent. */
function clean(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  // The pipeline writes these where it genuinely does not know.
  // Carrying them into the ERP as data would turn "nobody knows"
  // into a product attribute called UNKNOWN.
  if (['UNKNOWN', 'NOT_CLASSIFIED', 'N/A', '-', 'NA'].includes(text.toUpperCase())) return null;
  return text;
}

/** A number, or null. Never NaN, and never a silent zero.
 *
 *  THE TRAP THIS CLOSES: stripping non-digits out of "about nine"
 *  leaves an empty string, and Number('') is 0 -- which is finite,
 *  so the obvious guard passes it. A tile would have arrived with
 *  a thickness of zero millimetres, looking like data rather than
 *  like the unreadable cell it was. The stripped text has to
 *  contain an actual digit before it is believed. */
function num(value) {
  const text = clean(value);
  if (text === null) return null;

  const stripped = String(text).replace(/[^0-9.\-]/g, '');
  if (!/\d/.test(stripped)) return null;

  const n = Number(stripped);
  return Number.isFinite(n) ? n : null;
}

/**
 * Work out a size string the ERP can store.
 *
 * MASTER has "Dimensions" (free text), and separate "Length" and
 * "Width". Dimensions is preferred because it is what the
 * catalogue printed; the two numbers are the fallback. Where
 * neither is present the size is null, and validation rejects the
 * row — a tile without a size is not importable, and inventing
 * one from the image would be a guess about a mandatory field.
 */
function resolveSize(row) {
  const dimensions = clean(row['Dimensions']);
  if (dimensions) return dimensions;

  const length = num(row['Length']);
  const width = num(row['Width']);
  if (length && width) return length + 'x' + width + 'mm';
  return null;
}

/**
 * Turn one MASTER row into the shape product.service.create()
 * takes — or as much of it as the source can honestly supply.
 *
 * Anything the source does not carry is left OUT, not defaulted.
 * An absent field and a field set to a plausible guess look the
 * same in the database afterwards, and only one of them is true.
 */
export function mapMasterRow(row) {
  const brandName = clean(row['Brand']);
  const productName = clean(row['Product Name']);
  const size = resolveSize(row);

  // Finish has four source columns in priority order: a human
  // override, what the catalogue text said, what the model
  // guessed, and the pipeline's own resolution of those.
  const finish = clean(row['Finish Override'])
    ?? clean(row['Finish Extracted'])
    ?? clean(row['Resolved Finish'])
    ?? clean(row['Finish AI']);

  const colour = clean(row['AI Color']);
  const colourIsAiDerived = colour !== null
    && !clean(row['Finish Override']);

  return {
    // ── identity, from the source ──────────────────────────
    sourceProductId: clean(row['Product ID']),
    sourceSku: clean(row['SKU / Product Code']),

    // ── what the ERP needs ─────────────────────────────────
    brandName,
    name: productName,
    size,
    thicknessMm: num(row['Thickness']),
    lengthMm: num(row['Length']),
    widthMm: num(row['Width']),
    finish,
    colour,

    // ── provenance ─────────────────────────────────────────
    catalogueName: clean(row['Catalog']),
    cataloguePdf: clean(row['PDF Name']),
    cataloguePage: num(row['Page']),
    imageUrl: clean(row['Drive URL']),
    imageFilename: clean(row['Image Filename']),
    extractionRef: clean(row['Product ID']),

    // ── everything else the sheet knows, kept as attributes ─
    // Only keys the ERP's own category rules allow are written to
    // the product; the rest stay on the import row, where they
    // are evidence rather than product data.
    sourceAttributes: {
      format: clean(row['Format']),
      slipRating: clean(row['Slip Rating']),
      pei: clean(row['PEI']),
      dcof: clean(row['DCOF']),
      floorOrWall: clean(row['Floor / Wall']),
      suitableForWall: clean(row['Suitable for Wall']),
      suitableForFloor: clean(row['Suitable for Floor']),
      aiStyle: clean(row['AI Style']),
      aiTone: clean(row['AI Tone']),
      aiPattern: clean(row['AI Pattern']),
      budget: clean(row['Resolved Budget']),
      technicalNotes: clean(row['Technical Notes']),
      notes: clean(row['Notes']),
      sourceStatus: clean(row['Status']),
    },

    // ── flags for the reviewer ─────────────────────────────
    colourIsAiDerived,
    /* The pipeline's own view of whether a human has looked at
       this row. An unclassified row is not wrong, but it is less
       certain, and the preview says so. */
    aiClassificationStatus: clean(row['AI Classification Status']),
  };
}

/**
 * Which ERP category a MASTER row belongs to.
 *
 * MASTER carries tiles and surfaces, and the sheet's own
 * "Floor / Wall" column is the only thing in it that distinguishes
 * them. Where it says nothing, the row gets no category and
 * validation asks for one — better than filing a wall tile under
 * floor because floor is more common.
 */
export function inferCategoryCode(mapped) {
  const hint = String(mapped.sourceAttributes?.floorOrWall ?? '').toUpperCase();
  if (hint.includes('FLOOR') && !hint.includes('WALL')) return 'FLOOR';
  if (hint.includes('WALL') && !hint.includes('FLOOR')) return 'WALL';

  const wall = String(mapped.sourceAttributes?.suitableForWall ?? '').toUpperCase();
  const floor = String(mapped.sourceAttributes?.suitableForFloor ?? '').toUpperCase();
  if (floor === 'YES' && wall !== 'YES') return 'FLOOR';
  if (wall === 'YES' && floor !== 'YES') return 'WALL';

  return null;
}
