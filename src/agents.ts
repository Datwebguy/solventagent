import { PublicKey } from "@solana/web3.js";

/** A team that put its agent on Solvent, as saved by /api/join and listed by /api/agents. */
export interface JoinedAgent {
  wallet: string;
  name: string;
  handle: string;
  joinedAt: string;
}

export const AGENTS_PREFIX = "solvent/agents/";
/** The most sign-ups kept, so a flood of junk cannot grow the store without limit. */
export const MAX_AGENTS = 500;

export type JoinInput = { wallet: string; name: string; handle: string };

/** Checks and cleans a sign-up. Returns the cleaned fields, or a message the visitor can act on. */
export function cleanJoin(raw: unknown): { ok: true; value: JoinInput } | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const wallet = typeof r.wallet === "string" ? r.wallet.trim() : "";
  const name = typeof r.name === "string" ? r.name.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim() : "";
  const handle = typeof r.handle === "string" ? r.handle.trim().replace(/^@/, "") : "";
  try {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) throw new Error("bad wallet");
    new PublicKey(wallet);
  } catch {
    return { ok: false, error: "That doesn't look like a Solana wallet address." };
  }
  if (name.length < 2 || name.length > 40) return { ok: false, error: "Your project name should be 2 to 40 characters." };
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return { ok: false, error: "Your X handle should be letters, numbers or underscores, like @yourproject." };
  return { ok: true, value: { wallet, name, handle } };
}
