/**
 * Solvent's hosted MCP server: lets any agent (Claude, Cursor, an ElizaOS or Hermes agent...)
 * check other agents, read the ranking and buy a Solvent Seal, with no install and no account.
 * It is served at /mcp by api/mcp.ts. Everything here is public data; nothing moves funds. The
 * only transaction it builds is unsigned, for the agent to sign with its own wallet.
 */
import { head } from "@vercel/blob";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { auditWallet } from "./audit.js";
import { env } from "./config.js";
import { buildSealTransaction, TIERS, tierFor, type SealRecord, type TierName } from "./seal.js";
import { confirmSealPayment, readSeals } from "./seal-store.js";
import { SEALS_PREFIX } from "./seal.js";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (err: unknown) => ({ isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] });

function wallet(value: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error("wallet is not a valid Solana address");
  }
}

async function readPublic<T>(path: string): Promise<T> {
  const blob = await head(path);
  const res = await fetch(`${blob.url}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} is not available right now`);
  return (await res.json()) as T;
}

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "solvent", version: "0.1.0" },
    {
      instructions:
        "Solvent shows whether an AI agent pays its own way, from public Solana records. Use solvent_check_agent before you pay, hire or lend to another agent. Use solvent_seal_quote to earn a Solvent Seal for your own agent: it returns an unsigned transaction that your agent's wallet signs and submits, then solvent_seal_confirm records it. Nothing here holds funds or keys.",
    },
  );

  server.registerTool(
    "solvent_check_agent",
    {
      title: "Check an agent",
      description:
        "Reads any agent wallet on Solana and reports what it earns from its token (ClawPump creator fees), what it pays for AI (to UsePod), its profit over the last 7 days, holdings, and whether it holds a Solvent Seal. Status is SOLVENT, AT RISK, NO AI COSTS SEEN or NO ACTIVITY. Takes up to about 45 seconds; long histories are read partially and marked partial.",
      inputSchema: { wallet: z.string().min(32).max(44).describe("The agent's payout wallet (the one that receives its token earnings)") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ wallet: w }) => {
      try {
        wallet(w);
        const [audit, seals] = await Promise.all([auditWallet(w, 60, Date.now(), { budgetMs: 45_000 }), readSeals().catch(() => undefined)]);
        const seal = seals?.seals[w] ?? null;
        return json({ ...audit, seal });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "solvent_ranking",
    {
      title: "Ranking of agents by earnings",
      description: "The Solvent ranking: agents on the ClawPump leaderboard ordered by what their tokens really earn per day, with whether each was seen paying for its own AI and any Solvent Seal. Refreshed twice a day.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(25) },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      try {
        const [idx, seals] = await Promise.all([
          readPublic<{ generatedAt: string; entries: { rank: number; name: string; ticker: string; mint: string; payoutWallet: string | null; audit: { status: string; feeIncome: { avgPerDayUsd: number; last7dUsd: number }; aiSpend: { payments: number } } | null }[] }>("solvent/index.json"),
          readSeals().catch(() => undefined),
        ]);
        const agents = idx.entries
          .filter((e) => e.audit && e.payoutWallet && e.audit.feeIncome.avgPerDayUsd > 0)
          .sort((a, b) => b.audit!.feeIncome.avgPerDayUsd - a.audit!.feeIncome.avgPerDayUsd)
          .slice(0, limit)
          .map((e, i) => ({
            rank: i + 1,
            name: e.name,
            ticker: e.ticker,
            wallet: e.payoutWallet,
            earnedPerDayUsd: e.audit!.feeIncome.avgPerDayUsd,
            earned7dUsd: e.audit!.feeIncome.last7dUsd,
            seenPayingForAi: e.audit!.aiSpend.payments > 0,
            status: e.audit!.status,
            seal: seals?.seals[e.payoutWallet!]?.tier ?? null,
          }));
        return json({ updatedAt: idx.generatedAt, agents });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "solvent_own_books",
    {
      title: "Solvent's own books",
      description: "Solvent's public books: thinking budget, earned, spent on AI, profit, wallet, and the rules it follows. Solvent is itself an agent that pays for its own AI.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return json(await readPublic("solvent/books.json"));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "solvent_seal_status",
    {
      title: "Seal status",
      description: "Whether a wallet holds a Solvent Seal (bronze, silver or gold), how much $ANSEM it has paid in and burned. The seal shows as lit only while the agent is earning; use solvent_check_agent for that.",
      inputSchema: { wallet: z.string().min(32).max(44) },
      annotations: { readOnlyHint: true },
    },
    async ({ wallet: w }) => {
      try {
        wallet(w);
        const blob = await head(`${SEALS_PREFIX}${w}.json`).catch(() => undefined);
        if (!blob) return json({ wallet: w, seal: null });
        const r = (await (await fetch(`${blob.url}?t=${Date.now()}`, { cache: "no-store" })).json()) as SealRecord;
        return json({ wallet: w, seal: tierFor(r.usd ?? 0), paidUsd: r.usd, ansemPaid: r.total, ansemBurned: r.burned, since: r.firstAt });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "solvent_seal_quote",
    {
      title: "Get a seal: unsigned transaction",
      description: `Prices a Solvent Seal in dollars (${TIERS.map((t) => `${t.name} $${t.usd}`).join(", ")}), works out the exact $ANSEM at the live price, and returns an UNSIGNED transaction locked for 10 minutes. The agent's own wallet must sign and submit it to Solana: it burns 80% of the $ANSEM and sends 20% to Solvent's AI budget. Then call solvent_seal_confirm with the signature. The wallet must hold enough $ANSEM. This tool moves no funds.`,
      inputSchema: { wallet: z.string().min(32).max(44).describe("The agent's own wallet, which will sign and pay"), tier: z.enum(["bronze", "silver", "gold"]) },
      annotations: { readOnlyHint: true },
    },
    async ({ wallet: w, tier }) => {
      try {
        if (!env.SOLVENT_TREASURY_ADDRESS || !env.SOLVENT_QUOTE_SECRET) throw new Error("seals are not configured");
        const r = await buildSealTransaction(wallet(w), tier as TierName, new PublicKey(env.SOLVENT_TREASURY_ADDRESS), env.SOLVENT_QUOTE_SECRET);
        return json({
          transactionBase64: Buffer.from(r.transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64"),
          format: "legacy Solana transaction, unsigned; deserialize, sign with the wallet, send",
          tier: r.tier,
          priceUsd: r.usd,
          ansem: Number(r.total) / 1e6,
          burn: Number(r.burn) / 1e6,
          toSolventAiBudget: Number(r.fee) / 1e6,
          expiresAt: new Date(r.quote.e * 1000).toISOString(),
          next: "Sign and submit the transaction, wait for it to confirm, then call solvent_seal_confirm with the signature.",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "solvent_seal_confirm",
    {
      title: "Confirm a seal payment",
      description: "Checks a submitted seal transaction on-chain (signed by the wallet, exact quoted amount, 80% burned, 20% to Solvent) and records the seal. Safe to call again with the same signature.",
      inputSchema: { wallet: z.string().min(32).max(44), signature: z.string().min(80).max(90) },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ wallet: w, signature }) => {
      try {
        wallet(w);
        return json({ ok: true, ...(await confirmSealPayment(w, signature)) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
