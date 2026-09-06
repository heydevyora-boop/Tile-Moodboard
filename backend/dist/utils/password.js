"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashPassword = hashPassword;
exports.comparePassword = comparePassword;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const index_1 = require("@config/index");
function hashPassword(plain) {
    return bcryptjs_1.default.hash(plain, index_1.config.auth.bcryptSaltRounds);
}
function comparePassword(plain, hash) {
    return bcryptjs_1.default.compare(plain, hash);
}
//# sourceMappingURL=password.js.map