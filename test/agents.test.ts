import { describe, expect, it } from "vitest";
import { cleanJoin } from "../src/agents.js";

const wallet = "8kZBBhPkM9bHhHuUeCzLdNu6eekwTfvNgsF1oPUVZ6YS";

describe("agent sign-up", () => {
  it("accepts a good sign-up and tidies it", () => {
    const r = cleanJoin({ wallet: ` ${wallet} `, name: "  My   Agent ", handle: "@my_agent" });
    expect(r).toEqual({ ok: true, value: { wallet, name: "My Agent", handle: "my_agent" } });
  });

  it("rejects a bad wallet", () => {
    for (const w of ["", "hello", "0OIl" + "1".repeat(30), wallet.slice(10)]) {
      expect(cleanJoin({ wallet: w, name: "Agent", handle: "agent" }).ok).toBe(false);
    }
  });

  it("rejects bad names and handles", () => {
    expect(cleanJoin({ wallet, name: "A", handle: "agent" }).ok).toBe(false);
    expect(cleanJoin({ wallet, name: "x".repeat(41), handle: "agent" }).ok).toBe(false);
    expect(cleanJoin({ wallet, name: "Agent", handle: "not a handle" }).ok).toBe(false);
    expect(cleanJoin({ wallet, name: "Agent", handle: "waytoolonghandle_x" }).ok).toBe(false);
  });

  it("strips markup characters from the name", () => {
    const r = cleanJoin({ wallet, name: "<b>Bold</b> Agent", handle: "agent" });
    expect(r.ok && r.value.name).toBe("bBold/b Agent");
  });

  it("copes with junk input", () => {
    expect(cleanJoin(null).ok).toBe(false);
    expect(cleanJoin({ wallet: 5, name: {}, handle: [] }).ok).toBe(false);
  });
});
