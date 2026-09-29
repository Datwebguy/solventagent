import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POST as mcp } from "../api/mcp.js";

const spec = JSON.parse(readFileSync("public/openapi.json", "utf8")) as { paths: Record<string, unknown> };
const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const rpc = async (body: unknown) => JSON.parse(await (await mcp(new Request("http://x/mcp", { method: "POST", headers: H, body: JSON.stringify(body) }))).text());

describe("what agents are told about Solvent", () => {
  it("documents only endpoints that exist", () => {
    for (const path of Object.keys(spec.paths)) {
      const file = path === "/mcp" ? "api/mcp.ts" : `api${path.slice(4)}.ts`.replace(/^api\//, "api/");
      expect(existsSync(file), `${path} -> ${file}`).toBe(true);
    }
  });

  it("names every hosted MCP tool in llms.txt and lists them all over MCP", async () => {
    const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (list.result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(["solvent_check_agent", "solvent_own_books", "solvent_ranking", "solvent_seal_confirm", "solvent_seal_quote", "solvent_seal_status"]);
    const llms = readFileSync("public/llms.txt", "utf8");
    for (const n of names) expect(llms).toContain(n);
  });

  it("refuses bad input before doing any work", async () => {
    const badTier = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "solvent_seal_quote", arguments: { wallet: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", tier: "diamond" } } });
    expect(JSON.stringify(badTier)).toMatch(/Invalid/);
    const badWallet = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "solvent_seal_status", arguments: { wallet: "0".repeat(40) } } });
    expect(JSON.stringify(badWallet)).toMatch(/valid Solana address/);
  });

  it("does not build a seal transaction without its secret configured", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "solvent_seal_quote", arguments: { wallet: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", tier: "bronze" } } });
    expect(r.result.isError).toBe(true);
  });
});
