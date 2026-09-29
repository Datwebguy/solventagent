import { PublicKey, type ParsedTransactionWithMeta, type TokenBalance } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { MINTS } from "./config.js";
import { classifyInflow } from "./income.js";
import { usdPrices } from "./prices.js";
import { getParsedTx, readConnection, recentSignatures, tokenBalance, withRetry } from "./solana.js";

/**
 * Checks any pump.fun token (ClawPump launches included) from public records only: is the team
 * earning creator fees, and are they holding or selling their own token?
 */
export const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_AMM_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL = NATIVE_MINT.toBase58();
/** Below this, a fee vault holds only its rent, not fees. */
const VAULT_DUST_SOL = 0.001;

export type TokenVerdict = "EARNING AND HOLDING" | "EARNING AND SELLING" | "SELLING, NOT EARNING" | "NOT EARNING YET";

export interface TokenCheck {
  mint: string;
  name: string | null;
  ticker: string | null;
  launchpad: "ClawPump" | "pump.fun";
  /** Moved from the bonding curve to the PumpSwap pool. */
  graduated: boolean;
  /** The creator recorded on the token's bonding curve. */
  creator: string;
  /** Where the team's fees land: the ClawPump payout wallet, or the creator. */
  teamWallet: string;
  /** Creator fees waiting to be claimed by the creator (for all of the creator's pump.fun tokens). */
  unclaimed: { sol: number; usd: number };
  /** Fees the team wallet claimed or was paid, in the transactions read. */
  earned: { count: number; sol: number; usd: number; last7dUsd: number };
  sold: { count: number; tokens: number; usd: number; last7dUsd: number };
  bought: { count: number; tokens: number; usd: number };
  holds: { tokens: number; pctOfSupply: number | null; usd: number };
  verdict: TokenVerdict;
  scanned: { transactions: number; from: string | null; to: string | null; partial?: boolean };
  events: { kind: "earned" | "sold" | "bought"; usd: number; tokens?: number; ts: string | null; signature: string }[];
}

/** What one transaction did for `wallet`: fees received, and buys or sells of `mint`. */
export interface TxEffect {
  feeLamports: number;
  tokenDelta: number;
  lamportsDelta: number;
}

/** SOL and wrapped-SOL change of `wallet` in a transaction, in lamports. */
function lamportsChange(tx: ParsedTransactionWithMeta, wallet: string): number {
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const i = keys.indexOf(wallet);
  const sol = i >= 0 ? (tx.meta?.postBalances[i] ?? 0) - (tx.meta?.preBalances[i] ?? 0) : 0;
  return sol + tokenChange(tx, wallet, WSOL) * 1e9;
}

/** Change in `wallet`'s balance of `mint` in a transaction, in UI units. */
function tokenChange(tx: ParsedTransactionWithMeta, wallet: string, mint: string): number {
  const sum = (list: TokenBalance[] | null | undefined) =>
    (list ?? []).filter((b) => b.owner === wallet && b.mint === mint).reduce((s, b) => s + Number(b.uiTokenAmount.uiAmountString ?? 0), 0);
  return sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances);
}

/** Pure: how a transaction moved money for the team wallet. */
export function txEffect(tx: ParsedTransactionWithMeta, wallet: string, mint: string, signature = ""): TxEffect {
  const logs = tx.meta?.logMessages ?? [];
  const lamportsDelta = lamportsChange(tx, wallet);
  const tokenDelta = tokenChange(tx, wallet, mint);
  let feeLamports = 0;
  if (logs.some((l) => /Instruction: Collect(Coin)?CreatorFee/.test(l)) && lamportsDelta > 0 && tokenDelta === 0) feeLamports = lamportsDelta;
  const payout = classifyInflow(tx, signature, wallet, new Set());
  if (payout?.source === "clawpump_fees") feeLamports = Math.max(feeLamports, payout.lamports);
  return { feeLamports, tokenDelta, lamportsDelta };
}

export function tokenVerdict(earnedUsd: number, unclaimedUsd: number, soldUsd: number): TokenVerdict {
  const earning = earnedUsd > 0 || unclaimedUsd > 0;
  if (earning) return soldUsd > 0 ? "EARNING AND SELLING" : "EARNING AND HOLDING";
  return soldUsd > 0 ? "SELLING, NOT EARNING" : "NOT EARNING YET";
}

/** The creator and state recorded on a pump.fun bonding curve, or null if `mint` is not a pump.fun token. */
export async function readBondingCurve(mint: PublicKey): Promise<{ creator: string; graduated: boolean } | null> {
  const [curve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM);
  const info = await withRetry(() => readConnection().getAccountInfo(curve));
  if (!info || !info.owner.equals(PUMP_PROGRAM) || info.data.length < 81) return null;
  return { creator: new PublicKey(info.data.subarray(49, 81)).toBase58(), graduated: info.data[48] === 1 };
}

/** Creator fees waiting in the creator's pump.fun and PumpSwap vaults, in SOL. */
async function unclaimedFees(creator: PublicKey): Promise<number> {
  const [curveVault] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBuffer()], PUMP_PROGRAM);
  const [ammAuthority] = PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), creator.toBuffer()], PUMP_AMM_PROGRAM);
  const ammVault = getAssociatedTokenAddressSync(NATIVE_MINT, ammAuthority, true);
  const { value } = await withRetry(() => readConnection().getMultipleParsedAccounts([curveVault, ammVault]));
  const curveSol = (value[0]?.lamports ?? 0) / 1e9;
  const ammData = value[1]?.data as { parsed?: { info?: { tokenAmount?: { uiAmountString?: string } } } } | undefined;
  const ammSol = Number(ammData?.parsed?.info?.tokenAmount?.uiAmountString ?? 0);
  return (curveSol > VAULT_DUST_SOL ? curveSol : 0) + (ammSol > VAULT_DUST_SOL ? ammSol : 0);
}

async function supplyOf(mint: PublicKey): Promise<number | null> {
  const { value } = await withRetry(() => readConnection().getParsedAccountInfo(mint));
  const supply = (value?.data as { parsed?: { info?: { supply?: string; decimals?: number } } } | undefined)?.parsed?.info;
  return supply?.supply ? Number(supply.supply) / 10 ** (supply.decimals ?? 0) : null;
}

/** Resolves with the promise's value, or null if it takes longer than `ms`. */
async function within<T>(ms: number, p: Promise<T>): Promise<T | null> {
  if (ms <= 0) return null;
  if (!Number.isFinite(ms)) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)));
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
    p.catch(() => {});
  }
}

export class NotAPumpToken extends Error {}

export async function checkToken(
  mintAddress: string,
  opts: { maxTransactions?: number; budgetMs?: number; now?: number; known?: { name?: string; ticker?: string; payoutWallet?: string | null } | null } = {},
): Promise<TokenCheck> {
  const now = opts.now ?? Date.now();
  const readUntil = opts.budgetMs ? Date.now() + opts.budgetMs - 6_000 : Infinity;
  const mint = new PublicKey(mintAddress);
  const curve = await readBondingCurve(mint);
  if (!curve) throw new NotAPumpToken("This works for tokens launched on pump.fun or ClawPump. That address isn't one.");

  const clawpump = !!opts.known?.payoutWallet;
  const team = new PublicKey(opts.known?.payoutWallet ?? curve.creator);
  const [prices, unclaimedSol, supply, sigsRaw] = await Promise.all([
    usdPrices([MINTS.SOL, mintAddress]).catch(() => ({}) as Record<string, number>),
    // A ClawPump token's curve creator is ClawPump's launcher, whose vault is not this team's.
    clawpump ? Promise.resolve(0) : unclaimedFees(new PublicKey(curve.creator)).catch(() => 0),
    supplyOf(mint).catch(() => null),
    recentSignatures(team, opts.maxTransactions ?? 60),
  ]);
  const solUsd = prices[MINTS.SOL] ?? 0;
  const tokenUsd = prices[mintAddress] ?? 0;
  const sigs = sigsRaw.filter((s) => !s.err);

  const earned: { usd: number; t: number; sig: string; lamports: number }[] = [];
  const trades: { kind: "sold" | "bought"; usd: number; tokens: number; t: number; sig: string }[] = [];
  let read = 0;
  let partial = false;
  for (let i = 0; i < sigs.length; i += 3) {
    const batch = sigs.slice(i, i + 3);
    const txs = await within(readUntil - Date.now(), Promise.all(batch.map((s) => getParsedTx(s.signature))));
    if (!txs) {
      partial = true;
      break;
    }
    read = i + batch.length;
    txs.forEach((tx, j) => {
      if (!tx) return;
      const sig = batch[j]!.signature;
      const t = tx.blockTime ?? batch[j]!.blockTime ?? 0;
      const e = txEffect(tx, team.toBase58(), mintAddress, sig);
      if (e.feeLamports > 0) earned.push({ usd: (e.feeLamports / 1e9) * solUsd, t, sig, lamports: e.feeLamports });
      if (e.tokenDelta < 0 && e.lamportsDelta > 0) trades.push({ kind: "sold", usd: (e.lamportsDelta / 1e9) * solUsd, tokens: -e.tokenDelta, t, sig });
      if (e.tokenDelta > 0 && e.lamportsDelta < 0) trades.push({ kind: "bought", usd: (-e.lamportsDelta / 1e9) * solUsd, tokens: e.tokenDelta, t, sig });
    });
  }

  const weekAgo = now / 1000 - 7 * 86_400;
  const sum = (xs: { usd: number }[]) => xs.reduce((s, x) => s + x.usd, 0);
  const sold = trades.filter((x) => x.kind === "sold");
  const bought = trades.filter((x) => x.kind === "bought");
  const held = await tokenBalance(team, mintAddress).catch(() => 0);
  const times = sigs.slice(0, read).map((s) => s.blockTime ?? 0).filter(Boolean);
  const iso = (t: number) => (t ? new Date(t * 1000).toISOString() : null);
  const earnedUsd = sum(earned);
  const unclaimedUsd = unclaimedSol * solUsd;
  const soldUsd = sum(sold);

  return {
    mint: mintAddress,
    name: opts.known?.name ?? null,
    ticker: opts.known?.ticker ?? null,
    launchpad: clawpump ? "ClawPump" : "pump.fun",
    graduated: curve.graduated,
    creator: curve.creator,
    teamWallet: team.toBase58(),
    unclaimed: { sol: unclaimedSol, usd: unclaimedUsd },
    earned: { count: earned.length, sol: earned.reduce((s, x) => s + x.lamports, 0) / 1e9, usd: earnedUsd, last7dUsd: sum(earned.filter((x) => x.t >= weekAgo)) },
    sold: { count: sold.length, tokens: sold.reduce((s, x) => s + x.tokens, 0), usd: soldUsd, last7dUsd: sum(sold.filter((x) => x.t >= weekAgo)) },
    bought: { count: bought.length, tokens: bought.reduce((s, x) => s + x.tokens, 0), usd: sum(bought) },
    holds: { tokens: held, pctOfSupply: supply ? (held / supply) * 100 : null, usd: held * tokenUsd },
    verdict: tokenVerdict(earnedUsd, unclaimedUsd, soldUsd),
    scanned: { transactions: read, from: times.length ? iso(Math.min(...times)) : null, to: times.length ? iso(Math.max(...times)) : null, ...(partial ? { partial: true } : {}) },
    events: [
      ...earned.map((x) => ({ kind: "earned" as const, usd: x.usd, ts: iso(x.t), signature: x.sig })),
      ...trades.map((x) => ({ kind: x.kind, usd: x.usd, tokens: x.tokens, ts: iso(x.t), signature: x.sig })),
    ]
      .sort((a, b) => Date.parse(b.ts ?? "0") - Date.parse(a.ts ?? "0"))
      .slice(0, 30),
  };
}
