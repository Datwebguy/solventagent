import { burnUsdPerDay, verifyChain, type Entry } from "./ledger.js";
import { pickTier, runwayDays, solvencyStatus, type Tier, DEFAULT_TIERS } from "./metabolism.js";

export interface Books {
  reserveUsd: number;
  burnUsdPerDay: number;
  runwayDays: number | null; // null = unlimited (nothing being spent)
  status: ReturnType<typeof solvencyStatus>;
  tier: Tier["name"];
  incomeUsd: number;
  spentOnThinkingUsd: number;
  thoughts: number;
  ledgerEntries: number;
  ledgerHead: string | null;
  ledgerIntact: boolean;
}

/** The agent's books, derived from the ledger plus the live reserve balance. */
export function books(entries: Entry[], reserveUsd: number, tiers: Tier[] = DEFAULT_TIERS, now = new Date()): Books {
  const burn = burnUsdPerDay(entries, now);
  const runway = runwayDays(reserveUsd, burn);
  const thoughts = entries.filter((e) => e.kind === "thought");
  return {
    reserveUsd,
    burnUsdPerDay: burn,
    runwayDays: Number.isFinite(runway) ? runway : null,
    status: solvencyStatus(runway),
    tier: pickTier(runway, tiers).name,
    incomeUsd: entries.filter((e) => e.kind === "income").reduce((s, e) => s + e.usd, 0),
    spentOnThinkingUsd: thoughts.reduce((s, e) => s - e.usd, 0),
    thoughts: thoughts.length,
    ledgerEntries: entries.length,
    ledgerHead: entries[entries.length - 1]?.hash ?? null,
    ledgerIntact: verifyChain(entries) === -1,
  };
}
