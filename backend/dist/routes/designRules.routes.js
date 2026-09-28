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
const designRulesController = __importStar(require("@controllers/designRules.controller"));
const auth_1 = require("@middlewares/auth");
const validate_1 = require("@middlewares/validate");
const designRules_validators_1 = require("@validators/designRules.validators");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
router.get('/preview', (0, auth_1.requirePermission)('design_rules:read'), designRulesController.previewDraft);
router.post('/publish', (0, auth_1.requirePermission)('design_rules:write'), (0, validate_1.validate)(designRules_validators_1.publishRulesSchema), designRulesController.publishRules);
router.get('/live', (0, auth_1.requirePermission)('design_rules:read'), designRulesController.getLiveVersion);
router.get('/versions', (0, auth_1.requirePermission)('design_rules:read'), (0, validate_1.validate)(designRules_validators_1.listVersionsQuerySchema, 'query'), designRulesController.listVersionHistory);
router.get('/versions/compare', (0, auth_1.requirePermission)('design_rules:read'), (0, validate_1.validate)(designRules_validators_1.compareVersionsQuerySchema, 'query'), designRulesController.compareVersions);
router.get('/versions/:id', (0, auth_1.requirePermission)('design_rules:read'), designRulesController.getVersion);
router.post('/versions/:id/restore', (0, auth_1.requirePermission)('design_rules:write'), designRulesController.restoreVersion);
router.delete('/versions/:id', (0, auth_1.requirePermission)('design_rules:write'), designRulesController.deleteVersion);
router.get('/', (0, auth_1.requirePermission)('design_rules:read'), designRulesController.listDesignRules);
router.post('/', (0, auth_1.requirePermission)('design_rules:write'), (0, validate_1.validate)(designRules_validators_1.createDesignRuleSchema), designRulesController.createDesignRule);
router.get('/:id', (0, auth_1.requirePermission)('design_rules:read'), designRulesController.getDesignRule);
router.patch('/:id', (0, auth_1.requirePermission)('design_rules:write'), (0, validate_1.validate)(designRules_validators_1.updateDesignRuleSchema), designRulesController.updateDesignRule);
router.delete('/:id', (0, auth_1.requirePermission)('design_rules:write'), designRulesController.deleteDesignRule);
exports.default = router;
//# sourceMappingURL=designRules.routes.js.map