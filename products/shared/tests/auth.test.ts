import { describe, expect, it } from "vitest";

import {
  envVarName,
  GUMROAD_VERIFY_URL,
  LicenseError,
  LicenseManager,
  maskKey,
  meetsTier,
  parseTier,
  verifyWithGumroad,
} from "../auth.ts";
import { MemoryStore } from "../store.ts";
import { CONFIG, Clock, deps, KEY, notFound, ok, scriptedFetch } from "./helpers.ts";

async function expectLicenseError(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LicenseError);
  expect((err as LicenseError).code).toBe(code);
  return err as LicenseError;
}

describe("parseTier", () => {
  const cfg = { defaultTier: "pro" as const };
  it.each([
    ["(Hobbyist)", "hobbyist"],
    ["(Tier: Pro)", "pro"],
    ["(Tier: Enterprise, Billing: Annual)", "enterprise"],
    ["(Personal License)", "hobbyist"],
    ["(Team - 10 seats)", "enterprise"],
    ["(Billing: Monthly, Plan: Professional)", "pro"],
    ["", "pro"],
    [null, "pro"],
    ["(Blue)", "pro"],
  ])("%s → %s", (variants, tier) => {
    expect(parseTier(variants, cfg)).toBe(tier);
  });

  it("uses custom tierMap entries and prefers the highest tier", () => {
    expect(parseTier("(Gold)", { tierMap: { gold: "enterprise" } })).toBe("enterprise");
    expect(parseTier("(Starter + Pro Addon)", {})).toBe("pro");
  });

  it("honours defaultTier for single-tier products", () => {
    expect(parseTier("", { defaultTier: "hobbyist" })).toBe("hobbyist");
  });
});

describe("helpers", () => {
  it("compares tiers", () => {
    expect(meetsTier("enterprise", "pro")).toBe(true);
    expect(meetsTier("hobbyist", "pro")).toBe(false);
  });
  it("builds env var names and masks keys", () => {
    expect(envVarName("commit-craft")).toBe("COMMIT_CRAFT_LICENSE_KEY");
    expect(maskKey(KEY)).toBe("AAAA…4444");
    expect(maskKey("short")).toBe("****");
  });
});

describe("verifyWithGumroad", () => {
  it("posts product_id, license_key and increment flag as a form", async () => {
    const { fetch, calls } = scriptedFetch(ok());
    const out = await verifyWithGumroad("prod_ABC123", `  ${KEY} `, true, { fetch });
    expect(out.kind).toBe("ok");
    expect(calls[0]!.url).toBe(GUMROAD_VERIFY_URL);
    expect(Object.fromEntries(calls[0]!.params)).toEqual({
      product_id: "prod_ABC123",
      license_key: KEY,
      increment_uses_count: "true",
    });
  });

  it("treats 404 as a definitive rejection without retrying", async () => {
    const { fetch, calls } = scriptedFetch(notFound);
    const out = await verifyWithGumroad("p", KEY, false, { fetch, sleep: async () => {} });
    expect(out).toEqual({ kind: "rejected", message: "That license does not exist for the provided product." });
    expect(calls).toHaveLength(1);
  });

  it("retries network errors, 429 and 5xx, then succeeds", async () => {
    const { fetch, calls } = scriptedFetch(new TypeError("fetch failed"), { status: 429 }, ok());
    const out = await verifyWithGumroad("p", KEY, false, { fetch, sleep: async () => {} });
    expect(out.kind).toBe("ok");
    expect(calls).toHaveLength(3);
  });

  it("reports unreachable after exhausting retries", async () => {
    const { fetch, calls } = scriptedFetch({ status: 503 });
    const out = await verifyWithGumroad("p", KEY, false, { fetch, retries: 2, sleep: async () => {} });
    expect(out).toEqual({ kind: "unreachable", message: "Gumroad returned HTTP 503" });
    expect(calls).toHaveLength(3);
  });
});

describe("LicenseManager", () => {
  it("activates, caches, and serves from cache without network", async () => {
    const { fetch, calls } = scriptedFetch(ok({}, 1));
    const store = new MemoryStore();
    const lm = new LicenseManager(CONFIG, deps(fetch, new Clock(), store));
    const lic = await lm.activate(KEY);
    expect(lic).toMatchObject({ tier: "pro", email: "buyer@example.com", uses: 1, source: "online", variant: "Tier: Pro" });
    expect(calls[0]!.params.get("increment_uses_count")).toBe("true");
    expect(store.get("test-tool")?.licenseKey).toBe(KEY);

    const again = await lm.check();
    expect(again.source).toBe("cache");
    expect(calls).toHaveLength(1);
  });

  it("throws 'missing' when nothing is configured", async () => {
    const lm = new LicenseManager(CONFIG, deps(scriptedFetch(ok()).fetch));
    const err = await expectLicenseError(lm.check(), "missing");
    expect(err.hint).toContain("TEST_TOOL_LICENSE_KEY");
  });

  it("re-verifies after revalidateAfterDays without consuming an activation", async () => {
    const clock = new Clock();
    const { fetch, calls } = scriptedFetch(ok({}, 1), ok({ variants: "(Enterprise)" }, 1));
    const lm = new LicenseManager(CONFIG, deps(fetch, clock));
    await lm.activate(KEY);
    clock.advanceDays(8);
    const lic = await lm.check();
    expect(lic.source).toBe("online");
    expect(lic.tier).toBe("enterprise"); // upgrades picked up on revalidation
    expect(calls[1]!.params.get("increment_uses_count")).toBe("false");
    expect(Date.parse(lic.lastVerifiedAt)).toBe(clock.t);
  });

  it("allows offline use within the grace period, then blocks", async () => {
    const clock = new Clock();
    const { fetch } = scriptedFetch(ok(), new TypeError("ENOTFOUND api.gumroad.com"));
    const lm = new LicenseManager(CONFIG, deps(fetch, clock));
    await lm.activate(KEY);

    clock.advanceDays(10);
    const lic = await lm.check();
    expect(lic.source).toBe("offline-grace");
    expect(lic.graceDaysLeft).toBe(4);

    clock.advanceDays(5); // 15 days since last verification > 14
    await expectLicenseError(lm.check(), "grace_expired");
  });

  it("revokes refunded licenses on revalidation and clears the cache", async () => {
    const clock = new Clock();
    const store = new MemoryStore();
    const { fetch } = scriptedFetch(ok(), ok({ refunded: true }));
    const lm = new LicenseManager(CONFIG, deps(fetch, clock, store));
    await lm.activate(KEY);
    clock.advanceDays(30);
    await expectLicenseError(lm.check(), "revoked");
    expect(store.get("test-tool")).toBeUndefined();
  });

  it("clears the cache when Gumroad no longer recognises the key", async () => {
    const clock = new Clock();
    const store = new MemoryStore();
    const lm = new LicenseManager(CONFIG, deps(scriptedFetch(ok(), notFound).fetch, clock, store));
    await lm.activate(KEY);
    await expectLicenseError(lm.check({ forceOnline: true }), "invalid");
    expect(store.get("test-tool")).toBeUndefined();
  });

  it.each([
    [{ chargebacked: true }, "revoked"],
    [{ subscription_ended_at: "2025-12-01T00:00:00Z" }, "revoked"],
    [{ subscription_failed_at: "2025-12-01T00:00:00Z" }, "revoked"],
    [{ test: true }, "test_purchase"],
    [{ product_id: "someone-elses" }, "invalid"],
  ])("rejects purchase %o with %s", async (p, code) => {
    const lm = new LicenseManager(CONFIG, deps(scriptedFetch(ok(p)).fetch));
    await expectLicenseError(lm.activate(KEY), code);
  });

  it("accepts test purchases when allowed", async () => {
    const lm = new LicenseManager({ ...CONFIG, allowTestPurchases: true }, deps(scriptedFetch(ok({ test: true })).fetch));
    expect((await lm.activate(KEY)).test).toBe(true);
  });

  it("enforces per-tier activation limits", async () => {
    const lm = new LicenseManager(CONFIG, deps(scriptedFetch(ok({ variants: "(Hobbyist)" }, 3)).fetch));
    const err = await expectLicenseError(lm.activate(KEY), "activation_limit");
    expect(err.message).toContain("limit 2");
    // Enterprise has no limit configured.
    const ent = new LicenseManager(CONFIG, deps(scriptedFetch(ok({ variants: "(Enterprise)" }, 99)).fetch));
    expect((await ent.activate(KEY)).tier).toBe("enterprise");
  });

  it("forces an online check when the clock goes backwards, and refuses grace", async () => {
    const clock = new Clock();
    const { fetch } = scriptedFetch(ok(), new TypeError("offline"));
    const lm = new LicenseManager(CONFIG, deps(fetch, clock));
    await lm.activate(KEY);
    clock.advanceDays(-3);
    const err = await expectLicenseError(lm.check(), "grace_expired");
    expect(err.message).toMatch(/clock/);
  });

  it("verifies env-var keys without incrementing uses", async () => {
    const { fetch, calls } = scriptedFetch(ok());
    const lm = new LicenseManager(CONFIG, deps(fetch, new Clock(), new MemoryStore(), { TEST_TOOL_LICENSE_KEY: KEY }));
    const lic = await lm.check();
    expect(lic.source).toBe("env");
    expect(calls[0]!.params.get("increment_uses_count")).toBe("false");
  });

  it("re-verifies when the env key differs from the cached key", async () => {
    const store = new MemoryStore();
    const { fetch, calls } = scriptedFetch(ok(), ok({ variants: "(Enterprise)" }));
    await new LicenseManager(CONFIG, deps(fetch, new Clock(), store)).activate(KEY);
    const lm = new LicenseManager(CONFIG, deps(fetch, new Clock(), store, { TEST_TOOL_LICENSE_KEY: "OTHER-KEY-123456" }));
    expect((await lm.check()).tier).toBe("enterprise");
    expect(calls[1]!.params.get("license_key")).toBe("OTHER-KEY-123456");
  });

  it("supports a dev bypass in non-release builds", async () => {
    const lm = new LicenseManager(CONFIG, deps(scriptedFetch(notFound).fetch, new Clock(), new MemoryStore(),
      { INDIE_CLI_DEV_LICENSE: "enterprise" }));
    expect(await lm.check()).toMatchObject({ tier: "enterprise", source: "dev" });
  });

  it("reports network failures during activation distinctly", async () => {
    const lm = new LicenseManager(CONFIG, deps(scriptedFetch(new TypeError("offline")).fetch));
    await expectLicenseError(lm.activate(KEY), "network");
  });

  it("requireTier explains the upgrade path", () => {
    const lm = new LicenseManager(CONFIG, deps(scriptedFetch(ok()).fetch));
    expect(() => lm.requireTier({ tier: "pro" }, "pro")).not.toThrow();
    try {
      lm.requireTier({ tier: "hobbyist" }, "enterprise", "Batch mode");
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: "tier", hint: `Upgrade at ${CONFIG.purchaseUrl}` });
      expect((e as Error).message).toContain('"Batch mode" requires the Enterprise tier');
    }
  });

  it("deactivate removes the local activation", async () => {
    const lm = new LicenseManager(CONFIG, deps(scriptedFetch(ok()).fetch));
    await lm.activate(KEY);
    expect(lm.deactivate()).toBe(true);
    expect(lm.peek()).toBeUndefined();
    expect(lm.deactivate()).toBe(false);
  });

  it("validates config", () => {
    expect(() => new LicenseManager({ ...CONFIG, productId: "" })).toThrow(/productId/);
    expect(() => new LicenseManager({ ...CONFIG, slug: "Bad Slug" })).toThrow(/slug/);
  });
});
