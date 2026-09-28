"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.remove = exports.deactivateAll = exports.deactivate = exports.activate = exports.rotate = exports.create = exports.list = void 0;
const catchAsync_1 = require("@utils/catchAsync");
const AppError_1 = require("@utils/AppError");
const apiKeyService = __importStar(require("@services/apiKey.service"));
function requireActorId(req) {
    if (!req.user)
        throw AppError_1.AppError.unauthorized('Authentication required');
    return req.user.id;
}
exports.list = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const query = req.query;
    const keys = await apiKeyService.listApiKeys(query);
    res.status(200).json({ success: true, data: { keys } });
});
exports.create = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    const key = await apiKeyService.createApiKey(input, requireActorId(req), req);
    res.status(201).json({ success: true, data: { key } });
});
exports.rotate = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    const key = await apiKeyService.rotateApiKey(req.params.id, input, requireActorId(req), req);
    res.status(200).json({ success: true, data: { key } });
});
exports.activate = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const key = await apiKeyService.setApiKeyActive(req.params.id, true, requireActorId(req), req);
    res.status(200).json({ success: true, data: { key } });
});
exports.deactivate = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const key = await apiKeyService.setApiKeyActive(req.params.id, false, requireActorId(req), req);
    res.status(200).json({ success: true, data: { key } });
});
exports.deactivateAll = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const result = await apiKeyService.deactivateAllKeys(requireActorId(req), req);
    res.status(200).json({ success: true, data: result });
});
exports.remove = (0, catchAsync_1.catchAsync)(async (req, res) => {
    await apiKeyService.deleteApiKey(req.params.id, requireActorId(req), req);
    res.status(200).json({ success: true, message: 'API key deleted' });
});
//# sourceMappingURL=apiKey.controller.js.map