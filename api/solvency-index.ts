import { head } from "@vercel/blob";

/** The Clawrena Solvency Index, rebuilt from the chain by the runtime. */
export async function GET(): Promise<Response> {
  try {
    const blob = await head("solvent/index.json");
    const res = await fetch(`${blob.url}?t=${Date.now()}`);
    return new Response(await res.text(), { headers: { "content-type": "application/json", "cache-control": "public, max-age=120" } });
  } catch {
    return Response.json({ error: "index not built yet" }, { status: 404 });
  }
}
