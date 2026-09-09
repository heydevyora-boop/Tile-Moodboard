-- CreateEnum
CREATE TYPE "ClientResponseStatus" AS ENUM ('APPROVED', 'CHANGES_REQUESTED');

-- CreateTable
CREATE TABLE "mood_board_shares" (
    "id" TEXT NOT NULL,
    "moodBoardId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "clientResponse" "ClientResponseStatus",

    CONSTRAINT "mood_board_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mood_board_shares_moodBoardId_key" ON "mood_board_shares"("moodBoardId");

-- CreateIndex
CREATE UNIQUE INDEX "mood_board_shares_token_key" ON "mood_board_shares"("token");

-- AddForeignKey
ALTER TABLE "mood_board_shares" ADD CONSTRAINT "mood_board_shares_moodBoardId_fkey" FOREIGN KEY ("moodBoardId") REFERENCES "mood_boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mood_board_shares" ADD CONSTRAINT "mood_board_shares_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
