import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { MINTS } from "./config.js";

/** UsePod's deposit program: agents top up their prepaid AI budget through it. */
export const USEPOD_DEPOSIT_PROGRAM = "BBAdcqUkg68JXNiPQ1HR1wujfZuayyK3eQTQSYAh6FSW";
/** UsePod's pay-per-answer (x402) receiving address. */
export const USEPOD_X402_PAY_TO = "GXfqVnZENHzvim8rNN8TPwqxWXQe8EBbxhcEMYE8Z7BS";

export interface AiPayment {
  kind: "topup" | "per_answer";
  /** USD value paid to UsePod (USDC is exact; SOL is valued at `solPriceUsd`). */
  usd: number;
}

interface TokenBalance {
  owner?: string;
  mint: string;
  uiTokenAmount: { amount: string };
}

const tokenTotal = (bals: TokenBalance[] | null | undefined, owner: string, mint: string) =>
  (bals ?? []).filter((b) => b.owner === owner && b.mint === mint).reduce((s, b) => s + Number(b.uiTokenAmount.amount), 0);

/**
 * How much `wallet` paid UsePod for AI in this transaction, if anything.
 * Top-ups: the USDC moved inside UsePod's deposit instruction (exact, even when the same
 * transaction first swapped SOL or $ANSEM into USDC). Pay-per-answer: USDC or SOL sent to
 * UsePod's payment address.
 */
export function classifyAiPayment(tx: ParsedTransactionWithMeta, wallet: string, solPriceUsd: number): AiPayment | undefined {
  const top = tx.transaction.message.instructions;
  const signers = tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey.toBase58());
  if (!signers.includes(wallet)) return undefined; // only payments this wallet made

  // 1) Top-ups through the deposit program: sum the token transfers it performed.
  let topupMicros = 0;
  top.forEach((ix, index) => {
    if (ix.programId.toBase58() !== USEPOD_DEPOSIT_PROGRAM) return;
    const inner = (tx.meta?.innerInstructions ?? []).find((g) => g.index === index)?.instructions ?? [];
    for (const i of inner) {
      if (!("parsed" in i) || typeof i.parsed !== "object" || !String(i.parsed?.type).startsWith("transfer")) continue;
      const info = i.parsed.info as { amount?: string; tokenAmount?: { amount: string }; mint?: string };
      if (info.mint && info.mint !== MINTS.USDC) continue;
      topupMicros += Number(info.tokenAmount?.amount ?? info.amount ?? 0);
    }
  });
  if (topupMicros > 0) return { kind: "topup", usd: topupMicros / 1e6 };

  // 2) Pay-per-answer: USDC received by UsePod's payment address...
  const usdcToPod =
    tokenTotal(tx.meta?.postTokenBalances as TokenBalance[], USEPOD_X402_PAY_TO, MINTS.USDC) -
    tokenTotal(tx.meta?.preTokenBalances as TokenBalance[], USEPOD_X402_PAY_TO, MINTS.USDC);
  if (usdcToPod > 0) return { kind: "per_answer", usd: usdcToPod / 1e6 };

  // ...or SOL sent straight to it.
  const lamports = top.reduce((s, ix) => {
    if ("parsed" in ix && ix.program === "system" && ix.parsed?.type === "transfer") {
      const info = ix.parsed.info as { source: string; destination: string; lamports: number };
      if (info.source === wallet && info.destination === USEPOD_X402_PAY_TO) return s + Number(info.lamports);
    }
    return s;
  }, 0);
  if (lamports > 0) return { kind: "per_answer", usd: (lamports / 1e9) * solPriceUsd };
  return undefined;
}
