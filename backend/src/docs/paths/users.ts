import { standardErrors } from '../responses';

const userResponse = { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { user: { $ref: '#/components/schemas/User' } } } } };

export const userPaths = {
  '/users/me': {
    get: { tags: ['Users'], summary: 'Get your own profile', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Your profile.', content: { 'application/json': { schema: userResponse } } }, ...standardErrors() } },
    patch: {
      tags: ['Users'],
      summary: 'Update your own profile (name only — email/role changes go through an admin)',
      security: [{ bearerAuth: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } },
      responses: { 200: { description: 'Updated.', content: { 'application/json': { schema: userResponse } } }, ...standardErrors(422) },
    },
  },
  '/users/me/change-password': {
    post: {
      tags: ['Users'],
      summary: 'Change your own password',
      security: [{ bearerAuth: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['currentPassword', 'newPassword'], properties: { currentPassword: { type: 'string', format: 'password' }, newPassword: { type: 'string', format: 'password', minLength: 8 } } } } } },
      responses: { 200: { description: 'Password changed.' }, 400: { description: 'Current password is incorrect.' }, ...standardErrors(422) },
    },
  },
  '/users': {
    get: {
      tags: ['Users'],
      summary: 'List staff accounts',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'page', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }],
      responses: { 200: { description: 'A page of users.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { users: { type: 'array', items: { $ref: '#/components/schemas/User' } } } }, meta: { $ref: '#/components/schemas/PaginationMeta' } } } } } }, ...standardErrors() },
    },
    post: {
      tags: ['Users'],
      summary: 'Create a staff account',
      description: 'Creates the account immediately with the temporary password the admin sets — there is no invite-email flow.',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['name', 'email', 'password', 'roleId'], properties: { name: { type: 'string' }, email: { type: 'string' }, password: { type: 'string' }, roleId: { type: 'string' } } }, example: { name: 'Farah Ali', email: 'farah@casadeaurum.com', password: 'TempPass123', roleId: 'role-staff-001' } } },
      },
      responses: { 201: { description: 'Created.', content: { 'application/json': { schema: userResponse } } }, ...standardErrors(422) },
    },
  },
  '/users/{id}': {
    get: { tags: ['Users'], summary: 'Get a staff account by id', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'The user.', content: { 'application/json': { schema: userResponse } } }, ...standardErrors(404) } },
    patch: { tags: ['Users'], summary: 'Update a staff account', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 200: { description: 'Updated.', content: { 'application/json': { schema: userResponse } } }, ...standardErrors(404, 422) } },
    delete: { tags: ['Users'], summary: 'Deactivate/delete a staff account', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Deleted.' }, ...standardErrors(404) } },
  },
  '/users/{id}/role': {
    patch: {
      tags: ['Users'],
      summary: "Change a staff member's role — Owner only",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['roleId'], properties: { roleId: { type: 'string' } } } } } },
      responses: { 200: { description: 'Role changed.', content: { 'application/json': { schema: userResponse } } }, ...standardErrors(404, 422) },
    },
  },
};

export const rolePaths = {
  '/roles': {
    get: {
      tags: ['Roles'],
      summary: 'List available roles and their permissions',
      security: [{ bearerAuth: [] }],
      responses: { 200: { description: 'Roles.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { roles: { type: 'array', items: { $ref: '#/components/schemas/Role' } } } } } } } } }, ...standardErrors() },
    },
  },
};

export const healthPaths = {
  '/health': {
    get: {
      tags: ['Health'],
      summary: 'Health check',
      description: 'No authentication required. Returns 200 if the API and database are both up, 503 if the database connection is down.',
      security: [],
      responses: {
        200: { description: 'Healthy.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, app: { type: 'string' }, env: { type: 'string' }, uptimeSeconds: { type: 'integer' }, timestamp: { type: 'string' }, db: { type: 'string', enum: ['up', 'down'] } } } } } },
        503: { description: 'Database is unreachable.' },
      },
    },
  },
};
