import { list } from "@vercel/blob";
import { AGENTS_PREFIX, MAX_AGENTS, type JoinedAgent } from "../src/agents.js";

/** Public list of teams that put their agent on Solvent, newest first. */
export async function GET(): Promise<Response> {
  try {
    const { blobs } = await list({ prefix: AGENTS_PREFIX, limit: MAX_AGENTS });
    const rows = await Promise.all(
      blobs.map(async (b) => {
        try {
          return (await (await fetch(b.url)).json()) as JoinedAgent;
        } catch {
          return undefined;
        }
      }),
    );
    const agents = rows
      .filter((r): r is JoinedAgent => !!r?.wallet && !!r.name)
      .sort((a, b) => b.joinedAt.localeCompare(a.joinedAt));
    return Response.json({ count: agents.length, agents }, { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" } });
  } catch (err) {
    console.error(err);
    return Response.json({ count: 0, agents: [] }, { headers: { "cache-control": "no-store" } });
  }
}
