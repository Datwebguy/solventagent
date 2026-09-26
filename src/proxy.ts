import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { books } from "./books.js";
import { burnUsdPerDay, type Entry, type EntryInput } from "./ledger.js";
import { DEFAULT_TIERS, pickTier, runwayDays, type Tier } from "./metabolism.js";
import type { ReserveMeter } from "./meter.js";
import { USEPOD_API } from "./usepod/client.js";

export interface LedgerLike {
  all(): Entry[];
  append(input: EntryInput): Entry;
}

export interface ProxyOptions {
  apiToken: string;
  ledger: LedgerLike;
  meter: ReserveMeter;
  tiers?: Tier[];
  /** When set, callers must present it as a Bearer token or x-api-key. */
  proxyKey?: string;
  upstream?: string;
  fetchImpl?: typeof fetch;
  /** Balance checks after each call while waiting for UsePod to settle it. */
  settleDelaysMs?: number[];
}

type Surface = "openai" | "anthropic";
const AUTO_MODELS = new Set(["auto", "solvent"]);

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Pulls the last `"usage":{...}` object out of a stream tail, if the upstream sent one. */
function usageFromTail(tail: string): unknown {
  const matches = [...tail.matchAll(/"usage":(\{[^{}]*\})/g)];
  const last = matches[matches.length - 1]?.[1];
  if (!last) return undefined;
  try {
    return JSON.parse(last);
  } catch {
    return undefined;
  }
}

/**
 * OpenAI- and Anthropic-compatible proxy that pays for every call from the agent's
 * UsePod reserve, chooses the model tier from runway, and books each thought.
 */
export function createProxy(opts: ProxyOptions): Hono & { drain(): Promise<void> } {
  const tiers = opts.tiers ?? DEFAULT_TIERS;
  const upstream = opts.upstream ?? USEPOD_API;
  const doFetch = opts.fetchImpl ?? fetch;
  const app = new Hono();

  let burnCache = { at: 0, value: 0 };
  const burn = () => {
    if (Date.now() - burnCache.at > 30_000) burnCache = { at: Date.now(), value: burnUsdPerDay(opts.ledger.all()) };
    return burnCache.value;
  };

  // UsePod settles a call shortly after answering, so poll the balance before booking.
  const pending = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>) => {
    const guarded = p.catch((err) => console.error("solvent: failed to book thought:", err));
    pending.add(guarded);
    void guarded.finally(() => pending.delete(guarded));
    return guarded;
  };
  const settleDelaysMs = opts.settleDelaysMs ?? [0, 750, 1500, 3000, 5000];
  async function settleThenBook(immediate: number): Promise<{ micros: number; settled: boolean }> {
    if (immediate > 0) return { micros: immediate, settled: true };
    for (const ms of settleDelaysMs) {
      if (ms) await new Promise((r) => setTimeout(r, ms));
      const spent = await opts.meter.settle();
      if (spent > 0) return { micros: spent, settled: true };
    }
    // Not visible yet; the periodic resync books any late charge as a reconciliation entry.
    return { micros: 0, settled: false };
  }

  const authorized = (c: Context) => {
    if (!opts.proxyKey) return true;
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const apiKey = c.req.header("x-api-key");
    return [bearer, apiKey].some((k) => k != null && sameSecret(k, opts.proxyKey!));
  };

  const book = (surface: Surface, tier: Tier, model: string, spentMicros: number, res: Response, extra: Record<string, unknown>) => {
    burnCache.at = 0;
    return opts.ledger.append({
      kind: "thought",
      usd: -spentMicros / 1e6,
      meta: {
        via: "proxy",
        surface,
        tier: tier.name,
        model,
        route: res.headers.get("x-pod-route") ?? undefined,
        provider: res.headers.get("x-pod-provider-id") ?? undefined,
        ...extra,
      },
    });
  };

  const outHeaders = (res: Response, tier: Tier, model: string, runway: number) => {
    const h = new Headers();
    for (const name of ["content-type", "x-pod-route", "x-pod-provider-id"]) {
      const v = res.headers.get(name);
      if (v) h.set(name, v);
    }
    h.set("x-solvent-tier", tier.name);
    h.set("x-solvent-model", model);
    h.set("x-solvent-runway-days", Number.isFinite(runway) ? runway.toFixed(2) : "unlimited");
    return h;
  };

  async function handle(c: Context, surface: Surface) {
    if (!authorized(c)) return c.json({ error: { type: "unauthorized", message: "missing or wrong Solvent proxy key" } }, 401);
    let body: Record<string, any>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: "invalid_request", message: "body must be JSON" } }, 400);
    }

    const runway = runwayDays(opts.meter.reserveUsd, burn());
    const tier = pickTier(runway, tiers);
    if (tier.name === "dormant" || tier.models.length === 0) {
      return c.json(
        {
          error: {
            type: "insolvent",
            message: `Solvent: the compute reserve is empty ($${opts.meter.reserveUsd.toFixed(4)}). Top it up to resume thinking.`,
          },
        },
        402,
      );
    }

    const candidates = !body.model || AUTO_MODELS.has(String(body.model)) ? tier.models : [String(body.model)];
    const tokenKey = surface === "openai" && body.max_completion_tokens != null ? "max_completion_tokens" : "max_tokens";
    body[tokenKey] = Math.min(Number(body[tokenKey] ?? tier.maxTokens) || tier.maxTokens, tier.maxTokens);
    const streaming = body.stream === true;

    const url = `${upstream}/proxy/${opts.apiToken}${surface === "openai" ? "/v1/chat/completions" : "/v1/messages"}`;
    const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "solvent-proxy/0.1" };
    if (tier.ceiling.maxInputMicros != null) headers["X-Pod-Max-Price-Input"] = String(tier.ceiling.maxInputMicros);
    if (tier.ceiling.maxOutputMicros != null) headers["X-Pod-Max-Price-Output"] = String(tier.ceiling.maxOutputMicros);
    if (surface === "anthropic") headers["anthropic-version"] = c.req.header("anthropic-version") ?? "2023-06-01";

    opts.meter.begin();
    let ended = false;
    const end = () => {
      if (!ended) {
        ended = true;
        opts.meter.end();
      }
    };

    try {
      let res: Response | undefined;
      let model = candidates[0]!;
      for (const [i, m] of candidates.entries()) {
        model = m;
        res = await doFetch(url, { method: "POST", headers, body: JSON.stringify({ ...body, model: m }) });
        const last = i === candidates.length - 1;
        if (res.status !== 503 || last) break;
        const peek = await res.clone().text();
        if (!peek.includes("no_provider")) break;
      }
      if (!res) throw new Error("no upstream response");
      const out = outHeaders(res, tier, model, runway);

      if (streaming && res.ok && res.body) {
        const decoder = new TextDecoder();
        let tail = "";
        const response = res;
        const counted = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, ctl) {
            ctl.enqueue(chunk);
            tail = (tail + decoder.decode(chunk, { stream: true })).slice(-8192);
          },
          flush() {
            track(
              settleThenBook(0).then((spent) =>
                book(surface, tier, model, spent.micros, response, { stream: true, usage: usageFromTail(tail), costSettled: spent.settled }),
              ),
            ).finally(end);
          },
        });
        return new Response(res.body.pipeThrough(counted), { status: res.status, headers: out });
      }

      const text = await res.text();
      if (res.ok) {
        const h = res.headers.get("x-balance-remaining");
        const immediate = h != null && h !== "" ? opts.meter.observe(Number(h)) : 0;
        let usage: unknown;
        try {
          usage = JSON.parse(text)?.usage;
        } catch {
          usage = undefined;
        }
        // Answer now; book the cost once UsePod's settlement shows up in the balance.
        track(
          settleThenBook(immediate).then((spent) => book(surface, tier, model, spent.micros, res, { stream: false, usage, costSettled: spent.settled })),
        ).finally(end);
      } else {
        end();
      }
      return new Response(text, { status: res.status, headers: out });
    } catch (err) {
      end();
      return c.json({ error: { type: "upstream_error", message: err instanceof Error ? err.message : String(err) } }, 502);
    }
  }

  app.post("/v1/chat/completions", (c) => handle(c, "openai"));
  app.post("/v1/messages", (c) => handle(c, "anthropic"));

  app.get("/v1/models", async (c) => {
    if (!authorized(c)) return c.json({ error: { type: "unauthorized" } }, 401);
    const res = await doFetch(`${upstream}/proxy/${opts.apiToken}/v1/models`);
    const j = (await res.json().catch(() => ({ data: [] }))) as { data?: unknown[] };
    return c.json({ object: "list", data: [{ id: "auto", object: "model", owned_by: "solvent" }, ...(j.data ?? [])] });
  });

  // The books are public by design.
  app.get("/solvent/books", (c) => c.json(books(opts.ledger.all(), opts.meter.reserveUsd, tiers)));
  app.get("/health", (c) => c.json({ ok: true }));

  /** Resolves once every answered call has had its cost booked. */
  const drain = async () => {
    while (pending.size) await Promise.all([...pending]);
  };
  return Object.assign(app, { drain });
}
