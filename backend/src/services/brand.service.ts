import { prisma } from '@db/connection';
import { AppError } from '@utils/AppError';
import { CreateCompanyInput, UpdateCompanyInput, ListCompaniesQuery } from '@validators/catalogHierarchy.validators';

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

/* ============================================================
   COMPANY (Brand) -- catalog hierarchy management on top of the
   existing Brand model. listBrands/resolveBrand above are left
   untouched: they belong to the extraction/sync pipeline and this
   stage does not rebuild that workflow.
   ============================================================ */

export async function listCompanies(query: ListCompaniesQuery) {
  const where = {
    ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
    ...(query.search ? { name: { contains: query.search, mode: 'insensitive' as const } } : {}),
  };
  return prisma.brand.findMany({ where, orderBy: { name: 'asc' } });
}

export async function getCompanyById(id: string) {
  const company = await prisma.brand.findUnique({ where: { id } });
  if (!company) throw AppError.notFound('Company not found');
  return company;
}

export async function createCompany(input: CreateCompanyInput) {
  const slug = slugify(input.name);
  const existing = await prisma.brand.findUnique({ where: { slug } });
  if (existing) throw AppError.conflict('A company with this name already exists', { brandId: existing.id });

  return prisma.brand.create({
    data: {
      name: input.name,
      slug,
      code: input.code,
      description: input.description,
      logoUrl: input.logoUrl,
    },
  });
}

export async function updateCompany(id: string, input: UpdateCompanyInput) {
  const existing = await prisma.brand.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Company not found');

  return prisma.brand.update({
    where: { id },
    data: {
      name: input.name,
      code: input.code,
      description: input.description,
      logoUrl: input.logoUrl,
      isActive: input.isActive,
    },
  });
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
