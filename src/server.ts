import { serve } from "@hono/node-server";
import { env } from "./config.js";
import { FileLedger } from "./ledger.js";
import { ReserveMeter } from "./meter.js";
import { createProxy } from "./proxy.js";
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

// Pick up outside top-ups and any spend the per-call attribution missed.
setInterval(() => {
  meter
    .resync()
    .then((diff) => {
      if (diff > 0) ledger.append({ kind: "compute_topup", usd: 0, meta: { source: "external", reserveCreditUsd: diff / 1e6 } });
      else if (diff < 0) ledger.append({ kind: "thought", usd: diff / 1e6, meta: { via: "reconciliation" } });
    })
    .catch((err) => console.error("solvent: resync failed:", err));
}, 5 * 60_000);

serve({ fetch: app.fetch, hostname: env.SOLVENT_PROXY_HOST, port: env.SOLVENT_PROXY_PORT }, (info) => {
  const base = `http://${env.SOLVENT_PROXY_HOST}:${info.port}`;
  console.log(`Solvent proxy on ${base}  (reserve $${(reserve / 1e6).toFixed(4)})`);
  console.log(`  OpenAI clients:    OPENAI_BASE_URL=${base}/v1   model "auto"`);
  console.log(`  Anthropic clients: ANTHROPIC_BASE_URL=${base}`);
  console.log(`  Public books:      ${base}/solvent/books`);
});
