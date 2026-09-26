import { PublicKey, Transaction, sendAndConfirmTransaction, type Keypair } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { MINTS } from "./config.js";
import { reserveSpend } from "./guardrails.js";
import { connection, memoInstruction } from "./solana.js";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

/**
 * Buys a Solvent report over x402 as any agent would: quote, pay USDC with the quote memo,
 * then settle with the transaction signature.
 */
export async function buyReport(payer: Keypair, baseUrl: string, wallet: string): Promise<{ result: any; paymentTx: string }> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/report?wallet=${wallet}`;
  const quoteRes = await fetch(url, { method: "POST" });
  const header = quoteRes.headers.get("payment-required");
  if (quoteRes.status !== 402 || !header) throw new Error(`expected a 402 quote, got ${quoteRes.status}: ${await quoteRes.text()}`);
  const quote = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  const accept = quote.accepts[0] as { pay_to: string; amount_microunits: number; memo: string; mint: string };
  if (accept.mint !== MINTS.USDC) throw new Error("quote asks for an asset other than USDC");

  reserveSpend(accept.amount_microunits / 1e6);
  const mint = new PublicKey(MINTS.USDC);
  const tx = new Transaction().add(
    createTransferCheckedInstruction(
      getAssociatedTokenAddressSync(mint, payer.publicKey),
      mint,
      getAssociatedTokenAddressSync(mint, new PublicKey(accept.pay_to), true),
      payer.publicKey,
      BigInt(accept.amount_microunits),
      6,
    ),
    memoInstruction(accept.memo, payer.publicKey),
  );
  const paymentTx = await sendAndConfirmTransaction(connection(), tx, [payer], { commitment: "confirmed" });

  const settled = await fetch(url, {
    method: "POST",
    headers: { "PAYMENT-SIGNATURE": b64({ quote_id: quote.quote_id, signature: paymentTx, payer_wallet: payer.publicKey.toBase58() }) },
  });
  const result = await settled.json();
  if (!settled.ok) throw new Error(`settlement failed (${settled.status}): ${JSON.stringify(result)} — payment ${paymentTx}`);
  return { result, paymentTx };
}
