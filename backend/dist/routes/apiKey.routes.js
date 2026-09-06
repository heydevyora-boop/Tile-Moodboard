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
const apiKeyController = __importStar(require("@controllers/apiKey.controller"));
const auth_1 = require("@middlewares/auth");
const validate_1 = require("@middlewares/validate");
const apiKey_validators_1 = require("@validators/apiKey.validators");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
router.use((0, auth_1.authorize)('OWNER'));
router.get('/', (0, validate_1.validate)(apiKey_validators_1.listApiKeysQuerySchema, 'query'), apiKeyController.list);
router.post('/deactivate-all', apiKeyController.deactivateAll);
router.post('/', (0, validate_1.validate)(apiKey_validators_1.createApiKeySchema), apiKeyController.create);
router.post('/:id/rotate', (0, validate_1.validate)(apiKey_validators_1.rotateApiKeySchema), apiKeyController.rotate);
router.post('/:id/activate', apiKeyController.activate);
router.post('/:id/deactivate', apiKeyController.deactivate);
router.delete('/:id', apiKeyController.remove);
exports.default = router;
//# sourceMappingURL=apiKey.routes.js.map