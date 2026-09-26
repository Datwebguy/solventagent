import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { auditWallet } from "./audit.js";
import { books } from "./books.js";
import { buyReport } from "./buy.js";
import { put } from "@vercel/blob";
import { ingestInbox, publish } from "./publish.js";
import { buildSolvencyIndex, type SolvencyIndex } from "./solvency-index.js";
import { env, MINTS } from "./config.js";
import { loadPolicy, runCycle } from "./cycle.js";
import { FileLedger } from "./ledger.js";
import { ReserveMeter } from "./meter.js";
import { Policy, policyHash, policyMemo } from "./policy.js";
import { usdPrice } from "./prices.js";
import { createProxy } from "./proxy.js";
import { sendMemo, solscanTx, walletBalances } from "./solana.js";
import {
  listModels,
  registerToken,
  solanaRail,
  tokenBalanceMicros,
  x402Quote,
  x402Settle,
} from "./usepod/client.js";
import { depositFromToken, depositSol, depositUsdc, payX402Rail } from "./usepod/pay.js";
import { loadTreasury } from "./wallet.js";

const [, , cmd, ...args] = process.argv;
const flag = (name: string) => args.includes(`--${name}`);
const positional = args.filter((a) => !a.startsWith("--"));
const ledger = new FileLedger();

function requireToken(): string {
  if (!env.USEPOD_API_TOKEN) throw new Error("USEPOD_API_TOKEN is not set. Run: npm run cli usepod:register");
  return env.USEPOD_API_TOKEN;
}

function requireYes(action: string) {
  if (!flag("yes")) throw new Error(`${action} moves real funds. Re-run with --yes to confirm.`);
}

const commands: Record<string, () => Promise<void>> = {
  /** Public key and balances of the treasury wallet (read-only). */
  async wallet() {
    const kp = loadTreasury();
    const b = await walletBalances(kp.publicKey);
    const solUsd = b.sol * (await usdPrice(MINTS.SOL));
    console.log({ address: kp.publicKey.toBase58(), sol: b.sol, solUsd: +solUsd.toFixed(2), usdc: b.usdc });
  },

  /** Free: asks UsePod for an x402 price quote without paying. */
  async "usepod:quote"() {
    const prompt = positional[0] ?? "What is Solana?";
    const q = await x402Quote(JSON.stringify({ model: "gpt-4o-mini", max_tokens: 64, messages: [{ role: "user", content: prompt }] }));
    const usdc = solanaRail(q, "USDC");
    const sol = solanaRail(q, "SOL");
    console.log({ quoteId: q.quote_id, capUsdc: usdc.amount_microunits / 1e6, capLamports: sol.amount_microunits, payTo: usdc.pay_to });
  },

  /** Mints a UsePod prepaid token and saves it to .env (the token is a bearer secret). */
  async "usepod:register"() {
    if (env.USEPOD_API_TOKEN) throw new Error("USEPOD_API_TOKEN already set in .env; refusing to overwrite");
    const r = await registerToken();
    appendFileSync(".env", `\nUSEPOD_API_TOKEN=${r.apiToken}\nUSEPOD_DEPOSIT_CODE=${r.depositCode}\n`);
    console.log(`Registered UsePod token ${r.apiToken.slice(0, 8)}… (saved to .env). Deposit code saved too.`);
  },

  async "usepod:balance"() {
    console.log({ reserveUsd: (await tokenBalanceMicros(requireToken())) / 1e6 });
  },

  async "usepod:models"() {
    console.log((await listModels(requireToken())).join("\n"));
  },

  /** Tops up the compute reserve on-chain: usepod:deposit 2 [--sol] --yes (--sol swaps SOL→USDC in the same tx) */
  async "usepod:deposit"() {
    const usd = Number(positional[0]);
    if (!(usd > 0)) throw new Error("usage: usepod:deposit <usd> [--sol] --yes");
    requireYes("usepod:deposit");
    if (!env.USEPOD_DEPOSIT_CODE) throw new Error("USEPOD_DEPOSIT_CODE is not set");
    if (flag("sol")) {
      const lamports = BigInt(Math.floor((usd / (await usdPrice(MINTS.SOL))) * 1e9));
      const r = await depositSol(loadTreasury(), env.USEPOD_DEPOSIT_CODE, lamports);
      const e = ledger.append({ kind: "compute_topup", usd: 0, txSig: r.signature, meta: { amountUsd: usd, from: "SOL", usdcMinOut: r.usdcMinOut } });
      console.log(`Deposited ~$${usd} of SOL into the compute reserve: ${solscanTx(r.signature)} (ledger #${e.seq})`);
      return;
    }
    const sig = await depositUsdc(loadTreasury(), env.USEPOD_DEPOSIT_CODE, usd);
    const e = ledger.append({ kind: "compute_topup", usd: 0, txSig: sig, meta: { amountUsd: usd, from: "USDC" } });
    console.log(`Deposited $${usd} into the compute reserve: ${solscanTx(sig)} (ledger #${e.seq})`);
  },

  /** One thought through the same code path as the proxy: paid from the reserve, model chosen by runway. */
  async think() {
    const prompt = positional[0];
    if (!prompt) throw new Error('usage: think "<prompt>"');
    const token = requireToken();
    const meter = new ReserveMeter(() => tokenBalanceMicros(token));
    await meter.init();
    const app = createProxy({ apiToken: token, ledger, meter });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: prompt }] }),
    });
    const body = (await res.json()) as any;
    if (res.status !== 200) throw new Error(`${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
    console.log(body?.choices?.[0]?.message?.content);
    await app.drain();
    const booked = ledger.head();
    console.log({
      tier: res.headers.get("x-solvent-tier"),
      model: res.headers.get("x-solvent-model"),
      costUsd: booked?.kind === "thought" ? -booked.usd : undefined,
      costSettled: booked?.meta?.costSettled,
      reserveUsd: meter.reserveUsd,
      runwayDays: res.headers.get("x-solvent-runway-days"),
      ledger: booked?.seq,
    });
  },

  /** One thought paid per request via x402, straight from the wallet on-chain. */
  async "think:x402"() {
    const prompt = positional[0];
    if (!prompt) throw new Error('usage: think:x402 "<prompt>" [--sol] --yes');
    requireYes("think:x402");
    const kp = loadTreasury();
    const asset = flag("sol") ? "SOL" : "USDC";
    const bodyStr = JSON.stringify({ model: "gpt-4o-mini", max_tokens: 256, messages: [{ role: "user", content: prompt }] });
    const q = await x402Quote(bodyStr);
    const rail = solanaRail(q, asset);
    const sig = await payX402Rail(kp, rail);
    const res = await x402Settle(bodyStr, {
      quoteId: q.quote_id,
      network: rail.network,
      asset,
      payerWallet: kp.publicKey.toBase58(),
      signature: sig,
    });
    if (res.status !== 200) throw new Error(`UsePod ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
    const capUsd = asset === "USDC" ? rail.amount_microunits / 1e6 : (rail.amount_microunits / 1e9) * (await usdPrice(MINTS.SOL));
    const e = ledger.append({ kind: "thought", usd: -capUsd, txSig: sig, meta: { rail: "x402", asset, quoteId: q.quote_id, usage: res.usage } });
    console.log(res.body?.choices?.[0]?.message?.content);
    console.log({ paidCapUsd: capUsd, tx: solscanTx(sig), ledger: e.seq });
  },

  /** Writes solvent.policy.json for this treasury (default split: 50/20/20/10). */
  async "policy:init"() {
    if (existsSync("solvent.policy.json")) throw new Error("solvent.policy.json already exists");
    const policy: Policy = {
      version: 1,
      agent: { name: "Solvent", wallet: loadTreasury().publicKey.toBase58() },
      allocations: { computeReserve: 0.5, ansemReserve: 0.2, operatingCash: 0.2, buyback: 0.1 },
      computeReserveTargetDays: 14,
      caps: { maxTxUsd: env.SOLVENT_MAX_TX_USD, maxDayUsd: env.SOLVENT_MAX_DAY_USD },
    };
    writeFileSync("solvent.policy.json", JSON.stringify(Policy.parse(policy), null, 2) + "\n");
    console.log(`Wrote solvent.policy.json (hash ${policyHash(policy)})`);
  },

  /** Commits the policy hash on-chain so anyone can verify the published rules. */
  async "policy:commit"() {
    requireYes("policy:commit");
    const policy = loadPolicy();
    const sig = await sendMemo(loadTreasury(), policyMemo(policy));
    const e = ledger.append({ kind: "policy_commit", usd: 0, txSig: sig, meta: { hash: policyHash(policy) } });
    console.log(`Policy ${policyHash(policy)} committed: ${solscanTx(sig)} (ledger #${e.seq})`);
  },

  /** Treasury cycle. Dry run by default; --yes executes. */
  async cycle() {
    const r = await runCycle({ execute: flag("yes") });
    if (!r.executed) console.log("Dry run only. Re-run with --yes to execute.");
  },

  /** Tops up the compute reserve by selling $ANSEM: npm run cli topup:ansem <ansem> --yes */
  async "topup:ansem"() {
    const amount = Number(positional[0]);
    if (!(amount > 0)) throw new Error("usage: topup:ansem <ANSEM amount> --yes [--record-source]");
    requireYes("topup:ansem");
    if (!env.USEPOD_DEPOSIT_CODE) throw new Error("USEPOD_DEPOSIT_CODE is not set");
    const decimals = 6; // pump.fun tokens use 6 decimals
    const usd = amount * (await usdPrice(MINTS.ANSEM));
    const r = await depositFromToken(loadTreasury(), env.USEPOD_DEPOSIT_CODE, MINTS.ANSEM, BigInt(Math.round(amount * 10 ** decimals)), usd, flag("record-source"));
    const e = ledger.append({ kind: "compute_topup", usd: 0, txSig: r.signature, meta: { amountUsd: usd, from: "ANSEM", ansem: amount, usdcDeposited: r.usdcDeposited } });
    console.log(`Paid for thinking with ${amount} ANSEM (~$${usd.toFixed(4)}): ${solscanTx(r.signature)} (ledger #${e.seq})`);
  },

  /** Free on-chain audit of any agent wallet (read-only). */
  async audit() {
    const wallet = positional[0];
    if (!wallet) throw new Error("usage: audit <wallet>");
    console.log(JSON.stringify(await auditWallet(wallet), null, 2));
  },

  /** Buys a paid AI solvency report from a Solvent site over x402: audit:buy <wallet> --base <url> --yes */
  async "audit:buy"() {
    const wallet = positional[0];
    const base = args[args.indexOf("--base") + 1];
    if (!wallet || !args.includes("--base") || !base) throw new Error("usage: audit:buy <wallet> --base <https://site> --yes");
    requireYes("audit:buy");
    const { result, paymentTx } = await buyReport(loadTreasury(), base, wallet);
    console.log(result.report?.markdown);
    console.log({ paid: solscanTx(paymentTx), model: result.report?.model, reportCostUsd: result.report?.costUsd });
  },

  /** Publishes the books and ledger to the public dashboard and books any paid-audit sales. */
  async publish() {
    const booked = await ingestInbox(ledger);
    const reserve = env.USEPOD_API_TOKEN ? (await tokenBalanceMicros(env.USEPOD_API_TOKEN)) / 1e6 : 0;
    const urls = await publish(ledger, reserve);
    console.log({ bookedSales: booked, ...urls });
  },

  /** Builds the Clawrena Solvency Index from the chain, publishing after every project: index:build [limit] */
  async "index:build"() {
    const canPublish = env.SOLVENT_PUBLISH && env.BLOB_READ_WRITE_TOKEN;
    const save = async (index: SolvencyIndex) => {
      await put("solvent/index.json", JSON.stringify(index), {
        access: "public",
        allowOverwrite: true,
        addRandomSuffix: false,
        cacheControlMaxAge: 60,
        contentType: "application/json",
        token: env.BLOB_READ_WRITE_TOKEN,
      });
    };
    const index = await buildSolvencyIndex(Number(positional[0] ?? 25), (s) => console.log(s), canPublish ? save : undefined);
    console.log(canPublish ? `published ${index.entries.length} entries` : JSON.stringify(index, null, 2));
  },

  /** Books: reserve, burn, runway, status, and ledger integrity. */
  async status() {
    const reserve = env.USEPOD_API_TOKEN ? (await tokenBalanceMicros(env.USEPOD_API_TOKEN)) / 1e6 : 0;
    console.log(books(ledger.all(), reserve));
  },
};

const run = commands[cmd ?? ""];
if (!run) {
  console.log(`commands: ${Object.keys(commands).join(", ")}`);
  process.exit(cmd ? 1 : 0);
}
run().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
