import { standardErrors, errorResponses } from '../responses';

const moodBoardResponse = { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { board: { $ref: '#/components/schemas/MoodBoard' } } } } };

export const moodBoardPaths = {
  '/mood-boards/generate': {
    post: {
      tags: ['Mood Boards'],
      summary: 'Generate tile combinations from a client brief via Gemini',
      description:
        'Stateless — calls Gemini with the live design rules, the client brief, and available tile stock; returns candidate combinations without touching the database. Nothing is saved until you call `POST /mood-boards`. Rate-limited to 20 requests per 5 minutes per IP (Module 24) since each call is a real, billed Gemini API request.',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object', required: ['text', 'style', 'room'], properties: { text: { type: 'string' }, style: { type: 'string', example: 'LUXURY' }, room: { type: 'string', example: 'BATHROOM' }, combinationCount: { type: 'integer', default: 4 } } },
            example: { text: 'Client wants a spa-like feel, warm tones, budget around 3 Lakh', style: 'LUXURY', room: 'BATHROOM', combinationCount: 4 },
          },
        },
      },
      responses: {
        200: { description: 'Candidate combinations.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { combinations: { type: 'array', items: { $ref: '#/components/schemas/MoodBoardCombination' } } } } } } } } },
        429: errorResponses[429],
        500: { description: 'Gemini call failed after retries, or no API key is configured.' },
        ...standardErrors(422),
      },
    },
  },
  '/mood-boards': {
    get: {
      tags: ['Mood Boards'],
      summary: 'List saved mood boards',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'customerId', in: 'query', schema: { type: 'string' } }, { name: 'page', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }],
      responses: { 200: { description: 'A page of mood boards.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { boards: { type: 'array', items: { $ref: '#/components/schemas/MoodBoard' } } } }, meta: { $ref: '#/components/schemas/PaginationMeta' } } } } } }, ...standardErrors() },
    },
    post: {
      tags: ['Mood Boards'],
      summary: 'Save a generated set of combinations',
      description: 'Persists the output of `/generate` so it can be approved and later referenced from Customer History.',
      security: [{ bearerAuth: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['clientBrief', 'style', 'room', 'combinations'], properties: { clientBrief: { type: 'string' }, style: { type: 'string' }, room: { type: 'string' }, customerId: { type: 'string' }, combinations: { type: 'array', items: { $ref: '#/components/schemas/MoodBoardCombination' } } } } } } },
      responses: { 201: { description: 'Saved.', content: { 'application/json': { schema: moodBoardResponse } } }, ...standardErrors(422) },
    },
  },
  '/mood-boards/{id}': {
    get: { tags: ['Mood Boards'], summary: 'Get a saved mood board', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'The board.', content: { 'application/json': { schema: moodBoardResponse } } }, ...standardErrors(404) } },
    patch: { tags: ['Mood Boards'], summary: 'Edit a saved mood board', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 200: { description: 'Updated.', content: { 'application/json': { schema: moodBoardResponse } } }, ...standardErrors(404, 422) } },
    delete: { tags: ['Mood Boards'], summary: 'Delete a saved mood board', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Deleted.' }, ...standardErrors(404) } },
  },
  '/mood-boards/{id}/approve': {
    post: {
      tags: ['Mood Boards'],
      summary: 'Approve one of the saved combinations as the chosen one for this client',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['selectedIndex'], properties: { selectedIndex: { type: 'integer', example: 0 } } } } } },
      responses: { 200: { description: 'Approved.', content: { 'application/json': { schema: moodBoardResponse } } }, ...standardErrors(404, 422) },
    },
  },
};
