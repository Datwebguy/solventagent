import type { ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import { connection, getParsedTx, withRetry } from "./solana.js";

/**
 * ClawPump's buyback wallet. Most creator-fee payouts send it 12.5% alongside the ~75% agent
 * share (seen on SelfMade, Ansem.tips, BEARPROOF and Steve, 2026-09-26).
 */
export const CLAWPUMP_BUYBACK_WALLET = "CgzAtK78rvrgi6BHa6LETqRd5iQzDtdUdtupERPNdwn3";

/**
 * ClawPump's platform fee wallet. It receives a leg of every creator-fee payout, including the
 * direct pump.fun-share payouts that have no buyback leg (verified on PUMP.RPG, 2026-09-26).
 */
export const CLAWPUMP_PLATFORM_WALLET = "CeFF6QCFiu3dnK4zDK8sTErxGG8at8mSoVKUx9D4bGtM";

/** True when a set of transfers has the shape of a ClawPump creator-fee payout. */
export const isClawPumpPayout = (destinations: string[]) =>
  destinations.some((d) => d === CLAWPUMP_PLATFORM_WALLET || d === CLAWPUMP_BUYBACK_WALLET);

export interface Inflow {
  signature: string;
  blockTime: number | null;
  lamports: number;
  source: "clawpump_fees" | "income_source" | "deposit";
}

interface SystemTransfer {
  source: string;
  destination: string;
  lamports: number;
}

function systemTransfers(tx: ParsedTransactionWithMeta): SystemTransfer[] {
  const out: SystemTransfer[] = [];
  const all = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions),
  ];
  for (const ix of all) {
    if ("parsed" in ix && ix.program === "system" && ix.parsed?.type === "transfer") {
      const info = ix.parsed.info as { source: string; destination: string; lamports: number };
      out.push({ source: info.source, destination: info.destination, lamports: Number(info.lamports) });
    }
  }
  return out;
}

/** Classifies SOL arriving at `treasury` in one transaction; undefined if nothing arrived. */
export function classifyInflow(tx: ParsedTransactionWithMeta, signature: string, treasury: string, incomeSources: Set<string>): Inflow | undefined {
  const transfers = systemTransfers(tx);
  const received = transfers.filter((t) => t.destination === treasury && t.source !== treasury);
  const lamports = received.reduce((s, t) => s + t.lamports, 0);
  if (lamports <= 0) return undefined;
  const source = isClawPumpPayout(transfers.map((t) => t.destination))
    ? "clawpump_fees"
    : received.some((t) => incomeSources.has(t.source))
      ? "income_source"
      : "deposit";
  return { signature, blockTime: tx.blockTime ?? null, lamports, source };
}

/**
 * SOL inflows to the treasury after `untilSignature` (exclusive), oldest first, plus the
 * newest signature seen, which is the only safe cursor for the next call.
 */
export async function fetchInflows(
  treasury: PublicKey,
  incomeSources: Set<string>,
  untilSignature?: string,
): Promise<{ inflows: Inflow[]; newest: string | undefined }> {
  const sigs = await collectSignaturesSince(
    (before) => withRetry(() => connection().getSignaturesForAddress(treasury, { until: untilSignature, before, limit: 1000 })),
  );
  const newest = sigs[0]?.signature ?? untilSignature;
  const inflows: Inflow[] = [];
  for (const s of sigs.filter((x) => !x.err).reverse()) {
    const tx = await getParsedTx(s.signature, connection());
    if (!tx) continue;
    const inflow = classifyInflow(tx, s.signature, treasury.toBase58(), incomeSources);
    if (inflow) inflows.push(inflow);
  }
  return { inflows, newest };
}

/**
 * Every signature newer than the cursor, newest first. RPCs return at most one page per call,
 * so keep paging backwards with `before` until a short page says the cursor was reached.
 */
export async function collectSignaturesSince<T extends { signature: string }>(
  page: (before: string | undefined) => Promise<T[]>,
  pageSize = 1000,
  maxPages = 20,
): Promise<T[]> {
  const all: T[] = [];
  let before: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const batch = await page(before);
    all.push(...batch);
    if (batch.length < pageSize) return all;
    before = batch[batch.length - 1]!.signature;
  }
  throw new Error(`more than ${pageSize * maxPages} new transactions since the last cycle; run cycles more often`);
}

/** Newest signature touching the treasury, used as the cursor for the next cycle. */
export async function latestSignature(treasury: PublicKey): Promise<string | undefined> {
  const [s] = await withRetry(() => connection().getSignaturesForAddress(treasury, { limit: 1 }));
  return s?.signature;
}
