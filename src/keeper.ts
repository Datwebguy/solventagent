/**
 * One bookkeeping pass for a scheduled job on a fresh machine (GitHub Actions). See keep.ts.
 *
 *   npx tsx src/keeper.ts
 */
import { keepBooks } from "./keep.js";

const log = (s: string) => console.log(`[${new Date().toISOString()}] ${s}`);

keepBooks(log).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
