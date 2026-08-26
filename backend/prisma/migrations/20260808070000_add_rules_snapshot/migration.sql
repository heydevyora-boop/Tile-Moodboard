-- AlterTable
ALTER TABLE "rule_versions" ADD COLUMN "rulesSnapshot" JSONB NOT NULL DEFAULT '[]';

-- Drop the default now that existing rows (if any) have been backfilled —
-- new inserts must always provide a real snapshot explicitly.
ALTER TABLE "rule_versions" ALTER COLUMN "rulesSnapshot" DROP DEFAULT;
