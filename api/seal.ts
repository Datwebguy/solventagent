import { PublicKey } from "@solana/web3.js";
import { env } from "../src/config.js";
import { buildSealTransaction, tierAmount, TIERS, type TierName } from "../src/seal.js";

/**
 * Unsigned transaction to buy a Solvent Seal: POST /api/seal?wallet=<agent wallet>&tier=bronze|silver|gold
 * The agent's own wallet signs it: 80% of the $ANSEM is burned and 20% goes to Solvent's AI
 * budget. Nothing is held or signed here.
 */
export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const tier = url.searchParams.get("tier") ?? "";
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(url.searchParams.get("wallet") ?? "");
  } catch {
    return Response.json({ error: "pass ?wallet=<the agent's wallet>" }, { status: 400 });
  }
  if (!tierAmount(tier)) return Response.json({ error: `tier must be one of ${TIERS.map((t) => t.name).join(", ")}` }, { status: 400 });
  if (!env.SOLVENT_TREASURY_ADDRESS) return Response.json({ error: "seals are not configured" }, { status: 503 });
  try {
    const r = await buildSealTransaction(wallet, tier as TierName, new PublicKey(env.SOLVENT_TREASURY_ADDRESS));
    return Response.json({
      transaction: Buffer.from(r.transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64"),
      tier: r.tier,
      ansem: Number(r.total) / 1e6,
      burn: Number(r.burn) / 1e6,
      fee: Number(r.fee) / 1e6,
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
