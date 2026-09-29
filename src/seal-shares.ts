import type { Keypair } from "@solana/web3.js";
import { env, MINTS } from "./config.js";
import { readSealRecords, sealSharesToConvert } from "./autopilot.js";
import { reserveSpend } from "./guardrails.js";
import { jupQuote, jupSwap } from "./jupiter.js";
import type { Entry, FileLedger } from "./ledger.js";
import { usdPrice } from "./prices.js";
import { solscanTx, tokenBalance } from "./solana.js";
import { depositFromToken } from "./usepod/pay.js";

/**
 * Pure: how Solvent uses the $ANSEM share of one seal payment, in base units. Half pays for its
 * AI and half buys $SOLVENT. Before the token exists (no mint set) all of it pays for AI.
 */
export function splitSealShare(units: bigint, canBuy: boolean): { ai: bigint; buy: bigint } {
  const buy = canBuy ? units / 2n : 0n;
  return { ai: units - buy, buy };
}

/** Pure: what the ledger says is already done for each seal payment. */
export function sealShareProgress(entries: Entry[]): { ai: Map<string, boolean>; bought: Set<string> } {
  const ai = new Map<string, boolean>(); // seal signature -> whether that share was split
  const bought = new Set<string>();
  for (const e of entries) {
    if (e.kind === "income" && e.meta?.source === "seal_share" && e.txSig) ai.set(e.txSig, e.meta?.split === true);
    if (e.kind === "buyback" && typeof e.meta?.sealSig === "string") bought.add(e.meta.sealSig);
  }
  return { ai, bought };
}

/**
 * Uses the $ANSEM share of each Solvent Seal: half is deposited into the UsePod compute reserve
 * (booked as income and a top-up) and half buys $SOLVENT on the market (booked as a buyback).
 * The spending caps apply to both. Each half is booked only after it succeeds, and a half that
 * fails is simply retried next cycle, so nothing is paid twice.
 */
export async function convertSealShares(
  signer: Keypair,
  ledger: FileLedger,
  converted: string[],
  log: (s: string) => void,
): Promise<{ done: string[]; txs: { kind: string; signature: string }[]; failures: { kind: string; error: string }[] }> {
  const result = { done: [] as string[], txs: [] as { kind: string; signature: string }[], failures: [] as { kind: string; error: string }[] };
  if (!env.USEPOD_DEPOSIT_CODE || !env.BLOB_READ_WRITE_TOKEN) return result;

  const mint = env.SOLVENT_TOKEN_MINT;
  const { ai, bought } = sealShareProgress(ledger.all());
  // A share is finished once its AI half is booked and, when it was split, its $SOLVENT half too.
  // (A share booked before the split existed went all to AI.)
  const shares = sealSharesToConvert(await readSealRecords(), converted).filter(
    (s) => !(ai.has(s.signature) && (ai.get(s.signature) === false || bought.has(s.signature) || !mint)),
  );
  if (!shares.length) return result;

  const [balance, price] = await Promise.all([tokenBalance(signer.publicKey, MINTS.ANSEM), usdPrice(MINTS.ANSEM)]);
  let left = BigInt(Math.floor(balance * 1e6));
  log(`  seal shares: ${shares.length} waiting (wallet holds ${balance.toFixed(2)} $ANSEM)`);

  for (const s of shares) {
    const units = BigInt(Math.round(s.ansem * 1e6));
    const part = splitSealShare(units, !!mint);
    const aiDone = ai.has(s.signature);
    const need = (aiDone ? 0n : part.ai) + part.buy;
    const usdOf = (u: bigint) => (Number(u) / 1e6) * price;
    if (need > left || usdOf(part.ai) > env.SOLVENT_MAX_TX_USD || usdOf(part.buy) > env.SOLVENT_MAX_TX_USD) continue;
    try {
      if (!aiDone) {
        const r = await depositFromToken(signer, env.USEPOD_DEPOSIT_CODE, MINTS.ANSEM, part.ai, usdOf(part.ai));
        const shareUsd = usdOf(units);
        ledger.append({ kind: "income", usd: shareUsd, txSig: s.signature, meta: { source: "seal_share", ansem: s.ansem, sealWallet: s.wallet, amountUsd: shareUsd, split: part.buy > 0n } });
        ledger.append({ kind: "compute_topup", usd: 0, txSig: r.signature, meta: { amountUsd: usdOf(part.ai), from: "ANSEM", ansem: Number(part.ai) / 1e6, sealShare: true, usdcDeposited: r.usdcDeposited } });
        left -= part.ai;
        result.txs.push({ kind: "seal_share", signature: r.signature });
        log(`  done: ${(Number(part.ai) / 1e6).toFixed(2)} $ANSEM from a seal into the AI budget ${solscanTx(r.signature)}`);
      }
      if (part.buy > 0n && mint) {
        const usd = usdOf(part.buy);
        reserveSpend(usd);
        const quote = await jupQuote(MINTS.ANSEM, mint, part.buy);
        const sig = await jupSwap(signer, quote);
        ledger.append({ kind: "buyback", usd: -usd, txSig: sig, meta: { amountUsd: usd, from: MINTS.ANSEM, to: mint, ansem: Number(part.buy) / 1e6, outAmount: quote.outAmount, sealSig: s.signature, source: "seal_share" } });
        left -= part.buy;
        result.txs.push({ kind: "seal_buyback", signature: sig });
        log(`  done: ${(Number(part.buy) / 1e6).toFixed(2)} $ANSEM from a seal bought $SOLVENT ${solscanTx(sig)}`);
      }
      result.done.push(s.signature);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      result.failures.push({ kind: "seal_share", error });
      log(`  FAILED: seal share: ${error}`);
    }
  }
  return result;
}
