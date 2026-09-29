import { readSeals } from "../src/seal-store.js";

/** Every seal, and how much $ANSEM agents have burned in total. */
export async function GET(): Promise<Response> {
  try {
    return Response.json(await readSeals(), { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" } });
  } catch (err) {
    console.error(err);
    return Response.json({ seals: {}, burned: 0, count: 0 }, { headers: { "cache-control": "no-store" } });
  }
}
