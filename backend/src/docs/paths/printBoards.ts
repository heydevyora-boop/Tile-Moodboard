import { standardErrors, errorResponses } from '../responses';

const printBoardResponse = { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { board: { $ref: '#/components/schemas/PrintBoard' } } } } };

const generateBody = {
  type: 'object',
  required: ['moodBoardId', 'combinationIndex', 'format', 'layout', 'widthValue', 'heightValue', 'unit', 'dpi', 'fileFormat'],
  properties: {
    moodBoardId: { type: 'string' },
    combinationIndex: { type: 'integer' },
    format: { type: 'string', enum: ['CASSETTE_PANEL', 'ACP_SIGNBOARD', 'MOOD_BOARD_PRINT', 'CUSTOM'] },
    layout: { type: 'string', enum: ['HERO_IMAGE', 'TILE_GRID', 'SIDE_BY_SIDE', 'CASSETTE_STYLE'] },
    widthValue: { type: 'number' },
    heightValue: { type: 'number' },
    unit: { type: 'string', enum: ['FT', 'IN', 'CM', 'MM'] },
    dpi: { type: 'integer', example: 300 },
    fileFormat: { type: 'string', enum: ['PNG', 'PDF'] },
  },
};

export const printBoardPaths = {
  '/print-boards/templates': {
    get: { tags: ['Print Boards'], summary: 'List saved print board templates', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Templates.' }, ...standardErrors() } },
    post: { tags: ['Print Boards'], summary: 'Save the current form setup as a reusable template', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } }, responses: { 201: { description: 'Saved.' }, ...standardErrors(422) } },
  },
  '/print-boards/templates/{id}': {
    delete: { tags: ['Print Boards'], summary: 'Delete a template', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Deleted.' }, ...standardErrors(404) } },
  },
  '/print-boards/export-history': {
    get: { tags: ['Print Boards'], summary: 'List past exports', security: [{ bearerAuth: [] }], parameters: [{ name: 'page', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Export history.' }, ...standardErrors() } },
  },
  '/print-boards': {
    get: { tags: ['Print Boards'], summary: 'List generated print boards', security: [{ bearerAuth: [] }], parameters: [{ name: 'page', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'A page of print boards.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { boards: { type: 'array', items: { $ref: '#/components/schemas/PrintBoard' } } } }, meta: { $ref: '#/components/schemas/PaginationMeta' } } } } } }, ...standardErrors() } },
  },
  '/print-boards/generate': {
    post: {
      tags: ['Print Boards'],
      summary: 'Render and save a print board synchronously',
      description: 'Renders the PNG/PDF inline and waits for it to finish before responding — can take a while at high DPI. For large exports, prefer `/generate-async`. Rate-limited to 30 requests per 5 minutes per IP (Module 24) since rendering is CPU/memory intensive.',
      security: [{ bearerAuth: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: generateBody } } },
      responses: { 201: { description: 'Rendered and saved.', content: { 'application/json': { schema: printBoardResponse } } }, 400: { description: 'Requested pixel dimensions exceed the memory-safety guard (e.g. an oversized PNG at high DPI) — use PDF instead, which has no pixel-count limit.' }, 429: errorResponses[429], ...standardErrors(404, 422) },
    },
  },
  '/print-boards/generate-async': {
    post: {
      tags: ['Print Boards'],
      summary: 'Queue a print board render and return immediately',
      description: 'Same validated input and same underlying renderer as `/generate` — the only difference is this returns a job id right away instead of waiting. Poll `GET /jobs/{id}` for completion; the result contains `printBoardId` once done.',
      security: [{ bearerAuth: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: generateBody } } },
      responses: { 202: { description: 'Queued.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { job: { $ref: '#/components/schemas/Job' } } } }, example: { success: true, data: { job: { id: 'clx1job001', type: 'EXPORT', status: 'PENDING' } } } } } } }, 429: errorResponses[429], ...standardErrors(422) },
    },
  },
  '/print-boards/{id}': {
    get: { tags: ['Print Boards'], summary: 'Get a print board by id', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'The board.', content: { 'application/json': { schema: printBoardResponse } } }, ...standardErrors(404) } },
    patch: { tags: ['Print Boards'], summary: 'Edit print board metadata', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 200: { description: 'Updated.' }, ...standardErrors(404, 422) } },
    delete: { tags: ['Print Boards'], summary: 'Delete a print board', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Deleted.' }, ...standardErrors(404) } },
  },
  '/print-boards/{id}/share': {
    post: {
      tags: ['Print Boards'],
      summary: 'Upload the exported file to Google Drive and get a shareable link',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Shared.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { driveShareUrl: { type: 'string' } } } } } } } }, 500: { description: 'Google Drive is not configured or the upload failed.' }, ...standardErrors(404) },
    },
  },
};
