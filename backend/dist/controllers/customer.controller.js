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
exports.removeFavorite = exports.addFavorite = exports.listFavorites = exports.moodBoards = exports.history = exports.remove = exports.update = exports.getOne = exports.list = exports.create = void 0;
const catchAsync_1 = require("@utils/catchAsync");
const AppError_1 = require("@utils/AppError");
const customerService = __importStar(require("@services/customer.service"));
function requireActorId(req) {
    if (!req.user)
        throw AppError_1.AppError.unauthorized('Authentication required');
    return req.user.id;
}
exports.create = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    const customer = await customerService.createCustomer(input, requireActorId(req), req);
    res.status(201).json({ success: true, data: { customer } });
});
exports.list = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const query = req.query;
    const { customers, meta } = await customerService.listCustomers(query);
    res.status(200).json({ success: true, data: { customers }, meta });
});
exports.getOne = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const customer = await customerService.getCustomerById(req.params.id);
    res.status(200).json({ success: true, data: { customer } });
});
exports.update = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    const customer = await customerService.updateCustomer(req.params.id, input, requireActorId(req), req);
    res.status(200).json({ success: true, data: { customer } });
});
exports.remove = (0, catchAsync_1.catchAsync)(async (req, res) => {
    await customerService.deleteCustomer(req.params.id, requireActorId(req), req);
    res.status(200).json({ success: true, message: 'Customer deleted' });
});
exports.history = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const moodBoards = await customerService.getCustomerHistory(req.params.id);
    res.status(200).json({ success: true, data: { moodBoards } });
});
exports.moodBoards = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const query = req.query;
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const { boards, meta } = await customerService.listCustomerMoodBoards(req.params.id, { page, limit });
    res.status(200).json({ success: true, data: { boards }, meta });
});
exports.listFavorites = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const favorites = await customerService.listFavorites(req.params.id);
    res.status(200).json({ success: true, data: { favorites } });
});
exports.addFavorite = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const { tileId, note } = req.body;
    const favorite = await customerService.addFavorite(req.params.id, tileId, note, requireActorId(req), req);
    res.status(201).json({ success: true, data: { favorite } });
});
exports.removeFavorite = (0, catchAsync_1.catchAsync)(async (req, res) => {
    await customerService.removeFavorite(req.params.id, req.params.tileId, requireActorId(req), req);
    res.status(200).json({ success: true, message: 'Favorite removed' });
});
//# sourceMappingURL=customer.controller.js.map