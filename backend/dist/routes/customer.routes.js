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
const customerController = __importStar(require("@controllers/customer.controller"));
const auth_1 = require("@middlewares/auth");
const validate_1 = require("@middlewares/validate");
const customer_validators_1 = require("@validators/customer.validators");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
router.get('/', (0, auth_1.requirePermission)('customers:read'), (0, validate_1.validate)(customer_validators_1.listCustomersQuerySchema, 'query'), customerController.list);
router.post('/', (0, auth_1.requirePermission)('customers:write'), (0, validate_1.validate)(customer_validators_1.createCustomerSchema), customerController.create);
router.get('/:id', (0, auth_1.requirePermission)('customers:read'), customerController.getOne);
router.patch('/:id', (0, auth_1.requirePermission)('customers:write'), (0, validate_1.validate)(customer_validators_1.updateCustomerSchema), customerController.update);
router.delete('/:id', (0, auth_1.requirePermission)('customers:write'), customerController.remove);
router.get('/:id/history', (0, auth_1.requirePermission)('customers:read'), customerController.history);
router.get('/:id/mood-boards', (0, auth_1.requirePermission)('customers:read'), customerController.moodBoards);
router.get('/:id/favorites', (0, auth_1.requirePermission)('customers:read'), customerController.listFavorites);
router.post('/:id/favorites', (0, auth_1.requirePermission)('customers:write'), (0, validate_1.validate)(customer_validators_1.addFavoriteSchema), customerController.addFavorite);
router.delete('/:id/favorites/:tileId', (0, auth_1.requirePermission)('customers:write'), customerController.removeFavorite);
exports.default = router;
//# sourceMappingURL=customer.routes.js.map