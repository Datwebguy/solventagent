import { PublicKey } from "@solana/web3.js";
import { holderMin, isHolder, solventBalance } from "../src/holder.js";

/** How much $SOLVENT a wallet holds and whether that unlocks holder perks: GET /api/holder?wallet=<address> */
export async function GET(request: Request): Promise<Response> {
  const wallet = new URL(request.url).searchParams.get("wallet") ?? "";
  try {
    new PublicKey(wallet);
  } catch {
    return Response.json({ error: "pass ?wallet=<solana address>" }, { status: 400 });
  }
  try {
    const tokens = await solventBalance(wallet);
    return Response.json({ wallet, tokens, holder: isHolder(tokens), min: holderMin() }, { headers: { "cache-control": "public, s-maxage=30" } });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
