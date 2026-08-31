import path from 'path';

import { config } from '@config/index';

// ============================================================
// PYTHON AI SERVICE CONFIGURATION
// ============================================================

const PYTHON_AI_BASE_URL =
  config.python.aiBaseUrl ||
  'http://127.0.0.1:8000';

const BACKEND_PUBLIC_URL =
  config.backend.publicUrl ||
  `http://localhost:${config.app.port}`;

// ============================================================
// REQUEST TYPES
// ============================================================

export interface VisualizationRequest {
  product_id: string;
  surface: string;
  // Optional: empty/omitted means "generate a bathroom scene
  // instead of fetching one."
  scene_image_path?: string;
  scene_image_url?: string;
  scene_image_mode?: string;
  generate_random_scene?: boolean;
  spreadsheet_id?: string;
  sheet_name?: string;
  scene_id?: string;
  theme?: string;
  requirements?: Record<string, unknown>;
  // Real reference image already resolved for this tile in Postgres
  // (Tile.imageUrl) -- passed as a safety net for Python to fall back
  // on when its own MASTER-sheet product image is missing or stale.
  // Local path or absolute URL; relative /static/... paths are
  // resolved against BACKEND_PUBLIC_URL below before being sent.
  fallback_image_url?: string;
}

// ============================================================
// RESPONSE TYPES
// ============================================================

export interface PythonAIResponse {
  success: boolean;

  status?: string;

  visualization_id?: string;

  image?: {
    url?: string;
    drive_file_id?: string;
  };

  visualization?: {
    visualization_id?: string;
    product_id?: string;
    product_name?: string;
    surface?: string;
    image_path?: string;
  };

  drive?: {
    image?: {
      file_id?: string;
      webViewLink?: string;
      webContentLink?: string;
      url?: string;
    };
  };

  products?: unknown[];

  theme?: unknown;

  references?: unknown[];

  requirements?: unknown;

  generation?: unknown;

  error?: {
    type?: string;
    message?: string;
  };

  [key: string]: unknown;
}

// ============================================================
// GENERIC JSON RESPONSE
// ============================================================

type JSONResponse = Record<
  string,
  unknown
>;

// ============================================================
// BUILD PUBLIC IMAGE URL
// ============================================================

function buildVisualizationImageUrl(
  imagePath: string,
): string {
  const normalizedPath =
    String(imagePath || '')
      .trim()
      .replace(/\\/g, '/');

  if (!normalizedPath) {
    return '';
  }

  const fileName =
    path.basename(normalizedPath);

  if (!fileName) {
    return '';
  }

  return (
    `${BACKEND_PUBLIC_URL}` +
    `/generated-visualizations/` +
    `${encodeURIComponent(fileName)}`
  );
}

// ============================================================
// RESOLVE A TILE'S IMAGE TO A URL PYTHON CAN FETCH
// ============================================================

function toAbsoluteImageUrl(
  imageUrl: string,
): string {
  const trimmed =
    imageUrl.trim();

  if (!trimmed) {
    return '';
  }

  if (
    /^https?:\/\//i.test(
      trimmed,
    )
  ) {
    // Already absolute (e.g. a Google Drive URL, DRIVE storage mode).
    return trimmed;
  }

  // Relative /static/... path (LOCAL storage mode) -- Python runs as
  // a separate process/host, so it needs the full URL, not a path
  // that's only meaningful relative to this Express server.
  return `${BACKEND_PUBLIC_URL}${
    trimmed.startsWith('/')
      ? trimmed
      : `/${trimmed}`
  }`;
}

// ============================================================
// NORMALIZE PYTHON RESPONSE
// ============================================================

function normalizeVisualizationResponse(
  result: PythonAIResponse,
): PythonAIResponse {
  if (!result.success) {
    return result;
  }

  const imagePath =
    result.visualization?.image_path;

  const driveImage =
    result.drive?.image;

  const driveUrl =
    driveImage?.url ||
    driveImage?.webContentLink ||
    driveImage?.webViewLink;

  /*
   * Prefer local Express-served image.
   *
   * Fall back to Google Drive URL if the
   * local path isn't available.
   */

  const imageUrl =
    imagePath
      ? buildVisualizationImageUrl(
          imagePath,
        )
      : driveUrl || '';

  result.image = {
    url:
      imageUrl || undefined,

    drive_file_id:
      driveImage?.file_id,
  };

  if (
    !result.visualization_id &&
    result.visualization
      ?.visualization_id
  ) {
    result.visualization_id =
      result.visualization
        .visualization_id;
  }

  return result;
}

// ============================================================
// PYTHON AI HEALTH CHECK
// ============================================================

export async function checkPythonAIHealth(): Promise<JSONResponse> {
  const response = await fetch(
    `${PYTHON_AI_BASE_URL}/health`,
    {
      method: 'GET',

      headers: {
        Accept:
          'application/json',
      },
    },
  );

  let data: unknown;

  try {
    data =
      await response.json();
  } catch {
    throw new Error(
      `Python AI health endpoint returned non-JSON response (HTTP ${response.status})`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Python AI health check failed: HTTP ${response.status}`,
    );
  }

  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data)
  ) {
    throw new Error(
      'Python AI health endpoint returned an invalid JSON object.',
    );
  }

  return data as JSONResponse;
}

// ============================================================
// GENERATE VISUALIZATION
// ============================================================

export async function generateVisualization(
  request: VisualizationRequest,
): Promise<PythonAIResponse> {
  // ==========================================================
  // VALIDATION
  // ==========================================================

  if (
    typeof request.product_id !==
      'string' ||
    !request.product_id.trim()
  ) {
    throw new Error(
      'product_id is required.',
    );
  }

  if (
    typeof request.surface !==
      'string' ||
    !request.surface.trim()
  ) {
    throw new Error(
      'surface is required.',
    );
  }

  // ==========================================================
  // BUILD PYTHON PAYLOAD
  // ==========================================================

  // scene_image_path is intentionally optional here: an empty
  // value (or scene_image_mode "random"/generate_random_scene)
  // tells Python to generate a bathroom scene instead of fetching
  // one. Requiring it non-empty would block that flow entirely.
  const sceneImagePath =
    request.scene_image_path?.trim() ||
    '';

  const sceneImageUrl =
    request.scene_image_url?.trim() ||
    '';

  const wantsRandomScene =
    request.generate_random_scene ===
      true ||
    request.scene_image_mode ===
      'random' ||
    !(sceneImagePath || sceneImageUrl);

  const payload = {
    product_id:
      request.product_id.trim(),

    surface:
      request.surface
        .trim()
        .toUpperCase(),

    scene_image_path:
      sceneImagePath,

    scene_image_url:
      sceneImageUrl,

    scene_image_mode:
      wantsRandomScene
        ? 'random'
        : 'reference',

    generate_random_scene:
      wantsRandomScene,

    spreadsheet_id:
      request.spreadsheet_id?.trim() ||
      null,

    sheet_name:
      request.sheet_name?.trim() ||
      'MASTER',

    scene_id:
      request.scene_id?.trim() ||
      null,

    theme:
      request.theme?.trim() ||
      null,

    requirements:
      request.requirements || {},

    fallback_image_url:
      request.fallback_image_url?.trim()
        ? toAbsoluteImageUrl(
            request.fallback_image_url,
          )
        : null,
  };

  // ==========================================================
  // CALL PYTHON
  // ==========================================================

  let response: Response;

  try {
    response = await fetch(
      `${PYTHON_AI_BASE_URL}/internal/visualizations`,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',

          Accept:
            'application/json',
        },

        signal: AbortSignal.timeout(60000),

        body: JSON.stringify(
          payload,
        ),
      },
    );
  } catch (error) {
    throw new Error(
      `Unable to connect to Python AI service at ${PYTHON_AI_BASE_URL}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  // ==========================================================
  // READ RESPONSE
  // ==========================================================

  let data: unknown;

  try {
    data =
      await response.json();
  } catch {
    throw new Error(
      `Python AI returned a non-JSON response (HTTP ${response.status})`,
    );
  }

  // ==========================================================
  // VALIDATE RESPONSE
  // ==========================================================

  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data)
  ) {
    throw new Error(
      'Python AI returned an invalid JSON response.',
    );
  }

  let result =
    data as PythonAIResponse;

  // ==========================================================
  // HTTP ERROR
  // ==========================================================

  if (!response.ok) {
    throw new Error(
      `Python AI request failed: HTTP ${response.status} - ${
        result.error?.message ||
        JSON.stringify(result)
      }`,
    );
  }

  // ==========================================================
  // APPLICATION ERROR
  // ==========================================================

  if (
    result.success === false
  ) {
    throw new Error(
      result.error?.message ||
        'Python visualization failed.',
    );
  }

  // ==========================================================
  // NORMALIZE IMAGE
  // ==========================================================

  result =
    normalizeVisualizationResponse(
      result,
    );

  return result;
}