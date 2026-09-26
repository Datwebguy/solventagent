/** UsePod inference marketplace client: prepaid-token path and accountless x402 path. */

export const USEPOD_API = "https://api.usepod.ai";
const UA = "solvent/0.1";

export interface Registration {
  apiToken: string;
  depositCode: string;
  dashboardUrl?: string;
}

/** POST /v1/register — mints a new (unfunded) API token and its on-chain deposit code. */
export async function registerToken(): Promise<Registration> {
  const res = await fetch(`${USEPOD_API}/v1/register`, {
    method: "POST",
    headers: { Accept: "application/json", "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`UsePod register failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as {
    api_token: string;
    deposit_code: string;
    instructions?: { dashboard_url?: string };
  };
  return { apiToken: j.api_token, depositCode: j.deposit_code, dashboardUrl: j.instructions?.dashboard_url };
}

/** Remaining prepaid balance, in USDC microunits. */
export async function tokenBalanceMicros(apiToken: string): Promise<number> {
  const res = await fetch(`${USEPOD_API}/proxy/${apiToken}/balance`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`UsePod balance failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { usdc_balance?: number | string };
  return Number(j.usdc_balance ?? 0);
}

export async function listModels(apiToken: string): Promise<string[]> {
  const res = await fetch(`${USEPOD_API}/proxy/${apiToken}/v1/models`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`UsePod models failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { data?: { id: string }[] };
  return (j.data ?? []).map((m) => m.id);
}

export interface PriceCeiling {
  /** Max USDC microunits per million input tokens. */
  maxInputMicros?: number;
  /** Max USDC microunits per million output tokens. */
  maxOutputMicros?: number;
}

export type RoutingMode = "auto" | "marketplace-only" | "centralized-only";

export interface ChatRequest {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  max_tokens: number;
  [k: string]: unknown;
}

export interface ChatResult {
  status: number;
  body: any;
  route?: string;
  providerId?: string;
  balanceRemainingMicros?: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function podHeaders(ceiling?: PriceCeiling, routingMode?: RoutingMode): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", "User-Agent": UA };
  if (ceiling?.maxInputMicros != null) h["X-Pod-Max-Price-Input"] = String(Math.floor(ceiling.maxInputMicros));
  if (ceiling?.maxOutputMicros != null) h["X-Pod-Max-Price-Output"] = String(Math.floor(ceiling.maxOutputMicros));
  if (routingMode) h["X-Pod-Routing-Mode"] = routingMode;
  return h;
}

function readResult(res: Response, body: any): ChatResult {
  const bal = res.headers.get("x-balance-remaining");
  return {
    status: res.status,
    body,
    route: res.headers.get("x-pod-route") ?? undefined,
    providerId: res.headers.get("x-pod-provider-id") ?? undefined,
    balanceRemainingMicros: bal != null ? Number(bal) : undefined,
    usage: body?.usage,
  };
}

/** OpenAI-compatible chat completion against a prepaid token, with optional price ceilings. */
export async function chat(
  apiToken: string,
  req: ChatRequest,
  opts: { ceiling?: PriceCeiling; routingMode?: RoutingMode } = {},
): Promise<ChatResult> {
  const res = await fetch(`${USEPOD_API}/proxy/${apiToken}/v1/chat/completions`, {
    method: "POST",
    headers: podHeaders(opts.ceiling, opts.routingMode),
    body: JSON.stringify({ ...req, stream: false }),
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return readResult(res, body);
}

// ---------- x402 (accountless, pay per request) ----------

export const X402_CHAT_PATH = "/proxy/x402/v1/chat/completions";

export interface X402Rail {
  scheme: string;
  network: string;
  asset: string; // "USDC" | "SOL" on the UsePod dialect entries
  pay_to: string;
  amount_microunits: number; // USDC microunits, or lamports on the SOL rail
  mode?: string;
  expires_at?: string;
  model?: string;
}

export interface X402Quote {
  quote_id: string;
  accepts: X402Rail[];
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

/** Step 1: send the request unpaid and read the 402 quote. `bodyStr` must be reused verbatim for settlement. */
export async function x402Quote(bodyStr: string): Promise<X402Quote> {
  const res = await fetch(`${USEPOD_API}${X402_CHAT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: bodyStr,
  });
  const header = res.headers.get("payment-required");
  if (res.status !== 402 || !header) {
    throw new Error(`expected 402 with PAYMENT-REQUIRED, got ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const q = b64json(header) as X402Quote;
  return q;
}

/** Picks the UsePod-dialect Solana rail for an asset ("USDC" or "SOL"). */
export function solanaRail(q: X402Quote, asset: "USDC" | "SOL"): X402Rail {
  const rail = q.accepts.find((r) => r.asset === asset && r.network.startsWith("solana:") && r.pay_to);
  if (!rail) throw new Error(`quote ${q.quote_id} has no Solana ${asset} rail`);
  return rail;
}

/** Step 3: repeat the identical request, proving payment with the on-chain signature. */
export async function x402Settle(
  bodyStr: string,
  proof: { quoteId: string; network: string; asset: "USDC" | "SOL"; payerWallet: string; signature: string },
): Promise<ChatResult & { paymentResponse?: unknown }> {
  const paymentSignature = Buffer.from(
    JSON.stringify({
      quote_id: proof.quoteId,
      network: proof.network,
      asset: proof.asset,
      payer_wallet: proof.payerWallet,
      signature: proof.signature,
    }),
  ).toString("base64");
  const res = await fetch(`${USEPOD_API}${X402_CHAT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA, "PAYMENT-SIGNATURE": paymentSignature },
    body: bodyStr,
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  const pr = res.headers.get("payment-response");
  return { ...readResult(res, body), paymentResponse: pr ? safeB64json(pr) : undefined };
}

function safeB64json(s: string): unknown {
  try {
    return b64json(s);
  } catch {
    return s;
  }
}
