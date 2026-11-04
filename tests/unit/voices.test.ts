import { describe, expect, it } from "vitest";
import { loadHiveConfig } from "@/lib/hive/config";
import { activeAdvisors, byName, coreVoices, guildsOf, loadVoices } from "@/lib/hive/voices";

describe("voices loader", () => {
  const cfg = loadHiveConfig();
  const vs = loadVoices(cfg);

  it("loads all 33 entities with prompt bodies", () => {
    expect(vs).toHaveLength(33);
    expect(coreVoices(vs)).toHaveLength(15);
    for (const v of vs) expect(v.body.length, v.id).toBeGreaterThan(50);
  });

  it("NOOSPHERE is inactive; REVERENCE follows the edict module", () => {
    expect(byName(vs).get("NOOSPHERE")!.active).toBe(false);
    expect(activeAdvisors(vs)).toHaveLength(15);
    const off = loadVoices({ ...cfg, edict_module: { ...cfg.edict_module, enabled: false } });
    expect(byName(off).get("REVERENCE")!.active).toBe(false);
    expect(activeAdvisors(off)).toHaveLength(14);
  });

  it("carries pairings and relevance from the roster", () => {
    const m = byName(vs);
    expect(m.get("OMEGA")!.pairs).toEqual(["LOGOS", "MUSE", "AXIOM"]);
    expect(m.get("LOGOS")!.pairs).toEqual(["OMEGA", "ENTANGLE"]);
    expect(m.get("KINDRED")!.relevance.emotion).toBe(0.9);
  });

  it("guildsOf reports dual-homed membership", () => {
    expect(guildsOf("SENTIA", cfg.guilds)).toEqual(["perception", "social"]);
    expect(guildsOf("LUMEN", cfg.guilds)).toEqual(["integration"]);
    expect(guildsOf("SYMBIONT_PRIME", cfg.guilds)).toEqual([]);
  });
});
