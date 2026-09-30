/**
 * One-time copy of everything under solvent/ from Vercel Blob to Cloudflare R2.
 * Needs BLOB_READ_WRITE_TOKEN (the source) and the R2_* settings (the destination).
 * Safe to run again: it overwrites with the current Vercel copy.
 */
import * as vercel from "@vercel/blob";
import { list as listR2, put, r2 } from "../src/store.js";

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token || token === "r2") throw new Error("BLOB_READ_WRITE_TOKEN (Vercel Blob) is needed to read the current files");
if (!r2()) throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET and R2_PUBLIC_URL are needed");

const type = (p: string) => (p.endsWith(".json") ? "application/json" : p.endsWith(".jsonl") ? "application/x-ndjson" : "text/plain");
const skip = (p: string) => p === "solvent/state/lock.json"; // a lock from the old store must not block the new one

let cursor: string | undefined;
let copied = 0;
do {
  const page = await vercel.list({ prefix: "solvent/", token, cursor, limit: 1000 });
  for (const b of page.blobs) {
    if (skip(b.pathname)) continue;
    const res = await fetch(`${b.url}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${b.pathname}: HTTP ${res.status}`);
    await put(b.pathname, await res.text(), { contentType: type(b.pathname), cacheControlMaxAge: 0, allowOverwrite: true });
    copied++;
    console.log(`copied ${b.pathname}`);
  }
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);

const there = await listR2({ prefix: "solvent/" });
console.log(`done: copied ${copied} files; R2 now holds ${there.blobs.length} under solvent/`);
for (const f of ["solvent/books.json", "solvent/ledger.jsonl", "solvent/index.json"]) {
  const res = await fetch(`${r2()!.publicUrl}/${f}?t=${Date.now()}`);
  console.log(`public read ${f}: HTTP ${res.status}`);
}
