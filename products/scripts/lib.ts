import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface ProductManifest {
  displayName: string;
  category: string;
  entry: string;
  bin: string;
}

export interface Product {
  name: string;
  version: string;
  description: string;
  dir: string;
  manifest: ProductManifest;
  pkg: Record<string, unknown>;
}

/** Category directories = workspace globs of the form "<category>/*". */
export function categories(root = ROOT): string[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { workspaces: string[] };
  return pkg.workspaces.filter((w) => w.endsWith("/*")).map((w) => w.slice(0, -2));
}

export function discoverProducts(root = ROOT): Product[] {
  const products: Product[] = [];
  for (const category of categories(root)) {
    const catDir = join(root, category);
    if (!existsSync(catDir)) continue;
    for (const entry of readdirSync(catDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const dir = join(catDir, entry.name);
      const pkgPath = join(dir, "package.json");
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
      const manifest = pkg.product as ProductManifest | undefined;
      if (!manifest?.entry || !manifest.bin) continue;
      products.push({
        name: String(pkg.name),
        version: String(pkg.version ?? "0.0.0"),
        description: String(pkg.description ?? ""),
        dir,
        manifest: { ...manifest, category },
        pkg,
      });
    }
  }
  return products.sort((a, b) => a.name.localeCompare(b.name));
}

export function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--no-")) {
      flags[a.slice(5)] = false;
    } else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) flags[k] = argv[++i]!;
      else flags[k] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}
