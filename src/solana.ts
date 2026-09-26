import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  type Keypair,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { env, MINTS } from "./config.js";

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

let conn: Connection | undefined;
export const connection = () => (conn ??= new Connection(env.SOLANA_RPC_URL, "confirmed"));

/** Balance of an SPL token in UI units (0 when the account does not exist). */
export async function tokenBalance(owner: PublicKey, mint: string): Promise<number> {
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner, true);
  try {
    const res = await connection().getTokenAccountBalance(ata);
    return Number(res.value.uiAmountString ?? 0);
  } catch {
    return 0;
  }
}

export async function solBalance(owner: PublicKey): Promise<number> {
  return (await connection().getBalance(owner)) / 1e9;
}

export async function walletBalances(owner: PublicKey) {
  const [sol, usdc] = await Promise.all([solBalance(owner), tokenBalance(owner, MINTS.USDC)]);
  return { sol, usdc };
}

export function memoInstruction(text: string, signer: PublicKey) {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(text, "utf8"),
  });
}

/** Writes a memo on-chain (used to anchor policy and ledger hashes). */
export async function sendMemo(payer: Keypair, text: string): Promise<string> {
  const tx = new Transaction().add(memoInstruction(text, payer.publicKey));
  return sendAndConfirmTransaction(connection(), tx, [payer], { commitment: "confirmed" });
}

export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;
