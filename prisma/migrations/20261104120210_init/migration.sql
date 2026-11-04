-- CreateTable
CREATE TABLE "Mentor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "years" TEXT NOT NULL,
    "diedYear" INTEGER NOT NULL,
    "roles" TEXT NOT NULL DEFAULT '[]',
    "bio" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "inactiveReason" TEXT,
    "corpusStats" TEXT NOT NULL DEFAULT '{}'
);

-- CreateTable
CREATE TABLE "CorpusWork" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mentorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "translator" TEXT,
    "attributed" BOOLEAN NOT NULL DEFAULT false,
    "sourceUrl" TEXT NOT NULL,
    "license" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CorpusWork_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "Mentor" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CorpusChunk" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workId" TEXT NOT NULL,
    "mentorId" TEXT NOT NULL,
    "locator" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "embedding" BLOB,
    "embedModel" TEXT,
    "isEpisode" BOOLEAN NOT NULL DEFAULT false,
    "episodeP" REAL,
    "isPosition" BOOLEAN NOT NULL DEFAULT false,
    "heldOut" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "CorpusChunk_workId_fkey" FOREIGN KEY ("workId") REFERENCES "CorpusWork" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MentorPrinciple" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mentorId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "axis" TEXT NOT NULL,
    "receipts" TEXT NOT NULL DEFAULT '[]',
    "embedding" BLOB,
    CONSTRAINT "MentorPrinciple_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "Mentor" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MentorAnswer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mentorId" TEXT NOT NULL,
    "questionKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "answer" TEXT,
    "choice" TEXT,
    "evidence" TEXT NOT NULL DEFAULT '[]',
    "model" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MentorAnswer_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "Mentor" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Situation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "setKey" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "options" TEXT NOT NULL,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "meta" TEXT NOT NULL DEFAULT '{}'
);

-- CreateTable
CREATE TABLE "Voice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "attribute" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "temperature" REAL NOT NULL,
    "phases" TEXT NOT NULL DEFAULT '[]',
    "guilds" TEXT NOT NULL DEFAULT '[]',
    "relevance" TEXT NOT NULL DEFAULT '{}',
    "hat" TEXT NOT NULL DEFAULT '{}',
    "promptVersion" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "Formation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FormationMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "formationId" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL,
    "mentorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    CONSTRAINT "FormationMember_formationId_fkey" FOREIGN KEY ("formationId") REFERENCES "Formation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HivePrinciple" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "axis" TEXT NOT NULL,
    "receipts" TEXT NOT NULL DEFAULT '[]',
    "voiceIds" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "supersedesId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "HiveSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mode" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Cycle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "cycleNo" INTEGER NOT NULL,
    "situationId" TEXT,
    "input" TEXT NOT NULL,
    "output" TEXT,
    "awareness" TEXT,
    "verdict" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "formationVersion" INTEGER NOT NULL,
    "constitutionVersion" INTEGER,
    "trace" TEXT NOT NULL DEFAULT '{}',
    "costUsd" REAL NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Cycle_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "HiveSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BusMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cycleId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "inReplyTo" TEXT,
    "fromEntity" TEXT NOT NULL,
    "toEntity" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "urgency" TEXT NOT NULL DEFAULT 'normal',
    "body" TEXT NOT NULL,
    "provenance" TEXT NOT NULL,
    "authorized" BOOLEAN NOT NULL,
    "denyReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ConclaveRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cycleId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "domains" TEXT NOT NULL,
    "options" TEXT NOT NULL,
    "rounds" TEXT NOT NULL,
    "ballots" TEXT NOT NULL,
    "weights" TEXT NOT NULL,
    "totals" TEXT NOT NULL,
    "kappa" REAL NOT NULL,
    "winner" TEXT,
    "margin" REAL,
    "decision" TEXT NOT NULL,
    "dissent" TEXT NOT NULL DEFAULT '[]',
    "guildsInWinningCoalition" TEXT NOT NULL DEFAULT '[]'
);

-- CreateTable
CREATE TABLE "HiveRuling" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "situationId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "choice" TEXT,
    "constitutionChoice" TEXT,
    "perVoiceTop" TEXT NOT NULL DEFAULT '{}',
    "formationVersion" INTEGER NOT NULL,
    "constitutionVersion" INTEGER
);

-- CreateTable
CREATE TABLE "MemoryRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "ownerEntity" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "certainty" TEXT NOT NULL,
    "priority" REAL NOT NULL DEFAULT 1,
    "createdCycle" INTEGER NOT NULL,
    "supersedes" TEXT,
    "provenance" TEXT NOT NULL,
    "embedding" BLOB,
    "resolvedCycle" INTEGER
);

-- CreateTable
CREATE TABLE "SelfModelVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "deltaFrom" INTEGER,
    "cycleId" TEXT,
    "promoted" BOOLEAN NOT NULL,
    "rejectReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Commitment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cycleMade" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "contextRef" TEXT NOT NULL,
    "costType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "breakageRecord" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EgoAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cycleNo" INTEGER NOT NULL,
    "findings" TEXT NOT NULL,
    "mandate" BOOLEAN NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "InteroceptionSample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cycleNo" INTEGER NOT NULL,
    "valence" REAL NOT NULL,
    "arousal" REAL NOT NULL,
    "dominant" TEXT NOT NULL,
    "cIntra" REAL,
    "cInter" REAL,
    "openConflictMarkers" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "HivePrediction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cycleId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "proposedBy" TEXT NOT NULL,
    "mentorRefs" TEXT NOT NULL DEFAULT '[]',
    "principleIds" TEXT NOT NULL DEFAULT '[]',
    "checkInAt" DATETIME NOT NULL,
    "outcomeRating" INTEGER,
    "outcomeNote" TEXT,
    "checkedInAt" DATETIME
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "strength" REAL NOT NULL DEFAULT 1,
    "halfLifeDays" REAL NOT NULL DEFAULT 14,
    "cycleId" TEXT,
    "dismissedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PatternSurface" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "density" REAL NOT NULL,
    "dismissedUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "LedgerEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "cycleId" TEXT,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "model" TEXT,
    "calibrated" BOOLEAN NOT NULL DEFAULT true,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "refs" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EvalRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "suite" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "pass" BOOLEAN,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "details" TEXT NOT NULL,
    "model" TEXT,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "CorpusChunk_mentorId_isEpisode_idx" ON "CorpusChunk"("mentorId", "isEpisode");

-- CreateIndex
CREATE UNIQUE INDEX "MentorAnswer_mentorId_questionKey_key" ON "MentorAnswer"("mentorId", "questionKey");

-- CreateIndex
CREATE UNIQUE INDEX "Formation_version_key" ON "Formation"("version");

-- CreateIndex
CREATE UNIQUE INDEX "FormationMember_formationId_voiceId_mentorId_key" ON "FormationMember"("formationId", "voiceId", "mentorId");

-- CreateIndex
CREATE INDEX "HivePrinciple_status_idx" ON "HivePrinciple"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Cycle_cycleNo_key" ON "Cycle"("cycleNo");

-- CreateIndex
CREATE INDEX "BusMessage_cycleId_idx" ON "BusMessage"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "ConclaveRun_cycleId_key" ON "ConclaveRun"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "HiveRuling_cycleId_key" ON "HiveRuling"("cycleId");

-- CreateIndex
CREATE INDEX "HiveRuling_situationId_idx" ON "HiveRuling"("situationId");

-- CreateIndex
CREATE INDEX "MemoryRecord_scope_kind_idx" ON "MemoryRecord"("scope", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "SelfModelVersion_version_key" ON "SelfModelVersion"("version");

-- CreateIndex
CREATE UNIQUE INDEX "InteroceptionSample_cycleNo_key" ON "InteroceptionSample"("cycleNo");

-- CreateIndex
CREATE INDEX "Signal_subjectType_subjectId_type_idx" ON "Signal"("subjectType", "subjectId", "type");

-- CreateIndex
CREATE INDEX "LedgerEvent_kind_createdAt_idx" ON "LedgerEvent"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEvent_cycleId_idx" ON "LedgerEvent"("cycleId");
