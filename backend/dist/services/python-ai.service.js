"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkPythonAIHealth = checkPythonAIHealth;
exports.generateVisualization = generateVisualization;
const path_1 = __importDefault(require("path"));
const index_1 = require("@config/index");
const PYTHON_AI_BASE_URL = index_1.config.python.aiBaseUrl ||
    'http://127.0.0.1:8000';
const BACKEND_PUBLIC_URL = index_1.config.backend.publicUrl ||
    `http://localhost:${index_1.config.app.port}`;
function buildVisualizationImageUrl(imagePath) {
    const normalizedPath = String(imagePath || '')
        .trim()
        .replace(/\\/g, '/');
    if (!normalizedPath) {
        return '';
    }
    const fileName = path_1.default.basename(normalizedPath);
    if (!fileName) {
        return '';
    }
    return (`${BACKEND_PUBLIC_URL}` +
        `/generated-visualizations/` +
        `${encodeURIComponent(fileName)}`);
}
function toAbsoluteImageUrl(imageUrl) {
    const trimmed = imageUrl.trim();
    if (!trimmed) {
        return '';
    }
    if (/^https?:\/\//i.test(trimmed)) {
        return trimmed;
    }
    return `${BACKEND_PUBLIC_URL}${trimmed.startsWith('/')
        ? trimmed
        : `/${trimmed}`}`;
}
function normalizeVisualizationResponse(result) {
    if (!result.success) {
        return result;
    }
    const imagePath = result.visualization?.image_path;
    const driveImage = result.drive?.image;
    const driveUrl = driveImage?.url ||
        driveImage?.webContentLink ||
        driveImage?.webViewLink;
    const imageUrl = imagePath
        ? buildVisualizationImageUrl(imagePath)
        : driveUrl || '';
    result.image = {
        url: imageUrl || undefined,
        drive_file_id: driveImage?.file_id,
    };
    if (!result.visualization_id &&
        result.visualization
            ?.visualization_id) {
        result.visualization_id =
            result.visualization
                .visualization_id;
    }
    return result;
}
async function checkPythonAIHealth() {
    const response = await fetch(`${PYTHON_AI_BASE_URL}/health`, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
        },
    });
    let data;
    try {
        data =
            await response.json();
    }
    catch {
        throw new Error(`Python AI health endpoint returned non-JSON response (HTTP ${response.status})`);
    }
    if (!response.ok) {
        throw new Error(`Python AI health check failed: HTTP ${response.status}`);
    }
    if (!data ||
        typeof data !== 'object' ||
        Array.isArray(data)) {
        throw new Error('Python AI health endpoint returned an invalid JSON object.');
    }
    return data;
}
async function generateVisualization(request) {
    if (typeof request.product_id !==
        'string' ||
        !request.product_id.trim()) {
        throw new Error('product_id is required.');
    }
    if (typeof request.surface !==
        'string' ||
        !request.surface.trim()) {
        throw new Error('surface is required.');
    }
    const sceneImagePath = request.scene_image_path?.trim() ||
        '';
    const sceneImageUrl = request.scene_image_url?.trim() ||
        '';
    const wantsRandomScene = request.generate_random_scene ===
        true ||
        request.scene_image_mode ===
            'random' ||
        !(sceneImagePath || sceneImageUrl);
    const payload = {
        product_id: request.product_id.trim(),
        surface: request.surface
            .trim()
            .toUpperCase(),
        scene_image_path: sceneImagePath,
        scene_image_url: sceneImageUrl,
        scene_image_mode: wantsRandomScene
            ? 'random'
            : 'reference',
        generate_random_scene: wantsRandomScene,
        spreadsheet_id: request.spreadsheet_id?.trim() ||
            null,
        sheet_name: request.sheet_name?.trim() ||
            'MASTER',
        scene_id: request.scene_id?.trim() ||
            null,
        theme: request.theme?.trim() ||
            null,
        requirements: request.requirements || {},
        fallback_image_url: request.fallback_image_url?.trim()
            ? toAbsoluteImageUrl(request.fallback_image_url)
            : null,
    };
    let response;
    try {
        response = await fetch(`${PYTHON_AI_BASE_URL}/internal/visualizations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            signal: AbortSignal.timeout(180000),
            body: JSON.stringify(payload),
        });
    }
    catch (error) {
        throw new Error(`Unable to connect to Python AI service at ${PYTHON_AI_BASE_URL}: ${error instanceof Error
            ? error.message
            : String(error)}`);
    }
    let data;
    try {
        data =
            await response.json();
    }
    catch {
        throw new Error(`Python AI returned a non-JSON response (HTTP ${response.status})`);
    }
    if (!data ||
        typeof data !== 'object' ||
        Array.isArray(data)) {
        throw new Error('Python AI returned an invalid JSON response.');
    }
    let result = data;
    if (!response.ok) {
        throw new Error(`Python AI request failed: HTTP ${response.status} - ${result.error?.message ||
            JSON.stringify(result)}`);
    }
    if (result.success === false) {
        throw new Error(result.error?.message ||
            'Python visualization failed.');
    }
    result =
        normalizeVisualizationResponse(result);
    return result;
}
//# sourceMappingURL=python-ai.service.js.map