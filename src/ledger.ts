import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { env } from "./config.js";
import { canonicalJson, sha256 } from "./policy.js";

export type EntryKind =
  | "income" // creator fees or other revenue (profit and loss +)
  | "capital" // owner deposits into the treasury (not income)
  | "compute_topup" // prepaying the UsePod reserve (a transfer, not an expense)
  | "thought" // one paid inference call (expense)
  | "swap" // asset conversion, e.g. SOL → $ANSEM reserve
  | "buyback" // distribution to token holders
  | "policy_commit"
  | "anchor"; // ledger head hash written on-chain

export interface EntryInput {
  kind: EntryKind;
  /**
   * Profit-and-loss impact in USD: income +, thoughts and buybacks −, transfers and swaps 0.
   * Transfer sizes go in meta.amountUsd.
   */
  usd: number;
  txSig?: string;
  meta?: Record<string, unknown>;
}

export interface Entry extends EntryInput {
  seq: number;
  ts: string;
  prevHash: string;
  hash: string;
}

export const GENESIS = "0".repeat(64);

export function entryHash(e: Omit<Entry, "hash">): string {
  return sha256(canonicalJson(e));
}

/** Builds the next entry in the hash chain. */
export function chain(prev: Entry | undefined, input: EntryInput, now = new Date()): Entry {
  const base: Omit<Entry, "hash"> = {
    ...input,
    seq: (prev?.seq ?? -1) + 1,
    ts: now.toISOString(),
    prevHash: prev?.hash ?? GENESIS,
  };
  return { ...base, hash: entryHash(base) };
}

/** Returns the index of the first entry that breaks the chain, or -1 if it is intact. */
export function verifyChain(entries: Entry[]): number {
  let prevHash = GENESIS;
  for (const [i, e] of entries.entries()) {
    const { hash, ...rest } = e;
    if (e.prevHash !== prevHash || entryHash(rest) !== hash || e.seq !== i) return i;
    prevHash = hash;
  }
  return -1;
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Cross-process mutex using an atomic mkdir; locks older than 30s are treated as stale. */
function withFileLock<T>(lockPath: string, fn: () => T): T {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // lock vanished between checks; retry
      }
      if (Date.now() > deadline) throw new Error(`ledger is locked by another process (${lockPath})`);
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

/** Append-only JSONL ledger on disk. */
export class FileLedger {
  constructor(private readonly path = join(env.SOLVENT_DATA_DIR, "ledger.jsonl")) {}

  all(): Entry[] {
    try {
      return readFileSync(this.path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Entry);
    } catch {
      return [];
    }
  }

  append(input: EntryInput): Entry {
    mkdirSync(join(this.path, ".."), { recursive: true });
    // The proxy, CLI and MCP server may all append; a lock keeps the hash chain linear.
    return withFileLock(`${this.path}.lock`, () => {
      const entries = this.all();
      const e = chain(entries[entries.length - 1], input);
      appendFileSync(this.path, JSON.stringify(e) + "\n");
      return e;
    });
  }

  head(): Entry | undefined {
    const entries = this.all();
    return entries[entries.length - 1];
  }
}

/** USD spent on thinking over the trailing window, used as the burn rate. */
export function burnUsdPerDay(entries: Entry[], now = new Date(), windowDays = 1): number {
  const since = now.getTime() - windowDays * 86_400_000;
  const spent = entries
    .filter((e) => e.kind === "thought" && Date.parse(e.ts) >= since)
    .reduce((sum, e) => sum - e.usd, 0);
  return spent / windowDays;
}
