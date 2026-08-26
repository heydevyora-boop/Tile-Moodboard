-- AlterTable: add updatedAt to print_boards, backfilled from createdAt
ALTER TABLE "print_boards" ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "print_boards" SET "updatedAt" = "createdAt";
ALTER TABLE "print_boards" ALTER COLUMN "updatedAt" SET NOT NULL;

-- CreateTable
CREATE TABLE "print_board_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "format" "PrintFormat" NOT NULL,
    "layout" "PrintLayout" NOT NULL,
    "widthValue" DOUBLE PRECISION NOT NULL,
    "heightValue" DOUBLE PRECISION NOT NULL,
    "unit" "DimensionUnit" NOT NULL,
    "dpi" INTEGER NOT NULL DEFAULT 300,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "print_board_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "print_board_templates_name_key" ON "print_board_templates"("name");

-- AddForeignKey
ALTER TABLE "print_board_templates" ADD CONSTRAINT "print_board_templates_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
