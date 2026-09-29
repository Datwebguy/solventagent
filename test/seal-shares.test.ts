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

const { convertSealShares } = await import("../src/seal-shares.js");
const { FileLedger } = await import("../src/ledger.js");

const seal = (payments: { signature: string; fee: number }[]) => ({ wallet: "AgentWallet", payments: payments.map((p) => ({ ...p, at: "2026-09-29T10:00:00Z", tier: "bronze", usd: 0.3, burned: p.fee * 4 })) });
const signer = Keypair.generate();

describe("converting seal shares into AI budget", () => {
  beforeEach(() => {
    deposit.mockReset();
    deposit.mockResolvedValue({ signature: "depositSig", usdcDeposited: 0.28 });
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
});
