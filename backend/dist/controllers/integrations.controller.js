"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.testPythonAiConnection = exports.getPythonAiStatus = exports.testDriveConnection = exports.getDriveStatus = exports.testGeminiConnection = exports.getGeminiStatus = void 0;
const catchAsync_1 = require("@utils/catchAsync");
const index_1 = require("@config/index");
const gemini_service_1 = require("@services/gemini.service");
const googleDrive_service_1 = require("@services/googleDrive.service");
const python_ai_service_1 = require("@services/python-ai.service");
exports.getGeminiStatus = (0, catchAsync_1.catchAsync)(async (_req, res) => {
    res.status(200).json({
        success: true,
        data: {
            configured: await gemini_service_1.geminiClient.isConfigured(),
            model: index_1.config.gemini.model,
            timeoutMs: index_1.config.gemini.timeoutMs,
            maxRetries: index_1.config.gemini.maxRetries,
            retryBaseDelayMs: index_1.config.gemini.retryBaseDelayMs,
            temperature: index_1.config.gemini.temperature,
            maxOutputTokens: index_1.config.gemini.maxOutputTokens,
        },
    });
});
exports.testGeminiConnection = (0, catchAsync_1.catchAsync)(async (_req, res) => {
    const result = await gemini_service_1.geminiClient.testConnection();
    res.status(200).json({ success: true, data: result });
});
exports.getDriveStatus = (0, catchAsync_1.catchAsync)(async (_req, res) => {
    res.status(200).json({
        success: true,
        data: {
            configured: googleDrive_service_1.googleDriveClient.isConfigured(),
            rootFolder: index_1.config.google.driveRootFolder,
        },
    });
});
exports.testDriveConnection = (0, catchAsync_1.catchAsync)(async (_req, res) => {
    const result = await googleDrive_service_1.googleDriveClient.testConnection();
    res.status(200).json({ success: true, data: result });
});
exports.getPythonAiStatus = (0, catchAsync_1.catchAsync)(async (_req, res) => {
    res.status(200).json({
        success: true,
        data: {
            baseUrl: index_1.config.python.aiBaseUrl,
        },
    });
});
exports.testPythonAiConnection = (0, catchAsync_1.catchAsync)(async (_req, res) => {
    const startedAt = Date.now();
    try {
        const health = await (0, python_ai_service_1.checkPythonAIHealth)();
        res.status(200).json({ success: true, data: { ok: true, latencyMs: Date.now() - startedAt, health } });
    }
    catch (err) {
        res.status(200).json({
            success: true,
            data: {
                ok: false,
                message: err instanceof Error ? err.message : 'Could not reach the Python AI service.',
            },
        });
    }
});
//# sourceMappingURL=integrations.controller.js.map