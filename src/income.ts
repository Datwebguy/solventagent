import type { ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import { connection, withRetry } from "./solana.js";

/**
 * ClawPump's buyback wallet. Every creator-fee payout transaction sends it 12.5% alongside
 * the ~75% agent share, which makes it a reliable fingerprint for fee income.
 * (Verified on payouts to SelfMade, Ansem.tips, BEARPROOF and Steve, 2026-09-26.)
 */
export const CLAWPUMP_BUYBACK_WALLET = "CgzAtK78rvrgi6BHa6LETqRd5iQzDtdUdtupERPNdwn3";

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
  const source = transfers.some((t) => t.destination === CLAWPUMP_BUYBACK_WALLET)
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
  const sigs = await withRetry(() => connection().getSignaturesForAddress(treasury, { until: untilSignature, limit: 200 }));
  const newest = sigs[0]?.signature ?? untilSignature;
  const inflows: Inflow[] = [];
  for (const s of sigs.filter((x) => !x.err).reverse()) {
    const tx = await withRetry(() =>
      connection().getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }),
    );
    if (!tx) continue;
    const inflow = classifyInflow(tx, s.signature, treasury.toBase58(), incomeSources);
    if (inflow) inflows.push(inflow);
  }
  return { inflows, newest };
}

/** Newest signature touching the treasury, used as the cursor for the next cycle. */
export async function latestSignature(treasury: PublicKey): Promise<string | undefined> {
  const [s] = await withRetry(() => connection().getSignaturesForAddress(treasury, { limit: 1 }));
  return s?.signature;
}
