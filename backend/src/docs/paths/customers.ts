import { standardErrors } from '../responses';

const customerListResponse = {
  type: 'object',
  properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { customers: { type: 'array', items: { $ref: '#/components/schemas/Customer' } } } }, meta: { $ref: '#/components/schemas/PaginationMeta' } },
};
const customerResponse = { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { customer: { $ref: '#/components/schemas/Customer' } } } } };

export const customerPaths = {
  '/customers': {
    get: {
      tags: ['Customers'],
      summary: 'List customers',
      description: 'Searches name, phone, and email together when `search` is provided.',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'search', in: 'query', schema: { type: 'string' }, example: 'Priya' },
        { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
      ],
      responses: { 200: { description: 'A page of customers.', content: { 'application/json': { schema: customerListResponse } } }, ...standardErrors() },
    },
    post: {
      tags: ['Customers'],
      summary: 'Create a customer',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, preferredStyle: { type: 'string' }, preferredRoom: { type: 'string' }, budget: { type: 'string' }, notes: { type: 'string' } } },
            example: { name: 'Anita Kulkarni', phone: '9876543210', preferredStyle: 'luxury', preferredRoom: 'bathroom', budget: '2-3 Lakh' },
          },
        },
      },
      responses: { 201: { description: 'Created.', content: { 'application/json': { schema: customerResponse } } }, ...standardErrors(422) },
    },
  },
  '/customers/{id}': {
    get: {
      tags: ['Customers'],
      summary: 'Get a customer by id',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'The customer.', content: { 'application/json': { schema: customerResponse } } }, ...standardErrors(404) },
    },
    patch: {
      tags: ['Customers'],
      summary: 'Update a customer',
      description: 'Partial update — send only the fields you want to change.',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' }, example: { budget: '5-6 Lakh' } } } },
      responses: { 200: { description: 'Updated.', content: { 'application/json': { schema: customerResponse } } }, ...standardErrors(404, 422) },
    },
    delete: {
      tags: ['Customers'],
      summary: 'Delete a customer',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Deleted.' }, ...standardErrors(404) },
    },
  },
  '/customers/{id}/history': {
    get: {
      tags: ['Customers'],
      summary: 'Get every mood board generated for this customer',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Mood board history.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { moodBoards: { type: 'array', items: { $ref: '#/components/schemas/MoodBoard' } } } } } } } } },
        ...standardErrors(404),
      },
    },
  },
  '/customers/{id}/favorites': {
    get: {
      tags: ['Customers'],
      summary: "List a customer's favorited tiles",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Favorited tiles.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { favorites: { type: 'array', items: { $ref: '#/components/schemas/CustomerFavorite' } } } } } } } } },
        ...standardErrors(404),
      },
    },
    post: {
      tags: ['Customers'],
      summary: 'Favorite a tile for a customer',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['tileId'], properties: { tileId: { type: 'string' }, note: { type: 'string' } } }, example: { tileId: 'clx1tile001', note: 'Loved this on her last visit — mention when the new shipment arrives' } } } },
      responses: {
        201: { description: 'Favorited.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { favorite: { $ref: '#/components/schemas/CustomerFavorite' } } } } } } } },
        ...standardErrors(404, 409),
      },
    },
  },
  '/customers/{id}/favorites/{tileId}': {
    delete: {
      tags: ['Customers'],
      summary: 'Remove a favorited tile',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'tileId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Removed.' }, ...standardErrors(404) },
    },
  },
};
