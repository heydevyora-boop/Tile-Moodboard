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
const printBoardController = __importStar(require("@controllers/printBoard.controller"));
const auth_1 = require("@middlewares/auth");
const validate_1 = require("@middlewares/validate");
const rateLimiters_1 = require("@middlewares/rateLimiters");
const printBoard_validators_1 = require("@validators/printBoard.validators");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
router.get('/templates', (0, auth_1.requirePermission)('print_boards:read'), printBoardController.listTemplates);
router.post('/templates', (0, auth_1.requirePermission)('print_boards:write'), (0, validate_1.validate)(printBoard_validators_1.createPrintBoardTemplateSchema), printBoardController.createTemplate);
router.delete('/templates/:id', (0, auth_1.requirePermission)('print_boards:write'), printBoardController.deleteTemplate);
router.get('/export-history', (0, auth_1.requirePermission)('print_boards:read'), (0, validate_1.validate)(printBoard_validators_1.exportHistoryQuerySchema, 'query'), printBoardController.exportHistory);
router.get('/', (0, auth_1.requirePermission)('print_boards:read'), (0, validate_1.validate)(printBoard_validators_1.listPrintBoardsQuerySchema, 'query'), printBoardController.list);
router.post('/generate', (0, auth_1.requirePermission)('print_boards:write'), rateLimiters_1.printBoardExportRateLimiter, (0, validate_1.validate)(printBoard_validators_1.generatePrintBoardSchema), printBoardController.generate);
router.post('/generate-async', (0, auth_1.requirePermission)('print_boards:write'), rateLimiters_1.printBoardExportRateLimiter, (0, validate_1.validate)(printBoard_validators_1.generatePrintBoardSchema), printBoardController.generateAsync);
router.get('/:id', (0, auth_1.requirePermission)('print_boards:read'), printBoardController.getOne);
router.patch('/:id', (0, auth_1.requirePermission)('print_boards:write'), (0, validate_1.validate)(printBoard_validators_1.updatePrintBoardSchema), printBoardController.update);
router.delete('/:id', (0, auth_1.requirePermission)('print_boards:write'), printBoardController.remove);
router.post('/:id/share', (0, auth_1.requirePermission)('print_boards:write'), printBoardController.shareToDrive);
exports.default = router;
//# sourceMappingURL=printBoard.routes.js.map