/**
 * One bookkeeping pass, for a scheduled job on a fresh machine (GitHub Actions).
 *
 * It loads the books and the treasurer's state from the public Blob store, books paid-audit
 * sales, AI spending and new income, publishes the books, and saves the state back. It never
 * signs or sends a transaction and needs no private key: only SOLVENT_TREASURY_ADDRESS,
 * USEPOD_API_TOKEN (to read the AI budget) and BLOB_READ_WRITE_TOKEN.
 *
 *   npx tsx src/keeper.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { head, put } from "@vercel/blob";
import { env } from "./config.js";
import { readState, runCycle, writeState } from "./cycle.js";
import { FileLedger, verifyChain, type Entry } from "./ledger.js";
import { Policy } from "./policy.js";
import { ingestInbox, PUBLIC_PREFIX, publish } from "./publish.js";
import { tokenBalanceMicros } from "./usepod/client.js";

const STATE_BLOB = `${PUBLIC_PREFIX}state/treasurer.json`;
const log = (s: string) => console.log(`[${new Date().toISOString()}] ${s}`);

function need(name: string, v: string | undefined): string {
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Reads a blob's text, or undefined when it does not exist yet. */
async function readBlob(pathname: string, token: string): Promise<string | undefined> {
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

async function main() {
  const token = need("BLOB_READ_WRITE_TOKEN", env.BLOB_READ_WRITE_TOKEN);
  const apiToken = need("USEPOD_API_TOKEN", env.USEPOD_API_TOKEN);
  need("SOLVENT_TREASURY_ADDRESS", env.SOLVENT_TREASURY_ADDRESS);
  if (!env.SOLVENT_PUBLISH) throw new Error("SOLVENT_PUBLISH must be 1: the keeper's job is to publish the books");
  if (env.SOLVENT_AUTOPILOT) throw new Error("The keeper never moves funds; unset SOLVENT_AUTOPILOT");

  // 1. Load the published books, ledger and state onto this machine.
  const books = await readBlob(`${PUBLIC_PREFIX}books.json`, token);
  if (!books) throw new Error("No published books found; publish once from the CLI first");
  const policy = Policy.parse(JSON.parse(books).policy);
  writeFileSync("solvent.policy.json", JSON.stringify(policy, null, 2));

  const lines = (await readBlob(`${PUBLIC_PREFIX}ledger.jsonl`, token)) ?? "";
  const entries = lines.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Entry);
  const broken = verifyChain(entries);
  if (broken >= 0) throw new Error(`The published ledger fails its tamper check at #${broken}; refusing to build on it`);
  mkdirSync(env.SOLVENT_DATA_DIR, { recursive: true });
  writeFileSync(join(env.SOLVENT_DATA_DIR, "ledger.jsonl"), lines);
  const saved = await readBlob(STATE_BLOB, token);
  if (saved) writeState(JSON.parse(saved));
  const ledger = new FileLedger();
  log(`loaded ${entries.length} ledger entries${saved ? " and saved state" : " (no saved state yet: first run)"}`);

  // 2. Paid-audit sales recorded by the website, with the cost of writing each report.
  const before = ledger.head()?.seq ?? -1;
  const sales = await ingestInbox(ledger);
  const reportCostMicros = ledger
    .all()
    .filter((e) => e.seq > before && e.kind === "thought")
    .reduce((s, e) => s - e.usd * 1e6, 0);
  if (sales) log(`booked ${sales} paid audit sale(s)`);

  // 3. AI budget: book any spending (or outside top-up) since the last run.
  const live = await tokenBalanceMicros(apiToken);
  const prev = readState().reserveMicros;
  if (prev !== undefined) {
    const diff = live - prev + reportCostMicros; // report costs are already booked above
    if (diff < -1) {
      ledger.append({ kind: "thought", usd: diff / 1e6, meta: { via: "reconciliation" } });
      log(`booked $${(-diff / 1e6).toFixed(6)} of AI spending`);
    } else if (diff > 1) {
      ledger.append({ kind: "compute_topup", usd: 0, meta: { source: "external", reserveCreditUsd: diff / 1e6 } });
      log(`booked an outside top-up of $${(diff / 1e6).toFixed(4)}`);
    }
  }

  // 4. New token earnings, split by the published rules. Nothing is sent.
  await runCycle({ execute: false, bookOnly: true, log });
  writeState({ ...readState(), reserveMicros: live });

  // 5. Publish the books, then save the state for the next run.
  const { snapshotUrl } = await publish(ledger, live / 1e6);
  await put(STATE_BLOB, JSON.stringify(readState()), {
    access: "public",
    allowOverwrite: true,
    addRandomSuffix: false,
    cacheControlMaxAge: 0,
    contentType: "application/json",
    token,
  });
  log(`published ${ledger.all().length} entries, AI budget $${(live / 1e6).toFixed(4)}: ${snapshotUrl}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
