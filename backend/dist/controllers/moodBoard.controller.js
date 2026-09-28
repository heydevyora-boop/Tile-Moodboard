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
exports.approve = exports.remove = exports.update = exports.getOne = exports.list = exports.save = exports.generate = void 0;
const catchAsync_1 = require("@utils/catchAsync");
const AppError_1 = require("@utils/AppError");
const promptBuilderService = __importStar(require("@services/promptBuilder.service"));
const moodBoardService = __importStar(require("@services/moodBoard.service"));
function requireActorId(req) {
    if (!req.user)
        throw AppError_1.AppError.unauthorized('Authentication required');
    return req.user.id;
}
exports.generate = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    const result = await promptBuilderService.generateCombinations(input, requireActorId(req), req);
    res.status(200).json({
        success: true,
        data: {
            combinations: result.combinations,
            warnings: result.warnings,
            tilesConsidered: result.tilesConsidered,
        },
    });
});
exports.save = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    const board = await moodBoardService.saveMoodBoard(input, requireActorId(req), req);
    res.status(201).json({ success: true, data: { board } });
});
exports.list = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const query = req.query;
    const { boards, meta } = await moodBoardService.listMoodBoards(query);
    res.status(200).json({ success: true, data: { boards }, meta });
});
exports.getOne = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const board = await moodBoardService.getMoodBoardById(req.params.id);
    res.status(200).json({ success: true, data: { board } });
});
exports.update = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    const board = await moodBoardService.updateMoodBoard(req.params.id, input, requireActorId(req), req);
    res.status(200).json({ success: true, data: { board } });
});
exports.remove = (0, catchAsync_1.catchAsync)(async (req, res) => {
    await moodBoardService.deleteMoodBoard(req.params.id, requireActorId(req), req);
    res.status(200).json({ success: true, message: 'Mood board deleted' });
});
exports.approve = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const { selectedIndex } = req.body;
    const board = await moodBoardService.approveMoodBoard(req.params.id, selectedIndex, requireActorId(req), req);
    res.status(200).json({ success: true, data: { board } });
});
//# sourceMappingURL=moodBoard.controller.js.map