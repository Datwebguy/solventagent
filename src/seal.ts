import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
import { usdPrice } from "./prices.js";
import { connection, memoInstruction, tokenBalance } from "./solana.js";

/**
 * The Solvent Seal: an agent's wallet burns $ANSEM to earn a seal that stays lit only while
 * the agent is earning. Tiers are priced in dollars. When someone asks for a seal, Solvent turns
 * the dollar price into an exact $ANSEM amount at the live price and signs that amount into a
 * short-lived quote, carried in the transaction's memo. The check later requires exactly the
 * quoted amount, so the price cannot drift or be changed between the approval and the check.
 *
 * Each payment is split on-chain in one transaction: 80% burned, 20% to Solvent's wallet. The
 * burn is signed by the agent's own wallet, which is also the proof that it owns that wallet.
 */
export const TIERS = [
  { name: "bronze", usd: 0.3 },
  { name: "silver", usd: 2 },
  { name: "gold", usd: 5 },
] as const;
export type TierName = (typeof TIERS)[number]["name"];

/** $ANSEM has 6 decimals. */
export const DECIMALS = 6;
/** Amounts are rounded up to a hundredth of a $ANSEM, so they read cleanly. */
const ROUND_UNITS = 10_000n;
const QUOTE_TTL_S = 10 * 60;
const MEMO_PREFIX = "solvent-seal:";

export interface SealPayment {
  signature: string;
  tier: TierName;
  /** Dollar price of the tier at the time (from the signed quote). */
  usd: number;
  burned: number;
  fee: number;
  at: string;
}

export interface SealRecord {
  wallet: string;
  /** Total dollars paid into seals by this wallet (the tiers' prices, summed). */
  usd: number;
  /** Total $ANSEM paid (burned + fee). */
  total: number;
  burned: number;
  fee: number;
  payments: SealPayment[];
  firstAt: string;
  updatedAt: string;
}

export const SEALS_PREFIX = "solvent/seals/";

export const tierUsd = (name: string): number | undefined => TIERS.find((t) => t.name === name)?.usd;

/** The highest tier a dollar total reaches, or null below Bronze. */
export function tierFor(totalUsd: number): TierName | null {
  let found: TierName | null = null;
  for (const t of TIERS) if (totalUsd + 1e-9 >= t.usd) found = t.name;
  return found;
}

/** Splits an amount in base units: the burn takes 80% (rounded down), the rest goes to Solvent. */
export function splitAmount(totalBaseUnits: bigint): { burn: bigint; fee: bigint } {
  const burn = (totalBaseUnits * 8n) / 10n;
  return { burn, fee: totalBaseUnits - burn };
}

/** The $ANSEM (base units) that a dollar price comes to at `ansemUsd`, rounded up to a hundredth. */
export function ansemUnitsFor(usd: number, ansemUsd: number): bigint {
  if (!(ansemUsd > 0)) throw new Error("no $ANSEM price available");
  const units = BigInt(Math.ceil((usd / ansemUsd) * 10 ** DECIMALS));
  return ((units + ROUND_UNITS - 1n) / ROUND_UNITS) * ROUND_UNITS;
}

/**
 * Whether a seal is lit: the agent must have earned something in the last 7 days and must not be
 * paying more for AI than it earns.
 */
export function sealActive(audit: { status: string; feeIncome: { last7dUsd: number } } | null | undefined): boolean {
  return !!audit && audit.status !== "AT RISK" && audit.status !== "NO ACTIVITY" && audit.feeIncome.last7dUsd > 0;
}

// ---------- the signed quote ----------

export interface SealQuote {
  w: string; // the agent's wallet
  t: TierName;
  u: number; // dollar price of the tier
  a: string; // exact $ANSEM to pay, in base units
  e: number; // expiry, unix seconds
  n: string; // nonce
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const mac = (payload: string, secret: string) => createHmac("sha256", secret).update(payload).digest("base64url");

/** Stateless, tamper-proof quote: the claims plus an HMAC, small enough to ride in a memo. */
export function signSealQuote(claims: Omit<SealQuote, "e" | "n">, secret: string, nowS = Math.floor(Date.now() / 1000)): { id: string; quote: SealQuote } {
  const quote: SealQuote = { ...claims, e: nowS + QUOTE_TTL_S, n: randomBytes(4).toString("hex") };
  const payload = b64url(JSON.stringify(quote));
  return { id: `${payload}.${mac(payload, secret)}`, quote };
}

export function readSealQuote(id: string, secret: string, nowS = Math.floor(Date.now() / 1000)): SealQuote {
  const [payload, sig] = id.split(".");
  if (!payload || !sig) throw new Error("malformed seal quote");
  const expected = Buffer.from(mac(payload, secret));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new Error("seal quote signature invalid");
  const quote = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SealQuote;
  if (quote.e < nowS) throw new Error("the seal price quote had expired");
  return quote;
}

// ---------- the transaction ----------

/**
 * Unsigned transaction for `payer` (the agent's wallet) to buy a tier at the live price: one
 * burn, one transfer and a memo carrying the signed quote, all in a single approval. Nothing is
 * held or signed here.
 */
export async function buildSealTransaction(payer: PublicKey, tier: TierName, treasury: PublicKey, secret: string) {
  const usd = tierUsd(tier);
  if (!usd) throw new Error("unknown tier");
  const conn = connection();
  const mint = new PublicKey(MINTS.ANSEM);
  const total = ansemUnitsFor(usd, await usdPrice(MINTS.ANSEM));

  const mintInfo = await conn.getAccountInfo(mint, "confirmed");
  if (!mintInfo) throw new Error("$ANSEM mint not found");
  const program = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const decimals = (await getMint(conn, mint, "confirmed", program)).decimals;
  if (decimals !== DECIMALS) throw new Error(`unexpected $ANSEM decimals: ${decimals}`);

  const { burn, fee } = splitAmount(total);
  const payerAta = getAssociatedTokenAddressSync(mint, payer, true, program);
  const treasuryAta = getAssociatedTokenAddressSync(mint, treasury, true, program);

  // Read the balance with a plain account read: some public RPCs refuse getTokenAccountBalance,
  // and a refused read must never be mistaken for an empty wallet.
  const held = await tokenBalance(payer, MINTS.ANSEM).catch(() => {
    throw new Error("Couldn't read this wallet's $ANSEM balance right now. Please try again in a moment.");
  });
  const have = BigInt(Math.round(held * 10 ** DECIMALS));
  const needed = Number(total) / 10 ** DECIMALS;
  if (have < total) {
    throw new Error(`The ${tier} seal costs ${needed} $ANSEM ($${usd}) and this wallet holds ${held}.`);
  }

  const { id, quote } = signSealQuote({ w: payer.toBase58(), t: tier, u: usd, a: total.toString() }, secret);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(
    createAssociatedTokenAccountIdempotentInstruction(payer, treasuryAta, treasury, mint, program),
    createBurnCheckedInstruction(payerAta, mint, payer, burn, DECIMALS, [], program),
    createTransferCheckedInstruction(payerAta, mint, treasuryAta, payer, fee, DECIMALS, [], program),
    memoInstruction(`${MEMO_PREFIX}${id}`, payer),
  );
  return { transaction: tx, burn, fee, total, tier, usd, quote };
}

// ---------- the on-chain check ----------

type Info = {
  authority?: string;
  mint?: string;
  destination?: string;
  amount?: string;
  tokenAmount?: { amount: string };
};

/** Seal memos in a transaction's top-level instructions. */
function sealMemos(tx: ParsedTransactionWithMeta): string[] {
  return tx.transaction.message.instructions.flatMap((ix) =>
    "parsed" in ix && ix.program === "spl-memo" && typeof ix.parsed === "string" && ix.parsed.startsWith(MEMO_PREFIX) ? [ix.parsed.slice(MEMO_PREFIX.length)] : [],
  );
}

/**
 * Reads a confirmed transaction and returns what `wallet` paid for which tier. Throws with a
 * plain message if it is not a valid seal payment. Only the wallet's own burn and its own
 * transfer to Solvent's $ANSEM account count, the amounts must add up to exactly the signed
 * quote, and the quote must be Solvent's, for this wallet, and not expired at the time.
 */
export function verifySealTx(
  tx: ParsedTransactionWithMeta | null,
  wallet: string,
  treasury: string,
  secret: string,
): { burned: number; fee: number; tier: TierName; usd: number } {
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

  const memo = sealMemos(tx)[0];
  if (!memo) throw new Error("the payment doesn't carry a Solvent seal quote");
  const at = tx.blockTime ?? Math.floor(Date.now() / 1000);
  const quote = readSealQuote(memo, secret, at);
  if (quote.w !== wallet) throw new Error("that quote was issued to another wallet");
  const total = burned + fee;
  if (total !== BigInt(quote.a)) throw new Error("the amount paid is not the amount quoted");
  const want = splitAmount(total);
  if (burned !== want.burn || fee !== want.fee) throw new Error("the payment must be split 80% burned, 20% to Solvent");
  return { burned: Number(burned) / 10 ** DECIMALS, fee: Number(fee) / 10 ** DECIMALS, tier: quote.t, usd: quote.u };
}

/** Adds a verified payment to a wallet's record; the same signature is never counted twice. */
export function addPayment(prev: SealRecord | undefined, wallet: string, pay: SealPayment): SealRecord {
  const base: SealRecord = prev ?? { wallet, usd: 0, total: 0, burned: 0, fee: 0, payments: [], firstAt: pay.at, updatedAt: pay.at };
  if (base.payments.some((x) => x.signature === pay.signature)) return base;
  return {
    ...base,
    usd: (base.usd ?? 0) + pay.usd,
    burned: base.burned + pay.burned,
    fee: base.fee + pay.fee,
    total: base.total + pay.burned + pay.fee,
    payments: [...base.payments, pay],
    updatedAt: pay.at,
  };
}
