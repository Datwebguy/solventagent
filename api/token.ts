import { PublicKey } from "@solana/web3.js";
import { head } from "@vercel/blob";
import { env } from "../src/config.js";
import { findPayoutWallet } from "../src/solvency-index.js";
import { checkToken, readBondingCurve } from "../src/token-check.js";

type Known = { name?: string; ticker?: string; payoutWallet?: string | null };

/** Name and payout wallet of a ClawPump token, from the saved ranking or its ClawPump page. */
async function knownToken(mint: string): Promise<Known | null> {
  if (mint === env.SOLVENT_TOKEN_MINT && env.SOLVENT_TREASURY_ADDRESS) return { name: "Solvent Agent", ticker: "SOLVENT", payoutWallet: env.SOLVENT_TREASURY_ADDRESS };
  try {
    const blob = await head("solvent/index.json");
    const idx = (await (await fetch(blob.url)).json()) as { entries: (Known & { mint: string })[] };
    const hit = idx.entries.find((e) => e.mint === mint);
    if (hit?.payoutWallet) return hit;
  } catch {
    // no saved ranking: fall through to the token page
  }
  const late = new Promise<null>((r) => setTimeout(() => r(null), 6_000));
  const payoutWallet = await Promise.race([findPayoutWallet(mint).catch(() => null), late]);
  return payoutWallet ? { payoutWallet } : null;
}

/** Name and ticker from Jupiter's token list, for tokens not in the ranking. */
async function tokenName(mint: string): Promise<{ name?: string; ticker?: string }> {
  try {
    const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`, { signal: AbortSignal.timeout(4_000) });
    const hit = ((await res.json()) as { id: string; name?: string; symbol?: string }[]).find((t) => t.id === mint);
    return hit ? { name: hit.name, ticker: hit.symbol } : {};
  } catch {
    return {};
  }
}

/**
 * Free, read-only check of any pump.fun or ClawPump token: GET /api/token?mint=<address>.
 * Answers 404 with { notToken: true } for addresses that are not such a token (e.g. a wallet).
 */
export async function GET(request: Request): Promise<Response> {
  const started = Date.now();
  const mint = new URL(request.url).searchParams.get("mint") ?? "";
  let key: PublicKey;
  try {
    key = new PublicKey(mint);
  } catch {
    return Response.json({ error: "pass ?mint=<token address>" }, { status: 400 });
  }
  try {
    if (!(await readBondingCurve(key))) {
      return Response.json({ notToken: true, error: "Not a pump.fun or ClawPump token" }, { status: 404, headers: { "cache-control": "public, s-maxage=3600" } });
    }
    const [found, named] = await Promise.all([knownToken(mint), tokenName(mint)]);
    const known = { ...named, ...(found ?? {}) };
    // Bounded in time: the function limit is 60s, so a slow free RPC gives a partial answer.
    const check = await checkToken(mint, { maxTransactions: 60, budgetMs: 46_000 - (Date.now() - started), known });
    return Response.json(check, { headers: { "cache-control": `public, s-maxage=${check.scanned.partial ? 60 : 300}, stale-while-revalidate=86400` } });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
