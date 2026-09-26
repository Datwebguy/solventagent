import { describe, expect, it } from "vitest";
import { checkSpend, SpendCapError } from "../src/guardrails.js";
import { chain, verifyChain, burnUsdPerDay, type Entry } from "../src/ledger.js";
import { pickTier, runwayDays, solvencyStatus } from "../src/metabolism.js";
import { allocate, canonicalJson, policyHash, type Policy } from "../src/policy.js";

const policy: Policy = {
  version: 1,
  agent: { name: "Solvent", wallet: "11111111111111111111111111111111" },
  allocations: { computeReserve: 0.5, ansemReserve: 0.2, operatingCash: 0.2, buyback: 0.1 },
  computeReserveTargetDays: 14,
  caps: { maxTxUsd: 5, maxDayUsd: 10 },
};

describe("guardrails", () => {
  const caps = { maxTxUsd: 5, maxDayUsd: 10 };
  const now = new Date("2026-09-26T12:00:00Z");

  it("allows spends under both caps and accumulates", () => {
    const a = checkSpend({ day: "2026-09-26", spentUsd: 4 }, 3, caps, now);
    expect(a.spentUsd).toBe(7);
  });

  it("rejects a single spend over the per-transaction cap", () => {
    expect(() => checkSpend({ day: "2026-09-26", spentUsd: 0 }, 5.01, caps, now)).toThrow(SpendCapError);
  });

  it("rejects a spend that would cross the daily cap", () => {
    expect(() => checkSpend({ day: "2026-09-26", spentUsd: 8 }, 3, caps, now)).toThrow(SpendCapError);
  });

  it("resets the daily total on a new UTC day", () => {
    expect(checkSpend({ day: "2026-09-25", spentUsd: 9.9 }, 3, caps, now)).toEqual({ day: "2026-09-26", spentUsd: 3 });
  });

  it("rejects negative or non-finite amounts", () => {
    expect(() => checkSpend({ day: "2026-09-26", spentUsd: 0 }, -1, caps, now)).toThrow(SpendCapError);
    expect(() => checkSpend({ day: "2026-09-26", spentUsd: 0 }, Number.NaN, caps, now)).toThrow(SpendCapError);
  });
});

describe("policy", () => {
  it("hashes independently of key order", () => {
    const reordered = JSON.parse(canonicalJson(policy)) as Policy;
    expect(policyHash(reordered)).toBe(policyHash(policy));
    expect(policyHash({ ...policy, computeReserveTargetDays: 7 })).not.toBe(policyHash(policy));
  });

  it("rejects allocations that do not sum to 1", () => {
    expect(() => policyHash({ ...policy, allocations: { ...policy.allocations, buyback: 0.2 } })).toThrow();
  });

  it("splits income by policy when the compute reserve needs it all", () => {
    const s = allocate(100, policy, 1000);
    expect(s).toEqual({ computeReserve: 50, ansemReserve: 20, operatingCash: 20, buyback: 10 });
  });

  it("spills compute surplus pro rata once the reserve is full", () => {
    const s = allocate(100, policy, 10); // only $10 needed, $40 spills over 0.5 of remaining shares
    expect(s.computeReserve).toBe(10);
    expect(s.ansemReserve).toBeCloseTo(36);
    expect(s.operatingCash).toBeCloseTo(36);
    expect(s.buyback).toBeCloseTo(18);
    expect(s.computeReserve + s.ansemReserve + s.operatingCash + s.buyback).toBeCloseTo(100);
  });
});

describe("metabolism", () => {
  it("computes runway and handles zero burn", () => {
    expect(runwayDays(10, 2)).toBe(5);
    expect(runwayDays(0, 2)).toBe(0);
    expect(runwayDays(10, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("downgrades the model as runway shrinks", () => {
    expect(pickTier(30).name).toBe("thriving");
    expect(pickTier(5).name).toBe("steady");
    expect(pickTier(1).name).toBe("frugal");
    expect(pickTier(0.1).name).toBe("dormant");
    expect(pickTier(Number.POSITIVE_INFINITY).name).toBe("thriving");
  });

  it("labels solvency", () => {
    expect(solvencyStatus(10)).toBe("SOLVENT");
    expect(solvencyStatus(1)).toBe("AT RISK");
    expect(solvencyStatus(0)).toBe("INSOLVENT");
  });
});

describe("ledger", () => {
  const t = (h: number) => new Date(Date.UTC(2026, 8, 26, h));

  it("builds a verifiable hash chain and detects tampering", () => {
    const entries: Entry[] = [];
    for (const [i, usd] of [5, -0.01, -0.02].entries()) {
      entries.push(chain(entries[entries.length - 1], { kind: i === 0 ? "income" : "thought", usd }, t(i)));
    }
    expect(verifyChain(entries)).toBe(-1);
    const tampered = entries.map((e) => ({ ...e }));
    tampered[1]!.usd = -0.001;
    expect(verifyChain(tampered)).toBe(1);
  });

  it("measures burn from thoughts in the trailing window only", () => {
    const e0 = chain(undefined, { kind: "thought", usd: -1 }, t(0));
    const e1 = chain(e0, { kind: "thought", usd: -0.5 }, t(20));
    const e2 = chain(e1, { kind: "income", usd: 50 }, t(21));
    expect(burnUsdPerDay([e0, e1, e2], new Date(Date.UTC(2026, 8, 27, 1)))).toBeCloseTo(0.5);
  });
});
