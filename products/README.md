# Products Monorepo

A workspace for building and selling a portfolio of standalone, licensed CLI tools (Gumroad / Lemon Squeezy).
Every product shares one licensing module, one CLI scaffold and one build pipeline. Shipping product #37 should feel the same as shipping product #1.

```
products/
├── shared/                 # @products/shared, bundled into every product (never published)
│   ├── auth.ts             # Gumroad verification, tiers, cache, offline grace, LicenseManager
│   ├── store.ts            # encrypted, machine-bound cache in ~/.indie-cli/
│   ├── onboarding.ts       # friendly first-run license prompt (TTY) / instructions (CI)
│   ├── cli.ts              # Commander scaffold: `license` commands, gating hook, exit codes
│   ├── types.ts
│   └── tests/              # Vitest
├── dev-tools/              # ┐
├── gaming-mods/            # │ one directory per category;
├── creator-pipelines/      # │ each product lives in <category>/<name>/
├── lifestyle/              # │ (npm workspaces: "<category>/*")
├── micro-utilities/        # ┘
├── templates/cli-tool/     # what `npm run new` copies
├── scripts/
│   ├── build-all.ts        # esbuild bundles → npm packages, tarballs, standalone binaries
│   ├── new-product.ts      # scaffolder
│   └── lib.ts
├── package.json · tsconfig.base.json · tsconfig.json · vitest.config.ts
```

**Stack:** TypeScript 5.9, Node 20+ (develop on 22), Commander 14, chalk 5, ora 9, esbuild, Vitest 4, tsx.

## Quick start

```bash
cd products
npm install
npm run check                                   # typecheck + all tests

npm run new -- dev-tools commit-craft --description "AI commit messages from your staged diff"
INDIE_CLI_DEV_LICENSE=pro npm run dev -w commit-craft -- hello Ada
npm test -w commit-craft
npm run build -- --only commit-craft --pack --binary
```

## Commands

| Command | What it does |
|---|---|
| `npm run new -- <category> <name> [--description ..] [--display ..] [--bin ..] [--product-id ..]` | Scaffold a product from `templates/cli-tool` and link the workspace |
| `npm run build` | Bundle every product into `dist/<name>/`: an npm-ready package with one dependency-free `bin/<bin>.cjs` |
| `npm run build -- --only a,b` | Build a subset |
| `npm run build -- --pack` | Also create `dist/release/<name>-<version>.tgz` (upload this to Gumroad) |
| `npm run build -- --binary` | Also create a standalone executable for the current OS/arch (Node SEA, no Node needed) |
| `npm run build -- --typecheck` | Run `tsc` first and stop on type errors |
| `npm run release` | `--typecheck --pack` for all products |
| `npm test` / `npm run typecheck` / `npm run check` | Vitest across shared, scripts and all products / tsc / both |

Every build smoke-tests its output by running `--version`, then writes `dist/release/SHA256SUMS.txt` for the release artifacts.

**Cross-platform binaries:** Node SEA only builds for the machine it runs on. The workflow `.github/workflows/products-ci.yml` (`binaries` job) builds linux-x64, linux-arm64, macOS arm64 and windows-x64. Start it manually from the Actions tab.
Each binary is about 100–120 MB because it embeds the Node runtime. Offer the `.tgz` too, for buyers who already have Node.

---

## Licensing (`shared/auth.ts`)

### How it behaves for the buyer

1. **First run.** If the terminal is interactive, the buyer sees a welcome box with your purchase link and pastes their key. A spinner shows while it verifies with Gumroad, then their tier is confirmed.
   In CI or a pipe, the tool prints concise instructions and exits with code `3` instead of hanging on a prompt.
2. **Every later run** uses the cached activation, with no network call.
3. **Every 7 days** (`revalidateAfterDays`) the tool re-checks silently, without using an activation. This also picks up upgrades, refunds and chargebacks.
4. **Offline:** the tool keeps working for 14 days after the last successful check (`offlineGraceDays`). It shows a warning in the last 3 days.
5. **Headless use:** setting `<SLUG>_LICENSE_KEY` (e.g. `COMMIT_CRAFT_LICENSE_KEY`) verifies without using up an activation, which suits CI.
6. **Built-in subcommands:** `license activate <key>`, `license status [--online] [--json]` and `license deactivate`.

### Verification

`POST https://api.gumroad.com/v2/licenses/verify` with `product_id`, `license_key` and `increment_uses_count`. The flag is `true` only on an explicit activation.

| Gumroad says | Result |
|---|---|
| `success: true` | Valid. The tier comes from `purchase.variants` |
| `404` / `success: false` | `invalid`, and any cached activation is deleted |
| `refunded`, `chargebacked` or `disputed`, or `subscription_ended_at` / `subscription_failed_at` set | `revoked`, and the cache is deleted |
| `test: true` | Rejected unless `allowTestPurchases` |
| `uses` > `maxActivations[tier]` | `activation_limit` |
| Network error, timeout, 429 or 5xx | Retried twice with backoff, then treated as offline (grace period applies) |

Failures that need the network to recover (offline past the grace period, the clock moved backwards) never delete the cache.

### Tiers from Gumroad variants

Create a **variant category** on the Gumroad product (e.g. "Tier") with options named **Hobbyist**, **Pro** and **Enterprise**. Gumroad reports the choice as `"(Tier: Pro)"`.
`parseTier` reads every option value and maps it to a tier, choosing the highest if several match. It recognises common synonyms:

- **hobbyist:** personal, starter, basic, indie
- **pro:** professional, premium, plus
- **enterprise:** team, business, commercial, agency, unlimited

Add your own labels with `tierMap: { gold: "enterprise" }`. A purchase with no variants gets `defaultTier`.

Gate features in commands:

```ts
const lic = await license.current();
license.requireTier(lic, "pro", "--shout");   // throws a friendly LicenseError → exit code 4 + upgrade link
```

### Local cache

`~/.indie-cli/licenses.enc` holds one encrypted file for all products, keyed by slug. The directory is mode 0700 and the file 0600. Set `INDIE_CLI_HOME` to use a different location.

The file is encrypted with AES-256-GCM. The key is derived with scrypt from a random salt plus a machine fingerprint (hostname, OS user and home directory). As a result:
- editing the file breaks decryption, and the tool simply re-verifies online;
- copying the file to another machine doesn't work there;
- keys aren't visible in plain text.

Writes are atomic (temp file + rename).

### Exit codes (all products)

`0` ok · `1` error · `2` usage · `3` license missing/invalid/expired · `4` tier too low · `5` license server unreachable

### Developing without a key

`INDIE_CLI_DEV_LICENSE=hobbyist|pro|enterprise` fakes a license **only in unbundled runs** (tsx, Vitest).
Release builds define `__DEV__=false`, which turns the bypass off. The build verifies this against the bundled output.

### Be realistic about client-side licensing

Any license check in JavaScript that runs on the buyer's machine can be patched out by a determined person. This module exists to keep honest buyers honest and make paying the easiest path:
- smooth activation
- no surprise lockouts when offline
- refunds and chargebacks revoked automatically

It isn't DRM. If a feature truly must be protected, run it on a server you control and check the license there.

### Gumroad setup checklist (per product)

1. In the product's **Content** settings, enable **"Generate a unique license key per sale"**, then copy the **product ID** into `product.config.ts` → `productId`.
2. Add the "Tier" variant category with Hobbyist, Pro and Enterprise options.
3. Set `purchaseUrl` to the product's checkout link.
4. Upload `dist/release/<name>-<version>.tgz` and the binaries as the product files, and include `SHA256SUMS.txt`.

**Proxies:** Node's built-in `fetch` only uses `HTTPS_PROXY` when `NODE_USE_ENV_PROXY=1` is set (Node 22.21+ / 24+). The error message suggests this when a proxy variable is present.

**Lemon Squeezy:** not wired up yet. The natural next step is to add a provider interface next to `verifyWithGumroad`, using Lemon Squeezy's `POST /v1/licenses/activate` and `/validate` endpoints, with tier taken from `meta.variant_name`. `LicenseManager` would then take a provider option.

---

## Adding a product: conventions

- Keep logic pure and separate from Commander actions (see `templates/cli-tool/src/commands/hello.ts`), so tests don't need a terminal.
- Throw `UserError(message, hint, exitCode)` for expected failures. Anything else shows "Unexpected error" plus the `DEBUG=1` tip.
- Use `--json` on commands whose output someone might script against.
- Put runtime dependencies in the product's own `package.json`. esbuild inlines them, so buyers install nothing.
- Each product has its own README (generated from the template) written for buyers.
