import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { MINTS } from "./config.js";

/** Solana mainnet in CAIP-2 form, as used by x402. */
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const QUOTE_TTL_S = 15 * 60;

export interface QuoteClaims {
  w: string; // wallet being audited
  a: number; // price, USDC microunits
  p: string; // pay_to (treasury owner address)
  e: number; // expiry, unix seconds
  n: string; // nonce; the payment memo must carry it
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const sign = (payload: string, secret: string) => createHmac("sha256", secret).update(payload).digest("base64url");

/** Stateless, tamper-proof quote id: claims + HMAC. */
export function makeQuoteId(claims: Omit<QuoteClaims, "n" | "e">, secret: string, nowS = Math.floor(Date.now() / 1000)): { id: string; claims: QuoteClaims } {
  const full: QuoteClaims = { ...claims, e: nowS + QUOTE_TTL_S, n: randomBytes(8).toString("hex") };
  const payload = b64url(JSON.stringify(full));
  return { id: `${payload}.${sign(payload, secret)}`, claims: full };
}

export function readQuoteId(id: string, secret: string, nowS = Math.floor(Date.now() / 1000)): QuoteClaims {
  const [payload, mac] = id.split(".");
  if (!payload || !mac) throw new Error("malformed quote id");
  const expected = Buffer.from(sign(payload, secret));
  const got = Buffer.from(mac);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new Error("quote signature invalid");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as QuoteClaims;
  if (claims.e < nowS) throw new Error("quote expired");
  return claims;
}

export const quoteMemo = (claims: QuoteClaims) => `solvent:quote:${claims.n}`;

/** The PAYMENT-REQUIRED body: our dialect (self-broadcast + signature proof), mirroring UsePod's. */
export function paymentRequired(id: string, claims: QuoteClaims, resource: string) {
  return {
    x402_version: 2,
    quote_id: id,
    resource: { url: resource, description: `Solvent solvency report for ${claims.w}`, mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: SOLANA_MAINNET,
        asset: "USDC",
        mint: MINTS.USDC,
        pay_to: claims.p,
        amount_microunits: claims.a,
        memo: quoteMemo(claims),
        expires_at: new Date(claims.e * 1000).toISOString(),
      },
    ],
    instructions:
      "Send amount_microunits of USDC to pay_to in one transaction that also carries `memo` (SPL Memo), then repeat the request with a PAYMENT-SIGNATURE header: base64 JSON {quote_id, signature, payer_wallet}.",
  };
}

/** Memo strings in a parsed transaction (top-level and inner). */
function memos(tx: ParsedTransactionWithMeta): string[] {
  const all = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
  return all.flatMap((ix) => ("parsed" in ix && ix.program === "spl-memo" && typeof ix.parsed === "string" ? [ix.parsed] : []));
}

interface TokenBalance {
  owner?: string;
  mint: string;
  uiTokenAmount: { amount: string };
}

/** USDC (microunits) that `owner` gained in the transaction, from pre/post token balances. */
export function usdcReceived(tx: ParsedTransactionWithMeta, owner: string): number {
  const total = (bals: TokenBalance[] | null | undefined) =>
    (bals ?? []).filter((b) => b.owner === owner && b.mint === MINTS.USDC).reduce((s, b) => s + Number(b.uiTokenAmount.amount), 0);
  return total(tx.meta?.postTokenBalances) - total(tx.meta?.preTokenBalances);
}

/** Checks that `tx` pays the quote: confirmed, carries the quote memo, and delivers at least the price. */
export function verifyPayment(tx: ParsedTransactionWithMeta | null, claims: QuoteClaims): void {
  if (!tx) throw new Error("payment transaction not found (not confirmed yet?)");
  if (tx.meta?.err) throw new Error("payment transaction failed on-chain");
  if (!memos(tx).some((m) => m.includes(quoteMemo(claims)))) throw new Error("payment is missing the quote memo");
  const received = usdcReceived(tx, claims.p);
  if (received < claims.a) throw new Error(`payment too small: ${received} < ${claims.a} microunits`);
}
