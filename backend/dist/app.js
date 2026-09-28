"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const compression_1 = __importDefault(require("compression"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const index_1 = require("@config/index");
const requestLogger_1 = require("@middlewares/requestLogger");
const notFound_1 = require("@middlewares/notFound");
const errorHandler_1 = require("@middlewares/errorHandler");
const index_2 = __importDefault(require("@routes/index"));
const AppError_1 = require("@utils/AppError");
const openapi_1 = require("./docs/openapi");
function createApp() {
    const app = (0, express_1.default)();
    app.set('trust proxy', 1);
    app.use((0, helmet_1.default)());
    app.use((0, cors_1.default)({
        origin: (origin, callback) => {
            if (!origin ||
                index_1.config.cors.origins.includes(origin)) {
                callback(null, true);
            }
            else {
                callback(new AppError_1.AppError(`Origin ${origin} is not allowed by CORS`, 403));
            }
        },
        credentials: true,
    }));
    app.use(express_1.default.json({
        limit: '10mb',
    }));
    app.use(express_1.default.urlencoded({
        extended: true,
        limit: '10mb',
    }));
    app.use((0, cookie_parser_1.default)());
    app.use((0, compression_1.default)());
    app.use(requestLogger_1.requestLogger);
    app.use(index_1.config.app.apiPrefix, (0, express_rate_limit_1.default)({
        windowMs: index_1.config.rateLimit.windowMs,
        max: index_1.config.rateLimit.max,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
            success: false,
            status: 'fail',
            message: 'Too many requests, please try again later.',
        },
    }));
    const staticAssetHeaders = (_req, res, next) => {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        next();
    };
    app.use('/static/extracted', staticAssetHeaders, express_1.default.static(index_1.config.catalog.extractedDir));
    app.use('/static/reference-images', staticAssetHeaders, express_1.default.static(index_1.config.referenceImages.uploadsDir));
    app.use('/static/print-boards', staticAssetHeaders, express_1.default.static(index_1.config.printBoards.uploadsDir));
    const catalogProcessorRoot = path_1.default.resolve(process.cwd(), '../catalog_processor');
    const visualizationDirectory = path_1.default.join(catalogProcessorRoot, 'output', 'tile_visualizations');
    app.use('/generated-visualizations', staticAssetHeaders, express_1.default.static(visualizationDirectory));
    app.get('/', (_req, res) => {
        res.json({
            success: true,
            message: `${index_1.config.app.name} API`,
            env: index_1.config.env,
        });
    });
    app.get('/api-docs.json', (_req, res) => {
        res.json(openapi_1.openApiDocument);
    });
    app.use('/api-docs', swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(openapi_1.openApiDocument, {
        customSiteTitle: `${index_1.config.app.name} API Docs`,
    }));
    app.use(index_1.config.app.apiPrefix, index_2.default);
    app.use(notFound_1.notFoundHandler);
    app.use(errorHandler_1.globalErrorHandler);
    return app;
}
//# sourceMappingURL=app.js.map