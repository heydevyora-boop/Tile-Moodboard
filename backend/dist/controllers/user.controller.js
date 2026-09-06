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
exports.changePassword = exports.updateProfile = exports.getProfile = exports.assignRole = exports.deleteUser = exports.updateUser = exports.createUser = exports.getUser = exports.listUsers = void 0;
const catchAsync_1 = require("@utils/catchAsync");
const AppError_1 = require("@utils/AppError");
const userService = __importStar(require("@services/user.service"));
function requireActorId(req) {
    if (!req.user)
        throw AppError_1.AppError.unauthorized('Authentication required');
    return req.user.id;
}
exports.listUsers = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const query = req.query;
    const { users, meta } = await userService.listUsers(query);
    res.status(200).json({ success: true, data: { users }, meta });
});
exports.getUser = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const user = await userService.getUserById(req.params.id);
    res.status(200).json({ success: true, data: { user } });
});
exports.createUser = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    const user = await userService.createUser(input, requireActorId(req), req);
    res.status(201).json({ success: true, data: { user } });
});
exports.updateUser = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    const user = await userService.updateUser(req.params.id, input, requireActorId(req), req);
    res.status(200).json({ success: true, data: { user } });
});
exports.deleteUser = (0, catchAsync_1.catchAsync)(async (req, res) => {
    await userService.deleteUser(req.params.id, requireActorId(req), req);
    res.status(200).json({ success: true, message: 'User deleted' });
});
exports.assignRole = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const { roleId } = req.body;
    const user = await userService.assignRole(req.params.id, roleId, requireActorId(req), req);
    res.status(200).json({ success: true, data: { user } });
});
exports.getProfile = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const user = await userService.getProfile(requireActorId(req));
    res.status(200).json({ success: true, data: { user } });
});
exports.updateProfile = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    const user = await userService.updateProfile(requireActorId(req), input, req);
    res.status(200).json({ success: true, data: { user } });
});
exports.changePassword = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    await userService.changeOwnPassword(requireActorId(req), input, req);
    res.status(200).json({ success: true, message: 'Password changed. Please log in again.' });
});
//# sourceMappingURL=user.controller.js.map