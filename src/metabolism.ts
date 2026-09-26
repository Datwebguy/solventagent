import type { PriceCeiling } from "./usepod/client.js";

export type TierName = "thriving" | "steady" | "frugal" | "dormant";

export interface Tier {
  name: TierName;
  /** Minimum days of prepaid thinking needed to use this tier. */
  minRunwayDays: number;
  model: string;
  maxTokens: number;
  ceiling: PriceCeiling;
}

/**
 * Default tiers, richest first. Price ceilings are USDC microunits per million tokens,
 * so 1_000_000 = $1.00/M. Models must exist in the UsePod catalog.
 */
export const DEFAULT_TIERS: Tier[] = [
  { name: "thriving", minRunwayDays: 14, model: "claude-sonnet-4-5", maxTokens: 1024, ceiling: { maxInputMicros: 3_000_000, maxOutputMicros: 15_000_000 } },
  { name: "steady", minRunwayDays: 3, model: "gpt-4o-mini", maxTokens: 768, ceiling: { maxInputMicros: 150_000, maxOutputMicros: 600_000 } },
  { name: "frugal", minRunwayDays: 0.5, model: "llama-3.1-8b-instant", maxTokens: 384, ceiling: { maxInputMicros: 60_000, maxOutputMicros: 100_000 } },
  { name: "dormant", minRunwayDays: 0, model: "", maxTokens: 0, ceiling: {} },
];

/** Days of thinking the reserve covers at the current burn rate. Infinite when nothing is being spent. */
export function runwayDays(reserveUsd: number, burnUsdPerDay: number): number {
  if (reserveUsd <= 0) return 0;
  if (burnUsdPerDay <= 0) return Number.POSITIVE_INFINITY;
  return reserveUsd / burnUsdPerDay;
}

export function pickTier(runway: number, tiers: Tier[] = DEFAULT_TIERS): Tier {
  const sorted = [...tiers].sort((a, b) => b.minRunwayDays - a.minRunwayDays);
  const tier = sorted.find((t) => runway >= t.minRunwayDays) ?? sorted[sorted.length - 1];
  if (!tier) throw new Error("no metabolism tiers configured");
  return tier;
}

export type Status = "SOLVENT" | "AT RISK" | "INSOLVENT";

export function solvencyStatus(runway: number): Status {
  if (runway >= 3) return "SOLVENT";
  if (runway > 0) return "AT RISK";
  return "INSOLVENT";
}
