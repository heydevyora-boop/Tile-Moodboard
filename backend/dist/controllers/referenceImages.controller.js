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
exports.deleteReferenceImage = exports.replaceReferenceImage = exports.updateReferenceImage = exports.getReferenceImage = exports.listCategories = exports.listReferenceImages = exports.uploadReferenceImage = void 0;
const catchAsync_1 = require("@utils/catchAsync");
const AppError_1 = require("@utils/AppError");
const referenceImagesService = __importStar(require("@services/referenceImages.service"));
function requireActorId(req) {
    if (!req.user)
        throw AppError_1.AppError.unauthorized('Authentication required');
    return req.user.id;
}
exports.uploadReferenceImage = (0, catchAsync_1.catchAsync)(async (req, res) => {
    if (!req.file)
        throw AppError_1.AppError.badRequest('No file uploaded — attach an image under field name "file"');
    const input = req.body;
    const image = await referenceImagesService.uploadReferenceImage(req.file, input, requireActorId(req), req);
    res.status(201).json({ success: true, data: { image } });
});
exports.listReferenceImages = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const query = req.query;
    const { images, meta } = await referenceImagesService.listReferenceImages(query);
    res.status(200).json({ success: true, data: { images }, meta });
});
exports.listCategories = (0, catchAsync_1.catchAsync)(async (_req, res) => {
    const categories = await referenceImagesService.listCategories();
    res.status(200).json({ success: true, data: categories });
});
exports.getReferenceImage = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const image = await referenceImagesService.getReferenceImage(req.params.id);
    res.status(200).json({ success: true, data: { image } });
});
exports.updateReferenceImage = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    const image = await referenceImagesService.updateReferenceImage(req.params.id, input, requireActorId(req), req);
    res.status(200).json({ success: true, data: { image } });
});
exports.replaceReferenceImage = (0, catchAsync_1.catchAsync)(async (req, res) => {
    if (!req.file)
        throw AppError_1.AppError.badRequest('No file uploaded — attach an image under field name "file"');
    const image = await referenceImagesService.replaceReferenceImage(req.params.id, req.file, requireActorId(req), req);
    res.status(200).json({ success: true, data: { image } });
});
exports.deleteReferenceImage = (0, catchAsync_1.catchAsync)(async (req, res) => {
    await referenceImagesService.deleteReferenceImage(req.params.id, requireActorId(req), req);
    res.status(200).json({ success: true, message: 'Reference image deleted' });
});
//# sourceMappingURL=referenceImages.controller.js.map