/**
 * Public storage for the books, ledger, ranking, seals and state.
 *
 * Uses Cloudflare R2 when R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET and
 * R2_PUBLIC_URL are set, and Vercel Blob otherwise. The functions mirror the small part of the
 * @vercel/blob API this project uses (head, put, list, del), so callers don't change.
 */
import * as vercel from "@vercel/blob";
import { AwsClient } from "aws4fetch";

type R2 = { client: AwsClient; endpoint: string; publicUrl: string };
let r2Cache: R2 | null | undefined;

export function r2(): R2 | null {
  if (r2Cache !== undefined) return r2Cache;
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL } = process.env;
  r2Cache =
    R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET && R2_PUBLIC_URL
      ? {
          client: new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" }),
          endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}`,
          publicUrl: R2_PUBLIC_URL.replace(/\/+$/, ""),
        }
      : null;
  return r2Cache;
}

/** Test hook: forget the cached R2 settings. */
export const resetStore = () => (r2Cache = undefined);

class BlobNotFoundError extends Error {
  override name = "BlobNotFoundError";
}

const keyUrl = (s: R2, key: string) => `${s.endpoint}/${key.split("/").map(encodeURIComponent).join("/")}`;
const keyOf = (s: R2, urlOrPath: string) => (urlOrPath.startsWith(s.publicUrl + "/") ? urlOrPath.slice(s.publicUrl.length + 1) : urlOrPath);

export interface HeadResult {
  url: string;
  pathname: string;
  uploadedAt: Date;
  etag: string;
}

export async function head(pathname: string, opts?: { token?: string }): Promise<HeadResult> {
  const s = r2();
  if (!s) {
    const m = await vercel.head(pathname, opts);
    return { url: m.url, pathname: m.pathname ?? pathname, uploadedAt: m.uploadedAt, etag: m.etag };
  }
  const res = await s.client.fetch(keyUrl(s, pathname), { method: "HEAD" });
  if (res.status === 404) throw new BlobNotFoundError(`${pathname}: not found`);
  if (!res.ok) throw new Error(`storage HEAD ${pathname}: HTTP ${res.status}`);
  return {
    url: `${s.publicUrl}/${pathname}`,
    pathname,
    uploadedAt: new Date(res.headers.get("last-modified") ?? Date.now()),
    etag: res.headers.get("etag") ?? "",
  };
}

export interface PutOptions {
  access?: "public";
  addRandomSuffix?: boolean;
  allowOverwrite?: boolean;
  ifMatch?: string;
  cacheControlMaxAge?: number;
  contentType?: string;
  token?: string;
}

export async function put(pathname: string, body: string, opts: PutOptions = {}): Promise<{ url: string; pathname: string }> {
  const s = r2();
  if (!s) {
    const r = await vercel.put(pathname, body, { access: "public", ...opts } as Parameters<typeof vercel.put>[2]);
    return { url: r?.url ?? "", pathname: r?.pathname ?? pathname };
  }
  const headers: Record<string, string> = {
    "content-type": opts.contentType ?? "application/octet-stream",
    "cache-control": `public, max-age=${opts.cacheControlMaxAge ?? 60}`,
  };
  if (opts.allowOverwrite === false) headers["if-none-match"] = "*";
  if (opts.ifMatch) headers["if-match"] = opts.ifMatch;
  const res = await s.client.fetch(keyUrl(s, pathname), { method: "PUT", headers, body });
  if (res.status === 412) throw new Error(`${pathname}: already exists or changed (precondition failed)`);
  if (!res.ok) throw new Error(`storage PUT ${pathname}: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
  return { url: `${s.publicUrl}/${pathname}`, pathname };
}

export async function list(opts: { prefix?: string; limit?: number; token?: string } = {}): Promise<{ blobs: { pathname: string; url: string }[] }> {
  const s = r2();
  if (!s) {
    const r = await vercel.list(opts);
    return { blobs: (r?.blobs ?? []).map((b) => ({ pathname: b.pathname, url: b.url })) };
  }
  const blobs: { pathname: string; url: string }[] = [];
  let token: string | undefined;
  do {
    const q = new URLSearchParams({ "list-type": "2", prefix: opts.prefix ?? "", "max-keys": String(Math.min(opts.limit ?? 1000, 1000)) });
    if (token) q.set("continuation-token", token);
    const res = await s.client.fetch(`${s.endpoint}?${q}`);
    if (!res.ok) throw new Error(`storage LIST ${opts.prefix}: HTTP ${res.status}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      const key = m[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
      blobs.push({ pathname: key, url: `${s.publicUrl}/${key}` });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined;
  } while (token && (!opts.limit || blobs.length < opts.limit));
  return { blobs: opts.limit ? blobs.slice(0, opts.limit) : blobs };
}

export async function del(urlOrPathname: string, opts?: { token?: string }): Promise<void> {
  const s = r2();
  if (!s) return vercel.del(urlOrPathname, opts);
  const res = await s.client.fetch(keyUrl(s, keyOf(s, urlOrPathname)), { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`storage DELETE: HTTP ${res.status}`);
}
