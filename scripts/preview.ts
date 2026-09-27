/**
 * Local preview of the public site: serves public/ and forwards /api/* to the live deployment.
 *   npx tsx scripts/preview.ts   → http://127.0.0.1:5173  (/__phone shows a 390px-wide frame)
 */
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

const LIVE = process.env.PREVIEW_API ?? "https://solvent-delta.vercel.app";
const app = new Hono();
// The audit runs from local code so new changes can be previewed before deploying.
app.get("/api/audit", async (c) => {
  const { auditWallet } = await import("../src/audit.js");
  try {
    return c.json(await auditWallet(c.req.query("wallet") ?? "", 60));
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});
app.all("/api/*", async (c) => {
  const url = new URL(c.req.url);
  const res = await fetch(`${LIVE}${url.pathname}${url.search}`, {
    method: c.req.method,
    headers: c.req.header("payment-signature") ? { "PAYMENT-SIGNATURE": c.req.header("payment-signature")! } : {},
  });
  // fetch() already decompressed the body, so drop the upstream encoding headers.
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(res.body, { status: res.status, headers });
});
app.get("/__phone", (c) =>
  c.html(`<body style="margin:0;background:#333"><iframe src="/" style="width:390px;height:${c.req.query("h") ?? 3600}px;border:0;display:block"></iframe></body>`),
);
app.get("/", (c) => c.html(readFileSync("public/index.html", "utf8")));
app.get("/agent/:wallet", (c) => c.html(readFileSync("public/agent.html", "utf8")));
app.get("/style.css", (c) => c.body(readFileSync("public/style.css", "utf8"), 200, { "content-type": "text/css" }));
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 5173 }, () => console.log("preview on http://127.0.0.1:5173"));
