import { beforeEach, describe, expect, it, vi } from "vitest";

const sigs = Array.from({ length: 12 }, (_, i) => ({ signature: `sig${i}`, blockTime: 1_800_000_000 + i, err: null }));
const slow = vi.fn(async () => {
  await new Promise((r) => setTimeout(r, 60));
  return null;
});

vi.mock("../src/solana.js", () => ({
  recentSignatures: vi.fn(async () => sigs),
  getParsedTx: (...a: unknown[]) => (slow as (...x: unknown[]) => Promise<null>)(...a),
  solBalance: vi.fn(async () => 1),
  tokenBalance: vi.fn(async () => 0),
}));
vi.mock("../src/prices.js", () => ({ usdPrices: vi.fn(async () => ({})) }));

const { auditWallet } = await import("../src/audit.js");
const wallet = "8kZBBhPkM9bHhHuUeCzLdNu6eekwTfvNgsF1oPUVZ6YS";

describe("audit time budget", () => {
  beforeEach(() => slow.mockClear());

  it("reads everything when there is no budget", async () => {
    const a = await auditWallet(wallet, 12);
    expect(a.scanned.transactions).toBe(12);
    expect(a.scanned.partial).toBeUndefined();
  });

  it("stops early and says so when the budget runs out", async () => {
    // 9s is kept back for balances, so 9.15s leaves about 150ms for reading: 2-3 batches of 3.
    const a = await auditWallet(wallet, 12, Date.now(), { budgetMs: 9_150 });
    expect(a.scanned.partial).toBe(true);
    expect(a.scanned.transactions).toBeGreaterThan(0);
    expect(a.scanned.transactions).toBeLessThan(12);
    expect(a.balances.sol).toBe(1); // balances are still read
  });

  it("returns a partial audit even when the budget is already spent", async () => {
    const a = await auditWallet(wallet, 12, Date.now(), { budgetMs: 100 });
    expect(a.scanned.partial).toBe(true);
    expect(a.scanned.transactions).toBe(0);
  });
});
