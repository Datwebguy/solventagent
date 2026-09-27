import { PublicKey } from "@solana/web3.js";
import { classifyAiPayment } from "./aispend.js";
import { MINTS } from "./config.js";
import { classifyInflow } from "./income.js";
import { DEFAULT_TIERS } from "./metabolism.js";
import { usdPrices } from "./prices.js";
import { getParsedTx, readConnection, solBalance, tokenBalance, withRetry } from "./solana.js";

/** Plain-language standing of an agent, from public records only. */
export type AgentStatus = "SOLVENT" | "AT RISK" | "NO AI COSTS SEEN" | "NO ACTIVITY";

export interface AuditEvent {
  kind: "earned" | "ai_topup" | "ai_per_answer";
  usd: number;
  ts: string | null;
  signature: string;
}

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
  /** Money this wallet sent to UsePod for AI (top-ups of its AI budget, or pay-per-answer). */
  aiSpend: {
    payments: number;
    usd: number;
    last7dUsd: number;
    avgPerDayUsd: number;
  };
  /** Earned minus spent on AI over the last 7 days. */
  profit7dUsd: number;
  /** How many times over its token earnings cover its AI costs (last 7 days); null when nothing was spent. */
  coverage: number | null;
  status: AgentStatus;
  balances: { sol: number; usdc: number; ansem: number; usd: number };
  /** How many ~1K-token thoughts per day the fee income could fund at each tier's model. */
  thoughtsPerDay: Record<string, number>;
  /** Most recent earnings and AI payments, newest first, each with its transaction. */
  events: AuditEvent[];
}

/** Rough cost of a ~1K-token thought per tier, from UsePod quotes on 2026-09-26. */
const THOUGHT_COST_USD: Record<string, number> = { thriving: 0.0165, steady: 0.0055, frugal: 0.0003 };

export function agentStatus(earned7d: number, spent7d: number, everEarned: boolean, everSpent: boolean): AgentStatus {
  if (!everEarned && !everSpent) return "NO ACTIVITY";
  if (!everSpent) return "NO AI COSTS SEEN";
  return earned7d >= spent7d ? "SOLVENT" : "AT RISK";
}

/** Average per day over the last 7 days, measured from the first event inside that window. */
function perDay(items: { usd: number; t: number }[], now: number): number {
  const weekAgo = now / 1000 - 7 * 86_400;
  const recent = items.filter((x) => x.t >= weekAgo);
  if (!recent.length) return 0;
  const span = Math.max(1, (now / 1000 - Math.min(...recent.map((x) => x.t))) / 86_400);
  return recent.reduce((s, x) => s + x.usd, 0) / Math.min(7, span);
}

/**
 * Public audit of any agent wallet, from public records only: token earnings (ClawPump fee
 * payouts), money sent to UsePod for AI, profit, holdings, and what the income can pay for.
 */
export async function auditWallet(address: string, maxTransactions = 150, now = Date.now()): Promise<Audit> {
  const owner = new PublicKey(address);
  const [sigsRaw, prices] = await Promise.all([
    withRetry(() => readConnection().getSignaturesForAddress(owner, { limit: maxTransactions })),
    usdPrices([MINTS.SOL, MINTS.ANSEM]),
  ]);
  const sigs = sigsRaw.filter((s) => !s.err);
  const solUsd = prices[MINTS.SOL] ?? 0;
  const ansemUsd = prices[MINTS.ANSEM] ?? 0;

  const earned: { usd: number; t: number; sig: string; lamports: number }[] = [];
  const spent: { usd: number; t: number; sig: string; kind: "topup" | "per_answer" }[] = [];
  // Free RPCs reject batched getTransaction calls, so fetch individually, 3 at a time.
  for (let i = 0; i < sigs.length; i += 3) {
    const batch = sigs.slice(i, i + 3);
    const txs = await Promise.all(batch.map((s) => getParsedTx(s.signature)));
    txs.forEach((tx, j) => {
      if (!tx) return;
      const sig = batch[j]!.signature;
      const t = tx.blockTime ?? batch[j]!.blockTime ?? 0;
      const inflow = classifyInflow(tx, sig, address, new Set());
      if (inflow?.source === "clawpump_fees") earned.push({ usd: (inflow.lamports / 1e9) * solUsd, t, sig, lamports: inflow.lamports });
      const ai = classifyAiPayment(tx, address, solUsd);
      if (ai) spent.push({ usd: ai.usd, t, sig, kind: ai.kind });
    });
  }

  const weekAgo = now / 1000 - 7 * 86_400;
  const sum = (xs: { usd: number }[]) => xs.reduce((s, x) => s + x.usd, 0);
  const earned7d = sum(earned.filter((x) => x.t >= weekAgo));
  const spent7d = sum(spent.filter((x) => x.t >= weekAgo));
  const earnPerDay = perDay(earned, now);
  const times = sigs.map((s) => s.blockTime ?? 0).filter(Boolean);
  const [walletSol, usdc, ansem] = await Promise.all([solBalance(owner), tokenBalance(owner, MINTS.USDC), tokenBalance(owner, MINTS.ANSEM)]);
  const iso = (t: number) => (t ? new Date(t * 1000).toISOString() : null);

  return {
    address,
    scanned: { transactions: sigs.length, from: times.length ? iso(Math.min(...times)) : null, to: times.length ? iso(Math.max(...times)) : null },
    feeIncome: {
      payouts: earned.length,
      sol: earned.reduce((s, x) => s + x.lamports, 0) / 1e9,
      usd: sum(earned),
      last7dUsd: earned7d,
      avgPerDayUsd: earnPerDay,
    },
    aiSpend: { payments: spent.length, usd: sum(spent), last7dUsd: spent7d, avgPerDayUsd: perDay(spent, now) },
    profit7dUsd: earned7d - spent7d,
    coverage: spent7d > 0 ? earned7d / spent7d : null,
    status: agentStatus(earned7d, spent7d, earned.length > 0, spent.length > 0),
    balances: { sol: walletSol, usdc, ansem, usd: walletSol * solUsd + usdc + ansem * ansemUsd },
    thoughtsPerDay: Object.fromEntries(
      DEFAULT_TIERS.filter((t) => THOUGHT_COST_USD[t.name]).map((t) => [t.name, Math.floor(earnPerDay / THOUGHT_COST_USD[t.name]!)]),
    ),
    events: [
      ...earned.map((x) => ({ kind: "earned" as const, usd: x.usd, ts: iso(x.t), signature: x.sig })),
      ...spent.map((x) => ({ kind: x.kind === "topup" ? ("ai_topup" as const) : ("ai_per_answer" as const), usd: x.usd, ts: iso(x.t), signature: x.sig })),
    ]
      .sort((a, b) => Date.parse(b.ts ?? "0") - Date.parse(a.ts ?? "0"))
      .slice(0, 40),
  };
}
