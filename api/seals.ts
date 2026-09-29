import { list } from "@vercel/blob";
import { SEALS_PREFIX, tierFor, type SealRecord } from "../src/seal.js";

/** Every seal, and how much $ANSEM agents have burned in total. */
export async function GET(): Promise<Response> {
  try {
    const { blobs } = await list({ prefix: SEALS_PREFIX, limit: 500 });
    const rows = await Promise.all(
      blobs.map(async (b) => {
        try {
          return (await (await fetch(b.url)).json()) as SealRecord;
        } catch {
          return undefined;
        }
      }),
    );
    const seals: Record<string, { tier: string; total: number }> = {};
    let burned = 0;
    for (const r of rows) {
      const tier = r ? tierFor(r.usd ?? 0) : null;
      if (!r || !tier) continue;
      seals[r.wallet] = { tier, total: r.total };
      burned += r.burned;
    }
    return Response.json({ seals, burned, count: Object.keys(seals).length }, { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" } });
  } catch (err) {
    console.error(err);
    return Response.json({ seals: {}, burned: 0, count: 0 }, { headers: { "cache-control": "no-store" } });
  }
}
