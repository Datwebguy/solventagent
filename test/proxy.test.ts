import { describe, expect, it } from "vitest";
import { chain, type Entry, type EntryInput } from "../src/ledger.js";
import { ReserveMeter } from "../src/meter.js";
import { createProxy, type LedgerLike } from "../src/proxy.js";

class MemoryLedger implements LedgerLike {
  entries: Entry[] = [];
  all() {
    return this.entries;
  }
  append(input: EntryInput) {
    const e = chain(this.entries[this.entries.length - 1], input);
    this.entries.push(e);
    return e;
  }
}

/** A stand-in for the UsePod gateway: charges 1000 micros per call, can refuse models. */
function fakeUsePod(opts: { balance: number; noProvider?: string[] }) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  let balance = opts.balance;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, headers: init?.headers as Record<string, string>, body });
    if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: "claude-haiku-4-5" }] });
    if (opts.noProvider?.includes(body.model)) {
      return Response.json({ error: { message: `no healthy provider for model: ${body.model}`, type: "no_provider" } }, { status: 503 });
    }
    balance -= 1000;
    if (body.stream) {
      const sse = `data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n`;
      return new Response(sse, { headers: { "content-type": "text/event-stream", "x-pod-route": "marketplace" } });
    }
    return Response.json(
      { choices: [{ message: { content: `answer from ${body.model}` } }], usage: { prompt_tokens: 5, completion_tokens: 7 } },
      { headers: { "x-balance-remaining": String(balance), "x-pod-route": "marketplace", "x-pod-provider-id": "p-1" } },
    );
  }) as typeof fetch;
  return { fetchImpl, calls, balance: () => balance };
}

async function setup(balance: number, extra: { noProvider?: string[]; proxyKey?: string; ledger?: MemoryLedger } = {}) {
  const pod = fakeUsePod({ balance, noProvider: extra.noProvider });
  const ledger = extra.ledger ?? new MemoryLedger();
  const meter = new ReserveMeter(async () => pod.balance());
  await meter.init();
  const app = createProxy({ apiToken: "tok", ledger, meter, proxyKey: extra.proxyKey, upstream: "https://pod.test", fetchImpl: pod.fetchImpl });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { app, pod, ledger, meter, post };
}

const ask = { model: "auto", messages: [{ role: "user", content: "hi" }] };

describe("proxy", () => {
  it("routes 'auto' to the runway tier's model, forwards its price ceiling, and books the cost", async () => {
    const { pod, ledger, post } = await setup(10_000_000); // $10 reserve, no burn yet → thriving
    const res = await post("/v1/chat/completions", ask);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-solvent-tier")).toBe("thriving");
    expect(res.headers.get("x-solvent-cost-usd")).toBe("0.001000");
    const call = pod.calls[0]!;
    expect(call.url).toBe("https://pod.test/proxy/tok/v1/chat/completions");
    expect(call.body.model).toBe("claude-sonnet-4-5");
    expect(call.headers["X-Pod-Max-Price-Output"]).toBe("15000000");
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ kind: "thought", usd: -0.001, meta: { model: "claude-sonnet-4-5", route: "marketplace" } });
  });

  it("clamps max_tokens to the tier limit", async () => {
    const { pod, post } = await setup(10_000_000);
    await post("/v1/chat/completions", { ...ask, max_tokens: 100_000 });
    expect(pod.calls[0]!.body.max_tokens).toBe(4096);
  });

  it("falls back to the next model when UsePod has no provider", async () => {
    const { pod, post } = await setup(10_000_000, { noProvider: ["claude-sonnet-4-5"] });
    const res = await post("/v1/chat/completions", ask);
    expect(res.status).toBe(200);
    expect(pod.calls.map((c) => c.body.model)).toEqual(["claude-sonnet-4-5", "claude-sonnet-4-6"]);
    expect(res.headers.get("x-solvent-model")).toBe("claude-sonnet-4-6");
  });

  it("passes an explicitly requested model through unchanged", async () => {
    const { pod, post } = await setup(10_000_000);
    await post("/v1/chat/completions", { ...ask, model: "gpt-4o-mini" });
    expect(pod.calls[0]!.body.model).toBe("gpt-4o-mini");
  });

  it("goes dormant with 402 and never calls upstream when the reserve is empty", async () => {
    const { pod, ledger, post } = await setup(0);
    const res = await post("/v1/chat/completions", ask);
    expect(res.status).toBe(402);
    expect(((await res.json()) as any).error.type).toBe("insolvent");
    expect(pod.calls).toHaveLength(0);
    expect(ledger.entries).toHaveLength(0);
  });

  it("downgrades to a cheaper tier as runway shrinks", async () => {
    const ledger = new MemoryLedger();
    ledger.append({ kind: "thought", usd: -1 }); // $1/day burn
    const { pod, post } = await setup(2_000_000, { ledger }); // $2 reserve → 2 days → frugal
    const res = await post("/v1/chat/completions", ask);
    expect(res.headers.get("x-solvent-tier")).toBe("frugal");
    expect(pod.calls[0]!.body.model).toBe("deepseek-v4-1-flash");
  });

  it("requires the proxy key when one is configured", async () => {
    const key = "k".repeat(32);
    const { post } = await setup(10_000_000, { proxyKey: key });
    expect((await post("/v1/chat/completions", ask)).status).toBe(401);
    expect((await post("/v1/chat/completions", ask, { Authorization: `Bearer ${"x".repeat(32)}` })).status).toBe(401);
    expect((await post("/v1/chat/completions", ask, { Authorization: `Bearer ${key}` })).status).toBe(200);
    expect((await post("/v1/messages", { ...ask, max_tokens: 10 }, { "x-api-key": key })).status).toBe(200);
  });

  it("streams through and books the thought once the stream ends", async () => {
    const { ledger, post } = await setup(10_000_000);
    const res = await post("/v1/chat/completions", { ...ask, stream: true });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain("[DONE]");
    await new Promise((r) => setTimeout(r, 0));
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ usd: -0.001, meta: { stream: true, usage: { prompt_tokens: 5, completion_tokens: 2 } } });
  });

  it("serves the books publicly", async () => {
    const { app, post } = await setup(10_000_000, { proxyKey: "k".repeat(32) });
    await post("/v1/chat/completions", ask, { Authorization: `Bearer ${"k".repeat(32)}` });
    const b = (await (await app.request("/solvent/books")).json()) as any;
    expect(b).toMatchObject({ thoughts: 1, status: "SOLVENT", ledgerIntact: true });
    expect(b.reserveUsd).toBeCloseTo(9.999);
  });
});
