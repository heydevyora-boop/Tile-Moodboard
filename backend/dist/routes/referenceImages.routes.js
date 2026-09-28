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
const referenceImagesController = __importStar(require("@controllers/referenceImages.controller"));
const auth_1 = require("@middlewares/auth");
const validate_1 = require("@middlewares/validate");
const uploadReferenceImage_1 = require("@middlewares/uploadReferenceImage");
const referenceImages_validators_1 = require("@validators/referenceImages.validators");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
router.get('/categories', (0, auth_1.requirePermission)('reference_images:read'), referenceImagesController.listCategories);
router.get('/', (0, auth_1.requirePermission)('reference_images:read'), (0, validate_1.validate)(referenceImages_validators_1.listReferenceImagesQuerySchema, 'query'), referenceImagesController.listReferenceImages);
router.post('/', (0, auth_1.requirePermission)('reference_images:write'), uploadReferenceImage_1.uploadReferenceImage, (0, validate_1.validate)(referenceImages_validators_1.uploadReferenceImageSchema), referenceImagesController.uploadReferenceImage);
router.get('/:id', (0, auth_1.requirePermission)('reference_images:read'), referenceImagesController.getReferenceImage);
router.patch('/:id', (0, auth_1.requirePermission)('reference_images:write'), (0, validate_1.validate)(referenceImages_validators_1.updateReferenceImageSchema), referenceImagesController.updateReferenceImage);
router.put('/:id/image', (0, auth_1.requirePermission)('reference_images:write'), uploadReferenceImage_1.uploadReferenceImage, referenceImagesController.replaceReferenceImage);
router.delete('/:id', (0, auth_1.requirePermission)('reference_images:write'), referenceImagesController.deleteReferenceImage);
exports.default = router;
//# sourceMappingURL=referenceImages.routes.js.map