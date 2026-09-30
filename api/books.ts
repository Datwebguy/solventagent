import { head } from "../src/store.js";

/** Latest public snapshot of the agent's books, published by the runtime. */
export async function GET(): Promise<Response> {
  try {
    const blob = await head("solvent/books.json");
    const res = await fetch(`${blob.url}?t=${Date.now()}`);
    return new Response(await res.text(), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=30" },
    });
  } catch {
    return Response.json({ error: "no books published yet" }, { status: 404 });
  }
}
