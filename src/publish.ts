import { del, list, put } from "@vercel/blob";
import { books, type Books } from "./books.js";
import { env, MINTS } from "./config.js";
import { loadPolicy } from "./cycle.js";
import type { FileLedger } from "./ledger.js";
import { DEFAULT_TIERS } from "./metabolism.js";
import { policyHash, type Policy } from "./policy.js";
import { usdPrices } from "./prices.js";
import { walletBalances, tokenBalance } from "./solana.js";
import { PublicKey } from "@solana/web3.js";

export const PUBLIC_PREFIX = "solvent/";

export interface Snapshot {
  generatedAt: string;
  agent: { name: string; wallet: string };
  policy: Policy;
  policyHash: string;
  policyCommitTx: string | null;
  books: Books;
  wallet: { sol: number; usdc: number; ansem: number; usd: number };
  prices: { sol: number; ansem: number };
  tiers: { name: string; minRunwayDays: number; models: string[] }[];
  latestAnchor: { seq: number; hash: string; tx: string } | null;
}

/** Builds the public snapshot: everything a visitor needs except the ledger itself. */
export async function buildSnapshot(ledger: FileLedger, reserveUsd: number): Promise<Snapshot> {
  const policy = loadPolicy();
  const entries = ledger.all();
  const owner = new PublicKey(policy.agent.wallet);
  const [bal, ansem, prices] = await Promise.all([
    walletBalances(owner),
    tokenBalance(owner, MINTS.ANSEM),
    usdPrices([MINTS.SOL, MINTS.ANSEM]),
  ]);
  const sol = prices[MINTS.SOL] ?? 0;
  const ansemPx = prices[MINTS.ANSEM] ?? 0;
  const hash = policyHash(policy);
  const commit = [...entries].reverse().find((e) => e.kind === "policy_commit" && e.meta?.hash === hash);
  const anchor = [...entries].reverse().find((e) => e.kind === "anchor");
  return {
    generatedAt: new Date().toISOString(),
    agent: policy.agent,
    policy,
    policyHash: hash,
    policyCommitTx: commit?.txSig ?? null,
    books: books(entries, reserveUsd),
    wallet: { sol: bal.sol, usdc: bal.usdc, ansem, usd: bal.sol * sol + bal.usdc + ansem * ansemPx },
    prices: { sol, ansem: ansemPx },
    tiers: DEFAULT_TIERS.map(({ name, minRunwayDays, models }) => ({ name, minRunwayDays, models })),
    latestAnchor: anchor?.txSig ? { seq: Number(anchor.meta?.seq), hash: String(anchor.meta?.hash), tx: anchor.txSig } : null,
  };
}

const blobOpts = (contentType: string) => ({
  access: "public" as const,
  allowOverwrite: true,
  addRandomSuffix: false,
  cacheControlMaxAge: 60,
  contentType,
  token: env.BLOB_READ_WRITE_TOKEN,
});

/** Uploads the snapshot and the full ledger so the public dashboard can show and verify them. */
export async function publish(ledger: FileLedger, reserveUsd: number): Promise<{ snapshotUrl: string; ledgerUrl: string }> {
  if (!env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN is not set");
  const snap = await buildSnapshot(ledger, reserveUsd);
  const lines = ledger.all().map((e) => JSON.stringify(e)).join("\n");
  const [s, l] = await Promise.all([
    put(`${PUBLIC_PREFIX}books.json`, JSON.stringify(snap), blobOpts("application/json")),
    put(`${PUBLIC_PREFIX}ledger.jsonl`, lines ? lines + "\n" : "", blobOpts("application/x-ndjson")),
  ]);
  return { snapshotUrl: s.url, ledgerUrl: l.url };
}

/** Paid-audit sales recorded by the web endpoint, waiting to be booked into the ledger. */
export const INBOX_PREFIX = `${PUBLIC_PREFIX}inbox/`;

export interface SaleRecord {
  kind: "audit_sale";
  paymentTx: string;
  payer: string;
  priceUsd: number;
  wallet: string;
  reportCostUsd: number;
  model?: string;
  at: string;
}

/** Moves inbox sale records into the ledger (income + the thought that produced the report). */
export async function ingestInbox(ledger: FileLedger): Promise<number> {
  if (!env.BLOB_READ_WRITE_TOKEN) return 0;
  const { blobs } = await list({ prefix: INBOX_PREFIX, token: env.BLOB_READ_WRITE_TOKEN });
  const seen = new Set(ledger.all().map((e) => e.txSig).filter(Boolean));
  let booked = 0;
  for (const b of blobs) {
    const rec = (await (await fetch(b.url)).json()) as SaleRecord;
    if (!seen.has(rec.paymentTx)) {
      ledger.append({
        kind: "income",
        usd: rec.priceUsd,
        txSig: rec.paymentTx,
        meta: { source: "audit_sale", payer: rec.payer, auditedWallet: rec.wallet, amountUsd: rec.priceUsd },
      });
      ledger.append({
        kind: "thought",
        usd: -rec.reportCostUsd,
        meta: { via: "audit_report", model: rec.model, forPayment: rec.paymentTx },
      });
      booked++;
    }
    await del(b.url, { token: env.BLOB_READ_WRITE_TOKEN });
  }
  return booked;
}
