import { head, list, put } from "@vercel/blob";
import { PublicKey } from "@solana/web3.js";
import { AGENTS_PREFIX, cleanJoin, MAX_AGENTS, type JoinedAgent } from "../src/agents.js";
import { withRetry, readConnection } from "../src/solana.js";

/**
 * Puts a team's agent on Solvent's public list: POST /api/join {wallet, name, handle}.
 * The wallet must be a real Solana address with on-chain history. Nothing is signed or moved.
 */
export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send the form as JSON." }, { status: 400 });
  }
  if (body.website) return Response.json({ ok: true }); // hidden field only bots fill in
  const cleaned = cleanJoin(body);
  if (!cleaned.ok) return Response.json({ error: cleaned.error }, { status: 400 });
  const { wallet, name, handle } = cleaned.value;

  const pathname = `${AGENTS_PREFIX}${wallet}.json`;
  try {
    const existing = await head(pathname).catch(() => undefined);
    if (existing) return Response.json({ ok: true, already: true, wallet });

    const { blobs } = await list({ prefix: AGENTS_PREFIX, limit: MAX_AGENTS + 1 });
    if (blobs.length >= MAX_AGENTS) return Response.json({ error: "The list is full for now. Please message us on X." }, { status: 503 });

    let sigs;
    try {
      sigs = await withRetry(() => readConnection().getSignaturesForAddress(new PublicKey(wallet), { limit: 1 }), 3);
    } catch {
      return Response.json({ error: "We couldn't reach Solana just now. Please try again in a minute." }, { status: 503 });
    }
    if (!sigs.length) {
      return Response.json({ error: "We found no activity on that wallet. Use the wallet that receives your agent's token earnings." }, { status: 400 });
    }

    const record: JoinedAgent = { wallet, name, handle, joinedAt: new Date().toISOString() };
    try {
      await put(pathname, JSON.stringify(record), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: "application/json",
      });
    } catch (err) {
      // Two sign-ups for one wallet at the same moment: the second finds the first already saved.
      if (await head(pathname).catch(() => undefined)) return Response.json({ ok: true, already: true, wallet });
      throw err;
    }
    return Response.json({ ok: true, wallet });
  } catch (err) {
    console.error(err);
    return Response.json({ error: "Something went wrong saving your sign-up. Please try again." }, { status: 500 });
  }
}
