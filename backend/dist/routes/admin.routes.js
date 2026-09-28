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
const express_1 = require("express");
const adminController = __importStar(require("@controllers/admin.controller"));
const auth_1 = require("@middlewares/auth");
const validate_1 = require("@middlewares/validate");
const logs_validators_1 = require("@validators/logs.validators");
const loggingSystem_validators_1 = require("@validators/loggingSystem.validators");
const jobs_validators_1 = require("@validators/jobs.validators");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
router.use((0, auth_1.authorize)('OWNER'));
router.get('/logs', (0, validate_1.validate)(logs_validators_1.logsQuerySchema, 'query'), adminController.getLogs);
router.get('/logs/actions', adminController.getLogActions);
router.get('/logs/login-history', (0, validate_1.validate)(loggingSystem_validators_1.loginHistoryQuerySchema, 'query'), adminController.getLoginHistory);
router.get('/logs/errors', (0, validate_1.validate)(loggingSystem_validators_1.errorLogsQuerySchema, 'query'), adminController.getErrorLogs);
router.get('/logs/catalog', (0, validate_1.validate)(loggingSystem_validators_1.catalogLogsQuerySchema, 'query'), adminController.getCatalogLogs);
router.get('/logs/mood-boards', (0, validate_1.validate)(logs_validators_1.logsQuerySchema, 'query'), adminController.getMoodBoardLogs);
router.get('/logs/print-boards', (0, validate_1.validate)(logs_validators_1.logsQuerySchema, 'query'), adminController.getPrintBoardLogs);
router.get('/analytics', adminController.getAnalytics);
router.get('/queues', adminController.getQueueStats);
router.get('/queues/jobs', (0, validate_1.validate)(jobs_validators_1.jobsQuerySchema, 'query'), adminController.getJobs);
router.post('/queues/jobs/:id/retry', adminController.retryJob);
exports.default = router;
//# sourceMappingURL=admin.routes.js.map