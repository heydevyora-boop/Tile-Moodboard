-- CreateTable
CREATE TABLE "LibraryReference" (
    "id" TEXT NOT NULL,
    "themeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "driveFileId" TEXT NOT NULL,
    "room" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryReference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LibraryReference_driveFileId_key" ON "LibraryReference"("driveFileId");

-- CreateIndex
CREATE INDEX "LibraryReference_themeId_idx" ON "LibraryReference"("themeId");

-- CreateIndex
CREATE INDEX "LibraryReference_themeId_isActive_idx" ON "LibraryReference"("themeId", "isActive");

-- CreateIndex
CREATE INDEX "LibraryReference_room_idx" ON "LibraryReference"("room");

-- AddForeignKey
ALTER TABLE "LibraryReference" ADD CONSTRAINT "LibraryReference_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
