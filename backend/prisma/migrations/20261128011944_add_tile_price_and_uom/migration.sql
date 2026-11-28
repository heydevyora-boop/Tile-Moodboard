-- CreateEnum
CREATE TYPE "UnitOfMeasure" AS ENUM ('BOX', 'PIECE', 'SQFT', 'SQM', 'SET');

-- AlterTable
ALTER TABLE "tiles" ADD COLUMN     "sellingPrice" DECIMAL(14,2),
ADD COLUMN     "unitOfMeasure" "UnitOfMeasure";
