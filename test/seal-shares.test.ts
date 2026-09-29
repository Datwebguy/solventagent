import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SOLVENT_DATA_DIR = join(mkdtempSync(join(tmpdir(), "solvent-shares-")), "data");
process.env.USEPOD_DEPOSIT_CODE = "0123456789abcdef";
process.env.BLOB_READ_WRITE_TOKEN = "t";

const records = vi.hoisted(() => ({ value: [] as unknown[] }));
const deposit = vi.hoisted(() => vi.fn());
vi.mock("../src/autopilot.js", async (orig) => ({ ...(await orig<typeof import("../src/autopilot.js")>()), readSealRecords: async () => records.value }));
vi.mock("../src/solana.js", async (orig) => ({ ...(await orig<typeof import("../src/solana.js")>()), tokenBalance: async () => 10 }));
vi.mock("../src/prices.js", () => ({ usdPrice: async () => 0.14, usdPrices: async () => ({}) }));
vi.mock("../src/usepod/pay.js", () => ({ depositFromToken: deposit }));
const swap = vi.hoisted(() => vi.fn());
const quote = vi.hoisted(() => vi.fn());
vi.mock("../src/jupiter.js", () => ({ jupQuote: quote, jupSwap: swap }));

const { convertSealShares } = await import("../src/seal-shares.js");
const { FileLedger } = await import("../src/ledger.js");
const { env } = await import("../src/config.js");
const { splitSealShare } = await import("../src/seal-shares.js");

const seal = (payments: { signature: string; fee: number }[]) => ({ wallet: "AgentWallet", payments: payments.map((p) => ({ ...p, at: "2026-09-29T10:00:00Z", tier: "bronze", usd: 0.3, burned: p.fee * 4 })) });
const signer = Keypair.generate();

describe("converting seal shares into AI budget", () => {
  beforeEach(() => {
    deposit.mockReset();
    deposit.mockResolvedValue({ signature: "depositSig", usdcDeposited: 0.28 });
    swap.mockReset();
    swap.mockResolvedValue("swapSig");
    quote.mockReset();
    quote.mockImplementation(async (_in: string, _out: string, amount: bigint) => ({ inAmount: String(amount), outAmount: "123" }));
    env.SOLVENT_TOKEN_MINT = undefined;
  });

  it("deposits the share, books it as income and as a top-up, and marks it done", async () => {
    records.value = [seal([{ signature: "sealSig1", fee: 0.4 }])];
    const ledger = new FileLedger();
    const r = await convertSealShares(signer, ledger, [], () => {});
    expect(r.done).toEqual(["sealSig1"]);
    expect(deposit).toHaveBeenCalledTimes(1);
    expect(deposit.mock.calls[0]![3]).toBe(400_000n); // 0.4 $ANSEM in base units
    const kinds = ledger.all().map((e) => e.kind);
    expect(kinds).toEqual(["income", "compute_topup"]);
    expect(ledger.all()[0]).toMatchObject({ txSig: "sealSig1", meta: { source: "seal_share" } });
  });

  it("never converts the same share twice, even if the saved state missed it", async () => {
    records.value = [seal([{ signature: "sealSig2", fee: 0.4 }])];
    const ledger = new FileLedger();
    await convertSealShares(signer, ledger, [], () => {});
    deposit.mockClear();
    const again = await convertSealShares(signer, ledger, [], () => {}); // state forgot; the ledger remembers
    expect(again.done).toEqual([]);
    expect(deposit).not.toHaveBeenCalled();
  });

  it("leaves a share for the next cycle when the deposit fails", async () => {
    records.value = [seal([{ signature: "sealSig3", fee: 0.4 }])];
    deposit.mockRejectedValue(new Error("network down"));
    const ledger = new FileLedger();
    const before = ledger.all().length;
    const r = await convertSealShares(signer, ledger, [], () => {});
    expect(r.done).toEqual([]);
    expect(r.failures[0]!.error).toMatch(/network down/);
    expect(ledger.all()).toHaveLength(before); // nothing booked
  });

  it("does nothing when there are no shares", async () => {
    records.value = [];
    const r = await convertSealShares(signer, new FileLedger(), [], () => {});
    expect(r).toEqual({ done: [], txs: [], failures: [] });
    expect(deposit).not.toHaveBeenCalled();
  });

  describe("once $SOLVENT exists", () => {
    const MINT = "DXSrhYfkyEdjH2W4QrMTR9vbY4813eyKchyCYbEsf5AL";
    beforeEach(() => {
      env.SOLVENT_TOKEN_MINT = MINT;
    });

    it("splits a share in half without losing a unit", () => {
      expect(splitSealShare(400_000n, true)).toEqual({ ai: 200_000n, buy: 200_000n });
      expect(splitSealShare(400_001n, true)).toEqual({ ai: 200_001n, buy: 200_000n });
      expect(splitSealShare(400_000n, false)).toEqual({ ai: 400_000n, buy: 0n });
    });

    it("pays for AI with half and buys $SOLVENT with the other half", async () => {
      records.value = [seal([{ signature: "splitSig1", fee: 0.4 }])];
      const ledger = new FileLedger();
      const before = ledger.all().length;
      const r = await convertSealShares(signer, ledger, [], () => {});
      expect(r.done).toEqual(["splitSig1"]);
      expect(deposit.mock.calls[0]![3]).toBe(200_000n);
      expect(quote).toHaveBeenCalledWith(expect.any(String), MINT, 200_000n);
      const added = ledger.all().slice(before);
      expect(added.map((e) => e.kind)).toEqual(["income", "compute_topup", "buyback"]);
      expect(added[0]).toMatchObject({ txSig: "splitSig1", meta: { split: true } });
      expect(added[2]).toMatchObject({ txSig: "swapSig", meta: { sealSig: "splitSig1", to: MINT } });
      expect(added[2]!.usd).toBeCloseTo(-0.028);
    });

    it("when the buy fails, retries only the buy next cycle and never pays for AI twice", async () => {
      records.value = [seal([{ signature: "splitSig2", fee: 0.4 }])];
      swap.mockRejectedValueOnce(new Error("slippage"));
      const ledger = new FileLedger();
      const first = await convertSealShares(signer, ledger, [], () => {});
      expect(first.done).toEqual([]);
      expect(first.failures[0]!.error).toMatch(/slippage/);
      deposit.mockClear();
      const second = await convertSealShares(signer, ledger, [], () => {});
      expect(second.done).toEqual(["splitSig2"]);
      expect(deposit).not.toHaveBeenCalled();
      expect(swap).toHaveBeenCalledTimes(2);
      const third = await convertSealShares(signer, ledger, [], () => {});
      expect(third.done).toEqual([]);
    });

    it("leaves shares booked before the split alone", async () => {
      records.value = [seal([{ signature: "oldSig", fee: 0.4 }])];
      const ledger = new FileLedger();
      ledger.append({ kind: "income", usd: 0.056, txSig: "oldSig", meta: { source: "seal_share" } });
      const r = await convertSealShares(signer, ledger, [], () => {});
      expect(r.done).toEqual([]);
      expect(deposit).not.toHaveBeenCalled();
      expect(swap).not.toHaveBeenCalled();
    });

    it("waits when the wallet does not hold enough, or a half is over the per-payment cap", async () => {
      records.value = [seal([{ signature: "bigSig", fee: 80 }])]; // $11.20, each half $5.60 > $5 cap
      const r = await convertSealShares(signer, new FileLedger(), [], () => {});
      expect(r.done).toEqual([]);
      expect(deposit).not.toHaveBeenCalled();
    });
  });
});
