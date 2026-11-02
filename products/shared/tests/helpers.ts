import type { FetchLike, GumroadPurchase } from "../auth.ts";
import { MemoryStore } from "../store.ts";
import type { ProductLicenseConfig } from "../types.ts";

export const CONFIG: ProductLicenseConfig = {
  productId: "prod_ABC123",
  productName: "TestTool",
  slug: "test-tool",
  purchaseUrl: "https://example.gumroad.com/l/testtool",
  maxActivations: { hobbyist: 2, pro: 5 },
  supportEmail: "help@example.com",
};

export const KEY = "AAAA1111-BBBB2222-CCCC3333-DDDD4444";

export function purchase(overrides: Partial<GumroadPurchase> = {}): GumroadPurchase {
  return {
    id: "pur_1",
    product_id: CONFIG.productId,
    product_name: "TestTool",
    email: "buyer@example.com",
    variants: "(Tier: Pro)",
    refunded: false,
    disputed: false,
    chargebacked: false,
    test: false,
    subscription_ended_at: null,
    subscription_failed_at: null,
    license_key: KEY,
    ...overrides,
  };
}

type Reply = { status: number; body?: unknown } | Error;

/** Scripted fetch: returns the queued replies in order (the last one repeats). Records requests. */
export function scriptedFetch(...replies: Reply[]) {
  const calls: { url: string; params: URLSearchParams }[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, params: new URLSearchParams(String(init?.body ?? "")) });
    const reply = replies[Math.min(i++, replies.length - 1)]!;
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch, calls };
}

export const ok = (p: Partial<GumroadPurchase> = {}, uses = 1) => ({
  status: 200,
  body: { success: true, uses, purchase: purchase(p) },
});

export const notFound = {
  status: 404,
  body: { success: false, message: "That license does not exist for the provided product." },
};

export class Clock {
  constructor(public t = Date.parse("2026-01-01T00:00:00Z")) {}
  now = () => new Date(this.t);
  advanceDays(d: number) {
    this.t += d * 86_400_000;
  }
}

export function deps(fetch: FetchLike, clock = new Clock(), store = new MemoryStore(), env: NodeJS.ProcessEnv = {}) {
  return { fetch, now: clock.now, store, env, sleep: async () => {} };
}
