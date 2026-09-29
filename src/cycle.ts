import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, MINTS } from "./config.js";
import { reserveSpend } from "./guardrails.js";
import { fetchInflows, latestSignature } from "./income.js";
import { jupQuote, jupSwap } from "./jupiter.js";
import { FileLedger, burnUsdPerDay } from "./ledger.js";
import { Policy } from "./policy.js";
import { usdPrice } from "./prices.js";
import { PublicKey } from "@solana/web3.js";
import { sendMemo, solBalance, solscanTx } from "./solana.js";
import { BUCKET, EMPTY_PENDING, needsAnchor, planCycle, type Pending, type Plan } from "./treasurer.js";
import { tokenBalanceMicros } from "./usepod/client.js";
import { depositSol } from "./usepod/pay.js";
import { convertSealShares } from "./seal-shares.js";
import { loadTreasury } from "./wallet.js";

/** SOL always left in the wallet for network fees. */
export const FEE_BUFFER_SOL = 0.02;
const MIN_ACTION_USD = 0.5;
const RESERVE_FLOOR_USD = 1;

export interface State {
  cursor?: string;
  pending: Pending;
  lastRunAt?: string;
  anchoredSeq?: number;
  /** Last UsePod reserve balance the bookkeeper saw, in microdollars. */
  reserveMicros?: number;
  /** Seal payments whose 20% $ANSEM share has already been turned into AI budget. */
  sealSigs?: string[];
}

const statePath = () => join(env.SOLVENT_DATA_DIR, "treasurer.json");

export function readState(): State {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as State;
  } catch {
    return { pending: { ...EMPTY_PENDING } };
  }
}

export function writeState(s: State) {
  mkdirSync(env.SOLVENT_DATA_DIR, { recursive: true });
  writeFileSync(statePath(), JSON.stringify(s, null, 2));
}

export function loadPolicy(path = "solvent.policy.json"): Policy {
  return Policy.parse(JSON.parse(readFileSync(path, "utf8")));
}

export interface CycleReport {
  executed: boolean;
  incomeUsd: number;
  reserveUsd: number;
  plan: Plan;
  txs: { kind: string; signature: string }[];
  failures: { kind: string; error: string }[];
}

/**
 * One treasury cycle: book new income, split it by the published policy, and (with
 * `execute`) top up the compute reserve, buy the $ANSEM reserve, run buybacks, and anchor
 * the ledger head on-chain. Without `execute` it only reads and plans; with `bookOnly` it also
 * books the income and carries every planned action forward as pending, sending nothing.
 * Only `execute` needs the private key; otherwise SOLVENT_TREASURY_ADDRESS is enough.
 */
export async function runCycle({
  execute,
  bookOnly = false,
  log = console.log,
}: {
  execute: boolean;
  bookOnly?: boolean;
  log?: (s: string) => void;
}): Promise<CycleReport> {
  if (execute && bookOnly) throw new Error("choose execute or bookOnly, not both");
  const kp = execute || !env.SOLVENT_TREASURY_ADDRESS ? loadTreasury() : undefined;
  const owner = kp?.publicKey ?? new PublicKey(env.SOLVENT_TREASURY_ADDRESS!);
  const policy = loadPolicy();
  if (policy.agent.wallet !== owner.toBase58()) {
    throw new Error("solvent.policy.json names a different wallet than the treasury key");
  }
  const ledger = new FileLedger();
  const state = readState();
  const sources = new Set((env.SOLVENT_INCOME_SOURCES ?? "").split(",").map((s) => s.trim()).filter(Boolean));

  const solPrice = await usdPrice(MINTS.SOL);
  let inflows: Awaited<ReturnType<typeof fetchInflows>>["inflows"] = [];
  let cursor = state.cursor;
  if (state.cursor) {
    const r = await fetchInflows(owner, sources, state.cursor);
    inflows = r.inflows;
    cursor = r.newest;
  } else {
    cursor = await latestSignature(owner);
    log("First cycle: the income cursor starts now. Earlier wallet history is not counted as income.");
  }

  const toUsd = (lamports: number) => (lamports / 1e9) * solPrice;
  const incomeUsd = inflows.filter((f) => f.source !== "deposit").reduce((s, f) => s + toUsd(f.lamports), 0);
  const reserveUsd = env.USEPOD_API_TOKEN ? (await tokenBalanceMicros(env.USEPOD_API_TOKEN)) / 1e6 : 0;
  const sol = await solBalance(owner);
  const plan = planCycle({
    incomeUsd,
    reserveUsd,
    burnUsdPerDay: burnUsdPerDay(ledger.all()),
    policy,
    pending: state.pending,
    deployableUsd: Math.max(0, sol - FEE_BUFFER_SOL) * solPrice,
    minActionUsd: MIN_ACTION_USD,
    reserveFloorUsd: RESERVE_FLOOR_USD,
    buybackEnabled: Boolean(env.SOLVENT_TOKEN_MINT),
  });

  log(`SOL $${solPrice.toFixed(2)} | wallet ${sol.toFixed(4)} SOL | compute reserve $${reserveUsd.toFixed(4)} (target $${plan.targetReserveUsd.toFixed(2)})`);
  log(`New income: $${incomeUsd.toFixed(4)} from ${inflows.filter((f) => f.source !== "deposit").length} payout(s); ${inflows.filter((f) => f.source === "deposit").length} plain deposit(s)`);
  for (const a of plan.actions) log(`  plan: ${a.kind} $${a.usd.toFixed(4)}`);
  if (plan.actions.length === 0) log("  plan: nothing to execute this cycle");

  const report: CycleReport = { executed: execute, incomeUsd, reserveUsd, plan, txs: [], failures: [] };
  if (!execute && !bookOnly) return report;

  for (const f of inflows) {
    const usd = toUsd(f.lamports);
    ledger.append({
      kind: f.source === "deposit" ? "capital" : "income",
      usd: f.source === "deposit" ? 0 : usd,
      txSig: f.signature,
      meta: { source: f.source, sol: f.lamports / 1e9, amountUsd: usd },
    });
  }

  const pending: Pending = { ...plan.pendingAfter };
  if (bookOnly) {
    // Nothing is sent: planned moves stay pending until the owner turns on autopilot.
    for (const a of plan.actions) pending[BUCKET[a.kind]] += a.usd;
    writeState({ ...state, cursor, pending, lastRunAt: new Date().toISOString() });
    return report;
  }
  const signer = kp!;
  for (const a of plan.actions) {
    const lamports = BigInt(Math.floor((a.usd / solPrice) * 1e9));
    try {
      if (a.kind === "compute_topup") {
        if (!env.USEPOD_DEPOSIT_CODE) throw new Error("USEPOD_DEPOSIT_CODE is not set");
        const r = await depositSol(signer, env.USEPOD_DEPOSIT_CODE, lamports);
        ledger.append({ kind: "compute_topup", usd: 0, txSig: r.signature, meta: { amountUsd: a.usd, from: "SOL", usdcMinOut: r.usdcMinOut } });
        report.txs.push({ kind: a.kind, signature: r.signature });
      } else {
        const mint = a.kind === "ansem_buy" ? MINTS.ANSEM : env.SOLVENT_TOKEN_MINT!;
        reserveSpend(a.usd);
        const quote = await jupQuote(MINTS.SOL, mint, lamports);
        const sig = await jupSwap(signer, quote);
        ledger.append({
          kind: a.kind === "ansem_buy" ? "swap" : "buyback",
          usd: a.kind === "buyback" ? -a.usd : 0,
          txSig: sig,
          meta: { amountUsd: a.usd, from: MINTS.SOL, to: mint, outAmount: quote.outAmount },
        });
        report.txs.push({ kind: a.kind, signature: sig });
      }
      log(`  done: ${a.kind} $${a.usd.toFixed(4)} ${solscanTx(report.txs[report.txs.length - 1]!.signature)}`);
    } catch (err) {
      pending[BUCKET[a.kind]] += a.usd; // retry next cycle
      const error = err instanceof Error ? err.message : String(err);
      report.failures.push({ kind: a.kind, error });
      log(`  FAILED: ${a.kind}: ${error}`);
    }
  }

  // The 20% $ANSEM share of each Solvent Seal becomes AI budget.
  let sealSigs = state.sealSigs ?? [];
  try {
    const shares = await convertSealShares(signer, ledger, sealSigs, log);
    sealSigs = [...sealSigs, ...shares.done];
    report.txs.push(...shares.txs);
    report.failures.push(...shares.failures);
  } catch (err) {
    log(`  seal shares skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  let anchoredSeq = state.anchoredSeq;
  const head = ledger.head();
  if (head && needsAnchor(head, anchoredSeq)) {
    try {
      const sig = await sendMemo(signer, `solvent:ledger:${head.seq}:${head.hash}`);
      const anchor = ledger.append({ kind: "anchor", usd: 0, txSig: sig, meta: { seq: head.seq, hash: head.hash } });
      anchoredSeq = anchor.seq;
      report.txs.push({ kind: "anchor", signature: sig });
      log(`  anchored ledger #${head.seq} on-chain: ${solscanTx(sig)}`);
    } catch (err) {
      log(`  anchor failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  writeState({ ...state, cursor, pending, lastRunAt: new Date().toISOString(), anchoredSeq, sealSigs });
  return report;
}
