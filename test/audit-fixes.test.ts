import { ComputeBudgetProgram, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { collectSignaturesSince } from "../src/income.js";
import { withExtraComputeUnits } from "../src/jupiter.js";
import { needsAnchor } from "../src/treasurer.js";

describe("needsAnchor", () => {
  it("anchors new activity once, then stays idle", () => {
    expect(needsAnchor({ seq: 5, kind: "thought" }, undefined)).toBe(true);
    expect(needsAnchor({ seq: 5, kind: "thought" }, 3)).toBe(true);
    // After anchoring, the head is the anchor entry itself: nothing new to anchor.
    expect(needsAnchor({ seq: 6, kind: "anchor" }, 6)).toBe(false);
    expect(needsAnchor({ seq: 6, kind: "anchor" }, 5)).toBe(false);
    expect(needsAnchor(undefined, undefined)).toBe(false);
  });
});

describe("collectSignaturesSince", () => {
  it("pages past the RPC limit instead of dropping older signatures", async () => {
    const all = Array.from({ length: 2_350 }, (_, i) => ({ signature: `s${2_349 - i}` })); // newest first
    const page = async (before: string | undefined) => {
      const start = before ? all.findIndex((x) => x.signature === before) + 1 : 0;
      return all.slice(start, start + 1_000);
    };
    const got = await collectSignaturesSince(page);
    expect(got).toHaveLength(2_350);
    expect(got[0]!.signature).toBe("s2349");
    expect(got[got.length - 1]!.signature).toBe("s0");
  });

  it("stops after one call when the first page is short", async () => {
    let calls = 0;
    const got = await collectSignaturesSince(async () => (calls++, [{ signature: "a" }, { signature: "b" }]));
    expect(got).toHaveLength(2);
    expect(calls).toBe(1);
  });
});

describe("withExtraComputeUnits", () => {
  const other = new TransactionInstruction({ programId: new PublicKey("11111111111111111111111111111111"), keys: [], data: Buffer.alloc(0) });
  const unitsOf = (ixs: TransactionInstruction[]) =>
    ixs.filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2).map((ix) => ix.data.readUInt32LE(1));

  it("raises Jupiter's limit by the headroom and keeps exactly one limit instruction", () => {
    const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 });
    const out = withExtraComputeUnits([ComputeBudgetProgram.setComputeUnitLimit({ units: 180_000 }), price, other], 60_000);
    expect(unitsOf(out)).toEqual([240_000]);
    expect(out).toContain(price);
    expect(out).toContain(other);
  });

  it("falls back to a default base when there is no limit instruction", () => {
    expect(unitsOf(withExtraComputeUnits([other], 60_000))).toEqual([260_000]);
  });

  it("never exceeds Solana's maximum", () => {
    expect(unitsOf(withExtraComputeUnits([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_390_000 })], 60_000))).toEqual([1_400_000]);
  });
});
