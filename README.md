# Solvent

**The CFO for agentic companies.** An AI agent's income (its token's creator fees, plus paid audits) pays for its own inference on [UsePod](https://usepod.ai). It works under a published budget that is enforced in code, and its books are public and verifiable.

- **Pays for its own thinking.** A drop-in OpenAI/Anthropic-compatible proxy pays UsePod from the agent's prepaid compute reserve.
- **Metabolism.** The model tier follows runway. With 14+ days left it uses Sonnet-class models, then Haiku-class, then budget models. When the reserve is empty it goes dormant and the proxy answers HTTP 402 instead of overspending.
- **Treasury cycle.** It detects ClawPump creator-fee payouts on-chain, splits them by policy (compute reserve / $ANSEM reserve / operating cash / buyback), executes via UsePod's deposit program and Jupiter, and anchors the ledger on Solana.
- **$ANSEM pays for thinking.** One atomic transaction sells $ANSEM for USDC and deposits it into the compute reserve.
- **Verifiable books.** Every entry is hash-chained and fingerprints are written on-chain as memos. The public dashboard re-verifies the whole chain in the visitor's browser. Prompts are never stored.
- **Audit any agent.** Free on-chain audit of any agent wallet's fee income. The AI solvency report is sold for $0.05 over x402, and Solvent pays UsePod to write it out of its own reserve.
- **Clawrena Solvency Index.** AnsemHack entries ranked by the creator-fee income their agents actually receive, read from each payout wallet on-chain (`npm run cli index:build`).
- **Feed an agent with $ANSEM.** Anyone can top up Solvent's compute reserve from their own wallet. `/api/feed` builds an unsigned $ANSEM → USDC → UsePod deposit transaction for the visitor to sign.
- **Hard caps.** Per-transaction and per-day spend caps are checked before anything is signed.
- **Private by default.** Publishing the books (treasury address and balances) requires `SOLVENT_PUBLISH=1`. Secrets and local data never go into git or Vercel deploys.

**Live:** https://agentsolvent.vercel.app

## Quick start

```bash
npm install
cp .env.example .env            # add SOLVENT_TREASURY_SECRET (never commit .env)
npm run cli wallet              # treasury address and balances (read-only)
npm run cli usepod:register     # creates the UsePod compute reserve, saves token to .env
npm run cli usepod:deposit 2 --yes
npm run cli think "What should an agent do when its runway drops below 3 days?"
npm run cli status
```

Run the proxy and point any client at it:

```bash
npx tsx src/server.ts
OPENAI_BASE_URL=http://127.0.0.1:8787/v1        # model "auto"
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

The proxy binds to 127.0.0.1. To expose it, set `SOLVENT_PROXY_KEY` (24+ chars); clients then send it as `Authorization: Bearer …` or `x-api-key`.

## Treasury

```bash
npm run cli policy:init              # writes solvent.policy.json (50/20/20/10 split, 14-day reserve target)
npm run cli policy:commit --yes      # policy fingerprint on-chain
npm run cli cycle                    # dry run: income found, plan, no funds moved
npm run cli cycle --yes              # execute
npm run cli topup:ansem 10 --yes     # pay for thinking with 10 $ANSEM
```

In the server, the cycle runs hourly and only executes when `SOLVENT_AUTOPILOT=1`.

Income detection: every ClawPump fee payout sends 12.5% to ClawPump's buyback wallet (`CgzAtK78…`) in the same transaction, so inflows carrying that leg are booked as income. Plain transfers are booked as capital, not income.

## Hermes / claw-agent (MCP)

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  solvent:
    command: npx
    args: ["tsx", "/path/to/solvent/src/mcp.ts"]
```

Point the model provider at the proxy (`http://127.0.0.1:8787/v1`, model `auto`), and add `skills/solvent/SKILL.md` to the agent's skills.

MCP tools: `solvent_books`, `solvent_ledger`, `solvent_policy`, `solvent_plan_cycle`, `solvent_run_cycle`, `solvent_pay_with_ansem`, `solvent_audit_agent`.

## Public site (Vercel)

`public/index.html` plus `api/` (books, ledger, audit, report). The runtime publishes `solvent/books.json` and `solvent/ledger.jsonl` to Vercel Blob (`BLOB_READ_WRITE_TOKEN`). Paid reports need `USEPOD_API_TOKEN`, `SOLVENT_TREASURY_ADDRESS` and `SOLVENT_QUOTE_SECRET` set on the project.

Paid report flow (x402, USDC on Solana):

1. `POST /api/report?wallet=X` returns `402` with a `PAYMENT-REQUIRED` header: an HMAC-signed quote carrying price, `pay_to` and `memo`.
2. Send the USDC to `pay_to` in a transaction that also carries the memo.
3. Repeat the request with `PAYMENT-SIGNATURE: base64({quote_id, signature, payer_wallet})`.

The payment is verified on-chain, and each payment settles exactly one report. Buy one from the CLI with `npm run cli audit:buy <wallet> --base https://<site> --yes`.

## Docker

```bash
docker build -t solvent .
docker run -d --env-file .env -e SOLVENT_PROXY_KEY=<24+ chars> \
  -v "$PWD/data:/data" -v "$PWD/solvent.policy.json:/app/solvent.policy.json" -p 8787:8787 solvent
```

## Tests

```bash
npm test                    # unit tests (spend caps, policy, metabolism, ledger, proxy, treasury, x402)
npx tsx scripts/smoke.ts    # read-only checks against Jupiter, UsePod and a real ClawPump payout
```

## Known limitations

- **Free RPC endpoints.** Audits and the Solvency Index read the chain through free endpoints, so they are rate-limited and slow (about a minute per project in the index). Set `SOLANA_READ_RPC_URLS` (for example a Helius URL) to speed them up.
- **Audits sample recent history.** Audits read a wallet's last 40–60 transactions. The index measures income per payout wallet, so a wallet shared by several agents shows their combined income.
- **Books need the runtime.** The public books only refresh while `src/server.ts` is running with `SOLVENT_PUBLISH=1`.
- **One writer at a time.** Run the CLI's spending commands through the server when it is up (`think` does this automatically).
- **Upstream advisories.** `npm audit` reports advisories in dependencies of `@solana/web3.js` 1.x and `@coral-xyz/anchor` (`bigint-buffer`, `uuid`, `toml`). None of the flagged functions are called with untrusted input here; fixing them requires major upgrades of those libraries.
