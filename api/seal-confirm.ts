import { PublicKey } from "@solana/web3.js";
import { confirmSealPayment } from "../src/seal-store.js";

/**
 * Records a seal payment after checking it on-chain: POST /api/seal-confirm {wallet, signature}.
 * The transaction must be signed by `wallet`, carry a valid Solvent price quote, and burn 80% /
 * send 20% of exactly the quoted $ANSEM to Solvent.
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
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) return Response.json({ error: "signature is not a transaction signature" }, { status: 400 });
  try {
    return Response.json({ ok: true, ...(await confirmSealPayment(body.wallet as string, signature)) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
