const JUP_PRICE = "https://lite-api.jup.ag/price/v3";

/** USD prices for the given mints from Jupiter's price API. Missing mints are omitted. */
export async function usdPrices(mints: string[]): Promise<Record<string, number>> {
  const res = await fetch(`${JUP_PRICE}?ids=${mints.join(",")}`);
  if (!res.ok) throw new Error(`Jupiter price API ${res.status}`);
  const data = (await res.json()) as Record<string, { usdPrice?: number } | null>;
  const out: Record<string, number> = {};
  for (const [mint, v] of Object.entries(data)) {
    if (v?.usdPrice) out[mint] = v.usdPrice;
  }
  return out;
}

export async function usdPrice(mint: string): Promise<number> {
  const p = (await usdPrices([mint]))[mint];
  if (!p) throw new Error(`no USD price for ${mint}`);
  return p;
}
