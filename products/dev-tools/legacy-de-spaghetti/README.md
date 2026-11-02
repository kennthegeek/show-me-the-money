# Legacy-De-Spaghetti

> Find the worst functions in a legacy JavaScript/TypeScript codebase, lock in what they do with generated characterization tests, and split them into clean, well-named helpers. Every step is checked against the recorded behaviour.

```
$ despaghetti refactor src/invoice.js --write

╭──────────────────────────────────────────────────────────────────────────────╮
│ processOrder()  src/invoice.js                                               │
│                                                                              │
│ Lines       98 → 28                                                          │
│ Complexity  31 → 3                                                           │
│ Nesting     3 → 1                                                            │
│ Grade       F → A                                                            │
│                                                                              │
│ Extracted 5 function(s)                                                      │
│   › validateOrder(order, warnings) → country             11 lines, 100% covered │
│   › sumLineItems(order, warnings, total, itemCount) → total, itemCount  18 lines │
│   › applyCustomerDiscounts(order, total, opts, warnings) → discount     26 lines │
│   › computeShipping(total, discount, country, itemCount, opts) → shipping, …     │
│   › computeTax(country, order, subtotal, shipping) → tax                 5 lines │
│                                                                              │
│ ✔ Behaviour verified after every step: 28 recorded cases                     │
╰──────────────────────────────────────────────────────────────────────────────╯
✔ Wrote src/invoice.js
```

## Why this is safe

Refactoring legacy code is risky because nobody knows exactly what it does, and it has no tests. Legacy-De-Spaghetti handles that the way Michael Feathers' *Working Effectively with Legacy Code* recommends: **pin down current behaviour first, then change the structure.**

1. **Safety net.** It reads how each exported function uses its parameters: property chains, array loops, literal comparisons such as `tier === "gold"` or `qty > 10`, truthiness checks, and TypeScript types. From that it builds realistic inputs that hit those branches and boundaries.
   It then runs your code in an isolated child process and records every result, thrown error and argument mutation. It also measures which statements ran.
2. **Surgery.** A scope-aware data-flow analysis finds blocks that can move into their own function. It works out the parameters and return values, and refuses anything it can't prove safe:
   - early `return`s, or `break`/`continue` that leave the block
   - closures that would see a stale copy of a variable
   - hoisting tricks, shadowed names, `arguments`, `eval`
3. **Proof.** After **each** extraction, the safety net runs again on the new code. If any recorded case behaves differently, that extraction is thrown away and the next candidate is tried. Code the safety net never executed is not touched at all.
4. **You review.** The default is a dry-run diff. `--write` refuses to touch files with uncommitted changes and keeps a backup in `.despaghetti/backups/`.

Naming is deterministic by default. It uses your section comments, such as `// ---- apply discounts ----` → `applyCustomerDiscounts`, and the returned values. With `--ai`, Claude proposes names and one-line summaries instead. The AI only *names* code; the AST engine and the safety net decide what changes.

## Install

**Standalone binary** (no Node.js needed). Download the file for your platform from your purchase page:

```bash
chmod +x despaghetti-linux-x64 && sudo mv despaghetti-linux-x64 /usr/local/bin/despaghetti
```

On macOS, if Gatekeeper complains the first time: `xattr -d com.apple.quarantine /usr/local/bin/despaghetti`.

**npm tarball** (Node.js 20+): `npm install -g ./legacy-de-spaghetti-0.1.0.tgz`

## Activate

```bash
despaghetti license activate XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX
despaghetti license status
```

- **CI:** set `LEGACY_DE_SPAGHETTI_LICENSE_KEY` instead. It doesn't use up an activation.
- **Offline:** the license is re-checked about weekly, and the tool keeps working offline for 14 days.
- **Privacy:** your code never leaves your machine unless you pass `--ai`, which sends only the block being named to the Claude API.

## The workflow

```bash
despaghetti scan src/                          # 1. rank the most tangled functions
despaghetti plan src/billing.js --coverage     # 2. preview the split and what the safety net can verify
despaghetti safety-net src/billing.js          # 3. record behaviour, write characterization tests
despaghetti refactor src/billing.js            # 4. dry run: verified diff
despaghetti refactor src/billing.js --write    # 5. apply (Pro)
npm test                                        # the generated tests still pass, by construction
```

### `scan [path]`

Ranks every function by a 0–100 **spaghetti score**, built from logical lines, cyclomatic complexity, nesting depth and parameter count, and gives each a grade from A to F.
It respects `.gitignore` and skips `node_modules`, builds, tests and minified files.

| Option | Description |
|---|---|
| `-n, --top <n>` | Rows to show (default 15) |
| `--hotspots` | **Pro.** Weight by git churn (commits in the last 12 months). Tangled code that changes often is where refactoring pays off. |
| `--md <file>` | **Pro.** Write a Markdown report |
| `--sarif <file>` | **Enterprise.** Write SARIF for GitHub code scanning |
| `--json` | Machine-readable output |

### `plan <file>`

Shows which blocks of the worst function (or `-f name`) would become which helpers, with their parameters and return values, and which blocks can't move and why. Add `--coverage` to run the safety net and show how well each block is exercised. It never changes files.

### `safety-net <file>`

Generates inputs for every exported function, records outcomes, and writes:

- `__characterization__/<file>.characterization.test.(js|ts|mjs)`: readable, data-driven tests in **your** framework. It detects Vitest or Jest from `package.json` and otherwise uses `node:test`.
- `__characterization__/_despaghetti.cjs`: a small support file used to compare values.
- `.despaghetti/golden/<file>.json`: the golden master, reused by `refactor` so it replays the same inputs.

Non-deterministic cases (random numbers, timestamps) are detected by running every case twice, and are left out. Commit the tests. They also protect any refactoring you do by hand.

| Option | Description |
|---|---|
| `-f, --function <names...>` | Only drive these exports |
| `-c, --cases <n>` | Inputs per function (default 24) |
| `--framework vitest\|jest\|node` | Override detection |
| `-o, --out <dir>` | Test directory, relative to the source file |
| `--dry-run` | Report only |

### `refactor <file>`

| Option | Description |
|---|---|
| `-f, --function <name>` | Target function (default: the worst in the file). Class methods: `Class.method`. |
| `-w, --write` | **Pro.** Apply the changes. Without it you get a dry-run diff. |
| `--ai` | **Pro.** Claude names the extracted functions. Needs `ANTHROPIC_API_KEY`. |
| `--all` | **Enterprise.** Every over-threshold function under a directory (`--limit n`) |
| `--max-steps <n>` | Cap the number of extractions |
| `--unverified` | Allow refactoring code the safety net can't drive. Syntax checks only, not recommended. |
| `--no-typecheck` | Skip the "no new TypeScript errors" gate |
| `--force` | Write even if the file has uncommitted changes |

**TypeScript files** get real parameter types from the type checker, e.g. `collectLowStock(items: Item[], threshold: number)`. An extraction is rejected if it would add a type error under your `tsconfig.json`. Class methods become `private` sibling methods called as `this.helper(...)`.

### `check [path]` (Enterprise)

A CI ratchet. It fails when a new function goes over the thresholds, or a known one gets worse. Legacy debt doesn't block the build; new debt does.

```bash
despaghetti check --update-baseline   # once, commit .despaghetti/baseline.json
despaghetti check                     # in CI (exit 1 on regressions)
```

### `init`

Writes `.despaghettirc.json`:

```json
{
  "thresholds": { "maxLines": 60, "maxComplexity": 12, "maxDepth": 4, "maxParams": 5 },
  "include": [],
  "exclude": ["legacy/vendor/**"],
  "safetyNet": { "maxCases": 24, "timeoutMs": 2000, "outDir": "__characterization__" },
  "refactor": { "minSegmentLines": 5, "maxExtractedParams": 6, "maxExtractedReturns": 4, "maxSteps": 25, "minCoverage": 0.5 },
  "ai": { "model": "claude-opus-5-5", "effort": "low" }
}
```

## Tiers

| | Hobbyist | Pro | Enterprise |
|---|:-:|:-:|:-:|
| `scan`, `plan`, `safety-net` | ✅ | ✅ | ✅ |
| `refactor` dry-run diff | ✅ | ✅ | ✅ |
| `refactor --write` | | ✅ | ✅ |
| AI naming (`--ai`) | | ✅ | ✅ |
| Git-churn hotspots, Markdown reports | | ✅ | ✅ |
| `refactor --all`, `check` CI gate, SARIF | | | ✅ |
| Machines | 2 | 3 | Unlimited |

Upgrade at https://gumroad.com/l/legacy-de-spaghetti.

## Limits (honest ones)

- **Languages:** JavaScript and TypeScript (CommonJS and ESM, `.js/.mjs/.cjs/.ts/.mts/.cts`). JSX files are scanned but not recorded.
- **The safety net drives exported functions.** A function that is only reachable through code paths the generated inputs don't hit won't be refactored. `safety-net` shows coverage per function, so you can see this up front. Functions that do network or database I/O will time out or throw, and are recorded as such. Stub those dependencies for better coverage.
- **What it does:** **Extract Function**, the refactoring that does most of the work on long functions. It doesn't rename your variables, invert conditionals or change algorithms.
- **What "verified" means:** identical results on every recorded input. That's strong evidence, not a formal proof. Review the diff and run your own tests, as you would for a colleague's pull request.

## Exit codes

`0` ok · `1` error, or `check` found regressions · `2` usage · `3` license · `4` tier too low · `5` license server unreachable

Set `DEBUG=1` for stack traces.

## Support

Email support@example.com and include the output of `despaghetti --version` and `despaghetti license status`.

---

## Development (monorepo)

```bash
# from products/
npm install
INDIE_CLI_DEV_LICENSE=pro npm run dev -w legacy-de-spaghetti -- scan dev-tools/legacy-de-spaghetti/tests/fixtures
npm test -w legacy-de-spaghetti
npm run build -- --only legacy-de-spaghetti --pack --binary
```

How the code is organised:

- `src/analysis/`: metrics, the repository scan, reports
- `src/safety/`: input synthesis, the recorder child process, coverage probes, test generation
- `src/refactor/`: data-flow analysis, candidate selection, the transform, the engine loop, TypeScript support
- `src/ai/`: Claude naming

Set the real Gumroad product id in `product.config.ts`, or with `LEGACY_DE_SPAGHETTI_GUMROAD_PRODUCT_ID` at runtime.
