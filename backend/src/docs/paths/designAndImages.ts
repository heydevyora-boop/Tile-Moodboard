import { standardErrors } from '../responses';

const ruleResponse = { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { rule: { $ref: '#/components/schemas/DesignRule' } } } } };

export const designRulesPaths = {
  '/design-rules/preview': {
    get: { tags: ['Design Rules'], summary: 'Preview the current draft (unpublished) rules', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Draft rules.' }, ...standardErrors() } },
  },
  '/design-rules/publish': {
    post: { tags: ['Design Rules'], summary: 'Publish the draft as a new live version', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 200: { description: 'Published.' }, ...standardErrors(422) } },
  },
  '/design-rules/live': {
    get: { tags: ['Design Rules'], summary: 'Get the currently live (published) rule set — this is what mood board generation actually uses', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Live rules.' }, ...standardErrors() } },
  },
  '/design-rules/versions': {
    get: { tags: ['Design Rules'], summary: 'List published version history', security: [{ bearerAuth: [] }], parameters: [{ name: 'page', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Versions.' }, ...standardErrors() } },
  },
  '/design-rules/versions/compare': {
    get: { tags: ['Design Rules'], summary: 'Diff two published versions', security: [{ bearerAuth: [] }], parameters: [{ name: 'from', in: 'query', required: true, schema: { type: 'string' } }, { name: 'to', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Diff.' }, ...standardErrors(400) } },
  },
  '/design-rules/versions/{id}': {
    get: { tags: ['Design Rules'], summary: 'Get a specific version', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'The version.' }, ...standardErrors(404) } },
    delete: { tags: ['Design Rules'], summary: 'Delete a version from history', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Deleted.' }, ...standardErrors(404) } },
  },
  '/design-rules/versions/{id}/restore': {
    post: { tags: ['Design Rules'], summary: 'Restore an old version as the new live version', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Restored.' }, ...standardErrors(404) } },
  },
  '/design-rules': {
    get: { tags: ['Design Rules'], summary: 'List individual rule entries in the current draft', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Rules.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { rules: { type: 'array', items: { $ref: '#/components/schemas/DesignRule' } } } } } } } } }, ...standardErrors() } },
    post: { tags: ['Design Rules'], summary: 'Add a rule to the draft', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['section', 'title', 'content'], properties: { section: { type: 'string', enum: ['GENERAL', 'STYLE', 'ROOM', 'CLIENT'] }, title: { type: 'string' }, content: { type: 'string' } } } } } }, responses: { 201: { description: 'Created.', content: { 'application/json': { schema: ruleResponse } } }, ...standardErrors(422) } },
  },
  '/design-rules/{id}': {
    get: { tags: ['Design Rules'], summary: 'Get a rule by id', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'The rule.', content: { 'application/json': { schema: ruleResponse } } }, ...standardErrors(404) } },
    patch: { tags: ['Design Rules'], summary: 'Edit a draft rule', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 200: { description: 'Updated.', content: { 'application/json': { schema: ruleResponse } } }, ...standardErrors(404, 422) } },
    delete: { tags: ['Design Rules'], summary: 'Delete a draft rule', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Deleted.' }, ...standardErrors(404) } },
  },
};

export const referenceImagesPaths = {
  '/reference-images/categories': {
    get: { tags: ['Reference Images'], summary: 'List distinct style/room tags in use', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Categories.' }, ...standardErrors() } },
  },
  '/reference-images': {
    get: {
      tags: ['Reference Images'],
      summary: 'List reference images',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'style', in: 'query', schema: { type: 'string' } }, { name: 'room', in: 'query', schema: { type: 'string' } }, { name: 'search', in: 'query', schema: { type: 'string' } }],
      responses: { 200: { description: 'Reference images.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { images: { type: 'array', items: { $ref: '#/components/schemas/ReferenceImage' } } } } } } } } }, ...standardErrors() },
    },
    post: {
      tags: ['Reference Images'],
      summary: 'Upload a reference image',
      description:
        'Multipart upload, field name `file`. JPEG/PNG/WebP only, verified by real magic bytes (Module 24) in addition to the declared MIME type. The response returns immediately with `thumbnailUrl: null` — the Image Processing Queue fills it in a few seconds later.',
      security: [{ bearerAuth: [] }],
      requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file', 'styleTag'], properties: { file: { type: 'string', format: 'binary' }, styleTag: { type: 'string', example: 'luxury_bathroom_02' }, style: { type: 'string' }, room: { type: 'string' }, description: { type: 'string' } } } } } },
      responses: { 201: { description: 'Uploaded.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { image: { $ref: '#/components/schemas/ReferenceImage' } } } } } } } }, 400: { description: 'Not a real JPEG/PNG/WebP.' }, ...standardErrors(422) },
    },
  },
  '/reference-images/{id}': {
    get: { tags: ['Reference Images'], summary: 'Get a reference image by id', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'The image.' }, ...standardErrors(404) } },
    patch: { tags: ['Reference Images'], summary: 'Edit tags/description', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 200: { description: 'Updated.' }, ...standardErrors(404, 422) } },
    delete: { tags: ['Reference Images'], summary: 'Delete a reference image', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Deleted.' }, ...standardErrors(404) } },
  },
  '/reference-images/{id}/image': {
    put: {
      tags: ['Reference Images'],
      summary: 'Replace the image file, keeping the same metadata',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } } } },
      responses: { 200: { description: 'Replaced.' }, 400: { description: 'Not a real JPEG/PNG/WebP.' }, ...standardErrors(404) },
    },
  },
};
