export const TIERS = ["hobbyist", "pro", "enterprise"] as const;
export type Tier = (typeof TIERS)[number];

/** Static, per-product licensing configuration (lives in each product's product.config.ts). */
export interface ProductLicenseConfig {
  /** Gumroad product ID (Product → Edit → "License key" section). Required for products created after Jan 2023. */
  productId: string;
  /** Display name, e.g. "CommitCraft". */
  productName: string;
  /** Stable machine name; used as the cache key and env var prefix (COMMITCRAFT_LICENSE_KEY). */
  slug: string;
  /** Where users buy a key (Gumroad / Lemon Squeezy checkout URL). */
  purchaseUrl: string;
  /** Extra variant label → tier mappings (case-insensitive). Built-in synonyms cover the usual names. */
  tierMap?: Record<string, Tier>;
  /** Tier for purchases with no variant (single-tier products). Default: "pro". */
  defaultTier?: Tier;
  /** Re-verify online after this many days. Default 7. */
  revalidateAfterDays?: number;
  /** Keep working this many days after the last successful verification if offline. Default 14. */
  offlineGraceDays?: number;
  /** Max activations (Gumroad `uses`) per tier; omit for unlimited. */
  maxActivations?: Partial<Record<Tier, number>>;
  /** Accept Gumroad test purchases (seller's own test buys). Default false. */
  allowTestPurchases?: boolean;
  /** Support contact shown in error messages. */
  supportEmail?: string;
}

/** What we persist locally after a successful verification. */
export interface CachedLicense {
  licenseKey: string;
  productId: string;
  tier: Tier;
  variant: string;
  email: string;
  purchaseId: string;
  uses: number;
  activatedAt: string; // ISO
  lastVerifiedAt: string; // ISO; drives revalidation + offline grace
  test?: boolean;
}

export type LicenseSource = "cache" | "online" | "offline-grace" | "env" | "dev";

export interface LicenseInfo extends CachedLicense {
  source: LicenseSource;
  /** Days of offline use left (only meaningful when source === "offline-grace"). */
  graceDaysLeft?: number;
}

export type LicenseErrorCode =
  | "missing" // no key anywhere
  | "invalid" // Gumroad says the key doesn't exist for this product
  | "revoked" // refunded / charged back / disputed / subscription ended
  | "activation_limit" // more activations than the tier allows
  | "grace_expired" // offline for longer than the grace period
  | "network" // couldn't reach Gumroad and no usable cache
  | "tier" // valid license, but the tier is too low for this feature
  | "test_purchase"; // test purchase while allowTestPurchases is false
