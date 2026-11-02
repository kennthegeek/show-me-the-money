import type { ProductLicenseConfig } from "@products/shared";

import pkg from "./package.json" with { type: "json" };

declare const __PRODUCT_VERSION__: string | undefined;

/** Injected at build time; falls back to package.json in dev and tests. */
export const VERSION = typeof __PRODUCT_VERSION__ === "string" ? __PRODUCT_VERSION__ : pkg.version;

export const LICENSING: ProductLicenseConfig = {
  // Gumroad → your product → Content → "License key" section shows the product_id.
  productId: process.env.LEGACY_DE_SPAGHETTI_GUMROAD_PRODUCT_ID ?? "REPLACE_WITH_GUMROAD_PRODUCT_ID",
  productName: "Legacy-De-Spaghetti",
  slug: "legacy-de-spaghetti",
  purchaseUrl: "https://gumroad.com/l/legacy-de-spaghetti",
  // Gumroad variant labels → tiers. Built-in synonyms already cover hobbyist/pro/enterprise.
  tierMap: {},
  defaultTier: "pro",
  revalidateAfterDays: 7,
  offlineGraceDays: 14,
  maxActivations: { hobbyist: 2, pro: 3 },
  supportEmail: "support@example.com",
};
