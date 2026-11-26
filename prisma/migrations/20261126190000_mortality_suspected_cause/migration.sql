-- CreateEnum
CREATE TYPE "MortalityCause" AS ENUM ('NATURAL', 'INJURY', 'ACCIDENT', 'DISEASE', 'WEAKNESS');

-- AlterTable: nullable, null = unknown; existing rows stay unknown.
ALTER TABLE "MortalityLog" ADD COLUMN "suspected_cause" "MortalityCause";
