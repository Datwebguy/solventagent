import { PublicKey } from "@solana/web3.js";
import { MINTS } from "./config.js";
import { classifyInflow } from "./income.js";
import { DEFAULT_TIERS } from "./metabolism.js";
import { usdPrices } from "./prices.js";
import { getParsedTx, readConnection, solBalance, tokenBalance, withRetry } from "./solana.js";

export interface Audit {
  address: string;
  scanned: { transactions: number; from: string | null; to: string | null };
  feeIncome: {
    payouts: number;
    sol: number;
    usd: number;
    last7dUsd: number;
    avgPerDayUsd: number;
  };
  balances: { sol: number; usdc: number; ansem: number; usd: number };
  /** How many ~1K-token thoughts per day the fee income could fund at each tier's model. */
  thoughtsPerDay: Record<string, number>;
}

/** Rough cost of a ~1K-token thought per tier, from UsePod quotes on 2026-09-26. */
const THOUGHT_COST_USD: Record<string, number> = { thriving: 0.0165, steady: 0.0055, frugal: 0.0003 };

/**
 * Public audit of any agent wallet: ClawPump creator-fee income found on-chain, current
 * holdings, and what that income can pay for in thinking. Read-only.
 */
export async function auditWallet(address: string, maxTransactions = 150, now = Date.now()): Promise<Audit> {
  const owner = new PublicKey(address);
  const sigs = (await withRetry(() => readConnection().getSignaturesForAddress(owner, { limit: maxTransactions }))).filter((s) => !s.err);
  const payouts: { lamports: number; blockTime: number }[] = [];
  // Free RPCs reject batched getTransaction calls, so fetch individually, 3 at a time.
  for (let i = 0; i < sigs.length; i += 3) {
    const batch = sigs.slice(i, i + 3);
    const txs = await Promise.all(
      batch.map((s) => getParsedTx(s.signature)),
    );
    txs.forEach((tx, j) => {
      if (!tx) return;
      const inflow = classifyInflow(tx, batch[j]!.signature, address, new Set());
      if (inflow?.source === "clawpump_fees") payouts.push({ lamports: inflow.lamports, blockTime: inflow.blockTime ?? 0 });
    });
  }

  const prices = await usdPrices([MINTS.SOL, MINTS.ANSEM]);
  const solUsd = prices[MINTS.SOL] ?? 0;
  const ansemUsd = prices[MINTS.ANSEM] ?? 0;
  const sol = payouts.reduce((s, p) => s + p.lamports, 0) / 1e9;
  const weekAgo = now / 1000 - 7 * 86_400;
  const last7dSol = payouts.filter((p) => p.blockTime >= weekAgo).reduce((s, p) => s + p.lamports, 0) / 1e9;
  const times = sigs.map((s) => s.blockTime ?? 0).filter(Boolean);
  const spanDays = times.length > 1 ? Math.max(1, (Math.max(...times) - Math.min(...times)) / 86_400) : 1;

  const [walletSol, usdc, ansem] = await Promise.all([
    solBalance(owner),
    tokenBalance(owner, MINTS.USDC),
    tokenBalance(owner, MINTS.ANSEM),
  ]);
  const avgPerDayUsd = (sol * solUsd) / spanDays;

  return {
    address,
    scanned: {
      transactions: sigs.length,
      from: times.length ? new Date(Math.min(...times) * 1000).toISOString() : null,
      to: times.length ? new Date(Math.max(...times) * 1000).toISOString() : null,
    },
    feeIncome: { payouts: payouts.length, sol, usd: sol * solUsd, last7dUsd: last7dSol * solUsd, avgPerDayUsd },
    balances: { sol: walletSol, usdc, ansem, usd: walletSol * solUsd + usdc + ansem * ansemUsd },
    thoughtsPerDay: Object.fromEntries(
      DEFAULT_TIERS.filter((t) => THOUGHT_COST_USD[t.name]).map((t) => [t.name, Math.floor(avgPerDayUsd / THOUGHT_COST_USD[t.name]!)]),
    ),
  };
}
