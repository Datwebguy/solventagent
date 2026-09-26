import type { PriceCeiling } from "./usepod/client.js";

export type TierName = "thriving" | "steady" | "frugal" | "dormant";

export interface Tier {
  name: TierName;
  /** Minimum days of prepaid thinking needed to use this tier. */
  minRunwayDays: number;
  /** Preferred model first; the rest are tried when UsePod has no healthy provider. */
  models: string[];
  maxTokens: number;
  ceiling: PriceCeiling;
}

/**
 * Default tiers, richest first. Price ceilings are USDC microunits per million tokens,
 * so 1_000_000 = $1.00/M. Models verified against the UsePod catalog on 2026-09-26.
 */
export const DEFAULT_TIERS: Tier[] = [
  { name: "thriving", minRunwayDays: 14, models: ["claude-sonnet-4-5", "claude-sonnet-4-6"], maxTokens: 4096, ceiling: { maxInputMicros: 3_000_000, maxOutputMicros: 15_000_000 } },
  { name: "steady", minRunwayDays: 3, models: ["claude-haiku-4-5", "gpt-5-mini"], maxTokens: 2048, ceiling: { maxInputMicros: 1_000_000, maxOutputMicros: 5_000_000 } },
  { name: "frugal", minRunwayDays: 0.02, models: ["deepseek-v4-1-flash", "qwen3-32b", "gpt-4o-mini"], maxTokens: 1024, ceiling: { maxInputMicros: 300_000, maxOutputMicros: 700_000 } },
  { name: "dormant", minRunwayDays: 0, models: [], maxTokens: 0, ceiling: {} },
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
