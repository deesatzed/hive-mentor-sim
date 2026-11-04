import "server-only";
import { z } from "zod";

/**
 * Typed A2A envelope (reference/sent2.md v1.2 §3.3, "Envelope v2").
 * Changes from sent2: urgency is low|normal|high (the `distress` value and its bypass are removed,
 * owner decision); the guardian review message type is removed; whisper numbers (confidence,
 * salience, valence) are set from the decision layer, never by the Voice's own LLM output;
 * evidence carries verified {chunkId, quote, mentorId} records instead of bare refs.
 */

export const ScopeSchema = z.enum(["private", "project", "hive"]);
export const UrgencySchema = z.enum(["low", "normal", "high"]);

export const MessageTypeSchema = z.enum([
  "context.requested", "memory.results", "affect.assessed", // context
  "assessment.published", "evidence.shared", "uncertainty.reported", // analysis
  "proposal.submitted", "critique.published", "work.handed_off", // collaboration
  "conflict.detected", "ballot.cast", "objection.raised", // deliberation
  "amendment.requested", "decision.published", // governance
  "selfmodel.delta", "memory.candidate", "canon.candidate", "conflict.marked", // persistence
  "status.updated", "failure.reported", // operations
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const EvidenceSchema = z.object({ chunkId: z.string(), quote: z.string(), mentorId: z.string() });

export const WhisperBodySchema = z.object({
  kind: z.literal("whisper"),
  claim: z.string().max(280),
  confidence: z.number().min(0).max(1),
  valence: z.number().min(-1).max(1).default(0),
  salience: z.number().min(0).max(1).default(0.5),
  advisory: z.boolean().default(false),
  endorsed_by: z.string().nullable().default(null),
  request: z.string().nullable().default(null),
  evidence: z.array(EvidenceSchema).default([]),
  rejected_evidence: z.number().int().min(0).default(0),
  uncertainty: z.string().default(""),
  moral_flag: z.boolean().default(false),
  /** true when a number above came from a fallback because the decision layer was unavailable */
  numbers_unavailable: z.boolean().default(false),
  /** heartbeat phase label (perceive, whisper, attend, deliberate, govern, compose, reflect) */
  phase: z.string().optional(),
});
export type WhisperBody = z.infer<typeof WhisperBodySchema>;

export const ProvenanceSchema = z.object({ prompt_version: z.string(), model: z.string(), policy_version: z.string() });

/** Channel names use "/" (e.g. "task/analysis"); permissions.yaml uses "." — they are normalized. */
export const ChannelSchema = z.string().regex(/^[a-z_]+(\/[a-z_]+)*$/, "channel must look like task/analysis");

export const EnvelopeSchema = z.object({
  message_id: z.string(),
  task_id: z.string(),
  cycle_id: z.string(),
  cycle_no: z.number().int(),
  trace_id: z.string(),
  in_reply_to: z.string().nullable().default(null),
  from: z.string(),
  to: ChannelSchema,
  type: MessageTypeSchema,
  scope: ScopeSchema,
  urgency: UrgencySchema.default("normal"),
  body: z.record(z.string(), z.unknown()),
  provenance: ProvenanceSchema,
  created_at: z.string(),
  expects_reply: z.boolean().default(false),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** What a sender supplies; the bus stamps message_id, cycle ids, and created_at. */
export const EnvelopeDraftSchema = EnvelopeSchema.omit({ message_id: true, cycle_id: true, cycle_no: true, created_at: true });
export type EnvelopeDraft = z.input<typeof EnvelopeDraftSchema>;

export function isWhisper(body: Record<string, unknown>): boolean {
  return body.kind === "whisper";
}
