/**
 * Scaffold a new product from templates/cli-tool.
 *
 *   npm run new -- <category> <name> [--description "..."] [--display "Name"] [--bin cmd]
 *                                    [--product-id <gumroad id>] [--vendor "Your Co"] [--no-install]
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { categories, parseFlags, ROOT } from "./lib.ts";

const { positional, flags } = parseFlags(process.argv.slice(2));
const [category, name] = positional;
const cats = categories();

function fail(msg: string): never {
  process.stderr.write(`✖ ${msg}\n`);
  process.exit(1);
}

if (!category || !name) {
  fail(`Usage: npm run new -- <category> <name> [--description "..."]\n  Categories: ${cats.join(", ")}`);
}
if (!cats.includes(category)) fail(`Unknown category "${category}". Choose one of: ${cats.join(", ")}`);
if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) fail(`Name must be kebab-case (e.g. "commit-craft"), got "${name}"`);

const target = join(ROOT, category, name);
if (existsSync(target)) fail(`${relative(ROOT, target)} already exists`);

const displayName =
  typeof flags.display === "string"
    ? flags.display
    : name.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
const tokens: Record<string, string> = {
  name,
  category,
  displayName,
  bin: typeof flags.bin === "string" ? flags.bin : name,
  description: typeof flags.description === "string" ? flags.description : `${displayName}: a polished CLI tool.`,
  productId: typeof flags["product-id"] === "string" ? flags["product-id"] : "REPLACE_WITH_GUMROAD_PRODUCT_ID",
  envPrefix: name.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
  vendor: typeof flags.vendor === "string" ? flags.vendor : "Your Company",
  year: String(new Date().getFullYear()),
};

cpSync(join(ROOT, "templates", "cli-tool"), target, { recursive: true });
renameSync(join(target, "package.json.tmpl"), join(target, "package.json"));

function render(dir: string) {
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry);
    if (statSync(file).isDirectory()) {
      render(file);
      continue;
    }
    const text = readFileSync(file, "utf8");
    const out = text.replace(/\{\{(\w+)\}\}/g, (m, key: string) => tokens[key] ?? m);
    const leftover = out.match(/\{\{\w+\}\}/);
    if (leftover) fail(`unknown template token ${leftover[0]} in ${relative(ROOT, file)}`);
    writeFileSync(file, out);
  }
}
render(target);

if (flags.install !== false) {
  process.stdout.write("› Linking workspace (npm install)…\n");
  execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: ROOT, stdio: "inherit" });
}

process.stdout.write(`
✔ Created ${relative(ROOT, target)}

Next steps:
  1. Set your Gumroad product id in ${relative(ROOT, join(target, "product.config.ts"))}
  2. Replace src/commands/hello.ts with the real commands
  3. INDIE_CLI_DEV_LICENSE=pro npm run dev -w ${name} -- hello Ada
  4. npm test -w ${name}
  5. npm run build -- --only ${name} --pack --binary
`);
