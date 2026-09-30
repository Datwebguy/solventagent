import { head, list, put } from "./store.js";
import { env } from "./config.js";
import { addPayment, SEALS_PREFIX, tierFor, verifySealTx, type SealRecord } from "./seal.js";
import { getParsedTx } from "./solana.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Checks a seal payment on-chain and records it. The transaction must be signed by `wallet`,
 * carry a valid Solvent price quote, and burn 80% / send 20% of exactly the quoted $ANSEM.
 * Throws an Error with a plain message when it is not a valid seal payment.
 */
export async function confirmSealPayment(wallet: string, signature: string) {
  if (!env.SOLVENT_TREASURY_ADDRESS || !env.SOLVENT_QUOTE_SECRET) throw new Error("seals are not configured");
  // A just-confirmed transaction can take a moment to be readable.
  let tx = await getParsedTx(signature);
  for (let i = 0; !tx && i < 4; i++) {
    await sleep(2500);
    tx = await getParsedTx(signature);
  }
  const { burned, fee, tier, usd } = verifySealTx(tx, wallet, env.SOLVENT_TREASURY_ADDRESS, env.SOLVENT_QUOTE_SECRET);

  const path = `${SEALS_PREFIX}${wallet}.json`;
  const existing = await head(path).catch(() => undefined);
  const prev = existing ? ((await (await fetch(`${existing.url}?t=${Date.now()}`, { cache: "no-store" })).json()) as SealRecord) : undefined;
  const at = new Date((tx?.blockTime ?? Date.now() / 1000) * 1000).toISOString();
  const next = addPayment(prev, wallet, { signature, tier, usd, burned, fee, at });
  if (next !== prev) {
    await put(path, JSON.stringify(next), { access: "public", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 0, contentType: "application/json" });
  }
  return { tier: tierFor(next.usd), usd: next.usd, total: next.total, burned: next.burned };
}

/** Every seal, and how much $ANSEM agents have burned in total. */
export async function readSeals() {
  const { blobs } = await list({ prefix: SEALS_PREFIX, limit: 500 });
  const rows = await Promise.all(
    blobs.map(async (b) => {
      try {
        return (await (await fetch(b.url)).json()) as SealRecord;
      } catch {
        return undefined;
      }
    }),
  );
  const seals: Record<string, { tier: string; total: number }> = {};
  let burned = 0;
  for (const r of rows) {
    const tier = r ? tierFor(r.usd ?? 0) : null;
    if (!r || !tier) continue;
    seals[r.wallet] = { tier, total: r.total };
    burned += r.burned;
  }
  return { seals, burned, count: Object.keys(seals).length };
}
