/**
 * Read-only checks against the real services. Needs no wallet and moves no funds.
 *   npx tsx scripts/smoke.ts
 */
import { MINTS } from "../src/config.js";
import { classifyAiPayment } from "../src/aispend.js";
import { classifyInflow } from "../src/income.js";
import { jupQuote } from "../src/jupiter.js";
import { usdPrices } from "../src/prices.js";
import { connection, getParsedTx } from "../src/solana.js";
import { solanaRail, x402Quote } from "../src/usepod/client.js";

// A real ClawPump creator-fee payout (SelfMade by SP3ND, 2026-09-26) and its recipient.
const PAYOUT_SIG = "fYGtvaVPeTxeSEudnMFPzWqr4XrLW5it3s6M5d5f94wtydhLVLogw4VNVWseP6qDnAYwxvSoQioBQW9HBww8YgP";
const PAYOUT_RECIPIENT = "6tKiito8pV8oYgta7odevrgSD1xQhKV8b2VM1kouQmjm";

const checks: [string, () => Promise<string>][] = [
  [
    "prices (Jupiter)",
    async () => {
      const p = await usdPrices([MINTS.SOL, MINTS.ANSEM]);
      return `SOL $${p[MINTS.SOL]?.toFixed(2)}, ANSEM $${p[MINTS.ANSEM]?.toFixed(4)}`;
    },
  ],
  [
    "quote 0.01 SOL → ANSEM",
    async () => {
      const q = await jupQuote(MINTS.SOL, MINTS.ANSEM, 10_000_000n);
      return `${(Number(q.outAmount) / 1e6).toFixed(3)} ANSEM, impact ${q.priceImpactPct}`;
    },
  ],
  [
    "quote 10 ANSEM → USDC",
    async () => {
      const q = await jupQuote(MINTS.ANSEM, MINTS.USDC, 10_000_000n);
      return `$${(Number(q.outAmount) / 1e6).toFixed(4)} USDC (min $${(Number(q.otherAmountThreshold) / 1e6).toFixed(4)})`;
    },
  ],
  [
    "UsePod x402 quote",
    async () => {
      const q = await x402Quote(JSON.stringify({ model: "deepseek-v4-1-flash", max_tokens: 256, messages: [{ role: "user", content: "hi" }] }));
      return `cap $${(solanaRail(q, "USDC").amount_microunits / 1e6).toFixed(6)} for 256 tokens`;
    },
  ],
  [
    "income detector on a real ClawPump payout",
    async () => {
      const tx = await getParsedTx(PAYOUT_SIG, connection());
      if (!tx) throw new Error("payout transaction not found");
      const inflow = classifyInflow(tx, PAYOUT_SIG, PAYOUT_RECIPIENT, new Set());
      if (inflow?.source !== "clawpump_fees") throw new Error(`misclassified: ${JSON.stringify(inflow)}`);
      return `${(inflow.lamports / 1e9).toFixed(6)} SOL classified as clawpump_fees`;
    },
  ],
  [
    "AI-spending detector on Solvent's real UsePod top-ups",
    async () => {
      const wallet = "8kZBBhPkM9bHhHuUeCzLdNu6eekwTfvNgsF1oPUVZ6YS";
      const cases: [string, number][] = [
        ["5RADVjTywDhM7MgxjSxEsqtmaBoZ6p6RS11wrYeq785Ri5gHf3PMgzBFdTrhgxbYrGfMZsiTd6pMRvDsd4GJzgLh", 1.990085],
        ["3enYfmzeXPqnesdvYXguCYNqisCvFWsz3QFZ1YPiHspSRXwhVDg1b8dbjw7UM3baTg2RMtpfGBkgZJ2WMVgXb4vA", 0.985777],
      ];
      for (const [sig, want] of cases) {
        const tx = await getParsedTx(sig, connection());
        const got = tx && classifyAiPayment(tx, wallet, 120);
        if (!got || Math.abs(got.usd - want) > 1e-9) throw new Error(`${sig.slice(0, 8)}: expected $${want}, got ${JSON.stringify(got)}`);
      }
      return "both top-ups read exactly ($1.990085 and $0.985777)";
    },
  ],
];

let failed = 0;
for (const [name, run] of checks) {
  try {
    console.log(`ok   ${name}: ${await run()}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
process.exit(failed ? 1 : 0);
