/**
 * Universal licensing & tier module.
 *
 *   const lm = new LicenseManager(config);
 *   await lm.activate(key);            // first run: verifies with Gumroad, counts one activation
 *   const lic = await lm.check();      // every run: cached → periodic online re-check → offline grace
 *   lm.requireTier(lic, "pro");        // feature gating
 *
 * Verification: POST https://api.gumroad.com/v2/licenses/verify
 *   form: product_id, license_key, increment_uses_count
 *   200 → { success: true, uses, purchase: { variants: "(Tier: Pro)", refunded, ... } }
 *   404 → { success: false, message: "That license does not exist for the provided product." }
 */

import { EncryptedFileStore, type LicenseStore } from "./store.ts";
import {
  TIERS,
  type CachedLicense,
  type LicenseErrorCode,
  type LicenseInfo,
  type ProductLicenseConfig,
  type Tier,
} from "./types.ts";

export const GUMROAD_VERIFY_URL = "https://api.gumroad.com/v2/licenses/verify";
const DAY_MS = 86_400_000;
/** Tolerate this much backwards clock movement before distrusting the cache. */
const CLOCK_SKEW_MS = 60 * 60 * 1000;

declare const __DEV__: boolean | undefined;
/** esbuild defines __DEV__=false for release builds, which strips the dev bypass entirely. */
const IS_DEV = typeof __DEV__ === "undefined" ? true : __DEV__;

export class LicenseError extends Error {
  /** Set once the onboarding flow has already shown this error to the user. */
  reported = false;
  constructor(
    readonly code: LicenseErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "LicenseError";
  }
}

/** Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 (Node 22.21+ / 24+). */
function proxyHint(env: NodeJS.ProcessEnv): string {
  const proxied = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  return proxied && !env.NODE_USE_ENV_PROXY ? " Behind a proxy? Set NODE_USE_ENV_PROXY=1." : "";
}

// --------------------------------------------------------------------------------------
// Tiers
// --------------------------------------------------------------------------------------

const BUILTIN_TIER_SYNONYMS: Record<string, Tier> = {
  hobbyist: "hobbyist",
  hobby: "hobbyist",
  personal: "hobbyist",
  starter: "hobbyist",
  basic: "hobbyist",
  indie: "hobbyist",
  individual: "hobbyist",
  pro: "pro",
  professional: "pro",
  premium: "pro",
  plus: "pro",
  enterprise: "enterprise",
  business: "enterprise",
  team: "enterprise",
  teams: "enterprise",
  commercial: "enterprise",
  agency: "enterprise",
  unlimited: "enterprise",
};

export function tierRank(tier: Tier): number {
  return TIERS.indexOf(tier);
}

export function meetsTier(actual: Tier, required: Tier): boolean {
  return tierRank(actual) >= tierRank(required);
}

/**
 * Gumroad returns variants as one string, e.g. "(Pro)", "(Tier: Enterprise)",
 * "(Tier: Pro, Billing: Annual)", or "" for products without variants.
 * We look at every option value, then at every word, preferring the highest tier found.
 */
export function parseTier(variants: string | null | undefined, cfg: Pick<ProductLicenseConfig, "tierMap" | "defaultTier">): Tier {
  const fallback = cfg.defaultTier ?? "pro";
  const raw = (variants ?? "").trim().replace(/^\(|\)$/g, "");
  if (!raw) return fallback;
  const map: Record<string, Tier> = { ...BUILTIN_TIER_SYNONYMS };
  for (const [label, tier] of Object.entries(cfg.tierMap ?? {})) map[label.trim().toLowerCase()] = tier;

  const values = raw.split(",").map((part) => {
    const idx = part.indexOf(":");
    return (idx >= 0 ? part.slice(idx + 1) : part).trim().toLowerCase();
  });

  const found: Tier[] = [];
  for (const value of values) {
    if (map[value]) {
      found.push(map[value]);
      continue;
    }
    for (const word of value.split(/[^a-z0-9]+/)) {
      if (word && map[word]) found.push(map[word]);
    }
  }
  if (found.length === 0) return fallback;
  return found.reduce((best, t) => (tierRank(t) > tierRank(best) ? t : best));
}

// --------------------------------------------------------------------------------------
// Gumroad client
// --------------------------------------------------------------------------------------

export interface GumroadPurchase {
  id?: string;
  product_id?: string;
  product_name?: string;
  email?: string;
  variants?: string;
  refunded?: boolean;
  disputed?: boolean;
  chargebacked?: boolean;
  test?: boolean;
  subscription_ended_at?: string | null;
  subscription_cancelled_at?: string | null;
  subscription_failed_at?: string | null;
  license_key?: string;
  created_at?: string;
}

export interface GumroadVerifyResponse {
  success: boolean;
  uses?: number;
  message?: string;
  purchase?: GumroadPurchase;
}

export type VerifyOutcome =
  | { kind: "ok"; body: GumroadVerifyResponse }
  | { kind: "rejected"; message: string } // definitive "no" from Gumroad
  | { kind: "unreachable"; message: string }; // network / 5xx / 429 / timeout — retry later

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface VerifyOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function verifyWithGumroad(
  productId: string,
  licenseKey: string,
  incrementUses: boolean,
  opts: VerifyOptions = {},
): Promise<VerifyOutcome> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const body = new URLSearchParams({
    product_id: productId,
    license_key: licenseKey.trim(),
    increment_uses_count: String(incrementUses),
  });

  let lastError = "unknown error";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(8000, 500 * 2 ** attempt) * (0.5 + Math.random() / 2));
    let res: Response;
    try {
      res = await doFetch(GUMROAD_VERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = `Gumroad returned HTTP ${res.status}`;
      continue;
    }
    let json: GumroadVerifyResponse;
    try {
      json = (await res.json()) as GumroadVerifyResponse;
    } catch {
      lastError = `Gumroad returned a non-JSON response (HTTP ${res.status})`;
      continue;
    }
    if (res.ok && json.success) return { kind: "ok", body: json };
    // 404 / 400 with success:false is a definitive answer about the key.
    if (res.status >= 400 && res.status < 500) {
      return { kind: "rejected", message: json.message || `License rejected (HTTP ${res.status})` };
    }
    return { kind: "rejected", message: json.message || "License rejected" };
  }
  return { kind: "unreachable", message: lastError };
}

// --------------------------------------------------------------------------------------
// License manager
// --------------------------------------------------------------------------------------

export interface LicenseManagerDeps {
  store?: LicenseStore;
  fetch?: FetchLike;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
}

export interface CheckOptions {
  /** Force an online verification even if the cache is fresh. */
  forceOnline?: boolean;
}

export function envVarName(slug: string): string {
  return `${slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_LICENSE_KEY`;
}

export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 8) return "****";
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

export class LicenseManager {
  readonly config: Required<Pick<ProductLicenseConfig, "revalidateAfterDays" | "offlineGraceDays" | "defaultTier">> &
    ProductLicenseConfig;
  readonly store: LicenseStore;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;

  constructor(config: ProductLicenseConfig, deps: LicenseManagerDeps = {}) {
    if (!config.productId) throw new Error(`${config.productName}: licensing config is missing productId`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(config.slug)) throw new Error(`invalid slug "${config.slug}"`);
    this.config = { revalidateAfterDays: 7, offlineGraceDays: 14, defaultTier: "pro", ...config };
    this.store = deps.store ?? new EncryptedFileStore();
    this.fetchImpl = deps.fetch;
    this.now = deps.now ?? (() => new Date());
    this.env = deps.env ?? process.env;
    this.sleep = deps.sleep;
  }

  get envVar(): string {
    return envVarName(this.config.slug);
  }

  /** Verify a key online and store it. Counts as one activation on Gumroad. */
  async activate(licenseKey: string): Promise<LicenseInfo> {
    const key = licenseKey.trim();
    if (!key) throw new LicenseError("missing", "No license key provided.");
    const outcome = await this.verify(key, true);
    if (outcome.kind === "unreachable") {
      throw new LicenseError("network", "Couldn't reach Gumroad to activate your license.",
        `Check your internet connection and try again.${proxyHint(this.env)} (${outcome.message})`);
    }
    if (outcome.kind === "rejected") throw this.invalidError(outcome.message);
    const nowIso = this.now().toISOString();
    const cached = this.toCached(key, outcome.body, nowIso, nowIso);
    this.store.set(this.config.slug, cached);
    return { ...cached, source: "online" };
  }

  /**
   * Resolve the current license without user interaction. Order:
   *   dev bypass (non-release builds) → cache (fresh) → online re-check → offline grace → env var key.
   * Throws LicenseError when there's no usable license.
   */
  async check(opts: CheckOptions = {}): Promise<LicenseInfo> {
    const dev = this.devBypass();
    if (dev) return dev;

    const envKey = this.env[this.envVar]?.trim();
    let cached = this.store.get(this.config.slug);
    if (cached && (cached.productId !== this.config.productId || (envKey && envKey !== cached.licenseKey))) {
      cached = undefined; // product changed, or a different key was supplied via env
    }

    if (!cached) {
      if (!envKey) {
        throw new LicenseError("missing", `No ${this.config.productName} license found on this machine.`,
          `Run \`${this.config.slug} license activate <key>\` or set ${this.envVar}.`);
      }
      // CI / headless use: verify without consuming an activation on every run.
      const outcome = await this.verify(envKey, false);
      if (outcome.kind === "unreachable") {
        throw new LicenseError("network", "Couldn't reach Gumroad to verify the license from " + this.envVar + ".",
          `${outcome.message}.${proxyHint(this.env)}`);
      }
      if (outcome.kind === "rejected") throw this.invalidError(outcome.message);
      const nowIso = this.now().toISOString();
      const fresh = this.toCached(envKey, outcome.body, nowIso, nowIso);
      this.store.set(this.config.slug, fresh);
      return { ...fresh, source: "env" };
    }

    const now = this.now().getTime();
    const verifiedAt = Date.parse(cached.lastVerifiedAt);
    const age = now - verifiedAt;
    const clockWentBack = Number.isNaN(verifiedAt) || age < -CLOCK_SKEW_MS;
    const stale = age >= this.config.revalidateAfterDays * DAY_MS;

    if (!opts.forceOnline && !stale && !clockWentBack) {
      return { ...cached, source: "cache" };
    }

    const outcome = await this.verify(cached.licenseKey, false);
    if (outcome.kind === "ok") {
      const refreshed = this.toCached(cached.licenseKey, outcome.body, cached.activatedAt, this.now().toISOString());
      this.store.set(this.config.slug, refreshed);
      return { ...refreshed, source: "online" };
    }
    if (outcome.kind === "rejected") {
      this.store.delete(this.config.slug);
      throw this.invalidError(outcome.message);
    }

    // Offline. Honour the grace period unless the clock looks manipulated.
    const graceMs = this.config.offlineGraceDays * DAY_MS;
    if (!clockWentBack && age < graceMs) {
      const graceDaysLeft = Math.max(0, Math.floor((graceMs - age) / DAY_MS));
      return { ...cached, source: "offline-grace", graceDaysLeft };
    }
    throw new LicenseError("grace_expired",
      clockWentBack
        ? "Your system clock looks wrong, so the license needs to be re-checked online."
        : `${this.config.productName} hasn't been able to verify your license for ` +
          `${Math.floor(age / DAY_MS)} days (offline limit: ${this.config.offlineGraceDays}).`,
      `Connect to the internet and run the command again.${proxyHint(this.env)}`);
  }

  /** Current local state without throwing or hitting the network. */
  peek(): CachedLicense | undefined {
    return this.store.get(this.config.slug);
  }

  /** Remove the local activation (Gumroad's activation counter is seller-side only). */
  deactivate(): boolean {
    const had = Boolean(this.store.get(this.config.slug));
    this.store.delete(this.config.slug);
    return had;
  }

  requireTier(license: Pick<LicenseInfo, "tier">, required: Tier, feature?: string): void {
    if (meetsTier(license.tier, required)) return;
    const what = feature ? `"${feature}"` : "This feature";
    throw new LicenseError("tier",
      `${what} requires the ${capitalize(required)} tier (you have ${capitalize(license.tier)}).`,
      `Upgrade at ${this.config.purchaseUrl}`);
  }

  // -- internals ------------------------------------------------------------------------
  private verify(key: string, incrementUses: boolean): Promise<VerifyOutcome> {
    return verifyWithGumroad(this.config.productId, key, incrementUses, {
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      ...(this.sleep ? { sleep: this.sleep } : {}),
    });
  }

  private devBypass(): LicenseInfo | undefined {
    if (!IS_DEV) return undefined;
    const tier = this.env.INDIE_CLI_DEV_LICENSE?.trim().toLowerCase();
    if (!tier) return undefined;
    if (!(TIERS as readonly string[]).includes(tier)) {
      throw new Error(`INDIE_CLI_DEV_LICENSE must be one of ${TIERS.join(", ")}`);
    }
    const nowIso = this.now().toISOString();
    return {
      licenseKey: "DEV-LICENSE", productId: this.config.productId, tier: tier as Tier, variant: "dev",
      email: "dev@localhost", purchaseId: "dev", uses: 0, activatedAt: nowIso, lastVerifiedAt: nowIso, source: "dev",
    };
  }

  /** Validate purchase state and map it to what we cache. Throws on revoked/limit/test. */
  private toCached(key: string, body: GumroadVerifyResponse, activatedAt: string, verifiedAt: string): CachedLicense {
    const p = body.purchase ?? {};
    const support = this.config.supportEmail ? ` Contact ${this.config.supportEmail} if this is a mistake.` : "";
    if (p.refunded || p.chargebacked || p.disputed) {
      this.store.delete(this.config.slug);
      throw new LicenseError("revoked", `This license was ${p.refunded ? "refunded" : "charged back or disputed"}.${support}`);
    }
    if (p.subscription_ended_at || p.subscription_failed_at) {
      this.store.delete(this.config.slug);
      throw new LicenseError("revoked", "Your subscription has ended or its payment failed.",
        `Renew at ${this.config.purchaseUrl}`);
    }
    if (p.test && !this.config.allowTestPurchases) {
      throw new LicenseError("test_purchase", "This is a Gumroad test purchase, which this product doesn't accept.");
    }
    if (p.product_id && p.product_id !== this.config.productId) {
      throw new LicenseError("invalid", "This license key belongs to a different product.");
    }
    const tier = parseTier(p.variants, this.config);
    const uses = body.uses ?? 0;
    const limit = this.config.maxActivations?.[tier];
    if (limit !== undefined && uses > limit) {
      throw new LicenseError("activation_limit",
        `This ${capitalize(tier)} license has been activated ${uses} times (limit ${limit}).${support}`,
        `Need more seats? Upgrade at ${this.config.purchaseUrl}`);
    }
    return {
      licenseKey: key,
      productId: this.config.productId,
      tier,
      variant: (p.variants ?? "").replace(/^\(|\)$/g, ""),
      email: p.email ?? "",
      purchaseId: p.id ?? "",
      uses,
      activatedAt,
      lastVerifiedAt: verifiedAt,
      ...(p.test ? { test: true } : {}),
    };
  }

  private invalidError(message: string): LicenseError {
    return new LicenseError("invalid", `License key not accepted: ${message}`,
      `Double-check the key from your Gumroad receipt, or buy one at ${this.config.purchaseUrl}`);
  }
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
