import { standardErrors } from '../responses';

export const tileRecommendationPaths = {
  '/tiles/recommendations': {
    get: {
      tags: ['Tile Recommendations'],
      summary: 'Get ranked tile recommendations for a room/style context',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'style', in: 'query', required: true, schema: { type: 'string' } }, { name: 'room', in: 'query', required: true, schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', default: 10 } }],
      responses: { 200: { description: 'Ranked tiles.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { tiles: { type: 'array', items: { $ref: '#/components/schemas/Tile' } } } } } } } } }, ...standardErrors(422) },
    },
  },
};

export const apiKeyPaths = {
  '/admin/api-keys': {
    get: { tags: ['API Keys'], summary: 'List stored API keys (Owner only)', description: 'Values are always masked (e.g. `AIza...9fX2`) — the real value is encrypted at rest and never returned.', security: [{ bearerAuth: [] }], parameters: [{ name: 'service', in: 'query', schema: { type: 'string', enum: ['GEMINI', 'GOOGLE_DRIVE', 'CUSTOM'] } }], responses: { 200: { description: 'Keys.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { keys: { type: 'array', items: { $ref: '#/components/schemas/ApiKey' } } } } } } } } }, ...standardErrors() } },
    post: {
      tags: ['API Keys'],
      summary: 'Store a new API key (Owner only)',
      description: 'Encrypted at rest with AES-256-GCM. For GEMINI, an active key here takes effect on the very next Gemini call, overriding the `.env` fallback.',
      security: [{ bearerAuth: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['service', 'label', 'value'], properties: { service: { type: 'string', enum: ['GEMINI', 'GOOGLE_DRIVE', 'CUSTOM'] }, label: { type: 'string' }, value: { type: 'string' } } }, example: { service: 'GEMINI', label: 'Primary Gemini Key', value: 'AIzaSy...redacted' } } } },
      responses: { 201: { description: 'Stored.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { key: { $ref: '#/components/schemas/ApiKey' } } } } } } } }, ...standardErrors(422) },
    },
  },
  '/admin/api-keys/{id}/rotate': {
    post: { tags: ['API Keys'], summary: 'Rotate a key to a new value (Owner only)', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } } } } }, responses: { 200: { description: 'Rotated.' }, ...standardErrors(404) } },
  },
  '/admin/api-keys/{id}/activate': {
    post: { tags: ['API Keys'], summary: 'Reactivate a key (Owner only)', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Activated.' }, ...standardErrors(404) } },
  },
  '/admin/api-keys/{id}/deactivate': {
    post: { tags: ['API Keys'], summary: 'Deactivate a key without deleting it (Owner only)', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Deactivated.' }, ...standardErrors(404) } },
  },
  '/admin/api-keys/{id}': {
    delete: { tags: ['API Keys'], summary: 'Delete a key permanently (Owner only)', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Deleted.' }, ...standardErrors(404) } },
  },
};

export const jobsPaths = {
  '/jobs/{id}': {
    get: {
      tags: ['Jobs'],
      summary: 'Poll the status of a background job',
      description: 'Used to poll jobs created by `POST /print-boards/generate-async`, or Image Processing jobs created automatically after a reference image upload.',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'The job.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { job: { $ref: '#/components/schemas/Job' } } } } } } } }, ...standardErrors(404) },
    },
  },
};

export const dashboardPaths = {
  '/dashboard/stats': {
    get: { tags: ['Dashboard'], summary: 'Basic totals (tiles, catalogs, mood boards, print boards, staff)', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Stats.' }, ...standardErrors() } },
  },
  '/dashboard/recent-activity': {
    get: { tags: ['Dashboard'], summary: 'Recent activity feed for the dashboard home screen', security: [{ bearerAuth: [] }], parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Recent activity.' }, ...standardErrors() } },
  },
  '/dashboard/overview': {
    get: { tags: ['Dashboard'], summary: 'Combined stats + recent activity + system status in one call', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Overview.' }, ...standardErrors() } },
  },
};

export const integrationsPaths = {
  '/integrations/gemini/status': {
    get: { tags: ['Integrations'], summary: 'Check whether Gemini is configured', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Status.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { configured: { type: 'boolean' }, model: { type: 'string' } } } } } } } }, ...standardErrors() } },
  },
  '/integrations/gemini/test': {
    post: { tags: ['Integrations'], summary: 'Send a real test request to Gemini and report latency/success', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Test result.' }, ...standardErrors() } },
  },
  '/integrations/drive/status': {
    get: { tags: ['Integrations'], summary: 'Check whether Google Drive is configured', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Status.' }, ...standardErrors() } },
  },
  '/integrations/drive/test': {
    post: { tags: ['Integrations'], summary: 'Send a real test request to Google Drive and report success', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Test result.' }, ...standardErrors() } },
  },
};
