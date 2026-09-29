/**
 * What an always-on host needs so Solvent can run its treasury by itself, without a person:
 *  - start from the published books on a fresh machine (so the record is one unbroken chain),
 *  - tell the timers on Vercel and GitHub to stand down while it is running (one writer only),
 *  - keep its state safe outside the machine, and
 *  - find the $ANSEM shares from Solvent Seals that still need turning into AI budget.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { head, list, put } from "@vercel/blob";
import { env } from "./config.js";
import { verifyChain, type Entry } from "./ledger.js";
import { Policy } from "./policy.js";
// Kept here (not imported from publish.ts) so the modules do not import each other in a loop.
const PUBLIC_PREFIX = "solvent/";
import { SEALS_PREFIX, type SealRecord } from "./seal.js";

export const STATE_BLOB = `${PUBLIC_PREFIX}state/treasurer.json`;
export const HEARTBEAT_BLOB = `${PUBLIC_PREFIX}state/publisher.json`;
/** The timers stand down while the always-on server has checked in this recently. */
export const HEARTBEAT_FRESH_MS = 3 * 60 * 60_000;

/** Pure: whether a heartbeat time is recent enough. */
export function heartbeatFresh(at: string | undefined, nowMs = Date.now(), maxAgeMs = HEARTBEAT_FRESH_MS): boolean {
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) && nowMs - t >= 0 && nowMs - t < maxAgeMs;
}

async function readBlobText(pathname: string, token: string): Promise<string | undefined> {
  try {
    const meta = await head(pathname, { token });
    const res = await fetch(`${meta.url}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${pathname}: HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (err instanceof Error && /not found|does not exist/i.test(err.name + err.message)) return undefined;
    throw err;
  }
}

/** The server says it is publishing the books, so the timers must not. */
export async function writeHeartbeat(token = env.BLOB_READ_WRITE_TOKEN): Promise<void> {
  if (!token) return;
  await put(HEARTBEAT_BLOB, JSON.stringify({ at: new Date().toISOString() }), {
    access: "public",
    allowOverwrite: true,
    addRandomSuffix: false,
    cacheControlMaxAge: 0,
    contentType: "application/json",
    token,
  });
}

/** Whether the always-on server is publishing right now (used by the timers). */
export async function serverIsPublishing(token: string, nowMs = Date.now()): Promise<boolean> {
  const text = await readBlobText(HEARTBEAT_BLOB, token).catch(() => undefined);
  if (!text) return false;
  try {
    return heartbeatFresh((JSON.parse(text) as { at?: string }).at, nowMs);
  } catch {
    return false;
  }
}

/** Saves the treasurer's state outside the machine, so a replacement host carries on where it stopped. */
export async function saveStateToBlob(state: unknown, token = env.BLOB_READ_WRITE_TOKEN): Promise<void> {
  if (!token) return;
  await put(STATE_BLOB, JSON.stringify(state), {
    access: "public",
    allowOverwrite: true,
    addRandomSuffix: false,
    cacheControlMaxAge: 0,
    contentType: "application/json",
    token,
  });
}

/**
 * On a machine with no ledger yet, starts from the published books: the rules, the full record
 * (checked link by link first) and the saved state. Does nothing when a ledger is already here.
 */
export async function bootstrapFromPublished(log: (s: string) => void = console.log): Promise<"loaded" | "already here" | "nothing published"> {
  const token = env.BLOB_READ_WRITE_TOKEN;
  const ledgerPath = join(env.SOLVENT_DATA_DIR, "ledger.jsonl");
  try {
    if (readFileSync(ledgerPath, "utf8").trim()) return "already here";
  } catch {
    // no local ledger yet
  }
  if (!token) return "nothing published";
  const books = await readBlobText(`${PUBLIC_PREFIX}books.json`, token);
  if (!books) return "nothing published";
  const lines = (await readBlobText(`${PUBLIC_PREFIX}ledger.jsonl`, token)) ?? "";
  const entries = lines.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Entry);
  const broken = verifyChain(entries);
  if (broken >= 0) throw new Error(`The published record fails its check at entry ${broken}; refusing to build on it`);

  mkdirSync(env.SOLVENT_DATA_DIR, { recursive: true });
  writeFileSync(ledgerPath, lines);
  const policy = Policy.parse((JSON.parse(books) as { policy: unknown }).policy);
  try {
    readFileSync("solvent.policy.json", "utf8");
  } catch {
    writeFileSync("solvent.policy.json", JSON.stringify(policy, null, 2));
  }
  const state = await readBlobText(STATE_BLOB, token);
  if (state) writeFileSync(join(env.SOLVENT_DATA_DIR, "treasurer.json"), state);
  log(`started from the published books: ${entries.length} entries${state ? " and saved state" : ""}`);
  return "loaded";
}

// ---------- seal shares ----------

export interface SealShare {
  signature: string;
  wallet: string;
  /** Solvent's 20% share of the seal payment, in $ANSEM. */
  ansem: number;
  at: string;
}

/** Pure: seal payments whose 20% share Solvent has not finished using yet, oldest first. */
export function sealSharesToConvert(records: SealRecord[], converted: string[]): SealShare[] {
  const done = new Set(converted);
  return records
    .flatMap((r) => (r.payments ?? []).map((p) => ({ signature: p.signature, wallet: r.wallet, ansem: p.fee, at: p.at })))
    .filter((s) => s.ansem > 0 && !done.has(s.signature))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Every seal record with its payments, straight from storage. */
export async function readSealRecords(token = env.BLOB_READ_WRITE_TOKEN): Promise<SealRecord[]> {
  if (!token) return [];
  const { blobs } = await list({ prefix: SEALS_PREFIX, limit: 500, token });
  const rows = await Promise.all(blobs.map(async (b) => (await fetch(b.url)).json().catch(() => undefined) as Promise<SealRecord | undefined>));
  return rows.filter((r): r is SealRecord => !!r?.wallet);
}
