import express, { Application } from 'express';
import path from 'path';

import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';

import { config } from '@config/index';
import { requestLogger } from '@middlewares/requestLogger';
import { notFoundHandler } from '@middlewares/notFound';
import { globalErrorHandler } from '@middlewares/errorHandler';
import routes from '@routes/index';
import { AppError } from '@utils/AppError';
import { openApiDocument } from './docs/openapi';

export function createApp(): Application {
  const app = express();

  // ============================================================
  // TRUST PROXY
  // ============================================================

  app.set('trust proxy', 1);

  // ============================================================
  // SECURITY
  // ============================================================

  app.use(helmet());

  // ============================================================
  // CORS
  // ============================================================

  app.use(
    cors({
      origin: (origin, callback) => {
        if (
          !origin ||
          config.cors.origins.includes(origin)
        ) {
          callback(null, true);
        } else {
          callback(
            new AppError(
              `Origin ${origin} is not allowed by CORS`,
              403,
            ),
          );
        }
      },

      credentials: true,
    }),
  );

  // ============================================================
  // BODY PARSING
  // ============================================================

  app.use(
    express.json({
      limit: '10mb',
    }),
  );

  app.use(
    express.urlencoded({
      extended: true,
      limit: '10mb',
    }),
  );

  // ============================================================
  // COOKIES
  // ============================================================

  app.use(cookieParser());

  // ============================================================
  // COMPRESSION
  // ============================================================

  app.use(compression());

  // ============================================================
  // REQUEST LOGGER
  // ============================================================

  app.use(requestLogger);

  // ============================================================
  // RATE LIMIT
  // ============================================================

  app.use(
    config.app.apiPrefix,
    rateLimit({
      windowMs:
        config.rateLimit.windowMs,

      max:
        config.rateLimit.max,

      standardHeaders: true,

      legacyHeaders: false,

      message: {
        success: false,
        status: 'fail',
        message:
          'Too many requests, please try again later.',
      },
    }),
  );

  // ============================================================
  // STATIC ASSET HEADERS
  // ============================================================

  const staticAssetHeaders = (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    res.setHeader(
      'Cross-Origin-Resource-Policy',
      'cross-origin',
    );

    next();
  };

  // ============================================================
  // EXISTING STATIC ASSETS
  // ============================================================

  app.use(
    '/static/extracted',
    staticAssetHeaders,
    express.static(
      config.catalog.extractedDir,
    ),
  );

  app.use(
    '/static/reference-images',
    staticAssetHeaders,
    express.static(
      config.referenceImages.uploadsDir,
    ),
  );

  app.use(
    '/static/print-boards',
    staticAssetHeaders,
    express.static(
      config.printBoards.uploadsDir,
    ),
  );

  // ============================================================
  // AI GENERATED VISUALIZATIONS
  // ============================================================

  /*
   * Python output:
   *
   * catalog_processor/
   *   output/
   *     tile_visualizations/
   *
   * Express exposes it as:
   *
   * /generated-visualizations/<filename>
   */

  const catalogProcessorRoot = path.resolve(
    process.cwd(),
    '../catalog_processor',
  );

  const visualizationDirectory =
    path.join(
      catalogProcessorRoot,
      'output',
      'tile_visualizations',
    );

  app.use(
    '/generated-visualizations',
    staticAssetHeaders,
    express.static(
      visualizationDirectory,
    ),
  );

  // ============================================================
  // ROOT
  // ============================================================

  app.get('/', (_req, res) => {
    res.json({
      success: true,
      message:
        `${config.app.name} API`,
      env: config.env,
    });
  });

  // ============================================================
  // API DOCS
  // ============================================================

  app.get(
    '/api-docs.json',
    (_req, res) => {
      res.json(openApiDocument);
    },
  );

  app.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(
      openApiDocument,
      {
        customSiteTitle:
          `${config.app.name} API Docs`,
      },
    ),
  );

  // ============================================================
  // API ROUTES
  // ============================================================

  app.use(
    config.app.apiPrefix,
    routes,
  );

  // ============================================================
  // 404
  // ============================================================

  app.use(notFoundHandler);

  // ============================================================
  // GLOBAL ERROR HANDLER
  // ============================================================

  app.use(globalErrorHandler);

  return app;
}