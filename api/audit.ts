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
    // Bounded in count and in time (the function limit is 60s), so a slow free RPC gives a partial answer, not a 504.
    const audit = await auditWallet(wallet, 60, Date.now(), { budgetMs: 48_000 });
    return Response.json(audit, { headers: { "cache-control": `public, s-maxage=${audit.scanned.partial ? 60 : 300}` } });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
