import { appendFileSync } from "node:fs";
import { env, MINTS } from "./config.js";
import { FileLedger, burnUsdPerDay, verifyChain } from "./ledger.js";
import { pickTier, runwayDays, solvencyStatus } from "./metabolism.js";
import { usdPrice } from "./prices.js";
import { solscanTx, walletBalances } from "./solana.js";
import {
  chat,
  listModels,
  registerToken,
  solanaRail,
  tokenBalanceMicros,
  x402Quote,
  x402Settle,
} from "./usepod/client.js";
import { depositUsdc, payX402Rail } from "./usepod/pay.js";
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

  /** Tops up the compute reserve on-chain: npm run cli usepod:deposit 2 --yes */
  async "usepod:deposit"() {
    const usd = Number(positional[0]);
    if (!(usd > 0)) throw new Error("usage: usepod:deposit <usd> --yes");
    requireYes("usepod:deposit");
    if (!env.USEPOD_DEPOSIT_CODE) throw new Error("USEPOD_DEPOSIT_CODE is not set");
    const sig = await depositUsdc(loadTreasury(), env.USEPOD_DEPOSIT_CODE, usd);
    const e = ledger.append({ kind: "compute_topup", usd: -usd, txSig: sig, meta: { venue: "usepod" } });
    console.log(`Deposited $${usd} into the compute reserve: ${solscanTx(sig)} (ledger #${e.seq})`);
  },

  /** One thought, paid from the prepaid reserve, with the model chosen by runway. */
  async think() {
    const prompt = positional[0];
    if (!prompt) throw new Error('usage: think "<prompt>"');
    const token = requireToken();
    const reserveBefore = (await tokenBalanceMicros(token)) / 1e6;
    const runway = runwayDays(reserveBefore, burnUsdPerDay(ledger.all()));
    const tier = pickTier(runway);
    if (tier.name === "dormant") throw new Error(`Dormant: reserve $${reserveBefore.toFixed(4)} cannot fund thinking`);
    const res = await chat(
      token,
      { model: tier.model, max_tokens: tier.maxTokens, messages: [{ role: "user", content: prompt }] },
      { ceiling: tier.ceiling },
    );
    if (res.status !== 200) throw new Error(`UsePod ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
    const after = res.balanceRemainingMicros != null ? res.balanceRemainingMicros / 1e6 : reserveBefore;
    const cost = Math.max(0, reserveBefore - after);
    const e = ledger.append({
      kind: "thought",
      usd: -cost,
      meta: { tier: tier.name, model: tier.model, route: res.route, provider: res.providerId, usage: res.usage },
    });
    console.log(res.body?.choices?.[0]?.message?.content);
    console.log({ tier: tier.name, model: tier.model, costUsd: cost, reserveUsd: after, runwayDays: runway, ledger: e.seq });
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

  /** Books: reserve, burn, runway, status, and ledger integrity. */
  async status() {
    const entries = ledger.all();
    const broken = verifyChain(entries);
    const reserve = env.USEPOD_API_TOKEN ? (await tokenBalanceMicros(env.USEPOD_API_TOKEN)) / 1e6 : 0;
    const burn = burnUsdPerDay(entries);
    const runway = runwayDays(reserve, burn);
    console.log({
      reserveUsd: reserve,
      burnUsdPerDay: +burn.toFixed(6),
      runwayDays: Number.isFinite(runway) ? +runway.toFixed(1) : "∞",
      status: solvencyStatus(runway),
      tier: pickTier(runway).name,
      ledgerEntries: entries.length,
      ledgerIntact: broken === -1 ? true : `broken at #${broken}`,
    });
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
