import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
  type AddressLookupTableAccount,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { MINTS } from "../config.js";
import { reserveSpend } from "../guardrails.js";
import { DEPOSIT_EXTRA_CU, jupQuote, jupSwapInstructions, withExtraComputeUnits } from "../jupiter.js";
import { usdPrice } from "../prices.js";
import { connection } from "../solana.js";
import type { X402Rail } from "./client.js";

/** UsePod's sovereign deposit program (docs.usepod.ai/api/deposit-on-chain). */
export const USEPOD_PROGRAM_ID = new PublicKey("BBAdcqUkg68JXNiPQ1HR1wujfZuayyK3eQTQSYAh6FSW");
const USDC_MINT = new PublicKey(MINTS.USDC);

let idlCache: anchor.Idl | undefined;

async function usepodProgram(payer: Keypair) {
  const provider = new anchor.AnchorProvider(connection(), new anchor.Wallet(payer), { commitment: "confirmed" });
  idlCache ??= (await anchor.Program.fetchIdl(USEPOD_PROGRAM_ID, provider)) ?? undefined;
  if (!idlCache) throw new Error("UsePod IDL not found on-chain");
  return new anchor.Program(idlCache, provider);
}

function codeBytes(depositCode: string): number[] {
  if (!/^[0-9a-f]{16}$/.test(depositCode)) throw new Error("deposit code must be 16 hex chars");
  return Array.from(Buffer.from(depositCode, "hex"));
}

/** Signs and confirms a v0 transaction built from instructions and lookup tables. */
async function sendV0(payer: Keypair, instructions: TransactionInstruction[], alts: AddressLookupTableAccount[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message(alts);
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  const signature = await connection().sendTransaction(tx, { maxRetries: 3 });
  const conf = await connection().confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(conf.value.err)}`);
  return signature;
}

/**
 * Tops up the prepaid compute reserve: deposits USDC into a UsePod token through the
 * sovereign program. A plain transfer with a memo would NOT be credited.
 */
export async function depositUsdc(payer: Keypair, depositCode: string, amountUsd: number): Promise<string> {
  const code = codeBytes(depositCode);
  reserveSpend(amountUsd);
  const program = await usepodProgram(payer);
  const amount = new anchor.BN(Math.round(amountUsd * 1_000_000));
  return (program.methods as any).depositUsdc(code, amount).accounts({ mint: USDC_MINT }).rpc();
}

/** Tops up the reserve from SOL: Jupiter SOL→USDC and UsePod's deposit_sol in one transaction. */
export async function depositSol(payer: Keypair, depositCode: string, lamports: bigint): Promise<{ signature: string; usdcMinOut: number }> {
  const code = codeBytes(depositCode);
  reserveSpend((Number(lamports) / 1e9) * (await usdPrice(MINTS.SOL)));
  const program = await usepodProgram(payer);
  const quote = await jupQuote(MINTS.SOL, MINTS.USDC, lamports, 50);
  const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, payer.publicKey);
  const swap = await jupSwapInstructions(payer.publicKey, quote, usdcAta);
  const deposit = await (program.methods as any)
    .depositSol(code, new anchor.BN(lamports.toString()), new anchor.BN(quote.otherAmountThreshold))
    .accounts({ usdcMint: USDC_MINT })
    .instruction();
  const signature = await sendV0(payer, withExtraComputeUnits([...swap.before, deposit, ...swap.after], DEPOSIT_EXTRA_CU), swap.alts);
  return { signature, usdcMinOut: Number(quote.otherAmountThreshold) / 1e6 };
}

/**
 * Tops up the reserve from any SPL token (e.g. $ANSEM): Jupiter swap to USDC plus UsePod's
 * deposit_token, which records the source mint on-chain, in one transaction. Deposits the
 * guaranteed minimum output; any extra USDC from a better fill stays in the wallet.
 */
export async function depositFromToken(
  payer: Keypair,
  depositCode: string,
  inputMint: string,
  amountBaseUnits: bigint,
  inputUsd: number,
  recordSourceMint = false,
): Promise<{ signature: string; usdcDeposited: number }> {
  const code = codeBytes(depositCode);
  reserveSpend(inputUsd);
  const program = await usepodProgram(payer);
  const quote = await jupQuote(inputMint, MINTS.USDC, amountBaseUnits, 100);
  const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, payer.publicKey);
  const swap = await jupSwapInstructions(payer.publicKey, quote, usdcAta);
  const minOut = new anchor.BN(quote.otherAmountThreshold);
  // deposit_token is in the on-chain IDL but not in UsePod's docs; only use it once a small
  // live deposit has been confirmed as credited. deposit_usdc is the documented path.
  const deposit = recordSourceMint
    ? await (program.methods as any)
        .depositToken(code, new PublicKey(inputMint), new anchor.BN(amountBaseUnits.toString()), minOut)
        .accounts({ usdcMint: USDC_MINT })
        .instruction()
    : await (program.methods as any).depositUsdc(code, minOut).accounts({ mint: USDC_MINT }).instruction();
  const signature = await sendV0(payer, withExtraComputeUnits([...swap.before, deposit, ...swap.after], DEPOSIT_EXTRA_CU), swap.alts);
  return { signature, usdcDeposited: Number(quote.otherAmountThreshold) / 1e6 };
}

/**
 * Unsigned transaction that lets anyone ("payer") feed an agent's compute reserve with a token
 * such as $ANSEM: Jupiter swap to USDC, then deposit_usdc of the guaranteed minimum into the
 * agent's UsePod token. The payer signs it in their own wallet; nothing here holds funds.
 */
export async function buildFeedTransaction(
  payer: PublicKey,
  depositCode: string,
  inputMint: string,
  amountBaseUnits: bigint,
): Promise<{ transaction: VersionedTransaction; usdcMinOut: number; quoteOut: number }> {
  const code = codeBytes(depositCode);
  const readOnlyWallet = { publicKey: payer, signTransaction: async <T>(t: T) => t, signAllTransactions: async <T>(t: T[]) => t };
  const provider = new anchor.AnchorProvider(connection(), readOnlyWallet as unknown as anchor.Wallet, { commitment: "confirmed" });
  idlCache ??= (await anchor.Program.fetchIdl(USEPOD_PROGRAM_ID, provider)) ?? undefined;
  if (!idlCache) throw new Error("UsePod IDL not found on-chain");
  const program = new anchor.Program(idlCache, provider);
  const quote = await jupQuote(inputMint, MINTS.USDC, amountBaseUnits, 100);
  const swap = await jupSwapInstructions(payer, quote);
  const deposit = await (program.methods as any)
    .depositUsdc(code, new anchor.BN(quote.otherAmountThreshold))
    .accounts({ mint: USDC_MINT, depositor: payer })
    .instruction();
  const { blockhash } = await connection().getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: withExtraComputeUnits([...swap.before, deposit, ...swap.after], DEPOSIT_EXTRA_CU) }).compileToV0Message(swap.alts);
  return {
    transaction: new VersionedTransaction(message),
    usdcMinOut: Number(quote.otherAmountThreshold) / 1e6,
    quoteOut: Number(quote.outAmount) / 1e6,
  };
}

/** Step 2 of x402: sends the quoted amount on-chain to the quote's pay_to address. */
export async function payX402Rail(payer: Keypair, rail: X402Rail): Promise<string> {
  const payTo = new PublicKey(rail.pay_to);
  const tx = new Transaction();
  if (rail.asset === "USDC") {
    reserveSpend(rail.amount_microunits / 1e6);
    tx.add(
      createTransferCheckedInstruction(
        getAssociatedTokenAddressSync(USDC_MINT, payer.publicKey),
        USDC_MINT,
        getAssociatedTokenAddressSync(USDC_MINT, payTo, true),
        payer.publicKey,
        BigInt(rail.amount_microunits),
        6,
      ),
    );
  } else if (rail.asset === "SOL") {
    const lamports = rail.amount_microunits; // the SOL rail is quoted in lamports
    reserveSpend((lamports / 1e9) * (await usdPrice(MINTS.SOL)));
    tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payTo, lamports }));
  } else {
    throw new Error(`unsupported rail asset ${rail.asset}`);
  }
  return sendAndConfirmTransaction(connection(), tx, [payer], { commitment: "confirmed" });
}
