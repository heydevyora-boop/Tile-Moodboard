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
exports.shareToDrive = exports.exportHistory = exports.deleteTemplate = exports.createTemplate = exports.listTemplates = exports.remove = exports.update = exports.getOne = exports.list = exports.generateAsync = exports.generate = void 0;
const catchAsync_1 = require("@utils/catchAsync");
const AppError_1 = require("@utils/AppError");
const printBoardService = __importStar(require("@services/printBoard.service"));
const jobQueue_service_1 = require("@services/jobQueue.service");
function requireActorId(req) {
    if (!req.user)
        throw AppError_1.AppError.unauthorized('Authentication required');
    return req.user.id;
}
exports.generate = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    const board = await printBoardService.generatePrintBoard(input, requireActorId(req), req);
    res.status(201).json({ success: true, data: { board } });
});
exports.generateAsync = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    const actorId = requireActorId(req);
    const job = await (0, jobQueue_service_1.enqueueJob)('EXPORT', { input, actorId }, { createdById: actorId });
    res.status(202).json({ success: true, data: { job } });
});
exports.list = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const query = req.query;
    const { boards, meta } = await printBoardService.listPrintBoards(query);
    res.status(200).json({ success: true, data: { boards }, meta });
});
exports.getOne = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const board = await printBoardService.getPrintBoardById(req.params.id);
    res.status(200).json({ success: true, data: { board } });
});
exports.update = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    const board = await printBoardService.updatePrintBoard(req.params.id, input, requireActorId(req), req);
    res.status(200).json({ success: true, data: { board } });
});
exports.remove = (0, catchAsync_1.catchAsync)(async (req, res) => {
    await printBoardService.deletePrintBoard(req.params.id, requireActorId(req), req);
    res.status(200).json({ success: true, message: 'Print board deleted' });
});
exports.listTemplates = (0, catchAsync_1.catchAsync)(async (_req, res) => {
    const templates = await printBoardService.listTemplates();
    res.status(200).json({ success: true, data: { templates } });
});
exports.createTemplate = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    const template = await printBoardService.createTemplate(input, requireActorId(req), req);
    res.status(201).json({ success: true, data: { template } });
});
exports.deleteTemplate = (0, catchAsync_1.catchAsync)(async (req, res) => {
    await printBoardService.deleteTemplate(req.params.id, requireActorId(req), req);
    res.status(200).json({ success: true, message: 'Template deleted' });
});
exports.exportHistory = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const query = req.query;
    const { events, meta } = await printBoardService.getExportHistory(query);
    res.status(200).json({ success: true, data: { events }, meta });
});
exports.shareToDrive = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const board = await printBoardService.shareToDrive(req.params.id, requireActorId(req), req);
    res.status(200).json({ success: true, data: { board } });
});
//# sourceMappingURL=printBoard.controller.js.map