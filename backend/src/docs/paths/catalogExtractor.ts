import { standardErrors } from '../responses';

export const catalogExtractorPaths = {
  '/catalog-extractor/brands': {
    get: { tags: ['Catalog Extractor'], summary: 'List known tile brands', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Brands.' }, ...standardErrors() } },
  },
  '/catalog-extractor/upload': {
    post: {
      tags: ['Catalog Extractor'],
      summary: 'Upload a catalog PDF for extraction',
      description:
        'Multipart upload, field name `file`. The PDF is verified twice before extraction runs: multer checks the declared MIME type, then the server independently checks the actual file bytes for a real `%PDF` signature (Module 24) — a relabeled non-PDF file is rejected either way. The catalog enters the extraction queue immediately; poll `GET /catalog-extractor/catalogs/{id}` for progress.',
      security: [{ bearerAuth: [] }],
      requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, brandId: { type: 'string' } }, required: ['file'] } } } },
      responses: {
        201: { description: 'Queued for extraction.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { catalog: { $ref: '#/components/schemas/Catalog' } } } } } } } },
        400: { description: 'Not a PDF (wrong declared type, or failed real content verification).' },
        ...standardErrors(422),
      },
    },
  },
  '/catalog-extractor/catalogs': {
    get: {
      tags: ['Catalog Extractor'],
      summary: 'List catalog uploads',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'] } }, { name: 'page', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }],
      responses: { 200: { description: 'A page of catalogs.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { catalogs: { type: 'array', items: { $ref: '#/components/schemas/Catalog' } } } }, meta: { $ref: '#/components/schemas/PaginationMeta' } } } } } }, ...standardErrors() },
    },
  },
  '/catalog-extractor/catalogs/{id}': {
    get: { tags: ['Catalog Extractor'], summary: 'Get a catalog upload by id (poll this for extraction progress)', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'The catalog.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { catalog: { $ref: '#/components/schemas/Catalog' } } } } } } } }, ...standardErrors(404) } },
    delete: { tags: ['Catalog Extractor'], summary: 'Delete a catalog upload', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Deleted.' }, ...standardErrors(404) } },
  },
  '/catalog-extractor/catalogs/{id}/tiles': {
    get: { tags: ['Catalog Extractor'], summary: 'List tiles extracted from a catalog', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Extracted tiles.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { tiles: { type: 'array', items: { $ref: '#/components/schemas/Tile' } } } } } } } } }, ...standardErrors(404) } },
  },
  '/catalog-extractor/catalogs/{id}/retry': {
    post: { tags: ['Catalog Extractor'], summary: 'Retry a failed extraction', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Re-queued.' }, ...standardErrors(404) } },
  },
  '/catalog-extractor/tiles/{tileId}': {
    patch: { tags: ['Catalog Extractor'], summary: 'Edit an extracted tile', security: [{ bearerAuth: [] }], parameters: [{ name: 'tileId', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 200: { description: 'Updated.' }, ...standardErrors(404, 422) } },
    delete: { tags: ['Catalog Extractor'], summary: 'Delete an extracted tile', security: [{ bearerAuth: [] }], parameters: [{ name: 'tileId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Deleted.' }, ...standardErrors(404) } },
  },
};
