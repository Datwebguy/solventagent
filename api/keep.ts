import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorized } from "../src/keep-auth.js";

let running: Promise<Response> | undefined;

/**
 * Runs one bookkeeping pass (see src/keep.ts). Called hourly by an outside timer and daily by
 * Vercel Cron, both sending `Authorization: Bearer $CRON_SECRET`. It never moves funds.
 */
export async function GET(request: Request): Promise<Response> {
  if (!authorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // One pass at a time per instance: the pass works in the process's current directory.
  running ??= run().finally(() => (running = undefined));
  return (await running).clone();
}

export const POST = GET;

async function run(): Promise<Response> {
  // This endpoint exists to publish the books, so publishing is on here by definition.
  process.env.SOLVENT_PUBLISH = "1";
  const { keepBooks } = await import("../src/keep.js");
  const home = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "solvent-keep-"));
  const lines: string[] = [];
  try {
    process.chdir(dir);
    const result = await keepBooks((s) => lines.push(s));
    return Response.json({ ...result, log: lines }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error(err);
    return Response.json({ ran: false, error: err instanceof Error ? err.message : String(err), log: lines }, { status: 500 });
  } finally {
    process.chdir(home);
    rmSync(dir, { recursive: true, force: true });
  }
}
