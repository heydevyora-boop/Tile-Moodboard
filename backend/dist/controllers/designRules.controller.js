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
exports.deleteVersion = exports.restoreVersion = exports.compareVersions = exports.getVersion = exports.listVersionHistory = exports.getLiveVersion = exports.publishRules = exports.previewDraft = exports.deleteDesignRule = exports.updateDesignRule = exports.createDesignRule = exports.getDesignRule = exports.listDesignRules = void 0;
const catchAsync_1 = require("@utils/catchAsync");
const AppError_1 = require("@utils/AppError");
const designRulesService = __importStar(require("@services/designRules.service"));
function requireActorId(req) {
    if (!req.user)
        throw AppError_1.AppError.unauthorized('Authentication required');
    return req.user.id;
}
exports.listDesignRules = (0, catchAsync_1.catchAsync)(async (_req, res) => {
    const rules = await designRulesService.listDesignRules();
    res.status(200).json({ success: true, data: { rules } });
});
exports.getDesignRule = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const rule = await designRulesService.getDesignRule(req.params.id);
    res.status(200).json({ success: true, data: { rule } });
});
exports.createDesignRule = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    const rule = await designRulesService.createDesignRule(input, requireActorId(req), req);
    res.status(201).json({ success: true, data: { rule } });
});
exports.updateDesignRule = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    const rule = await designRulesService.updateDesignRule(req.params.id, input, requireActorId(req), req);
    res.status(200).json({ success: true, data: { rule } });
});
exports.deleteDesignRule = (0, catchAsync_1.catchAsync)(async (req, res) => {
    await designRulesService.deleteDesignRule(req.params.id, requireActorId(req), req);
    res.status(200).json({ success: true, message: 'Design rule deleted' });
});
exports.previewDraft = (0, catchAsync_1.catchAsync)(async (_req, res) => {
    const preview = await designRulesService.previewDraft();
    res.status(200).json({ success: true, data: preview });
});
exports.publishRules = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const { changeSummary } = req.body;
    const version = await designRulesService.publishRules(changeSummary, requireActorId(req), req);
    res.status(201).json({ success: true, data: { version } });
});
exports.getLiveVersion = (0, catchAsync_1.catchAsync)(async (_req, res) => {
    const version = await designRulesService.getLiveVersion();
    res.status(200).json({ success: true, data: { version } });
});
exports.listVersionHistory = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const query = req.query;
    const { versions, meta } = await designRulesService.listVersionHistory(query);
    res.status(200).json({ success: true, data: { versions }, meta });
});
exports.getVersion = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const version = await designRulesService.getVersionById(req.params.id);
    res.status(200).json({ success: true, data: { version } });
});
exports.compareVersions = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const { from, to } = req.query;
    const result = await designRulesService.compareVersions(from, to);
    res.status(200).json({ success: true, data: result });
});
exports.restoreVersion = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const rules = await designRulesService.restoreVersion(req.params.id, requireActorId(req), req);
    res.status(200).json({ success: true, data: { rules }, message: 'Draft restored. Publish to make it live.' });
});
exports.deleteVersion = (0, catchAsync_1.catchAsync)(async (req, res) => {
    await designRulesService.deleteVersion(req.params.id, requireActorId(req), req);
    res.status(200).json({ success: true, message: 'Version deleted' });
});
//# sourceMappingURL=designRules.controller.js.map