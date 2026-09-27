import {
  Connection,
  type ParsedTransactionWithMeta,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  type Keypair,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { env, MINTS } from "./config.js";

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

let conn: Connection | undefined;
export const connection = () => (conn ??= new Connection(env.SOLANA_RPC_URL, "confirmed"));

// Heavy read paths (audits, the index) can rotate across several endpoints (SOLANA_READ_RPC_URLS).
const READ_URLS = (env.SOLANA_READ_RPC_URLS ?? env.SOLANA_RPC_URL).split(",").map((u) => u.trim()).filter(Boolean);
const readers = READ_URLS.map((u) => new Connection(u, { commitment: "confirmed", disableRetryOnRateLimit: true }));
let nextReader = 0;
export const readConnection = () => readers[nextReader++ % readers.length]!;

/** Retries RPC reads that hit rate limits (429) or dropped connections, backing off up to 10s. */
export async function withRetry<T>(fn: () => Promise<T>, tries = 8): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (i >= tries - 1 || !/429|Too many requests|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, Math.min(10_000, 500 * 2 ** i)));
    }
  }
}

/**
 * A wallet's recent transaction signatures. Some free endpoints return only a day or so of
 * history to servers, so when the answer is short, also ask Solana's public endpoint and keep
 * whichever list reaches further back.
 */
export async function recentSignatures(owner: PublicKey, limit: number) {
  const first = await withRetry(() => readConnection().getSignaturesForAddress(owner, { limit }));
  if (first.length >= limit) return first;
  try {
    const fallback = new Connection("https://api.mainnet-beta.solana.com", { commitment: "confirmed", disableRetryOnRateLimit: true });
    const second = await withRetry(() => fallback.getSignaturesForAddress(owner, { limit }), 4);
    return second.length > first.length ? second : first;
  } catch {
    return first;
  }
}

/**
 * Parsed transaction, accepting any version the RPC can return (v0 and the newer v1).
 * Returns null instead of throwing when a transaction cannot be read, so one odd
 * transaction never breaks a whole scan.
 */
export async function getParsedTx(sig: string, conn: Connection = readConnection()): Promise<ParsedTransactionWithMeta | null> {
  try {
    return await withRetry(() =>
      conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1 as 0, commitment: "confirmed" }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/version|not supported|parse/i.test(msg)) return null;
    throw err;
  }
}

/**
 * Balance of a token in UI units, read from the owner's standard token account under both the
 * classic and Token-2022 programs (pump.fun tokens such as $ANSEM are Token-2022). Uses plain
 * account reads, which free RPC endpoints allow from any server.
 */
export async function tokenBalance(owner: PublicKey, mint: string): Promise<number> {
  const mintKey = new PublicKey(mint);
  const atas = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((program) => getAssociatedTokenAddressSync(mintKey, owner, true, program));
  const infos = await withRetry(() => readConnection().getMultipleParsedAccounts(atas));
  return infos.value.reduce((sum, acc) => {
    const data = acc?.data as { parsed?: { info?: { tokenAmount?: { uiAmountString?: string } } } } | undefined;
    return sum + Number(data?.parsed?.info?.tokenAmount?.uiAmountString ?? 0);
  }, 0);
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
