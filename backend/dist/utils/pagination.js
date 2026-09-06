"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPagination = getPagination;
exports.buildPaginationMeta = buildPaginationMeta;
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
function getPagination({ page, limit }) {
    const safePage = Math.max(1, page ?? DEFAULT_PAGE);
    const safeLimit = Math.min(MAX_LIMIT, Math.max(1, limit ?? DEFAULT_LIMIT));
    return {
        page: safePage,
        limit: safeLimit,
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
    };
}
function buildPaginationMeta(total, page, limit) {
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
    };
}
//# sourceMappingURL=pagination.js.map