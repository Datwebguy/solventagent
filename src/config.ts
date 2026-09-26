import { config } from "dotenv";
import { z } from "zod";

// .env holds your secrets; .env.local is written by `vercel link` / `vercel env pull`.
config({ path: [".env", ".env.local"], quiet: true });

const Env = z.object({
  // PublicNode serves batched reads without a key; the Solana public RPC rate-limits them.
  SOLANA_RPC_URL: z.url().default("https://solana-rpc.publicnode.com"),
  // Treasury key: base58 (Phantom/Solflare export) or a JSON byte array. Never logged.
  SOLVENT_TREASURY_SECRET: z.string().optional(),
  SOLVENT_TREASURY_KEYPAIR_PATH: z.string().optional(),
  USEPOD_API_TOKEN: z.string().optional(),
  USEPOD_DEPOSIT_CODE: z
    .string()
    .regex(/^[0-9a-f]{16}$/, "deposit code is 16 hex chars")
    .optional(),
  // Hard caps, enforced before any transaction is signed.
  SOLVENT_MAX_TX_USD: z.coerce.number().positive().default(5),
  SOLVENT_MAX_DAY_USD: z.coerce.number().positive().default(10),
  SOLVENT_DATA_DIR: z.string().default("data"),
  // Drop-in proxy. It spends the reserve, so it binds to loopback unless a key is set.
  SOLVENT_PROXY_HOST: z.string().default("127.0.0.1"),
  SOLVENT_PROXY_PORT: z.coerce.number().int().positive().default(8787),
  SOLVENT_PROXY_KEY: z.string().min(24).optional(),
  // Extra wallets whose payments count as income (ClawPump fee payouts are detected automatically).
  SOLVENT_INCOME_SOURCES: z.string().optional(),
  // The project's own token; enables the buyback bucket once set.
  SOLVENT_TOKEN_MINT: z.string().optional(),
  // Vercel Blob store used to publish the books for the public dashboard.
  BLOB_READ_WRITE_TOKEN: z.string().optional(),
  // Public site settings (web side). The treasury address receives paid-audit payments.
  SOLVENT_TREASURY_ADDRESS: z.string().optional(),
  SOLVENT_AUDIT_PRICE_USD: z.coerce.number().positive().default(0.05),
  // HMAC secret that signs paid-audit quotes so they cannot be forged or altered.
  SOLVENT_QUOTE_SECRET: z.string().min(32).optional(),
  // When "1", the hourly treasury cycle executes; otherwise it only plans.
  SOLVENT_AUTOPILOT: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

export type Env = z.infer<typeof Env>;

export const env: Env = Env.parse(process.env);

export const MINTS = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  SOL: "So11111111111111111111111111111111111111112",
  // $ANSEM, "The Black Bull" (CoinGecko: the-black-bull).
  ANSEM: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump",
} as const;
