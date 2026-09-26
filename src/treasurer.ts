import { allocate, type Policy, type Split } from "./policy.js";

/** USD owed to each bucket but not yet executed (carried between cycles to avoid dust trades). */
export interface Pending {
  computeReserve: number;
  ansemReserve: number;
  buyback: number;
}

export const EMPTY_PENDING: Pending = { computeReserve: 0, ansemReserve: 0, buyback: 0 };

export type ActionKind = "compute_topup" | "ansem_buy" | "buyback";

export interface Action {
  kind: ActionKind;
  usd: number;
}

export interface PlanInput {
  incomeUsd: number;
  reserveUsd: number;
  burnUsdPerDay: number;
  policy: Policy;
  pending: Pending;
  /** Wallet SOL above the fee buffer, in USD: the most the cycle can deploy. */
  deployableUsd: number;
  /** Skip actions smaller than this; they stay pending. */
  minActionUsd: number;
  /** Reserve target when there is no burn history yet. */
  reserveFloorUsd: number;
  buybackEnabled: boolean;
}

export interface Plan {
  targetReserveUsd: number;
  split: Split;
  actions: Action[];
  pendingAfter: Pending;
}

export const BUCKET: Record<ActionKind, keyof Pending> = {
  compute_topup: "computeReserve",
  ansem_buy: "ansemReserve",
  buyback: "buyback",
};

/** Decides what this cycle should do. Pure: no network, no signing. */
export function planCycle(i: PlanInput): Plan {
  const targetReserveUsd = Math.max(i.policy.computeReserveTargetDays * i.burnUsdPerDay, i.reserveFloorUsd);
  const shortfall = Math.max(0, targetReserveUsd - i.reserveUsd - i.pending.computeReserve);
  const split = allocate(i.incomeUsd, i.policy, shortfall);
  const pending: Pending = {
    computeReserve: i.pending.computeReserve + split.computeReserve,
    ansemReserve: i.pending.ansemReserve + split.ansemReserve,
    buyback: i.pending.buyback + split.buyback,
  };

  const actions: Action[] = [];
  let budget = i.deployableUsd;
  const order: ActionKind[] = ["compute_topup", "ansem_buy", ...(i.buybackEnabled ? (["buyback"] as const) : [])];
  for (const kind of order) {
    const key = BUCKET[kind];
    const usd = Math.min(pending[key], budget, i.policy.caps.maxTxUsd);
    if (usd < i.minActionUsd) continue;
    actions.push({ kind, usd });
    pending[key] -= usd;
    budget -= usd;
  }
  return { targetReserveUsd, split, actions, pendingAfter: pending };
}

/**
 * Whether the ledger head needs a new on-chain anchor. The anchor entry itself does not
 * count as new activity, so an idle ledger is anchored once, not every cycle.
 */
export function needsAnchor(head: { seq: number; kind: string } | undefined, anchoredSeq: number | undefined): boolean {
  if (!head) return false;
  if (head.kind === "anchor") return false;
  return head.seq !== anchoredSeq;
}
