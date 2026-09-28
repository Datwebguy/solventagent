import { createHash, timingSafeEqual } from "node:crypto";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Checks `Authorization: Bearer <secret>`. With no secret configured, nobody is let in. */
export function authorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 24 || !header?.startsWith("Bearer ")) return false;
  return timingSafeEqual(digest(header.slice(7)), digest(secret));
}
