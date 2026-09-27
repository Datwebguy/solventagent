import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { classifyAiPayment, USEPOD_DEPOSIT_PROGRAM, USEPOD_X402_PAY_TO } from "../src/aispend.js";
import { agentStatus } from "../src/audit.js";
import { MINTS } from "../src/config.js";

const W = "Wa11et1111111111111111111111111111111111111";
const pk = (s: string) => ({ toBase58: () => s }) as unknown as PublicKey;

interface Opts {
  signer?: string;
  topLevel?: { programId: string; parsed?: unknown; program?: string }[];
  inner?: { index: number; instructions: { parsed: unknown }[] }[];
  pre?: { owner: string; mint: string; amount: string }[];
  post?: { owner: string; mint: string; amount: string }[];
}
function tx(o: Opts): ParsedTransactionWithMeta {
  const bal = (xs: Opts["pre"]) => (xs ?? []).map((b) => ({ owner: b.owner, mint: b.mint, uiTokenAmount: { amount: b.amount } }));
  return {
    blockTime: 1,
    meta: { innerInstructions: o.inner ?? [], preTokenBalances: bal(o.pre), postTokenBalances: bal(o.post) },
    transaction: {
      message: {
        accountKeys: [{ pubkey: pk(o.signer ?? W), signer: true }],
        instructions: (o.topLevel ?? []).map((ix) => ({ ...ix, programId: pk(ix.programId) })),
      },
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe("classifyAiPayment", () => {
  it("reads a top-up from the transfer inside UsePod's deposit instruction, even after a swap", () => {
    // Shape of Solvent's real $ANSEM top-up: a swap, then deposit_usdc moving 985,777 USDC micros.
    const t = tx({
      topLevel: [{ programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" }, { programId: USEPOD_DEPOSIT_PROGRAM }],
      inner: [
        { index: 0, instructions: [{ parsed: { type: "transferChecked", info: { mint: MINTS.USDC, tokenAmount: { amount: "999999999" } } } }] },
        { index: 1, instructions: [{ parsed: { type: "transferChecked", info: { mint: MINTS.USDC, tokenAmount: { amount: "985777" } } } }] },
      ],
    });
    expect(classifyAiPayment(t, W, 120)).toEqual({ kind: "topup", usd: 0.985777 });
  });

  it("reads a USDC pay-per-answer from UsePod's payment address balance", () => {
    const t = tx({
      pre: [{ owner: USEPOD_X402_PAY_TO, mint: MINTS.USDC, amount: "1000" }],
      post: [{ owner: USEPOD_X402_PAY_TO, mint: MINTS.USDC, amount: "1043" }],
    });
    expect(classifyAiPayment(t, W, 120)).toEqual({ kind: "per_answer", usd: 0.000043 });
  });

  it("values a SOL pay-per-answer at the given SOL price", () => {
    const t = tx({ topLevel: [{ programId: "11111111111111111111111111111111", program: "system", parsed: { type: "transfer", info: { source: W, destination: USEPOD_X402_PAY_TO, lamports: 1_000_000 } } }] });
    expect(classifyAiPayment(t, W, 120)!.usd).toBeCloseTo(0.12);
  });

  it("ignores payments this wallet did not sign, and unrelated transactions", () => {
    const deposit = { topLevel: [{ programId: USEPOD_DEPOSIT_PROGRAM }], inner: [{ index: 0, instructions: [{ parsed: { type: "transfer", info: { amount: "5000" } } }] }] };
    expect(classifyAiPayment(tx({ ...deposit, signer: "Someone" }), W, 120)).toBeUndefined();
    expect(classifyAiPayment(tx({ topLevel: [{ programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" }] }), W, 120)).toBeUndefined();
  });
});

describe("agentStatus", () => {
  it("grades from public earnings and AI costs", () => {
    expect(agentStatus(0, 0, false, false)).toBe("NO ACTIVITY");
    expect(agentStatus(50, 0, true, false)).toBe("NO AI COSTS SEEN");
    expect(agentStatus(50, 10, true, true)).toBe("SOLVENT");
    expect(agentStatus(5, 10, true, true)).toBe("AT RISK");
    expect(agentStatus(0, 3, false, true)).toBe("AT RISK");
  });
});
