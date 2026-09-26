import { createHash } from "node:crypto";
import { z } from "zod";

/** How incoming revenue is split. Shares must sum to 1. */
export const Allocations = z
  .object({
    computeReserve: z.number().min(0).max(1),
    ansemReserve: z.number().min(0).max(1),
    operatingCash: z.number().min(0).max(1),
    buyback: z.number().min(0).max(1),
  })
  .refine((a) => Math.abs(a.computeReserve + a.ansemReserve + a.operatingCash + a.buyback - 1) < 1e-9, {
    message: "allocation shares must sum to 1",
  });

export const Policy = z.object({
  version: z.literal(1),
  agent: z.object({ name: z.string().min(1), wallet: z.string().min(32) }),
  allocations: Allocations,
  /** Keep this many days of thinking prepaid; surplus beyond it flows to the other buckets. */
  computeReserveTargetDays: z.number().positive(),
  caps: z.object({ maxTxUsd: z.number().positive(), maxDayUsd: z.number().positive() }),
});

export type Policy = z.infer<typeof Policy>;

/** Deterministic JSON: keys sorted at every level, so the same policy always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function policyHash(p: Policy): string {
  return sha256(canonicalJson(Policy.parse(p)));
}

/** Memo text committed on-chain so anyone can check the published policy was not changed. */
export const policyMemo = (p: Policy) => `solvent:policy:v1:${policyHash(p)}`;

export interface Split {
  computeReserve: number;
  ansemReserve: number;
  operatingCash: number;
  buyback: number;
}

/**
 * Splits `incomeUsd` by the policy. The compute reserve only takes what it needs to reach
 * its target; anything beyond that is redistributed pro rata to the other buckets.
 */
export function allocate(incomeUsd: number, p: Policy, computeShortfallUsd: number): Split {
  const a = p.allocations;
  const wantCompute = incomeUsd * a.computeReserve;
  const compute = Math.min(wantCompute, Math.max(0, computeShortfallUsd));
  const spill = wantCompute - compute;
  const rest = a.ansemReserve + a.operatingCash + a.buyback;
  const share = (x: number) => incomeUsd * x + (rest > 0 ? spill * (x / rest) : 0);
  return {
    computeReserve: compute,
    ansemReserve: share(a.ansemReserve),
    operatingCash: rest > 0 ? share(a.operatingCash) : spill + incomeUsd * a.operatingCash,
    buyback: share(a.buyback),
  };
}
