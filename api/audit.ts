import { PublicKey } from "@solana/web3.js";
import { auditWallet } from "../src/audit.js";

/** Free, read-only audit of any agent wallet: GET /api/audit?wallet=<address> */
export async function GET(request: Request): Promise<Response> {
  const wallet = new URL(request.url).searchParams.get("wallet") ?? "";
  try {
    new PublicKey(wallet);
  } catch {
    return Response.json({ error: "pass ?wallet=<solana address>" }, { status: 400 });
  }
  try {
    const audit = await auditWallet(wallet, 60); // bounded so a busy wallet cannot hit the function timeout
    return Response.json(audit, { headers: { "cache-control": "public, s-maxage=300" } });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
