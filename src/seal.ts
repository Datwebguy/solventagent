import {
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, type ParsedInstruction, type ParsedTransactionWithMeta, Transaction } from "@solana/web3.js";
import { MINTS } from "./config.js";
import { connection, memoInstruction } from "./solana.js";

/**
 * The Solvent Seal: an agent's wallet burns $ANSEM to earn a seal that stays lit only while
 * the agent is really earning. Each payment is split on-chain in one transaction: 80% is burned
 * and 20% goes to Solvent's wallet (its AI budget). The burn is signed by the agent's own
 * wallet, which is also the proof that the wallet belongs to whoever asks for the seal.
 */
export const TIERS = [
  { name: "bronze", ansem: 1 },
  { name: "silver", ansem: 10 },
  { name: "gold", ansem: 50 },
] as const;
export type TierName = (typeof TIERS)[number]["name"];

/** $ANSEM has 6 decimals. */
export const DECIMALS = 6;
export const BURN_SHARE = 0.8;

export interface SealPayment {
  signature: string;
  burned: number;
  fee: number;
  at: string;
}

export interface SealRecord {
  wallet: string;
  /** Total $ANSEM paid into seals by this wallet (burned + fee). */
  total: number;
  burned: number;
  fee: number;
  payments: SealPayment[];
  firstAt: string;
  updatedAt: string;
}

export const SEALS_PREFIX = "solvent/seals/";

export const tierAmount = (name: string): number | undefined => TIERS.find((t) => t.name === name)?.ansem;

/** The highest tier a total reaches, or null below Bronze. */
export function tierFor(totalAnsem: number): TierName | null {
  let found: TierName | null = null;
  for (const t of TIERS) if (totalAnsem + 1e-9 >= t.ansem) found = t.name;
  return found;
}

/** Splits an amount in base units: the burn takes 80% (rounded down), the rest goes to Solvent. */
export function splitAmount(totalBaseUnits: bigint): { burn: bigint; fee: bigint } {
  const burn = (totalBaseUnits * 8n) / 10n;
  return { burn, fee: totalBaseUnits - burn };
}

/**
 * Whether a seal is lit: the agent must have earned something in the last 7 days and must not be
 * paying more for AI than it earns.
 */
export function sealActive(audit: { status: string; feeIncome: { last7dUsd: number } } | null | undefined): boolean {
  return !!audit && audit.status !== "AT RISK" && audit.status !== "NO ACTIVITY" && audit.feeIncome.last7dUsd > 0;
}

/**
 * Unsigned transaction for `payer` (the agent's wallet) to buy a tier: one burn and one transfer
 * of $ANSEM in a single approval. Nothing is held or signed here.
 */
export async function buildSealTransaction(payer: PublicKey, tier: TierName, treasury: PublicKey) {
  const ansem = tierAmount(tier);
  if (!ansem) throw new Error("unknown tier");
  const conn = connection();
  const mint = new PublicKey(MINTS.ANSEM);
  const mintInfo = await conn.getAccountInfo(mint, "confirmed");
  if (!mintInfo) throw new Error("$ANSEM mint not found");
  const program = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const decimals = (await getMint(conn, mint, "confirmed", program)).decimals;
  if (decimals !== DECIMALS) throw new Error(`unexpected $ANSEM decimals: ${decimals}`);

  const total = BigInt(Math.round(ansem * 10 ** DECIMALS));
  const { burn, fee } = splitAmount(total);
  const payerAta = getAssociatedTokenAddressSync(mint, payer, true, program);
  const treasuryAta = getAssociatedTokenAddressSync(mint, treasury, true, program);

  const balance = await conn.getTokenAccountBalance(payerAta, "confirmed").catch(() => null);
  const have = BigInt(balance?.value.amount ?? "0");
  if (have < total) {
    throw new Error(`This wallet needs ${ansem} $ANSEM for the ${tier} seal and holds ${Number(have) / 10 ** DECIMALS}.`);
  }

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(
    createAssociatedTokenAccountIdempotentInstruction(payer, treasuryAta, treasury, mint, program),
    createBurnCheckedInstruction(payerAta, mint, payer, burn, DECIMALS, [], program),
    createTransferCheckedInstruction(payerAta, mint, treasuryAta, payer, fee, DECIMALS, [], program),
    memoInstruction(`solvent-seal:${tier}`, payer),
  );
  return { transaction: tx, burn, fee, total, tier };
}

type Info = {
  authority?: string;
  mint?: string;
  destination?: string;
  amount?: string;
  tokenAmount?: { amount: string };
};

/**
 * Reads a confirmed transaction and returns what `wallet` burned and what it sent to Solvent.
 * Throws with a plain message if it is not a valid seal payment. Only the wallet's own burn and
 * its own transfer to Solvent's $ANSEM account count.
 */
export function verifySealTx(tx: ParsedTransactionWithMeta | null, wallet: string, treasury: string): { burned: number; fee: number } {
  if (!tx) throw new Error("transaction not found (it may not be confirmed yet)");
  if (tx.meta?.err) throw new Error("that transaction failed on-chain");
  const signer = tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey.toBase58();
  if (signer !== wallet) throw new Error("the seal has to be paid by the agent's own wallet");

  const mint = new PublicKey(MINTS.ANSEM);
  const treasuryAtas = [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID].map((p) => getAssociatedTokenAddressSync(mint, new PublicKey(treasury), true, p).toBase58());

  let burned = 0n;
  let fee = 0n;
  for (const ix of tx.transaction.message.instructions) {
    if (!("parsed" in ix)) continue;
    const p = ix as ParsedInstruction;
    if (!String(p.program).startsWith("spl-token")) continue;
    const info = (p.parsed?.info ?? {}) as Info;
    if (info.mint !== MINTS.ANSEM || info.authority !== wallet) continue;
    const amount = BigInt(info.tokenAmount?.amount ?? info.amount ?? "0");
    if (p.parsed.type === "burnChecked" || p.parsed.type === "burn") burned += amount;
    else if ((p.parsed.type === "transferChecked" || p.parsed.type === "transfer") && info.destination && treasuryAtas.includes(info.destination)) fee += amount;
  }
  if (burned <= 0n) throw new Error("no $ANSEM burn found in that transaction");
  // The split is 80/20: at least a fifth of the total must have gone to Solvent (rounding allowed).
  const total = burned + fee;
  if (fee < total / 5n - 1n) throw new Error("the 20% share for Solvent's AI budget is missing");
  if (burned < (total * 4n) / 5n - 1n) throw new Error("less than 80% was burned");
  return { burned: Number(burned) / 10 ** DECIMALS, fee: Number(fee) / 10 ** DECIMALS };
}

/** Adds a verified payment to a wallet's record; the same signature is never counted twice. */
export function addPayment(prev: SealRecord | undefined, wallet: string, pay: SealPayment): SealRecord {
  const base: SealRecord = prev ?? { wallet, total: 0, burned: 0, fee: 0, payments: [], firstAt: pay.at, updatedAt: pay.at };
  if (base.payments.some((x) => x.signature === pay.signature)) return base;
  return {
    ...base,
    burned: base.burned + pay.burned,
    fee: base.fee + pay.fee,
    total: base.total + pay.burned + pay.fee,
    payments: [...base.payments, pay],
    updatedAt: pay.at,
  };
}
