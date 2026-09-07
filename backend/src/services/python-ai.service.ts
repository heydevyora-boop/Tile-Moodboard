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

const LOOPBACK_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
]);

/**
 * Repoints a loopback URL at this deployment's own public origin.
 *
 * The browser sends scene_image_url, and a page still served from cache
 * builds it against http://localhost:5000 -- a host that exists only on a
 * developer's machine. Handing that to the Python service produced
 * "Unable to download scene image ... [Errno 111] Connection refused",
 * because Python is a different process on a different machine and there
 * is nothing on its port 5000. Only the origin is swapped; the path is
 * untouched. When BACKEND_PUBLIC_URL is itself localhost (local
 * development) this rewrites localhost to localhost, i.e. does nothing.
 */
function rewriteLoopbackUrl(
  url: string,
): string {
  try {
    const parsed = new URL(url);

    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
      return url;
    }

    // Rebuilt against the public origin rather than assigning .host:
    // assigning a host without a port leaves any existing port in place,
    // which turned localhost:5000 into casa-de-aurum.vercel.app:5000.
    return new URL(
      parsed.pathname + parsed.search + parsed.hash,
      BACKEND_PUBLIC_URL,
    ).toString();
  } catch {
    // Not a parseable absolute URL -- leave it exactly as supplied.
    return url;
  }
}

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
    return rewriteLoopbackUrl(trimmed);
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

  // Python already reads the file it just wrote -- in its own process,
  // immediately after writing it -- and embeds it here as a data: URL
  // (_build_success_response in visualization_api.py). That is the only
  // image reference in this response both sides can actually use: Node
  // and Python run as separate serverless functions on Vercel with no
  // shared disk, so image_path (Python's own local path, turned into
  // /generated-visualizations/<file> below) points at a file that exists
  // only inside Python's container -- unreachable from this Express
  // server -- which is what made every generated visualization fail to
  // load once the underlying scene-image fetch itself was fixed.
  const embeddedImageUrl =
    result.image?.url;

  /*
   * Prefer the image Python already embedded.
   *
   * Fall back to reconstructing a local Express-served URL, then to
   * Google Drive, only if Python didn't already supply one (an older
   * Python build, or a save that produced no bytes).
   */

  const imageUrl =
    embeddedImageUrl ||
    (imagePath
      ? buildVisualizationImageUrl(
          imagePath,
        )
      : driveUrl || '');

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

  // Rewritten, not trusted as-is: this value comes straight from the
  // browser, so a cached page pointing at localhost would otherwise be
  // forwarded to Python verbatim. See rewriteLoopbackUrl above.
  const sceneImageUrl =
    rewriteLoopbackUrl(
      request.scene_image_url?.trim() ||
        '',
    );

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

        // 3 minutes: generous enough for Gemini's own generation time
        // plus the Python side's retry-with-backoff on transient
        // 429/503s (up to ~3 attempts x 15s backoff each, for both
        // the Gemini call and the Sheets MASTER read) -- a request
        // that's genuinely retrying shouldn't get cut off here before
        // it has a chance to succeed.
        signal: AbortSignal.timeout(180000),

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