import { generateKeyPairSync, sign } from "node:crypto";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { checkHolderRequest, holderMessage, isHolder, signedBy } from "../src/holder.js";

function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return { address: new PublicKey(raw).toBase58(), sign: (m: string) => bs58.encode(sign(null, Buffer.from(m, "utf8"), privateKey)) };
}
const AGENT = "6tKiito8pV8oYgta7odevrgSD1xQhKV8b2VM1kouQmjm";

describe("$SOLVENT holder requests", () => {
  it("accepts a fresh request signed by the holder's own wallet", () => {
    const w = wallet();
    const at = new Date().toISOString();
    expect(signedBy(holderMessage(AGENT, at), w.sign(holderMessage(AGENT, at)), w.address)).toBe(true);
    expect(() => checkHolderRequest({ signer: w.address, agent: AGENT, at, signature: w.sign(holderMessage(AGENT, at)) }, AGENT)).not.toThrow();
  });

  it("refuses someone else's signature, another agent, or an old request", () => {
    const w = wallet(), other = wallet();
    const at = new Date().toISOString();
    expect(() => checkHolderRequest({ signer: w.address, agent: AGENT, at, signature: other.sign(holderMessage(AGENT, at)) }, AGENT)).toThrow(/signature/);
    expect(() => checkHolderRequest({ signer: w.address, agent: AGENT, at, signature: w.sign(holderMessage(AGENT, at)) }, "8kZBBhPkM9bHhHuUeCzLdNu6eekwTfvNgsF1oPUVZ6YS")).toThrow(/another agent/);
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(() => checkHolderRequest({ signer: w.address, agent: AGENT, at: old, signature: w.sign(holderMessage(AGENT, old)) }, AGENT)).toThrow(/expired/);
  });

  it("counts a wallet as a holder from the minimum up", () => {
    expect(isHolder(50_000)).toBe(true);
    expect(isHolder(49_999)).toBe(false);
  });
});
