import { standardErrors } from '../responses';

export const adminPaths = {
  '/admin/logs': {
    get: {
      tags: ['Admin — Logs'],
      summary: 'User Activity Logs — the general business-activity audit trail (Owner only)',
      description: "Every create/update/delete/generate/publish/approve action across the whole app writes here. This is the general-purpose log; the more specific views below (Login History, Errors, Catalog, Mood Boards, Print Boards) are filtered slices of related data, not this same table re-labeled.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'action', in: 'query', schema: { type: 'string' }, description: 'Substring match, e.g. "mood_board"' },
        { name: 'entityType', in: 'query', schema: { type: 'string' } },
        { name: 'userId', in: 'query', schema: { type: 'string' } },
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'page', in: 'query', schema: { type: 'integer' } },
        { name: 'limit', in: 'query', schema: { type: 'integer' } },
      ],
      responses: { 200: { description: 'A page of activity log entries.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { logs: { type: 'array', items: { $ref: '#/components/schemas/ActivityLog' } } } }, meta: { $ref: '#/components/schemas/PaginationMeta' } } } } } }, ...standardErrors() },
    },
  },
  '/admin/logs/actions': {
    get: { tags: ['Admin — Logs'], summary: 'List distinct action names seen so far, for building a filter UI (Owner only)', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Distinct actions.' }, ...standardErrors() } },
  },
  '/admin/logs/login-history': {
    get: {
      tags: ['Admin — Logs'],
      summary: 'Login History — every login attempt, successful or not (Owner only)',
      description: 'Includes failed attempts against emails that never had an account, since the raw attempted email is recorded regardless.',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'success', in: 'query', schema: { type: 'boolean' } }, { name: 'page', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }],
      responses: { 200: { description: 'Login attempts.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { attempts: { type: 'array', items: { $ref: '#/components/schemas/LoginAttempt' } } } }, meta: { $ref: '#/components/schemas/PaginationMeta' } } } } } }, ...standardErrors() },
    },
  },
  '/admin/logs/errors': {
    get: {
      tags: ['Admin — Logs'],
      summary: 'Error Logs — real captured 5xx server errors (Owner only)',
      description: 'Written by the global error handler on every 5xx response. This is the actual set of errors the server has thrown — not a generic APM/tracing system (no request tracing or alerting on top of it).',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'page', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }],
      responses: { 200: { description: 'Error logs.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { errors: { type: 'array', items: { $ref: '#/components/schemas/ErrorLog' } } } }, meta: { $ref: '#/components/schemas/PaginationMeta' } } } } } }, ...standardErrors() },
    },
  },
  '/admin/logs/catalog': {
    get: { tags: ['Admin — Logs'], summary: 'Catalog Logs — catalog upload/extraction runs (Owner only)', security: [{ bearerAuth: [] }], parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'page', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Catalog logs.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { catalogs: { type: 'array', items: { $ref: '#/components/schemas/Catalog' } } } } } } } } }, ...standardErrors() } },
  },
  '/admin/logs/mood-boards': {
    get: { tags: ['Admin — Logs'], summary: 'Mood Board Logs — activity log entries scoped to MoodBoard entities (Owner only)', security: [{ bearerAuth: [] }], parameters: [{ name: 'page', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Mood board logs.' }, ...standardErrors() } },
  },
  '/admin/logs/print-boards': {
    get: { tags: ['Admin — Logs'], summary: 'Print Board Logs — activity log entries scoped to PrintBoard entities (Owner only)', security: [{ bearerAuth: [] }], parameters: [{ name: 'page', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Print board logs.' }, ...standardErrors() } },
  },
  '/admin/analytics': {
    get: {
      tags: ['Admin — Analytics'],
      summary: 'Usage analytics: exports, mood board approval rate + style/room breakdown, top favorited tiles, catalog success rate, staff activity (Owner only)',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 30 } }],
      responses: { 200: { description: 'Analytics overview.' }, ...standardErrors() },
    },
  },
  '/admin/queues': {
    get: {
      tags: ['Admin — Queues'],
      summary: 'Real-time stats for the Catalog Processing, Image Processing, and Export queues (Owner only)',
      security: [{ bearerAuth: [] }],
      responses: { 200: { description: 'Queue stats.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { catalog: { type: 'object' }, imageProcessing: { type: 'object' }, export: { type: 'object' } } } } } } } }, ...standardErrors() },
    },
  },
  '/admin/queues/jobs': {
    get: {
      tags: ['Admin — Queues'],
      summary: 'List background jobs, optionally filtered by type/status (Owner only)',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'type', in: 'query', schema: { type: 'string', enum: ['IMAGE_PROCESSING', 'EXPORT'] } }, { name: 'status', in: 'query', schema: { type: 'string', enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'] } }, { name: 'page', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }],
      responses: { 200: { description: 'Jobs.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { jobs: { type: 'array', items: { $ref: '#/components/schemas/Job' } } } } } } } } }, ...standardErrors() },
    },
  },
  '/admin/queues/jobs/{id}/retry': {
    post: {
      tags: ['Admin — Queues'],
      summary: 'Manually retry a FAILED job (Owner only)',
      description: 'Resets the attempt counter, so the job gets its full retry budget again. Only works on jobs currently in FAILED status.',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Re-queued.' }, 404: { description: 'Job not found, or not currently FAILED.' }, ...standardErrors() },
    },
  },
};

export const settingsPaths = {
  '/settings': {
    get: { tags: ['Settings'], summary: 'Get all four settings categories at once', description: 'Readable by all staff. Real schema defaults are returned even before any row exists in the database for a category.', security: [{ bearerAuth: [] }], responses: { 200: { description: 'All settings.' }, ...standardErrors() } },
  },
  '/settings/{category}': {
    get: { tags: ['Settings'], summary: 'Get one settings category', security: [{ bearerAuth: [] }], parameters: [{ name: 'category', in: 'path', required: true, schema: { type: 'string', enum: ['company', 'print', 'rules', 'general'] } }], responses: { 200: { description: 'The category.' }, ...standardErrors(404) } },
    put: {
      tags: ['Settings'],
      summary: 'Update a settings category — Owner only',
      description: "The 'rules' category is not just storage — promptBuilder.service.ts reads defaultMinTiles/defaultMaxCombinations/defaultRoomType/defaultStyleTag from here and uses them whenever a mood board brief doesn't specify its own values.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'category', in: 'path', required: true, schema: { type: 'string', enum: ['company', 'print', 'rules', 'general'] } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' }, example: { defaultDpi: 300, defaultFormat: 'CASSETTE_PANEL', defaultFileFormat: 'PDF', defaultUnit: 'FT' } } } },
      responses: { 200: { description: 'Updated.' }, ...standardErrors(404, 422) },
    },
  },
};
