/**
 * Solvent MCP server (stdio). Gives an agent (Hermes / claw-agent, Claude, Cursor…) awareness
 * of its own books and control of its treasury, within the published policy and hard caps.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { auditWallet } from "./audit.js";
import { books } from "./books.js";
import { env, MINTS } from "./config.js";
import { loadPolicy, runCycle } from "./cycle.js";
import { FileLedger } from "./ledger.js";
import { policyHash } from "./policy.js";
import { usdPrice } from "./prices.js";
import { solscanTx } from "./solana.js";
import { tokenBalanceMicros } from "./usepod/client.js";
import { depositFromToken } from "./usepod/pay.js";
import { loadTreasury } from "./wallet.js";

const ledger = new FileLedger();
const server = new McpServer({ name: "solvent", version: "0.1.0" });

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
});
const reserveUsd = async () => (env.USEPOD_API_TOKEN ? (await tokenBalanceMicros(env.USEPOD_API_TOKEN)) / 1e6 : 0);

server.registerTool(
  "solvent_books",
  {
    title: "My books",
    description:
      "Your own financial state: compute reserve, burn rate, days of thinking left (runway), SOLVENT / AT RISK / INSOLVENT status, current model tier, income, and whether the ledger's hash chain is intact. Check this before expensive work.",
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      return json(books(ledger.all(), await reserveUsd()));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "solvent_ledger",
  {
    title: "Recent ledger entries",
    description: "The most recent entries in your hash-chained ledger: income, thoughts, top-ups, swaps, buybacks, anchors. Each has a hash linking it to the previous one.",
    inputSchema: { limit: z.number().int().min(1).max(200).default(20) },
    annotations: { readOnlyHint: true },
  },
  async ({ limit }) => json(ledger.all().slice(-limit)),
);

server.registerTool(
  "solvent_policy",
  {
    title: "My spending policy",
    description: "Your published budget policy (how income is split, reserve target, hard caps), its hash, and the on-chain transaction that committed it, if any.",
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const policy = loadPolicy();
      const commit = [...ledger.all()].reverse().find((e) => e.kind === "policy_commit" && e.meta?.hash === policyHash(policy));
      return json({ policy, hash: policyHash(policy), committedTx: commit?.txSig ? solscanTx(commit.txSig) : null });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "solvent_plan_cycle",
  {
    title: "Plan a treasury cycle (dry run)",
    description: "Reads new creator-fee income and shows what the treasury cycle would do under your policy. Moves no funds.",
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const lines: string[] = [];
      const r = await runCycle({ execute: false, log: (s) => lines.push(s) });
      return json({ log: lines, plan: r.plan });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "solvent_run_cycle",
  {
    title: "Run the treasury cycle",
    description:
      "Executes the treasury cycle: books new income, tops up the compute reserve, buys the $ANSEM reserve, runs buybacks, and anchors the ledger on-chain. Moves real funds within the published policy and hard caps. Requires confirm=true.",
    inputSchema: { confirm: z.boolean() },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async ({ confirm }) => {
    if (!confirm) return fail("Refusing to move funds without confirm=true. Use solvent_plan_cycle to preview.");
    try {
      const lines: string[] = [];
      const r = await runCycle({ execute: true, log: (s) => lines.push(s) });
      return json({ log: lines, txs: r.txs.map((t) => ({ ...t, url: solscanTx(t.signature) })), failures: r.failures });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "solvent_pay_with_ansem",
  {
    title: "Pay for thinking with $ANSEM",
    description:
      "Sells the given amount of $ANSEM for USDC and deposits it into your UsePod compute reserve in one atomic transaction. Moves real funds within hard caps. Requires confirm=true.",
    inputSchema: { ansem: z.number().positive(), confirm: z.boolean() },
  },
  async ({ ansem, confirm }) => {
    if (!confirm) return fail("Refusing to move funds without confirm=true.");
    try {
      if (!env.USEPOD_DEPOSIT_CODE) throw new Error("USEPOD_DEPOSIT_CODE is not set");
      const usd = ansem * (await usdPrice(MINTS.ANSEM));
      const r = await depositFromToken(loadTreasury(), env.USEPOD_DEPOSIT_CODE, MINTS.ANSEM, BigInt(Math.round(ansem * 1e6)), usd);
      const e = ledger.append({ kind: "compute_topup", usd: 0, txSig: r.signature, meta: { amountUsd: usd, from: "ANSEM", ansem, usdcDeposited: r.usdcDeposited } });
      return json({ ansem, usdcDeposited: r.usdcDeposited, tx: solscanTx(r.signature), ledgerSeq: e.seq });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "solvent_audit_agent",
  {
    title: "Audit another agent",
    description:
      "Public, read-only audit of any agent wallet on Solana: ClawPump creator-fee income found on-chain, run-rate per day, holdings, and how many thoughts per day that income can fund at each model tier.",
    inputSchema: { wallet: z.string().min(32).max(44) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ wallet }) => {
    try {
      return json(await auditWallet(wallet));
    } catch (err) {
      return fail(err);
    }
  },
);

await server.connect(new StdioServerTransport());
