"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listBrands = listBrands;
exports.resolveBrand = resolveBrand;
const connection_1 = require("@db/connection");
function slugify(value) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/[\s-]+/g, '-');
}
async function listBrands() {
    return connection_1.prisma.brand.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
}
async function resolveBrand(input) {
    if (input.brandId) {
        const brand = await connection_1.prisma.brand.findUnique({ where: { id: input.brandId } });
        if (brand)
            return brand;
    }
    if (input.brandName) {
        const slug = slugify(input.brandName);
        const existing = await connection_1.prisma.brand.findUnique({ where: { slug } });
        if (existing)
            return existing;
        return connection_1.prisma.brand.create({ data: { name: input.brandName.trim(), slug } });
    }
    return null;
}
//# sourceMappingURL=brand.service.js.map