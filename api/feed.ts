import { PublicKey } from "@solana/web3.js";
import { env, MINTS } from "../src/config.js";
import { buildFeedTransaction } from "../src/usepod/pay.js";

/**
 * Feed Solvent with $ANSEM. POST /api/feed?payer=<wallet>&ansem=<amount>
 * Returns an unsigned transaction (base64) for the payer to sign in their own wallet:
 * $ANSEM → USDC via Jupiter, deposited into Solvent's UsePod compute reserve.
 */
export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const ansem = Number(url.searchParams.get("ansem"));
  let payer: PublicKey;
  try {
    payer = new PublicKey(url.searchParams.get("payer") ?? "");
  } catch {
    return Response.json({ error: "pass ?payer=<your wallet>" }, { status: 400 });
  }
  if (!(ansem > 0 && ansem <= 100_000)) return Response.json({ error: "ansem must be between 0 and 100000" }, { status: 400 });
  if (!env.USEPOD_DEPOSIT_CODE) return Response.json({ error: "feeding is not configured" }, { status: 503 });
  try {
    const r = await buildFeedTransaction(payer, env.USEPOD_DEPOSIT_CODE, MINTS.ANSEM, BigInt(Math.round(ansem * 1e6)));
    return Response.json({
      transaction: Buffer.from(r.transaction.serialize()).toString("base64"),
      ansem,
      usdcToReserve: r.usdcMinOut,
      expectedUsdc: r.quoteOut,
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
