import { createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { env } from "./config.js";
import { tokenBalance } from "./solana.js";

/**
 * $SOLVENT holder perks. A wallet holding at least `holderMin()` $SOLVENT gets Solvent's full
 * agent reports free and a holder badge. Ownership is proven by signing a short message, so
 * nobody can claim someone else's balance.
 */
export const holderMin = () => env.SOLVENT_HOLDER_MIN;
const MESSAGE_TTL_MS = 5 * 60_000;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export async function solventBalance(wallet: string): Promise<number> {
  if (!env.SOLVENT_TOKEN_MINT) return 0;
  return tokenBalance(new PublicKey(wallet), env.SOLVENT_TOKEN_MINT);
}

export const isHolder = (tokens: number) => tokens >= holderMin();

/** The exact text a holder signs to ask for a free report on `agent`. */
export const holderMessage = (agent: string, at: string) => `Solvent holder report\nAgent: ${agent}\nTime: ${at}`;

/** Checks that `signature` (base58) is `signer`'s signature of `message`. */
export function signedBy(message: string, signature: string, signer: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, new PublicKey(signer).toBuffer()]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(bs58.decode(signature)));
  } catch {
    return false;
  }
}

/**
 * Pure: whether a signed holder request for `agent` is valid right now. Throws a plain message
 * when it is not (wrong agent, too old, or not signed by `signer`).
 */
export function checkHolderRequest(req: { signer: string; agent: string; at: string; signature: string }, agent: string, now = Date.now()) {
  if (req.agent !== agent) throw new Error("that request was for another agent");
  const t = Date.parse(req.at);
  if (!Number.isFinite(t) || Math.abs(now - t) > MESSAGE_TTL_MS) throw new Error("that request has expired, please try again");
  if (!signedBy(holderMessage(req.agent, req.at), req.signature, req.signer)) throw new Error("the signature doesn't match the wallet");
}
