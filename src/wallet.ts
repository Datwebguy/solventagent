import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { env } from "./config.js";

/** Parses a secret key given as base58 or a JSON byte array. Never echoes the input. */
export function parseSecretKey(raw: string): Uint8Array {
  const s = raw.trim();
  let bytes: Uint8Array;
  try {
    bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s) as number[]) : bs58.decode(s);
  } catch {
    throw new Error("Treasury secret is neither base58 nor a JSON byte array");
  }
  if (bytes.length !== 64) {
    throw new Error(`Treasury secret must decode to 64 bytes, got ${bytes.length}`);
  }
  return bytes;
}

export function loadTreasury(): Keypair {
  const raw =
    env.SOLVENT_TREASURY_SECRET ||
    (env.SOLVENT_TREASURY_KEYPAIR_PATH
      ? readFileSync(env.SOLVENT_TREASURY_KEYPAIR_PATH, "utf8")
      : undefined);
  if (!raw) {
    throw new Error(
      "No treasury key. Set SOLVENT_TREASURY_SECRET or SOLVENT_TREASURY_KEYPAIR_PATH in .env",
    );
  }
  return Keypair.fromSecretKey(parseSecretKey(raw));
}
