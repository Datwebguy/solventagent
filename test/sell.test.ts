import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { MINTS } from "../src/config.js";
import { makeQuoteId, quoteMemo, readQuoteId, verifyPayment, type QuoteClaims } from "../src/sell.js";

const SECRET = "s".repeat(40);
const T = "Treasury1111111111111111111111111111111111";

describe("paid-audit quotes", () => {
  it("round-trips a signed quote", () => {
    const { id, claims } = makeQuoteId({ w: "Wallet1", a: 50_000, p: T }, SECRET);
    expect(readQuoteId(id, SECRET)).toEqual(claims);
  });

  it("rejects a quote signed with another secret", () => {
    const { id } = makeQuoteId({ w: "Wallet1", a: 50_000, p: T }, SECRET);
    expect(() => readQuoteId(id, "x".repeat(40))).toThrow(/signature/);
  });

  it("rejects a quote whose price was edited", () => {
    const { id } = makeQuoteId({ w: "Wallet1", a: 50_000, p: T }, SECRET);
    const [payload, mac] = id.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    claims.a = 1;
    const forged = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${mac}`;
    expect(() => readQuoteId(forged, SECRET)).toThrow(/signature/);
  });

  it("rejects an expired quote", () => {
    const { id } = makeQuoteId({ w: "Wallet1", a: 50_000, p: T }, SECRET, 1_000);
    expect(() => readQuoteId(id, SECRET, 1_000 + 16 * 60)).toThrow(/expired/);
  });
});

function paymentTx(opts: { memo?: string; received: number; err?: unknown }): ParsedTransactionWithMeta {
  const bal = (amount: number) => [{ owner: T, mint: MINTS.USDC, uiTokenAmount: { amount: String(amount) } }];
  return {
    meta: { err: opts.err ?? null, preTokenBalances: bal(1_000), postTokenBalances: bal(1_000 + opts.received), innerInstructions: [] },
    transaction: {
      message: { instructions: opts.memo ? [{ program: "spl-memo", programId: {}, parsed: opts.memo }] : [] },
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe("verifyPayment", () => {
  const claims: QuoteClaims = { w: "Wallet1", a: 50_000, p: T, e: 9_999_999_999, n: "abcd1234abcd1234" };

  it("accepts a confirmed payment with the memo and enough USDC", () => {
    expect(() => verifyPayment(paymentTx({ memo: quoteMemo(claims), received: 50_000 }), claims)).not.toThrow();
  });

  it("rejects a payment without the quote memo", () => {
    expect(() => verifyPayment(paymentTx({ received: 50_000 }), claims)).toThrow(/memo/);
    expect(() => verifyPayment(paymentTx({ memo: "solvent:quote:other", received: 50_000 }), claims)).toThrow(/memo/);
  });

  it("rejects an underpayment", () => {
    expect(() => verifyPayment(paymentTx({ memo: quoteMemo(claims), received: 49_999 }), claims)).toThrow(/too small/);
  });

  it("rejects a failed or missing transaction", () => {
    expect(() => verifyPayment(paymentTx({ memo: quoteMemo(claims), received: 50_000, err: { InstructionError: [0, "x"] } }), claims)).toThrow(/failed/);
    expect(() => verifyPayment(null, claims)).toThrow(/not found/);
  });
});
