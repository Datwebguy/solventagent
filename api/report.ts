import { head, put } from "@vercel/blob";
import { PublicKey } from "@solana/web3.js";
import { auditWallet } from "../src/audit.js";
import { env } from "../src/config.js";
import type { SaleRecord } from "../src/publish.js";
import { checkHolderRequest, isHolder, solventBalance } from "../src/holder.js";
import { writeReport } from "../src/report.js";
import { makeQuoteId, paymentRequired, readQuoteId, SOLANA_MAINNET, verifyPayment } from "../src/sell.js";
import { connection, getParsedTx } from "../src/solana.js";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const blob = { access: "public" as const, addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" };

/**
 * Paid solvency report over x402 (USDC on Solana).
 *   1. POST /api/report?wallet=X            -> 402 + PAYMENT-REQUIRED quote
 *   2. pay the quote on-chain with its memo
 *   3. POST again with PAYMENT-SIGNATURE     -> report (+ PAYMENT-RESPONSE)
 */
export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const wallet = url.searchParams.get("wallet") ?? "";
  try {
    new PublicKey(wallet);
  } catch {
    return Response.json({ error: "pass ?wallet=<solana address>" }, { status: 400 });
  }
  const secret = env.SOLVENT_QUOTE_SECRET;
  const treasury = env.SOLVENT_TREASURY_ADDRESS;
  const token = env.USEPOD_API_TOKEN;
  if (!secret || !treasury || !token) return Response.json({ error: "paid reports are not configured" }, { status: 503 });

  // $SOLVENT holders get the report free: they sign a short message to prove the wallet is theirs.
  const holderHeader = request.headers.get("x-solvent-holder");
  if (holderHeader) {
    try {
      const req = JSON.parse(Buffer.from(holderHeader, "base64").toString("utf8")) as { signer: string; agent: string; at: string; signature: string };
      checkHolderRequest(req, wallet);
      const tokens = await solventBalance(req.signer);
      if (!isHolder(tokens)) return Response.json({ error: "this wallet doesn't hold enough $SOLVENT for free reports", tokens }, { status: 403 });
      // One fresh report per agent per day is shared by all holders, so free reports can't drain the AI budget.
      const day = new Date().toISOString().slice(0, 10);
      const cachePath = `solvent/holder-reports/${wallet}-${day}.json`;
      try {
        const cached = await head(cachePath);
        return new Response(await (await fetch(cached.url)).text(), { headers: { "content-type": "application/json" } });
      } catch {
        // not written yet today
      }
      const audit = await auditWallet(wallet, 60);
      const report = await writeReport(audit, token);
      const result = { audit, report, holder: { wallet: req.signer, tokens } };
      await put(cachePath, JSON.stringify(result), blob);
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 403 });
    }
  }

  const proofHeader = request.headers.get("payment-signature");
  if (!proofHeader) {
    const { id, claims } = makeQuoteId({ w: wallet, a: Math.round(env.SOLVENT_AUDIT_PRICE_USD * 1e6), p: treasury }, secret);
    const body = paymentRequired(id, claims, url.toString());
    return new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": b64(body) } });
  }

  try {
    const proof = JSON.parse(Buffer.from(proofHeader, "base64").toString("utf8")) as { quote_id: string; signature: string; payer_wallet?: string };
    if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(proof.signature)) throw new Error("bad signature format");
    const claims = readQuoteId(proof.quote_id, secret);
    if (claims.w !== wallet) throw new Error("quote was issued for a different wallet");

    // A payment settles one report. Replays get the stored report instead of new spend.
    const salePath = `solvent/sales/${proof.signature}.json`;
    try {
      const existing = await head(salePath);
      return new Response(await (await fetch(existing.url)).text(), { headers: { "content-type": "application/json" } });
    } catch {
      // first settlement for this payment
    }

    const tx = await getParsedTx(proof.signature, connection());
    verifyPayment(tx, claims);

    const audit = await auditWallet(wallet, 60);
    const report = await writeReport(audit, token);
    const record: SaleRecord = {
      kind: "audit_sale",
      paymentTx: proof.signature,
      payer: proof.payer_wallet ?? "unknown",
      priceUsd: claims.a / 1e6,
      wallet,
      reportCostUsd: report.costUsd,
      model: report.model,
      at: new Date().toISOString(),
    };
    const result = { audit, report, payment: { tx: proof.signature, priceUsd: record.priceUsd, network: SOLANA_MAINNET } };
    await put(salePath, JSON.stringify(result), blob);
    await put(`solvent/inbox/${proof.signature}.json`, JSON.stringify(record), blob);
    return Response.json(result, { headers: { "PAYMENT-RESPONSE": b64({ signature: proof.signature, network: SOLANA_MAINNET }) } });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 402 });
  }
}
