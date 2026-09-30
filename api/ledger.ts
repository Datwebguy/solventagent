import { head } from "../src/store.js";

/** The full hash-chained ledger (JSON lines). The dashboard re-verifies the chain in the browser. */
export async function GET(): Promise<Response> {
  try {
    const blob = await head("solvent/ledger.jsonl");
    const res = await fetch(`${blob.url}?t=${Date.now()}`);
    return new Response(await res.text(), {
      headers: { "content-type": "application/x-ndjson", "cache-control": "public, max-age=30" },
    });
  } catch {
    return new Response("", { status: 404 });
  }
}
