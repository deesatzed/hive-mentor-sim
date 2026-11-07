-- AlterTable
ALTER TABLE "ConclaveRun" ADD COLUMN "finalCall" TEXT;

-- AlterTable
ALTER TABLE "HiveRuling" ADD COLUMN "dominantMentorId" TEXT;

-- AlterTable
ALTER TABLE "HiveSession" ADD COLUMN "dominantMentorId" TEXT;

-- CreateTable
CREATE TABLE "OperatorSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);
