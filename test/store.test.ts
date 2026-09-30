import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { del, head, list, put, resetStore } from "../src/store.js";

const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
let respond: (method: string, url: string) => Response;

beforeEach(() => {
  Object.assign(process.env, { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "solvent", R2_PUBLIC_URL: "https://pub.example.dev/" });
  resetStore();
  calls.length = 0;
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push({ method: req.method, url: req.url, headers: Object.fromEntries(req.headers) });
    return respond(req.method, req.url);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_URL"]) delete process.env[k];
  resetStore();
});

describe("storage on Cloudflare R2", () => {
  it("writes to the bucket, signed, with public read URLs", async () => {
    respond = () => new Response(null, { status: 200 });
    const r = await put("solvent/books.json", "{}", { contentType: "application/json", cacheControlMaxAge: 0 });
    expect(r.url).toBe("https://pub.example.dev/solvent/books.json");
    expect(calls[0]!.url).toBe("https://acct.r2.cloudflarestorage.com/solvent/solvent/books.json");
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256/);
    expect(calls[0]!.headers["cache-control"]).toBe("public, max-age=0");
  });

  it("creates the lock only if it doesn't exist, and replaces it only if unchanged", async () => {
    respond = () => new Response(null, { status: 412 });
    await expect(put("solvent/state/lock.json", "{}", { allowOverwrite: false })).rejects.toThrow(/precondition/);
    expect(calls[0]!.headers["if-none-match"]).toBe("*");
    await expect(put("solvent/state/lock.json", "{}", { ifMatch: '"abc"' })).rejects.toThrow(/precondition/);
    expect(calls[1]!.headers["if-match"]).toBe('"abc"');
  });

  it("reports a missing file the way callers expect", async () => {
    respond = () => new Response(null, { status: 404 });
    await expect(head("solvent/state/publisher.json")).rejects.toThrow(/not found/);
  });

  it("reads a file's time and etag", async () => {
    respond = () => new Response(null, { status: 200, headers: { "last-modified": "Wed, 30 Sep 2026 12:00:00 GMT", etag: '"e1"' } });
    const h = await head("solvent/books.json");
    expect(h.etag).toBe('"e1"');
    expect(h.uploadedAt.toISOString()).toBe("2026-09-30T12:00:00.000Z");
    expect(h.url).toBe("https://pub.example.dev/solvent/books.json");
  });

  it("lists every page of a prefix", async () => {
    let page = 0;
    respond = () =>
      new Response(
        page++ === 0
          ? "<ListBucketResult><Contents><Key>solvent/seals/A.json</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>t2</NextContinuationToken></ListBucketResult>"
          : "<ListBucketResult><Contents><Key>solvent/seals/B.json</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>",
      );
    const r = await list({ prefix: "solvent/seals/" });
    expect(r.blobs.map((b) => b.pathname)).toEqual(["solvent/seals/A.json", "solvent/seals/B.json"]);
    expect(calls[1]!.url).toContain("continuation-token=t2");
  });

  it("deletes by public URL or by path", async () => {
    respond = () => new Response(null, { status: 204 });
    await del("https://pub.example.dev/solvent/inbox/x.json");
    await del("solvent/inbox/y.json");
    expect(calls.map((c) => c.url)).toEqual([
      "https://acct.r2.cloudflarestorage.com/solvent/solvent/inbox/x.json",
      "https://acct.r2.cloudflarestorage.com/solvent/solvent/inbox/y.json",
    ]);
  });
});
