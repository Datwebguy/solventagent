import type { Keypair } from "@solana/web3.js";
import { env, MINTS } from "./config.js";
import { planSealShares, readSealRecords, sealSharesToConvert } from "./autopilot.js";
import type { FileLedger } from "./ledger.js";
import { usdPrice } from "./prices.js";
import { solscanTx, tokenBalance } from "./solana.js";
import { depositFromToken } from "./usepod/pay.js";

/**
 * Turns the 20% $ANSEM share of each Solvent Seal into AI budget: deposits it into the UsePod
 * compute reserve and books it (the share as income, the deposit as a top-up). The spending caps
 * apply inside the deposit. A share is only marked done after its deposit succeeds, so a failure
 * is simply retried next cycle.
 */
export async function convertSealShares(
  signer: Keypair,
  ledger: FileLedger,
  converted: string[],
  log: (s: string) => void,
): Promise<{ done: string[]; txs: { kind: string; signature: string }[]; failures: { kind: string; error: string }[] }> {
  const result = { done: [] as string[], txs: [] as { kind: string; signature: string }[], failures: [] as { kind: string; error: string }[] };
  if (!env.USEPOD_DEPOSIT_CODE || !env.BLOB_READ_WRITE_TOKEN) return result;

  // A share already booked in the ledger counts as done, even if the saved state missed it.
  const booked = ledger.all().map((e) => e.txSig).filter((s): s is string => !!s);
  const shares = sealSharesToConvert(await readSealRecords(), [...converted, ...booked]);
  if (!shares.length) return result;
  const [balance, price] = await Promise.all([tokenBalance(signer.publicKey, MINTS.ANSEM), usdPrice(MINTS.ANSEM)]);
  const plan = planSealShares(shares, balance, price, env.SOLVENT_MAX_TX_USD);
  log(`  seal shares: ${shares.length} waiting, ${plan.length} to convert now (wallet holds ${balance.toFixed(2)} $ANSEM)`);

  for (const s of plan) {
    try {
      const units = BigInt(Math.round(s.ansem * 1e6));
      const r = await depositFromToken(signer, env.USEPOD_DEPOSIT_CODE, MINTS.ANSEM, units, s.usd);
      ledger.append({ kind: "income", usd: s.usd, txSig: s.signature, meta: { source: "seal_share", ansem: s.ansem, sealWallet: s.wallet, amountUsd: s.usd } });
      ledger.append({ kind: "compute_topup", usd: 0, txSig: r.signature, meta: { amountUsd: s.usd, from: "ANSEM", ansem: s.ansem, sealShare: true, usdcDeposited: r.usdcDeposited } });
      result.done.push(s.signature);
      result.txs.push({ kind: "seal_share", signature: r.signature });
      log(`  done: seal share ${s.ansem.toFixed(2)} $ANSEM into the AI budget ${solscanTx(r.signature)}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      result.failures.push({ kind: "seal_share", error });
      log(`  FAILED: seal share: ${error}`);
    }
  }
  return result;
}
