"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validate = void 0;
const validate = (schema, part = 'body') => (req, _res, next) => {
    try {
        const parsed = schema.parse(req[part]);
        req[part] = parsed;
        next();
    }
    catch (err) {
        next(err);
    }
};
exports.validate = validate;
//# sourceMappingURL=validate.js.map