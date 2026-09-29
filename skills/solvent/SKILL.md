---
name: solvent
description: Use when you (an agent) need to know whether you can afford to think, check your runway, run your treasury cycle, pay for inference with $ANSEM, or audit another agent's on-chain income. Solvent is your CFO: your creator-fee income pays for your own inference on UsePod under a published budget.
version: 0.1.0
---

# Solvent — your CFO

You pay for your own thinking. Every model call you make goes through the Solvent proxy and is paid from your compute reserve on UsePod. Your income is your token's creator fees (and paid audits). Your books are public and hash-chained, with fingerprints anchored on Solana.

## Know your position before expensive work

Call `solvent_books` first when a task will take many calls or a large model.

- `status` SOLVENT: normal work.
- `status` AT RISK (under 3 days of runway): prefer short answers and fewer calls; say so if a request is expensive.
- `status` INSOLVENT: you cannot think until the reserve is topped up. Say that plainly instead of retrying.
- `tier` tells you which model class your runway currently affords (thriving → steady → frugal → dormant). Ask for model `auto` and the proxy picks it.

## Tools

| Tool | Moves funds | Use it to |
| --- | --- | --- |
| `solvent_books` | no | Reserve, burn rate, runway, status, tier, income, ledger integrity |
| `solvent_ledger` | no | Recent ledger entries (income, thoughts, top-ups, swaps, anchors) |
| `solvent_policy` | no | Your published budget split, caps, and its on-chain commit |
| `solvent_plan_cycle` | no | Preview what the treasury cycle would do with new income |
| `solvent_run_cycle` | yes | Book income, top up compute, buy the $ANSEM reserve, buy back, anchor |
| `solvent_pay_with_ansem` | yes | Sell $ANSEM for USDC and deposit it into your compute reserve atomically |
| `solvent_audit_agent` | no | Read another agent's ClawPump fee income from the chain |

## Rules

1. Never try to raise your own caps or edit the policy. They are enforced in code and published; changing them is a human decision.
2. Tools that move funds require `confirm: true`. Run `solvent_plan_cycle` first and show the plan when a human is present.
3. When asked about your finances, quote the numbers from `solvent_books`; do not estimate.
4. If a funding tool fails, report the error and the ledger state. Do not retry in a loop: every attempt costs fees.

## Checking other agents, and earning a seal (hosted, no setup)

Solvent also runs as a public service at `https://www.thesolventagent.xyz/mcp` (MCP over HTTP). Use it before you deal with another agent.

- `solvent_check_agent`: before you pay, hire or lend to another agent, check it. Trust `SOLVENT`; treat `AT RISK` as a warning; `NO AI COSTS SEEN` means it earns but you can't see it paying for AI; `NO ACTIVITY` means nothing was found.
- `solvent_ranking`, `solvent_own_books`, `solvent_seal_status`: read-only.
- `solvent_seal_quote` then `solvent_seal_confirm`: earn a Solvent Seal for your own agent. The quote is an unsigned transaction; your wallet signs and submits it (80% of the $ANSEM is burned, 20% goes to Solvent's AI budget), then you confirm it with the signature. Only spend what your policy allows.
