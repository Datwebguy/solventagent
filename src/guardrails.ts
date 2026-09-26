import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "./config.js";

export interface Caps {
  maxTxUsd: number;
  maxDayUsd: number;
}

export interface SpendLog {
  day: string; // UTC date, YYYY-MM-DD
  spentUsd: number;
}

export class SpendCapError extends Error {}

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * Pure check: returns the updated log if `usd` fits under both caps, throws otherwise.
 * A new UTC day resets the running total.
 */
export function checkSpend(log: SpendLog, usd: number, caps: Caps, now = new Date()): SpendLog {
  if (!Number.isFinite(usd) || usd < 0) throw new SpendCapError(`invalid spend amount: ${usd}`);
  if (usd > caps.maxTxUsd) {
    throw new SpendCapError(`$${usd.toFixed(4)} exceeds the per-transaction cap of $${caps.maxTxUsd}`);
  }
  const day = utcDay(now);
  const spent = log.day === day ? log.spentUsd : 0;
  if (spent + usd > caps.maxDayUsd) {
    throw new SpendCapError(
      `$${usd.toFixed(4)} would bring today's spend to $${(spent + usd).toFixed(4)}, over the daily cap of $${caps.maxDayUsd}`,
    );
  }
  return { day, spentUsd: spent + usd };
}

const logPath = () => join(env.SOLVENT_DATA_DIR, "spend.json");

function readLog(): SpendLog {
  try {
    return JSON.parse(readFileSync(logPath(), "utf8")) as SpendLog;
  } catch {
    return { day: utcDay(), spentUsd: 0 };
  }
}

/**
 * Reserves `usd` against the caps before a transaction is signed. The reservation is
 * kept even if the transaction later fails, which errs on the side of spending less.
 */
export function reserveSpend(usd: number, caps: Caps = { maxTxUsd: env.SOLVENT_MAX_TX_USD, maxDayUsd: env.SOLVENT_MAX_DAY_USD }) {
  const next = checkSpend(readLog(), usd, caps);
  mkdirSync(env.SOLVENT_DATA_DIR, { recursive: true });
  writeFileSync(logPath(), JSON.stringify(next, null, 2));
  return next;
}
