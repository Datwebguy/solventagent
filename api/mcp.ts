import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "../src/mcp-remote.js";

/**
 * Solvent's hosted MCP server (Streamable HTTP, stateless): POST /mcp with JSON-RPC.
 * Point any MCP client at https://<site>/mcp. No key, no install.
 */
export async function POST(request: Request): Promise<Response> {
  const server = buildMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  return new Response(response.body, { status: response.status, headers });
}

/** Stateless server: no streaming channel. */
export async function GET(): Promise<Response> {
  return Response.json({ error: "This MCP server is stateless. POST JSON-RPC to /mcp." }, { status: 405, headers: { allow: "POST, OPTIONS" } });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, GET, OPTIONS",
      "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id",
    },
  });
}
