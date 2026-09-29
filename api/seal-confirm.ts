import { head, put } from "@vercel/blob";
import { PublicKey } from "@solana/web3.js";
import { env } from "../src/config.js";
import { addPayment, SEALS_PREFIX, tierFor, verifySealTx, type SealRecord } from "../src/seal.js";
import { getParsedTx } from "../src/solana.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Records a seal payment after checking it on-chain: POST /api/seal-confirm {wallet, signature}.
 * The transaction must be signed by `wallet`, carry a valid Solvent price quote, and burn 80% / send 20% of exactly the quoted $ANSEM to Solvent.
 */
export async function POST(request: Request): Promise<Response> {
  let body: { wallet?: string; signature?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "send JSON: {wallet, signature}" }, { status: 400 });
  }
  const signature = String(body.signature ?? "");
  try {
    new PublicKey(body.wallet ?? "");
  } catch {
    return Response.json({ error: "wallet is not a Solana address" }, { status: 400 });
  }
  const wallet = body.wallet as string;
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) return Response.json({ error: "signature is not a transaction signature" }, { status: 400 });
  if (!env.SOLVENT_TREASURY_ADDRESS || !env.SOLVENT_QUOTE_SECRET) return Response.json({ error: "seals are not configured" }, { status: 503 });

  try {
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
    return Response.json({ ok: true, tier: tierFor(next.usd), usd: next.usd, total: next.total, burned: next.burned });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
