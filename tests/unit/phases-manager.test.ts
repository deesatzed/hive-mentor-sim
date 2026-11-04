import { describe, expect, it } from "vitest";
import { resolveProviderConfig } from "@/lib/council/providers";
import { mentorFirstPerson } from "@/lib/hive/mentorVoice";
import { allowedNext, defaultNext, type PhaseId } from "@/lib/hive/phases";

const ran = (...ids: PhaseId[]) => new Set<PhaseId>(ids);

describe("phase dependencies", () => {
  it("allowedNext follows the dependency table", () => {
    expect(allowedNext(ran())).toEqual(["P1"]);
    expect(allowedNext(ran("P1"))).toEqual(["P2"]);
    expect(allowedNext(ran("P1", "P2", "P3"))).toEqual(["P4", "P5"]);
    expect(allowedNext(ran("P1", "P2", "P3", "P5"))).toEqual(["P6"]); // P4 cannot run after P5
    expect(allowedNext(ran("P1", "P2", "P3", "P4", "P5", "P6"))).toEqual(["P7", "FINISH"]);
    expect(allowedNext(ran("P1", "P2", "P3", "P4", "P5", "P6", "P7"))).toEqual(["FINISH"]);
  });

  it("defaultNext is the full P1→P7 order", () => {
    const seen = new Set<PhaseId>();
    const order: string[] = [];
    for (;;) {
      const n = defaultNext(seen);
      order.push(n);
      if (n === "FINISH") break;
      seen.add(n);
    }
    expect(order).toEqual(["P1", "P2", "P3", "P4", "P5", "P6", "P7", "FINISH"]);
  });
});

describe("model overrides from config/hive.yaml (owner's one-place switch)", () => {
  // test labels, not real model IDs
  const ENV = { OPENROUTER_API_KEY: "k", OPENROUTER_DEC_MODEL_1: "dec/one", OPENROUTER_REVIEWER_MODEL: "env/reviewer", TIER_FAST_MODEL: "env/fast" };

  it("empty overrides: manager and grader use the reviewer model; tiers use env", () => {
    const c = resolveProviderConfig(ENV, { manager: "", fast: "", standard: "", premium: "", grader: "" });
    if (c.mode !== "cloud") throw new Error("cloud expected");
    expect(c.manager).toEqual({ model: "env/reviewer", source: "OPENROUTER_REVIEWER_MODEL" });
    expect(c.grader.model).toBe("env/reviewer");
    expect(c.tiers.fast).toEqual({ model: "env/fast", source: "TIER_FAST_MODEL" });
    expect(c.tiers.premium.model).toBe("env/reviewer");
  });

  it("config values override env for the manager, each tier, and the grader", () => {
    const c = resolveProviderConfig(ENV, { manager: "cfg/manager", fast: "cfg/fast", grader: "cfg/grader" });
    if (c.mode !== "cloud") throw new Error("cloud expected");
    expect(c.manager).toEqual({ model: "cfg/manager", source: "config/hive.yaml models.manager" });
    expect(c.tiers.fast).toEqual({ model: "cfg/fast", source: "config/hive.yaml models.fast" });
    expect(c.grader.model).toBe("cfg/grader");
    expect(c.tiers.standard.model).toBe("env/reviewer");
  });
});

describe("no mentor first person (TEST_PLAN #2)", () => {
  const names = ["Marcus Aurelius", "Epictetus"];
  it("flags impersonation outside quotes and allows description and the Hive's own I", () => {
    expect(mentorFirstPerson("I, Marcus Aurelius, say be calm.", names)).toBe("Marcus Aurelius");
    expect(mentorFirstPerson("As Epictetus, I tell you this.", names)).toBe("Epictetus");
    expect(mentorFirstPerson("I am Epictetus.", names)).toBe("Epictetus");
    expect(mentorFirstPerson("In the Meditations, Marcus Aurelius wrote about calm.", names)).toBeNull();
    expect(mentorFirstPerson('I notice Epictetus wrote: "I am Epictetus, a slave."', names)).toBeNull();
    expect(mentorFirstPerson("I think this matters.", names)).toBeNull();
  });
});
