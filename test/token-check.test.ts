import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { tokenVerdict, txEffect } from "../src/token-check.js";

const TEAM = "5gSQ7empPRS6nxtHYChCq4u3UvDVz6Auur55jCZ1PUJ6";
const MINT = "EpXtn6xGoZ4Y45vRjiDUHSCGbBoJD5FaEqZbF98YswH1";
const WSOL = "So11111111111111111111111111111111111111112";
const bal = (mint: string, amount: number) => ({ accountIndex: 1, mint, owner: TEAM, uiTokenAmount: { uiAmountString: String(amount), amount: "0", decimals: 6, uiAmount: amount } });

function tx(o: { logs?: string[]; sol?: [number, number]; token?: [number, number]; wsol?: [number, number] }) {
  return {
    blockTime: 1,
    transaction: { message: { accountKeys: [{ pubkey: new PublicKey(TEAM), signer: true, writable: true }], instructions: [] } },
    meta: {
      err: null,
      logMessages: o.logs ?? [],
      preBalances: [o.sol?.[0] ?? 0],
      postBalances: [o.sol?.[1] ?? 0],
      preTokenBalances: [...(o.token ? [bal(MINT, o.token[0])] : []), ...(o.wsol ? [bal(WSOL, o.wsol[0])] : [])],
      postTokenBalances: [...(o.token ? [bal(MINT, o.token[1])] : []), ...(o.wsol ? [bal(WSOL, o.wsol[1])] : [])],
    },
  } as never;
}

describe("reading a team wallet's transactions", () => {
  it("counts a pump.fun creator-fee claim as earned", () => {
    const e = txEffect(tx({ logs: ["Program log: Instruction: CollectCreatorFee"], sol: [1e9, 1.5e9] }), TEAM, MINT);
    expect(e.feeLamports).toBe(0.5e9);
  });

  it("counts a PumpSwap claim paid in wrapped SOL", () => {
    const e = txEffect(tx({ logs: ["Program log: Instruction: CollectCoinCreatorFee"], sol: [1e9, 1e9], wsol: [0, 0.25] }), TEAM, MINT);
    expect(e.feeLamports).toBe(0.25e9);
  });

  it("sees a sale of the team's own token, and does not call it earnings", () => {
    const e = txEffect(tx({ logs: ["Program log: Instruction: Sell"], sol: [1e9, 3e9], token: [1_000_000, 0] }), TEAM, MINT);
    expect(e.feeLamports).toBe(0);
    expect(e.tokenDelta).toBe(-1_000_000);
    expect(e.lamportsDelta).toBe(2e9);
  });

  it("ignores a claim log when the wallet got nothing", () => {
    expect(txEffect(tx({ logs: ["Program log: Instruction: CollectCreatorFee"], sol: [1e9, 1e9 - 5000] }), TEAM, MINT).feeLamports).toBe(0);
  });
});

describe("the verdict", () => {
  it("reads earning, selling and neither plainly", () => {
    expect(tokenVerdict(10, 0, 0)).toBe("EARNING AND HOLDING");
    expect(tokenVerdict(0, 5, 0)).toBe("EARNING AND HOLDING");
    expect(tokenVerdict(10, 0, 50)).toBe("EARNING AND SELLING");
    expect(tokenVerdict(0, 0, 50)).toBe("SELLING, NOT EARNING");
    expect(tokenVerdict(0, 0, 0)).toBe("NOT EARNING YET");
  });
});
