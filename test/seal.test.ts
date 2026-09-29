import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { MINTS } from "../src/config.js";
import { addPayment, ansemUnitsFor, readSealQuote, sealActive, signSealQuote, splitAmount, tierFor, verifySealTx } from "../src/seal.js";

const wallet = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const other = "8kZBBhPkM9bHhHuUeCzLdNu6eekwTfvNgsF1oPUVZ6YS";
const treasury = "8kZBBhPkM9bHhHuUeCzLdNu6eekwTfvNgsF1oPUVZ6YS";
const secret = "s".repeat(40);
const T0 = 1_800_000_000; // the transaction's block time
const treasuryAta = getAssociatedTokenAddressSync(new PublicKey(MINTS.ANSEM), new PublicKey(treasury), true, TOKEN_2022_PROGRAM_ID).toBase58();

type Ix = { program: string; parsed: unknown };
const burn = (amount: string, authority = wallet, mint: string = MINTS.ANSEM): Ix => ({ program: "spl-token", parsed: { type: "burnChecked", info: { authority, mint, tokenAmount: { amount } } } });
const send = (amount: string, destination = treasuryAta, authority = wallet): Ix => ({
  program: "spl-token",
  parsed: { type: "transferChecked", info: { authority, mint: MINTS.ANSEM, destination, tokenAmount: { amount } } },
});
const memo = (id: string): Ix => ({ program: "spl-memo", parsed: `solvent-seal:${id}` });
const tx = (instructions: Ix[], opts: { signer?: string; err?: unknown; blockTime?: number } = {}) =>
  ({
    meta: { err: opts.err ?? null },
    blockTime: opts.blockTime ?? T0,
    transaction: { message: { accountKeys: [{ pubkey: new PublicKey(opts.signer ?? wallet), signer: true }], instructions } },
  }) as never;
/** A signed quote for `a` base units, issued a minute before the transaction. */
const quote = (a: string, w = wallet, t: "bronze" | "silver" | "gold" = "bronze", u = 0.3) => signSealQuote({ w, t, u, a }, secret, T0 - 60).id;
const good = (a = "2000000") => {
  const { burn: b, fee } = splitAmount(BigInt(a));
  return [burn(b.toString()), send(fee.toString()), memo(quote(a))];
};

describe("seal tiers, priced in dollars", () => {
  it("gives the highest tier a dollar total reaches", () => {
    expect(tierFor(0.29)).toBeNull();
    expect(tierFor(0.3)).toBe("bronze");
    expect(tierFor(1.99)).toBe("bronze");
    expect(tierFor(2)).toBe("silver");
    expect(tierFor(4.99)).toBe("silver");
    expect(tierFor(5)).toBe("gold");
    expect(tierFor(50)).toBe("gold");
  });

  it("turns a dollar price into $ANSEM at the live price, rounded up to a hundredth", () => {
    expect(ansemUnitsFor(0.3, 0.144)).toBe(2_090_000n); // 2.0833 -> 2.09
    expect(ansemUnitsFor(2, 0.144)).toBe(13_890_000n); // 13.8889 -> 13.89
    expect(ansemUnitsFor(5, 0.144)).toBe(34_730_000n); // 34.7222 -> 34.73
    for (const [usd, price] of [[0.3, 0.144], [2, 0.09], [5, 0.31], [5, 0.0007]] as const) {
      const value = (Number(ansemUnitsFor(usd, price)) / 1e6) * price;
      expect(value).toBeGreaterThanOrEqual(usd - 1e-9); // never charges less than the tier
      expect(value).toBeLessThan(usd + 0.011 * price + 1e-9); // and never more than a hundredth over
    }
    expect(() => ansemUnitsFor(5, 0)).toThrow(/price/);
  });

  it("splits 80% to burn and 20% to Solvent without losing a unit", () => {
    for (const n of [2_090_000n, 13_890_000n, 34_730_000n, 1_000_003n]) {
      const { burn: b, fee } = splitAmount(n);
      expect(b + fee).toBe(n);
      expect(b).toBe((n * 8n) / 10n);
    }
  });
});

describe("seal is only lit while the agent is earning", () => {
  const audit = (status: string, last7dUsd: number) => ({ status, feeIncome: { last7dUsd } });
  it("lights for an earning agent", () => {
    expect(sealActive(audit("SOLVENT", 10))).toBe(true);
    expect(sealActive(audit("NO AI COSTS SEEN", 10))).toBe(true);
  });
  it("goes out when it stops earning, is at risk, or has no activity", () => {
    expect(sealActive(audit("NO AI COSTS SEEN", 0))).toBe(false);
    expect(sealActive(audit("AT RISK", 10))).toBe(false);
    expect(sealActive(audit("NO ACTIVITY", 0))).toBe(false);
    expect(sealActive(null)).toBe(false);
  });
});

describe("the signed price quote", () => {
  it("reads back what was signed", () => {
    const { id } = signSealQuote({ w: wallet, t: "gold", u: 5, a: "34730000" }, secret, 1000);
    expect(readSealQuote(id, secret, 1001)).toMatchObject({ w: wallet, t: "gold", u: 5, a: "34730000" });
  });
  it("rejects a tampered quote, a wrong secret and an expired quote", () => {
    const { id } = signSealQuote({ w: wallet, t: "gold", u: 5, a: "34730000" }, secret, 1000);
    const [payload, mac] = id.split(".") as [string, string];
    const cheaper = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), a: "1" })).toString("base64url");
    expect(() => readSealQuote(`${cheaper}.${mac}`, secret, 1001)).toThrow(/signature/);
    expect(() => readSealQuote(id, "x".repeat(40), 1001)).toThrow(/signature/);
    expect(() => readSealQuote(id, secret, 1000 + 601)).toThrow(/expired/);
    expect(() => readSealQuote("nonsense", secret)).toThrow(/malformed/);
  });
});

describe("verifying a seal payment on-chain", () => {
  it("accepts the exact quoted amount, split 80/20, paid by the wallet", () => {
    expect(verifySealTx(tx(good()), wallet, treasury, secret)).toEqual({ burned: 1.6, fee: 0.4, tier: "bronze", usd: 0.3 });
  });

  it("rejects a payment signed by another wallet, and a quote issued to another wallet", () => {
    expect(() => verifySealTx(tx(good(), { signer: other }), wallet, treasury, secret)).toThrow(/own wallet/);
    const b = splitAmount(2_000_000n);
    expect(() => verifySealTx(tx([burn(b.burn.toString()), send(b.fee.toString()), memo(quote("2000000", other))]), wallet, treasury, secret)).toThrow(/another wallet/);
  });

  it("rejects a failed or missing transaction", () => {
    expect(() => verifySealTx(null, wallet, treasury, secret)).toThrow(/not found/);
    expect(() => verifySealTx(tx(good(), { err: { InstructionError: [0, "x"] } }), wallet, treasury, secret)).toThrow(/failed/);
  });

  it("rejects a payment with no quote, a forged quote, or an expired one", () => {
    const b = splitAmount(2_000_000n);
    const noMemo = [burn(b.burn.toString()), send(b.fee.toString())];
    expect(() => verifySealTx(tx(noMemo), wallet, treasury, secret)).toThrow(/quote/);
    const forged = signSealQuote({ w: wallet, t: "gold", u: 5, a: "2000000" }, "y".repeat(40), T0 - 60).id;
    expect(() => verifySealTx(tx([...noMemo, memo(forged)]), wallet, treasury, secret)).toThrow(/signature/);
    const late = signSealQuote({ w: wallet, t: "bronze", u: 0.3, a: "2000000" }, secret, T0 - 700).id; // expired at T0 - 100
    expect(() => verifySealTx(tx([...noMemo, memo(late)]), wallet, treasury, secret)).toThrow(/expired/);
  });

  it("rejects paying less than the quote, or more", () => {
    const less = splitAmount(1_000_000n);
    expect(() => verifySealTx(tx([burn(less.burn.toString()), send(less.fee.toString()), memo(quote("2000000"))]), wallet, treasury, secret)).toThrow(/not the amount quoted/);
    const more = splitAmount(3_000_000n);
    expect(() => verifySealTx(tx([burn(more.burn.toString()), send(more.fee.toString()), memo(quote("2000000"))]), wallet, treasury, secret)).toThrow(/not the amount quoted/);
  });

  it("rejects a wrong split, or a share sent somewhere else", () => {
    expect(() => verifySealTx(tx([burn("1000000"), send("1000000"), memo(quote("2000000"))]), wallet, treasury, secret)).toThrow(/split/);
    expect(() => verifySealTx(tx([burn("2000000"), memo(quote("2000000"))]), wallet, treasury, secret)).toThrow(/not the amount quoted|split/);
    expect(() => verifySealTx(tx([burn("1600000"), send("400000", wallet), memo(quote("2000000"))]), wallet, treasury, secret)).toThrow(/not the amount quoted/);
  });

  it("ignores burns of other tokens and burns by other authorities", () => {
    const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    expect(() => verifySealTx(tx([burn("1600000", wallet, usdc), send("400000"), memo(quote("2000000"))]), wallet, treasury, secret)).toThrow(/no \$ANSEM burn/);
    expect(() => verifySealTx(tx([burn("1600000", other), send("400000"), memo(quote("2000000"))]), wallet, treasury, secret)).toThrow(/no \$ANSEM burn/);
  });
});

describe("seal record", () => {
  const pay = (signature: string, usd: number, burned: number, fee: number) => ({ signature, tier: "bronze" as const, usd, burned, fee, at: "2026-09-29T10:00:00.000Z" });
  it("adds payments up and never counts one signature twice", () => {
    let r = addPayment(undefined, wallet, pay("a", 0.3, 1.6, 0.4));
    r = addPayment(r, wallet, pay("a", 0.3, 1.6, 0.4));
    r = addPayment(r, wallet, pay("b", 2, 11.1, 2.8));
    expect(r.usd).toBeCloseTo(2.3);
    expect(r.total).toBeCloseTo(15.9);
    expect(r.payments).toHaveLength(2);
    expect(tierFor(r.usd)).toBe("silver");
  });
});
