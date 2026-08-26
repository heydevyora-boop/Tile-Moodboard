import { prisma } from '@db/connection';

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s-]+/g, '-');
}

export async function listBrands() {
  return prisma.brand.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
}

/** Looks up a brand by id, or by name (creating it if it doesn't exist yet). */
export async function resolveBrand(input: { brandId?: string; brandName?: string }) {
  if (input.brandId) {
    const brand = await prisma.brand.findUnique({ where: { id: input.brandId } });
    if (brand) return brand;
  }
  if (input.brandName) {
    const slug = slugify(input.brandName);
    const existing = await prisma.brand.findUnique({ where: { slug } });
    if (existing) return existing;
    return prisma.brand.create({ data: { name: input.brandName.trim(), slug } });
  }
  return null;
}
