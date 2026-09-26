import type { Audit } from "./audit.js";
import { DEFAULT_TIERS } from "./metabolism.js";
import { chat, tokenBalanceMicros } from "./usepod/client.js";

const SYSTEM = `You are Solvent, the CFO for agentic companies on Solana.
Write a short solvency report (max 180 words, markdown) about the agent wallet described in the JSON.
Use only numbers present in the JSON; never invent figures. Cover:
1. Income: ClawPump creator-fee payouts, run-rate per day, last 7 days.
2. Holdings.
3. What the income can pay for in thinking (thoughtsPerDay by tier).
4. A one-line verdict: is this agent able to fund its own inference from its own income?
Note that on-chain income is visible but compute spend is not, unless the agent publishes Solvent books.`;

export interface Report {
  markdown: string;
  model: string;
  costUsd: number;
}

/** Writes the narrative report with UsePod, paid from Solvent's own reserve. */
export async function writeReport(audit: Audit, apiToken: string): Promise<Report> {
  const tier = DEFAULT_TIERS.find((t) => t.name === "steady")!;
  const before = await tokenBalanceMicros(apiToken);
  for (const model of tier.models) {
    const res = await chat(
      apiToken,
      {
        model,
        max_tokens: 600,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: JSON.stringify(audit) },
        ],
      },
      { ceiling: tier.ceiling },
    );
    if (res.status === 503) continue;
    if (res.status !== 200) throw new Error(`report generation failed: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    // UsePod settles shortly after answering; wait briefly for the charge to show.
    let after = res.balanceRemainingMicros ?? before;
    for (const ms of [0, 750, 1500, 3000]) {
      if (after < before) break;
      if (ms) await new Promise((r) => setTimeout(r, ms));
      after = await tokenBalanceMicros(apiToken);
    }
    return {
      markdown: String(res.body?.choices?.[0]?.message?.content ?? ""),
      model,
      costUsd: Math.max(0, before - after) / 1e6,
    };
  }
  throw new Error("no model available for the report");
}
