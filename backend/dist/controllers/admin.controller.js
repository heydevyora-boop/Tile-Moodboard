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
exports.retryJob = exports.getJobs = exports.getQueueStats = exports.getPrintBoardLogs = exports.getMoodBoardLogs = exports.getCatalogLogs = exports.getErrorLogs = exports.getLoginHistory = exports.getAnalytics = exports.getLogActions = exports.getLogs = void 0;
const catchAsync_1 = require("@utils/catchAsync");
const AppError_1 = require("@utils/AppError");
const logsService = __importStar(require("@services/logs.service"));
const analyticsService = __importStar(require("@services/analytics.service"));
const loginAttemptService = __importStar(require("@services/loginAttempt.service"));
const errorLogService = __importStar(require("@services/errorLog.service"));
const jobQueue = __importStar(require("@services/jobQueue.service"));
const catalogExtractor_service_1 = require("@services/catalogExtractor.service");
exports.getLogs = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const query = req.query;
    const { logs, meta } = await logsService.listLogs(query);
    res.status(200).json({ success: true, data: { logs }, meta });
});
exports.getLogActions = (0, catchAsync_1.catchAsync)(async (_req, res) => {
    const actions = await logsService.listDistinctActions();
    res.status(200).json({ success: true, data: { actions } });
});
exports.getAnalytics = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const days = Number(req.query.days) || 30;
    const overview = await analyticsService.getAnalyticsOverview(days);
    res.status(200).json({ success: true, data: overview });
});
exports.getLoginHistory = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const query = req.query;
    const { attempts, meta } = await loginAttemptService.listLoginHistory(query);
    res.status(200).json({ success: true, data: { attempts }, meta });
});
exports.getErrorLogs = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const query = req.query;
    const { errors, meta } = await errorLogService.listErrorLogs(query);
    res.status(200).json({ success: true, data: { errors }, meta });
});
exports.getCatalogLogs = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const query = req.query;
    const { catalogs, meta } = await logsService.listCatalogLogs(query);
    res.status(200).json({ success: true, data: { catalogs }, meta });
});
exports.getMoodBoardLogs = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const query = req.query;
    const { logs, meta } = await logsService.listMoodBoardLogs(query);
    res.status(200).json({ success: true, data: { logs }, meta });
});
exports.getPrintBoardLogs = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const query = req.query;
    const { logs, meta } = await logsService.listPrintBoardLogs(query);
    res.status(200).json({ success: true, data: { logs }, meta });
});
exports.getQueueStats = (0, catchAsync_1.catchAsync)(async (_req, res) => {
    const [catalog, imageProcessing, exportQueue] = await Promise.all([
        (0, catalogExtractor_service_1.getExtractionQueueStats)(),
        jobQueue.getQueueStats('IMAGE_PROCESSING'),
        jobQueue.getQueueStats('EXPORT'),
    ]);
    res.status(200).json({ success: true, data: { catalog, imageProcessing, export: exportQueue } });
});
exports.getJobs = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const query = req.query;
    const { jobs, total } = await jobQueue.listJobs(query);
    res.status(200).json({ success: true, data: { jobs }, meta: { total, page: query.page, limit: query.limit } });
});
exports.retryJob = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const result = await jobQueue.retryJob(req.params.id);
    if (!result)
        throw AppError_1.AppError.notFound('Job not found or not in a FAILED state');
    res.status(200).json({ success: true, data: { job: result } });
});
//# sourceMappingURL=admin.controller.js.map