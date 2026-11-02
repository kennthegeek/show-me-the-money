# {{displayName}}

> {{description}}

`{{bin}}` is a fast, offline-friendly command-line tool. It's a single file with no runtime dependencies beyond Node.js 20+, or you can download a standalone binary that needs no Node at all.

---

## Install

**Standalone binary** (no Node.js needed). Download the file for your platform from your purchase page, then:

```bash
chmod +x {{bin}}-linux-x64 && sudo mv {{bin}}-linux-x64 /usr/local/bin/{{bin}}
```

On macOS, if Gatekeeper complains the first time, run `xattr -d com.apple.quarantine /usr/local/bin/{{bin}}`.

**npm tarball** (Node.js 20+):

```bash
npm install -g ./{{name}}-0.1.0.tgz
```

## Activate your license

The first time you run a command, `{{bin}}` asks for your license key. Paste the key from your Gumroad receipt:

```bash
{{bin}} license activate XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX
{{bin}} license status          # tier, licensed email, last check
{{bin}} license deactivate      # free this machine (e.g. before moving to a new computer)
```

**CI and scripts:** set `{{envPrefix}}_LICENSE_KEY` instead. It's checked without using up an activation.

**Offline:** your license is re-checked online about once a week. If you're offline, `{{bin}}` keeps working for **14 days** after the last successful check.

**Privacy:** the only thing sent to Gumroad is your license key, and only for verification. The activation is stored encrypted in `~/.indie-cli/`.

## Usage

```bash
{{bin}} hello Ada                 # example command
{{bin}} hello Ada --shout         # Pro
{{bin}} hello Ada --times 5       # Enterprise
{{bin}} hello Ada --json          # machine-readable output
{{bin}} --help
```

## Tiers

| | Hobbyist | Pro | Enterprise |
|---|:-:|:-:|:-:|
| Core commands | ✅ | ✅ | ✅ |
| `--shout` | | ✅ | ✅ |
| `--times > 3` | | | ✅ |
| Machines | 2 | 5 | Unlimited |

Upgrade any time at https://gumroad.com/l/{{name}}.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Error (bad input, failed operation) |
| 2 | Usage error (unknown flag or command) |
| 3 | License missing, invalid or expired |
| 4 | Feature needs a higher tier |
| 5 | Couldn't reach the license server |

Set `DEBUG=1` for stack traces.

## Support

Email support@example.com and include the output of `{{bin}} --version` and `{{bin}} license status`.

---

## Development (monorepo)

```bash
# from products/
npm install
INDIE_CLI_DEV_LICENSE=pro npm run dev -w {{name}} -- hello Ada   # dev bypass, only works in unbundled runs
npm test -w {{name}}
npm run build -- --only {{name}}           # → dist/{{name}}/
npm run build -- --only {{name}} --binary  # + standalone binary for this OS/arch
```

Set the real Gumroad product id in `product.config.ts`, or with `{{envPrefix}}_GUMROAD_PRODUCT_ID` at runtime.
