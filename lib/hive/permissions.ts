import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

/**
 * Runtime separation of powers (sent2 v1.2 §3.6, Invariant 9). Prompts describe; this decides.
 * Deny-first: `cannot` is checked before any grant, for every entity including governance.
 *
 * Action vocabulary (channels normalized from "task/analysis" to "task.analysis"):
 *   publish(type T to channel C) is checked against `cannot` as each of
 *     "<channel family>.<type family>"   e.g. ballot.cast → task/deliberation ⇒ "deliberation.ballot"
 *     "<C>.write", "<C>.publish"          e.g. memory/hive ⇒ "memory.hive.write"
 *     T and its alias                     e.g. decision.published ⇒ "governance.decide"
 *   then C must match a `write` grant. read(C) needs a `read` grant ("*" reads everything).
 * Matching is segment-aware: "task.analysis" grants "task.analysis" and "task.analysis.advisory",
 * never "task.analysisx".
 *
 * Fix vs sent2: sent2's matcher compared "/"-channels with "."-grants and so denied every Core
 * Voice's whisper; channels are normalized here, with a test.
 */

export const PermissionEntrySchema = z.object({
  read: z.array(z.string()),
  write: z.array(z.string()),
  cannot: z.array(z.string()),
});
export type PermissionEntry = z.infer<typeof PermissionEntrySchema>;
export const PermissionsSchema = z.record(z.string(), PermissionEntrySchema);
export type PermissionsConfig = z.infer<typeof PermissionsSchema>;

export class PermissionError extends Error {
  constructor(public readonly entityId: string, public readonly action: string, public readonly reason: string) {
    super(`PERMISSION DENIED: ${entityId} attempted ${action} — ${reason}`);
    this.name = "PermissionError";
  }
}

export function loadPermissions(file = path.join(process.cwd(), "constitution", "permissions.yaml")): PermissionsConfig {
  return PermissionsSchema.parse(YAML.parse(readFileSync(file, "utf8")));
}

export const dotted = (channel: string) => channel.replaceAll("/", ".");
const channelFamily = (channel: string) => dotted(channel).split(".")[1] ?? dotted(channel);
const typeFamily = (type: string) => type.split(".")[0];

/** Message types whose canonical governance action differs from their spelling. */
const TYPE_ALIASES: Record<string, string> = { "decision.published": "governance.decide", "ballot.cast": "deliberation.ballot" };

export function matches(pattern: string, action: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return action.startsWith(pattern.slice(0, -1));
  return action === pattern || action.startsWith(`${pattern}.`);
}

export function publishActions(channel: string, type: string): string[] {
  const c = dotted(channel);
  const acts = [`${channelFamily(channel)}.${typeFamily(type)}`, `${c}.write`, `${c}.publish`, type];
  if (TYPE_ALIASES[type]) acts.push(TYPE_ALIASES[type]);
  return [...new Set(acts)];
}

export class PolicyEngine {
  constructor(private readonly perms: PermissionsConfig, public readonly version = "permissions.yaml") {}

  entry(entityId: string): PermissionEntry {
    const cls = entityId.split(".")[0];
    return this.perms[entityId] ?? this.perms[`${cls}.*`] ?? this.perms.default ?? { read: [], write: [], cannot: [] };
  }

  private checkCannot(entityId: string, entry: PermissionEntry, actions: string[]): void {
    for (const denied of entry.cannot)
      for (const a of actions) if (matches(denied, a)) throw new PermissionError(entityId, a, `matches deny rule "${denied}"`);
  }

  authorizePublish(entityId: string, channel: string, type: string): void {
    const entry = this.entry(entityId);
    this.checkCannot(entityId, entry, publishActions(channel, type));
    const c = dotted(channel);
    if (!entry.write.some((p) => matches(p, c))) throw new PermissionError(entityId, `write:${c}`, "no write grant for channel");
  }

  authorizeRead(entityId: string, channel: string): void {
    const entry = this.entry(entityId);
    const c = channel === "*" ? "*" : dotted(channel);
    this.checkCannot(entityId, entry, [`${c}.read`]);
    const ok = entry.read.some((p) => p === "*" || (c !== "*" && matches(p, c)));
    if (!ok) throw new PermissionError(entityId, `read:${c}`, "no read grant for channel");
  }
}
