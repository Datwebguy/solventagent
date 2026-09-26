import { auditWallet, type Audit } from "./audit.js";
import { CLAWPUMP_BUYBACK_WALLET, CLAWPUMP_PLATFORM_WALLET, isClawPumpPayout } from "./income.js";
import { readConnection, withRetry } from "./solana.js";

/** Read-through for public ClawPump pages (they render client-side, so fetch via a reader). */
const reader = (url: string) => `https://r.jina.ai/${url}`;

export interface IndexEntry {
  rank: number;
  name: string;
  ticker: string;
  mint: string;
  clawpumpFeesSol: number;
  payoutWallet: string | null;
  audit: Pick<Audit, "feeIncome" | "thoughtsPerDay" | "scanned"> | null;
  error?: string;
}

export interface SolvencyIndex {
  generatedAt: string;
  source: string;
  entries: IndexEntry[];
}

/** Clawrena leaderboard rows from clawpump.tech/analytics: rank, name, ticker, mint, fees earned (SOL). */
export async function fetchLeaderboard(): Promise<Omit<IndexEntry, "payoutWallet" | "audit">[]> {
  const md = await (await fetch(reader("https://clawpump.tech/analytics"), { headers: { "X-Return-Format": "markdown" } })).text();
  const rows: Omit<IndexEntry, "payoutWallet" | "audit">[] = [];
  const re = /^\| #(\d+) \| \[([^\]]+)\]\(https:\/\/clawpump\.tech\/tokens\/([A-Za-z0-9]+)\)\$?([A-Z0-9]*) \| ([\d,.]+) SOL/gm;
  for (const m of md.matchAll(re)) {
    rows.push({ rank: Number(m[1]), name: m[2]!, mint: m[3]!, ticker: m[4] ?? "", clawpumpFeesSol: Number(m[5]!.replace(/,/g, "")) });
  }
  return rows;
}

/**
 * The agent's payout wallet: the ~75% leg of a ClawPump fee payout listed on the token page.
 * A payout is recognised by its leg to ClawPump's platform (or buyback) wallet.
 */
export async function findPayoutWallet(mint: string): Promise<string | null> {
  const md = await (await fetch(reader(`https://clawpump.tech/tokens/${mint}`), { headers: { "X-Return-Format": "markdown" } })).text();
  const sigs = [...md.matchAll(/solscan\.io\/tx\/([1-9A-HJ-NP-Za-km-z]{80,90})/g)].map((m) => m[1]!).slice(0, 8);
  for (const sig of sigs) {
    const tx = await withRetry(() => readConnection().getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }));
    if (!tx) continue;
    const transfers = tx.transaction.message.instructions.flatMap((ix) =>
      "parsed" in ix && ix.program === "system" && ix.parsed?.type === "transfer"
        ? [ix.parsed.info as { destination: string; lamports: number }]
        : [],
    );
    if (!isClawPumpPayout(transfers.map((t) => t.destination))) continue;
    const largest = transfers
      .filter((t) => t.destination !== CLAWPUMP_BUYBACK_WALLET && t.destination !== CLAWPUMP_PLATFORM_WALLET)
      .sort((a, b) => b.lamports - a.lamports)[0];
    if (largest) return largest.destination;
  }
  return null;
}

/** Builds the index for the top `limit` fee earners. Slow (reads the chain); run it from the runtime, not a web request. */
export async function buildSolvencyIndex(
  limit = 25,
  log: (s: string) => void = () => {},
  onProgress?: (partial: SolvencyIndex) => Promise<void>,
): Promise<SolvencyIndex> {
  const board = (await fetchLeaderboard()).filter((r) => r.clawpumpFeesSol > 0).slice(0, limit);
  const entries: IndexEntry[] = [];
  for (const row of board) {
    try {
      const payoutWallet = await findPayoutWallet(row.mint);
      const audit = payoutWallet ? await auditWallet(payoutWallet, 40) : null;
      entries.push({
        ...row,
        payoutWallet,
        audit: audit ? { feeIncome: audit.feeIncome, thoughtsPerDay: audit.thoughtsPerDay, scanned: audit.scanned } : null,
      });
      log(`#${row.rank} ${row.name}: ${payoutWallet ? `$${audit!.feeIncome.avgPerDayUsd.toFixed(2)}/day` : "no payout found"}`);
    } catch (err) {
      entries.push({ ...row, payoutWallet: null, audit: null, error: err instanceof Error ? err.message : String(err) });
      log(`#${row.rank} ${row.name}: failed (${err instanceof Error ? err.message : err})`);
    }
    if (onProgress) await onProgress(snapshot(entries)).catch((e) => log(`progress publish failed: ${e}`));
  }
  return snapshot(entries);
}

function snapshot(entries: IndexEntry[]): SolvencyIndex {
  const sorted = [...entries].sort((a, b) => (b.audit?.feeIncome.avgPerDayUsd ?? -1) - (a.audit?.feeIncome.avgPerDayUsd ?? -1));
  return { generatedAt: new Date().toISOString(), source: "clawpump.tech/analytics + Solana mainnet", entries: sorted };
}
