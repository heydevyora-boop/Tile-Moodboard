"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openApiDocument = void 0;
const schemas_1 = require("./schemas");
const responses_1 = require("./responses");
const auth_1 = require("./paths/auth");
const customers_1 = require("./paths/customers");
const users_1 = require("./paths/users");
const catalogExtractor_1 = require("./paths/catalogExtractor");
const designAndImages_1 = require("./paths/designAndImages");
const moodBoards_1 = require("./paths/moodBoards");
const printBoards_1 = require("./paths/printBoards");
const misc_1 = require("./paths/misc");
const admin_1 = require("./paths/admin");
exports.openApiDocument = {
    openapi: '3.0.3',
    info: {
        title: 'Casa de Aurum Internal Tool API',
        version: '1.0.0',
        description: `
Internal operations API for Casa de Aurum's tile store — catalog extraction, AI-driven mood board generation, print board export, customer management, and store administration.

## Authentication

Every endpoint except \`POST /auth/login\`, \`POST /auth/refresh\`, \`POST /auth/forgot-password\`, \`POST /auth/reset-password\`, and \`GET /health\` requires a bearer token.

**Getting a token:**
1. \`POST /auth/login\` with \`{ "email": "...", "password": "..." }\`. On success you get \`{ data: { accessToken, expiresIn, user } }\` in the body, and the server also sets an httpOnly refresh cookie you don't need to touch directly.
2. Send the access token on every subsequent request: \`Authorization: Bearer <accessToken>\`.
3. The access token is short-lived (\`expiresIn\` seconds — 900 by default). When a request comes back \`401\`, call \`POST /auth/refresh\` (no body needed, the browser sends the refresh cookie automatically) to get a new access token, then retry.
4. \`POST /auth/logout\` revokes the refresh token and clears the cookie.

**Roles**: every account has exactly one role (\`OWNER\`, \`ADMIN\`, or \`STAFF\`), each with a fixed permission set (see \`GET /roles\`). Endpoints marked "Owner only" additionally check the role name directly rather than a permission string, for the handful of actions (API keys, most \`/admin/*\` routes, changing someone's role) sensitive enough that even a custom Admin permission set shouldn't be able to grant them.

## Errors

All errors share one envelope shape:
\`\`\`json
{ "success": false, "status": "fail", "message": "A human-readable description of what went wrong." }
\`\`\`
Validation failures (\`422\`) additionally include an \`errors\` array of \`{ path, message }\` pairs, one per invalid field. Rate limit responses (\`429\`) include standard \`RateLimit-*\` headers indicating when the limit resets. See the shared response definitions below each endpoint for which specific error codes it can return.

## Pagination

List endpoints that paginate return a top-level \`meta: { page, limit, total, totalPages }\` alongside \`data\`, not nested inside it.
    `.trim(),
        contact: { name: 'Casa de Aurum Internal Tools' },
    },
    servers: [
        { url: 'http://localhost:5000/api/v1', description: 'Local development' },
        { url: 'https://api.yourdomain.com/api/v1', description: 'Production (replace with your real deployed URL)' },
    ],
    tags: [
        { name: 'Auth', description: 'Login, token refresh, password reset' },
        { name: 'Users', description: 'Staff account management' },
        { name: 'Roles', description: 'Role/permission lookup' },
        { name: 'Customers', description: 'Customer records, mood board history, favorited tiles' },
        { name: 'Catalog Extractor', description: 'PDF catalog upload and tile extraction' },
        { name: 'Design Rules', description: 'Draft/publish workflow for the rules that steer AI generation' },
        { name: 'Reference Images', description: 'On-brand example images used to guide mood board generation' },
        { name: 'Mood Boards', description: 'AI-generated tile combinations from a client brief' },
        { name: 'Print Boards', description: 'Rendered PDF/PNG exports for print or client sharing' },
        { name: 'Tile Recommendations', description: 'Ranked tile suggestions for a room/style context' },
        { name: 'API Keys', description: 'Encrypted storage and rotation of third-party API credentials' },
        { name: 'Admin — Logs', description: 'User Activity, Login History, Catalog, Mood Board, Print Board, and Error logs' },
        { name: 'Admin — Analytics', description: 'Usage analytics and reporting' },
        { name: 'Admin — Queues', description: 'Background job queue observability and manual retry' },
        { name: 'Settings', description: 'Company info, print defaults, generation defaults, general config' },
        { name: 'Jobs', description: 'Poll background job status' },
        { name: 'Dashboard', description: 'Home-screen stats and activity feed' },
        { name: 'Integrations', description: 'Gemini and Google Drive connection status/testing' },
        { name: 'Health', description: 'Unauthenticated health check' },
    ],
    components: {
        securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Obtained from POST /auth/login. Send as `Authorization: Bearer <token>`.' },
        },
        schemas: schemas_1.schemas,
        responses: responses_1.errorResponses,
    },
    security: [{ bearerAuth: [] }],
    paths: {
        ...auth_1.authPaths,
        ...users_1.userPaths,
        ...users_1.rolePaths,
        ...customers_1.customerPaths,
        ...catalogExtractor_1.catalogExtractorPaths,
        ...designAndImages_1.designRulesPaths,
        ...designAndImages_1.referenceImagesPaths,
        ...moodBoards_1.moodBoardPaths,
        ...printBoards_1.printBoardPaths,
        ...misc_1.tileRecommendationPaths,
        ...misc_1.apiKeyPaths,
        ...admin_1.adminPaths,
        ...admin_1.settingsPaths,
        ...misc_1.jobsPaths,
        ...misc_1.dashboardPaths,
        ...misc_1.integrationsPaths,
        ...users_1.healthPaths,
    },
};
//# sourceMappingURL=openapi.js.map