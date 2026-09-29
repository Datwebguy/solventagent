import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { MINTS } from "../src/config.js";
import { addPayment, sealActive, splitAmount, tierFor, verifySealTx } from "../src/seal.js";

const wallet = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const treasury = "8kZBBhPkM9bHhHuUeCzLdNu6eekwTfvNgsF1oPUVZ6YS";
const treasuryAta = getAssociatedTokenAddressSync(new PublicKey(MINTS.ANSEM), new PublicKey(treasury), true, TOKEN_2022_PROGRAM_ID).toBase58();

type Ix = { program: string; parsed: { type: string; info: Record<string, unknown> } };
const burn = (amount: string, authority = wallet, mint: string = MINTS.ANSEM): Ix => ({ program: "spl-token", parsed: { type: "burnChecked", info: { authority, mint, tokenAmount: { amount } } } });
const send = (amount: string, destination = treasuryAta, authority = wallet, mint: string = MINTS.ANSEM): Ix => ({
  program: "spl-token",
  parsed: { type: "transferChecked", info: { authority, mint, destination, tokenAmount: { amount } } },
});
const tx = (instructions: Ix[], opts: { signer?: string; err?: unknown } = {}) =>
  ({
    meta: { err: opts.err ?? null },
    blockTime: 1_800_000_000,
    transaction: { message: { accountKeys: [{ pubkey: new PublicKey(opts.signer ?? wallet), signer: true }], instructions } },
  }) as never;

describe("seal tiers and split", () => {
  it("gives the highest tier reached, none below the first", () => {
    expect(tierFor(0.99)).toBeNull();
    expect(tierFor(1)).toBe("bronze");
    expect(tierFor(9.99)).toBe("bronze");
    expect(tierFor(10)).toBe("silver");
    expect(tierFor(49)).toBe("silver");
    expect(tierFor(50)).toBe("gold");
    expect(tierFor(5000)).toBe("gold");
  });

  it("splits 80% to burn and 20% to Solvent without losing a unit", () => {
    for (const n of [1_000_000n, 10_000_000n, 50_000_000n, 1_000_003n]) {
      const { burn: b, fee } = splitAmount(n);
      expect(b + fee).toBe(n);
      expect(b).toBe((n * 8n) / 10n);
    }
    expect(splitAmount(1_000_000n)).toEqual({ burn: 800_000n, fee: 200_000n });
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

describe("verifying a seal payment on-chain", () => {
  it("accepts a burn plus the 20% share, both from the wallet", () => {
    expect(verifySealTx(tx([burn("800000"), send("200000")]), wallet, treasury)).toEqual({ burned: 0.8, fee: 0.2 });
  });

  it("rejects a payment signed by another wallet", () => {
    expect(() => verifySealTx(tx([burn("800000"), send("200000")], { signer: treasury }), wallet, treasury)).toThrow(/own wallet/);
  });

  it("rejects a failed or missing transaction", () => {
    expect(() => verifySealTx(null, wallet, treasury)).toThrow(/not found/);
    expect(() => verifySealTx(tx([burn("800000"), send("200000")], { err: { InstructionError: [0, "x"] } }), wallet, treasury)).toThrow(/failed/);
  });

  it("rejects a burn with no share for Solvent, or a share sent elsewhere", () => {
    expect(() => verifySealTx(tx([burn("1000000")]), wallet, treasury)).toThrow(/20%/);
    expect(() => verifySealTx(tx([burn("800000"), send("200000", wallet)]), wallet, treasury)).toThrow(/20%/);
  });

  it("rejects a payment that is mostly not burned", () => {
    expect(() => verifySealTx(tx([burn("100000"), send("900000")]), wallet, treasury)).toThrow(/80%/);
  });

  it("ignores burns of other tokens and burns by other authorities", () => {
    const other = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    expect(() => verifySealTx(tx([burn("800000", wallet, other), send("200000")]), wallet, treasury)).toThrow(/no \$ANSEM burn/);
    expect(() => verifySealTx(tx([burn("800000", treasury), send("200000")]), wallet, treasury)).toThrow(/no \$ANSEM burn/);
  });

  it("keeps the split exact: extra burn without the matching share is rejected", () => {
    expect(() => verifySealTx(tx([burn("9000000"), send("1000000")]), wallet, treasury)).toThrow(/20%/);
    expect(verifySealTx(tx([burn("8000000"), send("2000000")]), wallet, treasury)).toEqual({ burned: 8, fee: 2 });
  });
});

describe("seal record", () => {
  const pay = (signature: string, burned: number, fee: number) => ({ signature, burned, fee, at: "2026-09-29T10:00:00.000Z" });
  it("adds payments up and never counts one signature twice", () => {
    let r = addPayment(undefined, wallet, pay("a", 0.8, 0.2));
    r = addPayment(r, wallet, pay("a", 0.8, 0.2));
    r = addPayment(r, wallet, pay("b", 8, 2));
    expect(r.total).toBeCloseTo(11);
    expect(r.burned).toBeCloseTo(8.8);
    expect(r.payments).toHaveLength(2);
    expect(tierFor(r.total)).toBe("silver");
  });
});
