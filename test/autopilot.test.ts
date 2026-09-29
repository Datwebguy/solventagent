import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "solvent-autopilot-"));
process.env.SOLVENT_DATA_DIR = join(dir, "data");
process.env.BLOB_READ_WRITE_TOKEN = "test-token";

const blobs = new Map<string, string>();
vi.mock("@vercel/blob", () => ({
  head: async (path: string) => {
    if (!blobs.has(path)) throw Object.assign(new Error("Blob not found"), { name: "BlobNotFoundError" });
    return { url: `https://blob.test/${path}` };
  },
  put: async (path: string, body: string) => void blobs.set(path, body),
  list: async () => ({ blobs: [] }),
}));

const realFetch = globalThis.fetch;
const policy = { version: 1, agent: { name: "Solvent", wallet: "8kZBBhPkM9bHhHuUeCzLdNu6eekwTfvNgsF1oPUVZ6YS" }, allocations: { computeReserve: 0.5, ansemReserve: 0.2, operatingCash: 0.2, buyback: 0.1 }, computeReserveTargetDays: 14, caps: { maxTxUsd: 5, maxDayUsd: 10 } };

type Mod = typeof import("../src/autopilot.js");
let m: Mod;
let ledgerLib: typeof import("../src/ledger.js");
beforeAll(async () => {
  process.chdir(dir);
  m = await import("../src/autopilot.js");
  ledgerLib = await import("../src/ledger.js");
});
afterAll(() => void (globalThis.fetch = realFetch));
beforeEach(() => {
  blobs.clear();
  globalThis.fetch = (async (url: string) => {
    const path = String(url).replace("https://blob.test/", "").split("?")[0]!;
    const body = blobs.get(path);
    return body === undefined ? new Response("no", { status: 404 }) : new Response(body);
  }) as typeof fetch;
});

const goodLedger = () => {
  const a = ledgerLib.chain(undefined, { kind: "compute_topup", usd: 0, meta: {} });
  const b = ledgerLib.chain(a, { kind: "income", usd: 0.05, meta: {} });
  return [a, b];
};
const publish = (entries: unknown[], extra: Record<string, string> = {}) => {
  blobs.set("solvent/books.json", JSON.stringify({ policy }));
  blobs.set("solvent/ledger.jsonl", entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  for (const [k, v] of Object.entries(extra)) blobs.set(k, v);
};

describe("timers stand down while the server is publishing", () => {
  it("counts a recent check-in as fresh, and an old or missing one as not", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    expect(m.heartbeatFresh("2026-09-29T11:30:00Z", now)).toBe(true);
    expect(m.heartbeatFresh("2026-09-29T08:00:00Z", now)).toBe(false);
    expect(m.heartbeatFresh(undefined, now)).toBe(false);
    expect(m.heartbeatFresh("nonsense", now)).toBe(false);
    expect(m.heartbeatFresh("2026-09-29T13:00:00Z", now)).toBe(false); // a time in the future is not to be trusted
  });

  it("reads the check-in from storage", async () => {
    expect(await m.serverIsPublishing("t")).toBe(false);
    await m.writeHeartbeat("t");
    expect(await m.serverIsPublishing("t")).toBe(true);
    blobs.set("solvent/state/publisher.json", JSON.stringify({ at: "2020-01-01T00:00:00Z" }));
    expect(await m.serverIsPublishing("t")).toBe(false);
  });
});

describe("starting on a fresh machine", () => {
  it("loads the rules, the whole record and the saved state", async () => {
    publish(goodLedger(), { "solvent/state/treasurer.json": JSON.stringify({ pending: { computeReserve: 0, ansemReserve: 0, buyback: 0 }, cursor: "abc" }) });
    expect(await m.bootstrapFromPublished(() => {})).toBe("loaded");
    expect(readFileSync(join(dir, "data", "ledger.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(dir, "solvent.policy.json"), "utf8")).agent.name).toBe("Solvent");
    expect(JSON.parse(readFileSync(join(dir, "data", "treasurer.json"), "utf8")).cursor).toBe("abc");
  });

  it("leaves an existing ledger alone", async () => {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "ledger.jsonl"), "local\n");
    publish(goodLedger());
    expect(await m.bootstrapFromPublished(() => {})).toBe("already here");
    expect(readFileSync(join(dir, "data", "ledger.jsonl"), "utf8")).toBe("local\n");
  });

  it("refuses a published record that fails its check", async () => {
    writeFileSync(join(dir, "data", "ledger.jsonl"), "");
    const [a, b] = goodLedger();
    publish([a, { ...b, usd: 999 }]);
    await expect(m.bootstrapFromPublished(() => {})).rejects.toThrow(/fails its check/);
  });

  it("says so when nothing is published yet", async () => {
    writeFileSync(join(dir, "data", "ledger.jsonl"), "");
    expect(await m.bootstrapFromPublished(() => {})).toBe("nothing published");
  });
});

describe("turning seal shares into AI budget", () => {
  const rec = (wallet: string, payments: { signature: string; fee: number; at: string }[]) =>
    ({ wallet, usd: 0, total: 0, burned: 0, fee: 0, firstAt: "", updatedAt: "", payments: payments.map((p) => ({ ...p, tier: "bronze", usd: 0.3, burned: p.fee * 4 })) }) as never;

  it("lists shares not yet converted, oldest first, skipping empty ones", () => {
    const records = [
      rec("A", [{ signature: "s2", fee: 0.4, at: "2026-09-29T10:00:00Z" }]),
      rec("B", [{ signature: "s1", fee: 2.8, at: "2026-09-28T10:00:00Z" }, { signature: "s0", fee: 0, at: "2026-09-27T10:00:00Z" }]),
    ];
    expect(m.sealSharesToConvert(records, []).map((s) => s.signature)).toEqual(["s1", "s2"]);
    expect(m.sealSharesToConvert(records, ["s1"]).map((s) => s.signature)).toEqual(["s2"]);
    expect(m.sealSharesToConvert([{ wallet: "C" } as never], [])).toEqual([]);
  });

  const share = (signature: string, ansem: number) => ({ signature, wallet: "A", ansem, at: "2026-09-29T10:00:00Z" });
  it("converts what the wallet holds and what fits the per-transaction cap, in order", () => {
    const plan = m.planSealShares([share("a", 0.4), share("b", 2.8), share("c", 60)], 4, 0.14, 5);
    expect(plan.map((p) => p.signature)).toEqual(["a", "b"]); // "c" is $8.40, over the $5 cap
    expect(plan[1]!.usd).toBeCloseTo(0.392);
  });

  it("waits when the wallet does not hold enough yet", () => {
    expect(m.planSealShares([share("a", 3)], 2.9, 0.14, 5)).toEqual([]);
    expect(m.planSealShares([share("a", 3), share("b", 1)], 3.5, 0.14, 5).map((p) => p.signature)).toEqual(["a"]);
  });
});
