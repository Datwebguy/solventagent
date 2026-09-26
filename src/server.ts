import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { env } from "./config.js";
import { runCycle } from "./cycle.js";
import { FileLedger } from "./ledger.js";
import { ReserveMeter } from "./meter.js";
import { createProxy } from "./proxy.js";
import { ingestInbox, publish } from "./publish.js";
import { tokenBalanceMicros } from "./usepod/client.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

if (!env.USEPOD_API_TOKEN) {
  console.error("USEPOD_API_TOKEN is not set. Run: npm run cli usepod:register");
  process.exit(1);
}
if (!LOOPBACK.has(env.SOLVENT_PROXY_HOST) && !env.SOLVENT_PROXY_KEY) {
  console.error("Refusing to bind a non-loopback host without SOLVENT_PROXY_KEY: anyone could spend the reserve.");
  process.exit(1);
}

const token = env.USEPOD_API_TOKEN;
const ledger = new FileLedger();
const meter = new ReserveMeter(() => tokenBalanceMicros(token));
const reserve = await meter.init();

const app = createProxy({ apiToken: token, ledger, meter, proxyKey: env.SOLVENT_PROXY_KEY });

const log = (s: string) => console.log(`[${new Date().toISOString()}] ${s}`);

// Pick up outside top-ups and any spend the per-call attribution missed.
setInterval(() => {
  meter
    .resync()
    .then((diff) => {
      if (diff > 0) {
        // A top-up booked by the CLI or the cycle in the last 15 minutes is not an outside credit.
        const since = Date.now() - 15 * 60_000;
        const bookedRecently = ledger.all().some((e) => e.kind === "compute_topup" && e.txSig && Date.parse(e.ts) >= since);
        if (!bookedRecently) ledger.append({ kind: "compute_topup", usd: 0, meta: { source: "external", reserveCreditUsd: diff / 1e6 } });
      }
      else if (diff < 0) ledger.append({ kind: "thought", usd: diff / 1e6, meta: { via: "reconciliation" } });
    })
    .catch((err) => log(`resync failed: ${err}`));
}, 5 * 60_000);

// Publish the books when they change (and at least every 10 minutes), booking paid-audit sales first.
if (env.BLOB_READ_WRITE_TOKEN && env.SOLVENT_PUBLISH) {
  let lastHead: string | undefined;
  let lastAt = 0;
  const tick = async () => {
    try {
      const sales = await ingestInbox(ledger);
      if (sales) log(`booked ${sales} paid audit sale(s)`);
      const head = ledger.head()?.hash;
      if (head !== lastHead || Date.now() - lastAt > 10 * 60_000) {
        await publish(ledger, meter.reserveUsd);
        lastHead = head;
        lastAt = Date.now();
      }
    } catch (err) {
      log(`publish failed: ${err instanceof Error ? err.message : err}`);
    }
  };
  void tick();
  setInterval(tick, 2 * 60_000);
}

// Hourly treasury cycle. It only moves funds when SOLVENT_AUTOPILOT=1; otherwise it logs the plan.
if (existsSync("solvent.policy.json")) {
  const cycle = async () => {
    try {
      const r = await runCycle({ execute: env.SOLVENT_AUTOPILOT, log });
      for (const t of r.txs) if (t.kind === "compute_topup") await meter.resync();
    } catch (err) {
      log(`cycle failed: ${err instanceof Error ? err.message : err}`);
    }
  };
  setTimeout(cycle, 30_000);
  setInterval(cycle, 60 * 60_000);
}

serve({ fetch: app.fetch, hostname: env.SOLVENT_PROXY_HOST, port: env.SOLVENT_PROXY_PORT }, (info) => {
  const base = `http://${env.SOLVENT_PROXY_HOST}:${info.port}`;
  console.log(`Solvent proxy on ${base}  (reserve $${(reserve / 1e6).toFixed(4)})`);
  console.log(`  OpenAI clients:    OPENAI_BASE_URL=${base}/v1   model "auto"`);
  console.log(`  Anthropic clients: ANTHROPIC_BASE_URL=${base}`);
  console.log(`  Public books:      ${base}/solvent/books`);
});
