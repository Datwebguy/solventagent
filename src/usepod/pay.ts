import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, type Keypair } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { MINTS } from "../config.js";
import { reserveSpend } from "../guardrails.js";
import { usdPrice } from "../prices.js";
import { connection } from "../solana.js";
import type { X402Rail } from "./client.js";

/** UsePod's sovereign deposit program (docs.usepod.ai/api/deposit-on-chain). */
export const USEPOD_PROGRAM_ID = new PublicKey("BBAdcqUkg68JXNiPQ1HR1wujfZuayyK3eQTQSYAh6FSW");
const USDC_MINT = new PublicKey(MINTS.USDC);

/**
 * Tops up the prepaid compute reserve: deposits USDC into a UsePod token through the
 * sovereign program. A plain transfer with a memo would NOT be credited.
 */
export async function depositUsdc(payer: Keypair, depositCode: string, amountUsd: number): Promise<string> {
  if (!/^[0-9a-f]{16}$/.test(depositCode)) throw new Error("deposit code must be 16 hex chars");
  reserveSpend(amountUsd);
  const provider = new anchor.AnchorProvider(connection(), new anchor.Wallet(payer), { commitment: "confirmed" });
  const idl = await anchor.Program.fetchIdl(USEPOD_PROGRAM_ID, provider);
  if (!idl) throw new Error("UsePod IDL not found on-chain");
  const program = new anchor.Program(idl, provider);
  const code = Array.from(Buffer.from(depositCode, "hex"));
  const amount = new anchor.BN(Math.round(amountUsd * 1_000_000));
  return (program.methods as any).depositUsdc(code, amount).accounts({ mint: USDC_MINT }).rpc();
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
