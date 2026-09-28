import { describe, expect, it } from "vitest";
import { authorized } from "../src/keep-auth.js";

const secret = "s".repeat(32);

describe("bookkeeping endpoint auth", () => {
  it("lets in the right bearer secret", () => {
    expect(authorized(`Bearer ${secret}`, secret)).toBe(true);
  });

  it("turns away a wrong, missing or malformed header", () => {
    expect(authorized(`Bearer ${secret}x`, secret)).toBe(false);
    expect(authorized(null, secret)).toBe(false);
    expect(authorized(secret, secret)).toBe(false);
  });

  it("stays shut when no secret, or a short one, is configured", () => {
    expect(authorized("Bearer ", undefined)).toBe(false);
    expect(authorized("Bearer ", "")).toBe(false);
    expect(authorized("Bearer short", "short")).toBe(false);
  });
});
