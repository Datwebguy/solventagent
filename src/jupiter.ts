import {
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Keypair,
} from "@solana/web3.js";
import { connection } from "./solana.js";

const JUP = "https://lite-api.jup.ag/swap/v1";

export interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: unknown[];
  [k: string]: unknown;
}

export async function jupQuote(inputMint: string, outputMint: string, amount: bigint, slippageBps = 100): Promise<JupQuote> {
  const url = `${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
  const res = await fetch(url);
  const j = (await res.json()) as JupQuote & { error?: string };
  if (!res.ok || j.error) throw new Error(`Jupiter quote failed: ${j.error ?? res.status}`);
  return j;
}

// Cap priority fees so a congested block can't eat the treasury.
const PRIORITY = { priorityLevelWithMaxLamports: { maxLamports: 100_000, priorityLevel: "medium" } };

/** Executes a quoted swap from the payer's wallet and waits for confirmation. */
export async function jupSwap(payer: Keypair, quote: JupQuote): Promise<string> {
  const res = await fetch(`${JUP}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: payer.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: PRIORITY,
    }),
  });
  const j = (await res.json()) as { swapTransaction?: string; lastValidBlockHeight?: number; error?: string };
  if (!res.ok || !j.swapTransaction) throw new Error(`Jupiter swap failed: ${j.error ?? res.status}`);
  const tx = VersionedTransaction.deserialize(Buffer.from(j.swapTransaction, "base64"));
  tx.sign([payer]);
  const signature = await connection().sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const conf = await connection().confirmTransaction(
    { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: j.lastValidBlockHeight! },
    "confirmed",
  );
  if (conf.value.err) throw new Error(`swap ${signature} failed: ${JSON.stringify(conf.value.err)}`);
  return signature;
}

interface JupIx {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

export const jupIxToWeb3 = (ix: JupIx) =>
  new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  });

/**
 * Swap instructions (not a full transaction) so a swap can be composed with other
 * instructions atomically, e.g. swap then deposit into the compute reserve.
 */
export async function jupSwapInstructions(payer: PublicKey, quote: JupQuote, destinationTokenAccount?: PublicKey) {
  const res = await fetch(`${JUP}/swap-instructions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: payer.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: PRIORITY,
      destinationTokenAccount: destinationTokenAccount?.toBase58(),
    }),
  });
  const j = (await res.json()) as {
    computeBudgetInstructions?: JupIx[];
    setupInstructions?: JupIx[];
    swapInstruction: JupIx;
    cleanupInstruction?: JupIx;
    addressLookupTableAddresses?: string[];
    error?: string;
  };
  if (!res.ok || j.error) throw new Error(`Jupiter swap-instructions failed: ${j.error ?? res.status}`);
  const alts: AddressLookupTableAccount[] = [];
  for (const a of j.addressLookupTableAddresses ?? []) {
    const alt = (await connection().getAddressLookupTable(new PublicKey(a))).value;
    if (alt) alts.push(alt);
  }
  return {
    before: [...(j.computeBudgetInstructions ?? []), ...(j.setupInstructions ?? []), j.swapInstruction].map(jupIxToWeb3),
    after: j.cleanupInstruction ? [jupIxToWeb3(j.cleanupInstruction)] : [],
    alts,
  };
}
