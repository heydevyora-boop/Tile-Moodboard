-- CreateEnum
CREATE TYPE "CatalogStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "TileType" AS ENUM ('BASE', 'HIGHLIGHTER', 'BORDER', 'ACCENT', 'LARGE_FORMAT_BASE');
CREATE TYPE "RuleSection" AS ENUM ('GENERAL', 'STYLE', 'ROOM', 'CLIENT');
CREATE TYPE "MoodBoardStatus" AS ENUM ('DRAFT', 'GENERATED', 'REFINED', 'APPROVED', 'REJECTED', 'ARCHIVED');
CREATE TYPE "PrintFormat" AS ENUM ('CASSETTE_PANEL', 'ACP_SIGNBOARD', 'MOOD_BOARD_PRINT', 'CUSTOM');
CREATE TYPE "PrintLayout" AS ENUM ('HERO_IMAGE', 'TILE_GRID', 'SIDE_BY_SIDE', 'CASSETTE_STYLE');
CREATE TYPE "DimensionUnit" AS ENUM ('FT', 'IN', 'CM', 'MM');
CREATE TYPE "PrintFileFormat" AS ENUM ('PNG', 'PDF');

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogs" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "filePath" TEXT,
    "status" "CatalogStatus" NOT NULL DEFAULT 'PENDING',
    "totalPages" INTEGER,
    "tilesExtracted" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "uploadedById" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalogs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tiles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "catalogId" TEXT,
    "size" TEXT,
    "finish" TEXT,
    "type" "TileType" NOT NULL DEFAULT 'BASE',
    "colorTone" TEXT,
    "bestRoom" TEXT,
    "collection" TEXT,
    "imageUrl" TEXT,
    "productCode" TEXT,
    "inStock" BOOLEAN NOT NULL DEFAULT true,
    "sheetRowRef" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "design_rules" (
    "id" TEXT NOT NULL,
    "section" "RuleSection" NOT NULL,
    "key" TEXT,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "design_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_versions" (
    "id" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "fullContent" TEXT NOT NULL,
    "changeSummary" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_images" (
    "id" TEXT NOT NULL,
    "styleTag" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "description" TEXT,
    "style" TEXT,
    "room" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "preferredStyle" TEXT,
    "preferredRoom" TEXT,
    "budget" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mood_boards" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "createdById" TEXT,
    "clientBrief" TEXT NOT NULL,
    "style" TEXT NOT NULL,
    "room" TEXT NOT NULL,
    "combinations" JSONB NOT NULL,
    "status" "MoodBoardStatus" NOT NULL DEFAULT 'GENERATED',
    "selectedIndex" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mood_boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mood_board_tiles" (
    "id" TEXT NOT NULL,
    "moodBoardId" TEXT NOT NULL,
    "tileId" TEXT NOT NULL,
    "combinationIndex" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mood_board_tiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "print_boards" (
    "id" TEXT NOT NULL,
    "moodBoardId" TEXT,
    "createdById" TEXT,
    "format" "PrintFormat" NOT NULL,
    "layout" "PrintLayout" NOT NULL,
    "widthValue" DOUBLE PRECISION NOT NULL,
    "heightValue" DOUBLE PRECISION NOT NULL,
    "unit" "DimensionUnit" NOT NULL,
    "dpi" INTEGER NOT NULL DEFAULT 300,
    "fileFormat" "PrintFileFormat" NOT NULL,
    "fileUrl" TEXT,
    "tilesSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "print_boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "category" TEXT,
    "description" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE INDEX "users_roleId_idx" ON "users"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "brands_name_key" ON "brands"("name");
CREATE UNIQUE INDEX "brands_slug_key" ON "brands"("slug");

-- CreateIndex
CREATE INDEX "catalogs_brandId_idx" ON "catalogs"("brandId");
CREATE INDEX "catalogs_status_idx" ON "catalogs"("status");

-- CreateIndex
CREATE INDEX "tiles_brandId_idx" ON "tiles"("brandId");
CREATE INDEX "tiles_catalogId_idx" ON "tiles"("catalogId");
CREATE INDEX "tiles_type_idx" ON "tiles"("type");
CREATE INDEX "tiles_bestRoom_idx" ON "tiles"("bestRoom");

-- CreateIndex
CREATE UNIQUE INDEX "design_rules_section_key_key" ON "design_rules"("section", "key");

-- CreateIndex
CREATE UNIQUE INDEX "rule_versions_versionNumber_key" ON "rule_versions"("versionNumber");

-- CreateIndex
CREATE INDEX "reference_images_style_idx" ON "reference_images"("style");
CREATE INDEX "reference_images_room_idx" ON "reference_images"("room");

-- CreateIndex
CREATE INDEX "customers_phone_idx" ON "customers"("phone");

-- CreateIndex
CREATE INDEX "mood_boards_customerId_idx" ON "mood_boards"("customerId");
CREATE INDEX "mood_boards_status_idx" ON "mood_boards"("status");

-- CreateIndex
CREATE UNIQUE INDEX "mood_board_tiles_moodBoardId_tileId_combinationIndex_role_key" ON "mood_board_tiles"("moodBoardId", "tileId", "combinationIndex", "role");

-- CreateIndex
CREATE INDEX "print_boards_moodBoardId_idx" ON "print_boards"("moodBoardId");

-- CreateIndex
CREATE INDEX "activity_logs_userId_idx" ON "activity_logs"("userId");
CREATE INDEX "activity_logs_action_idx" ON "activity_logs"("action");
CREATE INDEX "activity_logs_entityType_entityId_idx" ON "activity_logs"("entityType", "entityId");
CREATE INDEX "activity_logs_createdAt_idx" ON "activity_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "settings_key_key" ON "settings"("key");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogs" ADD CONSTRAINT "catalogs_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalogs" ADD CONSTRAINT "catalogs_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiles" ADD CONSTRAINT "tiles_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tiles" ADD CONSTRAINT "tiles_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "catalogs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_rules" ADD CONSTRAINT "design_rules_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_versions" ADD CONSTRAINT "rule_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_images" ADD CONSTRAINT "reference_images_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mood_boards" ADD CONSTRAINT "mood_boards_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "mood_boards" ADD CONSTRAINT "mood_boards_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mood_board_tiles" ADD CONSTRAINT "mood_board_tiles_moodBoardId_fkey" FOREIGN KEY ("moodBoardId") REFERENCES "mood_boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mood_board_tiles" ADD CONSTRAINT "mood_board_tiles_tileId_fkey" FOREIGN KEY ("tileId") REFERENCES "tiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_boards" ADD CONSTRAINT "print_boards_moodBoardId_fkey" FOREIGN KEY ("moodBoardId") REFERENCES "mood_boards"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "print_boards" ADD CONSTRAINT "print_boards_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings" ADD CONSTRAINT "settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
