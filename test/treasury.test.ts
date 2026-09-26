import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { CLAWPUMP_BUYBACK_WALLET, classifyInflow } from "../src/income.js";
import type { Policy } from "../src/policy.js";
import { EMPTY_PENDING, planCycle, type PlanInput } from "../src/treasurer.js";

const policy: Policy = {
  version: 1,
  agent: { name: "Solvent", wallet: "T1" },
  allocations: { computeReserve: 0.5, ansemReserve: 0.2, operatingCash: 0.2, buyback: 0.1 },
  computeReserveTargetDays: 14,
  caps: { maxTxUsd: 5, maxDayUsd: 10 },
};

const base: PlanInput = {
  incomeUsd: 0,
  reserveUsd: 0,
  burnUsdPerDay: 0,
  policy,
  pending: EMPTY_PENDING,
  deployableUsd: 100,
  minActionUsd: 0.5,
  reserveFloorUsd: 1,
  buybackEnabled: true,
};

describe("planCycle", () => {
  it("does nothing without income or pending balances", () => {
    expect(planCycle(base).actions).toEqual([]);
  });

  it("fills the compute reserve first, then $ANSEM, then buybacks", () => {
    const p = planCycle({ ...base, incomeUsd: 10, burnUsdPerDay: 1 }); // target $14, all of the 50% needed
    expect(p.targetReserveUsd).toBe(14);
    expect(p.actions).toEqual([
      { kind: "compute_topup", usd: 5 },
      { kind: "ansem_buy", usd: 2 },
      { kind: "buyback", usd: 1 },
    ]);
  });

  it("sends compute surplus to the other buckets once the reserve is at target", () => {
    const p = planCycle({ ...base, incomeUsd: 10, burnUsdPerDay: 1, reserveUsd: 14 });
    expect(p.actions.find((a) => a.kind === "compute_topup")).toBeUndefined();
    expect(p.actions.find((a) => a.kind === "ansem_buy")!.usd).toBeCloseTo(4);
  });

  it("holds dust below the minimum action size for later cycles", () => {
    const p = planCycle({ ...base, incomeUsd: 0.6, burnUsdPerDay: 1 });
    expect(p.actions).toEqual([]);
    expect(p.pendingAfter.computeReserve).toBeCloseTo(0.3);
    const next = planCycle({ ...base, incomeUsd: 0.6, burnUsdPerDay: 1, pending: p.pendingAfter });
    expect(next.actions.map((a) => a.kind)).toEqual(["compute_topup"]);
    expect(next.actions[0]!.usd).toBeCloseTo(0.6);
  });

  it("never deploys more than the wallet can spare or the per-transaction cap", () => {
    const p = planCycle({ ...base, incomeUsd: 40, burnUsdPerDay: 5, deployableUsd: 6 });
    expect(p.actions).toEqual([
      { kind: "compute_topup", usd: 5 }, // capped at maxTxUsd
      { kind: "ansem_buy", usd: 1 }, // only $1 of wallet budget left
    ]);
    expect(p.pendingAfter.computeReserve).toBeCloseTo(15);
  });

  it("keeps the buyback bucket pending until the project token exists", () => {
    const p = planCycle({ ...base, incomeUsd: 10, burnUsdPerDay: 1, buybackEnabled: false });
    expect(p.actions.map((a) => a.kind)).toEqual(["compute_topup", "ansem_buy"]);
    expect(p.pendingAfter.buyback).toBeCloseTo(1);
  });
});

/** Minimal parsed transaction with top-level system transfers. */
function tx(transfers: [string, string, number][]): ParsedTransactionWithMeta {
  return {
    blockTime: 1_790_000_000,
    meta: { innerInstructions: [] },
    transaction: {
      message: {
        instructions: transfers.map(([source, destination, lamports]) => ({
          program: "system",
          programId: {},
          parsed: { type: "transfer", info: { source, destination, lamports } },
        })),
      },
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe("classifyInflow", () => {
  const T = "Treasury1111";

  it("recognises a ClawPump creator-fee payout by its buyback leg", () => {
    // Shape of a real payout: ~75% to the agent, 12.5% to ClawPump's buyback wallet, 12.5% elsewhere.
    const payout = tx([
      ["AgentW", "Fo6sb", 20_806],
      ["AgentW", T, 102_780_760],
      ["AgentW", "CeFF6", 17_133_594],
      ["AgentW", CLAWPUMP_BUYBACK_WALLET, 17_133_594],
    ]);
    expect(classifyInflow(payout, "sig1", T, new Set())).toMatchObject({ lamports: 102_780_760, source: "clawpump_fees" });
  });

  it("treats a plain transfer as a deposit, not income", () => {
    expect(classifyInflow(tx([["Owner", T, 50_000_000]]), "sig2", T, new Set())).toMatchObject({ source: "deposit" });
  });

  it("counts configured income sources as income", () => {
    expect(classifyInflow(tx([["Customer", T, 1_000]]), "sig3", T, new Set(["Customer"]))).toMatchObject({ source: "income_source" });
  });

  it("ignores transactions where nothing arrives at the treasury", () => {
    expect(classifyInflow(tx([[T, "Someone", 1_000]]), "sig4", T, new Set())).toBeUndefined();
  });
});
