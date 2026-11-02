/**
 * Build every product (or a subset) into distributable artifacts.
 *
 *   npm run build                         # bundle all products → dist/<name>/ (npm-ready package)
 *   npm run build -- --only a,b           # subset
 *   npm run build -- --pack               # + dist/release/<name>-<version>.tgz
 *   npm run build -- --binary             # + standalone executable for this OS/arch (Node SEA)
 *   npm run build -- --typecheck          # run tsc first and stop on type errors
 *   npm run build -- --no-minify          # readable output for debugging
 *
 * Each product is bundled by esbuild into ONE CommonJS file with all dependencies
 * (including @products/shared) inlined. `__DEV__` is false in these builds, which
 * strips the INDIE_CLI_DEV_LICENSE bypass. Every bundle is smoke-tested with --version.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { build } from "esbuild";

import { discoverProducts, formatBytes, parseFlags, type Product, ROOT } from "./lib.ts";

const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const NODE_TARGET = "node20";

const { flags } = parseFlags(process.argv.slice(2));
const only = typeof flags.only === "string" ? new Set(flags.only.split(",").map((s) => s.trim())) : undefined;
const minify = flags.minify !== false;
const outRoot = join(ROOT, typeof flags.out === "string" ? flags.out : "dist");
const releaseDir = join(outRoot, "release");

interface Result {
  product: Product;
  ok: boolean;
  bundleSize?: number;
  artifacts: string[];
  error?: string;
  ms: number;
}

function log(msg: string) {
  process.stdout.write(`${msg}\n`);
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function bundle(p: Product, pkgDir: string): Promise<string> {
  const binFile = join(pkgDir, "bin", `${p.manifest.bin}.cjs`);
  const result = await build({
    entryPoints: [join(p.dir, p.manifest.entry)],
    outfile: binFile,
    bundle: true,
    platform: "node",
    target: NODE_TARGET,
    format: "cjs",
    minify,
    sourcemap: false,
    legalComments: "external", // writes <bin>.cjs.LEGAL.txt for third-party notices
    banner: { js: "#!/usr/bin/env node" },
    define: {
      __DEV__: "false",
      __PRODUCT_VERSION__: JSON.stringify(p.version),
      "process.env.NODE_ENV": '"production"',
    },
    // tsconfig "paths" resolve @products/shared even without an npm install link.
    tsconfig: join(ROOT, "tsconfig.base.json"),
    logLevel: "silent",
    // Dev-only branches may reference import.meta (e.g. to locate tsx); they never run in bundles.
    logOverride: { "empty-import-meta": "silent" },
    metafile: true,
  });
  for (const w of result.warnings) log(`  ⚠ ${w.text}`);
  chmodSync(binFile, 0o755);
  return binFile;
}

function writePackage(p: Product, pkgDir: string): void {
  const out = {
    name: p.name,
    version: p.version,
    description: p.description,
    bin: { [p.manifest.bin]: `bin/${p.manifest.bin}.cjs` },
    files: ["bin/", "README.md", "LICENSE"],
    engines: { node: ">=20" },
    license: (p.pkg.license as string | undefined) ?? "SEE LICENSE IN LICENSE",
    keywords: (p.pkg.keywords as string[] | undefined) ?? ["cli", p.manifest.category],
    ...(p.pkg.homepage ? { homepage: p.pkg.homepage } : {}),
    // Everything is bundled: no dependencies to install.
  };
  writeFileSync(join(pkgDir, "package.json"), `${JSON.stringify(out, null, 2)}\n`);
  for (const f of ["README.md", "LICENSE", "CHANGELOG.md"]) {
    if (existsSync(join(p.dir, f))) copyFileSync(join(p.dir, f), join(pkgDir, f));
  }
}

function smokeTest(binFile: string, version: string): void {
  const res = spawnSync(process.execPath, [binFile, "--version"], {
    encoding: "utf8",
    env: { ...process.env, INDIE_CLI_HOME: join(outRoot, ".smoke-home"), NO_COLOR: "1" },
    timeout: 20_000,
  });
  if (res.status !== 0 || !res.stdout.includes(version)) {
    throw new Error(`smoke test failed (exit ${res.status}): ${res.stderr || res.stdout}`.trim());
  }
  // The dev license bypass must be dead in release builds.
  const bypass = spawnSync(process.execPath, [binFile, "license", "status", "--json"], {
    encoding: "utf8",
    env: { ...process.env, INDIE_CLI_HOME: join(outRoot, ".smoke-home"), INDIE_CLI_DEV_LICENSE: "enterprise",
      NO_COLOR: "1" },
    timeout: 20_000,
  });
  if (bypass.status === 0 || bypass.stdout.includes('"source": "dev"')) {
    throw new Error("release bundle still honours INDIE_CLI_DEV_LICENSE; is __DEV__ defined?");
  }
}

function pack(pkgDir: string): string {
  mkdirSync(releaseDir, { recursive: true });
  const out = execFileSync("npm", ["pack", "--json", "--pack-destination", releaseDir], {
    cwd: pkgDir,
    shell: process.platform === "win32",
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [info] = JSON.parse(out) as { filename: string }[];
  return join(releaseDir, info!.filename);
}

/** Node Single Executable Application for the host platform. Cross-platform builds: run in a CI matrix. */
function buildBinary(p: Product, binFile: string): string {
  const [major] = process.versions.node.split(".").map(Number);
  if ((major ?? 0) < 20) throw new Error("standalone binaries need Node.js 20+ on the build machine");
  mkdirSync(releaseDir, { recursive: true });
  const work = join(outRoot, ".sea", p.name);
  mkdirSync(work, { recursive: true });
  const blob = join(work, "sea-prep.blob");
  const cfg = join(work, "sea-config.json");
  writeFileSync(cfg, JSON.stringify({ main: binFile, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false }));
  execFileSync(process.execPath, ["--experimental-sea-config", cfg], { stdio: "pipe" });

  const ext = process.platform === "win32" ? ".exe" : "";
  const target = join(releaseDir, `${p.manifest.bin}-${process.platform}-${process.arch}${ext}`);
  copyFileSync(process.execPath, target);
  chmodSync(target, 0o755);
  if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", target]);

  const postject = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "postject.cmd" : "postject");
  if (!existsSync(postject)) throw new Error("postject is not installed; run `npm install` in products/");
  const args = [target, "NODE_SEA_BLOB", blob, "--sentinel-fuse", SEA_FUSE];
  if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA");
  // .cmd shims need a shell on Windows.
  execFileSync(postject, args, { stdio: "pipe", shell: process.platform === "win32" });
  if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", target]);

  const res = spawnSync(target, ["--version"], { encoding: "utf8", timeout: 20_000,
    env: { ...process.env, INDIE_CLI_HOME: join(outRoot, ".smoke-home") } });
  if (res.status !== 0 || !res.stdout.includes(p.version)) {
    throw new Error(`binary smoke test failed: ${res.stderr || res.stdout}`);
  }
  return target;
}

async function buildProduct(p: Product): Promise<Result> {
  const started = Date.now();
  const artifacts: string[] = [];
  const pkgDir = join(outRoot, p.name);
  try {
    rmSync(pkgDir, { recursive: true, force: true });
    mkdirSync(join(pkgDir, "bin"), { recursive: true });
    const binFile = await bundle(p, pkgDir);
    writePackage(p, pkgDir);
    smokeTest(binFile, p.version);
    artifacts.push(binFile);
    if (flags.pack) artifacts.push(pack(pkgDir));
    if (flags.binary) artifacts.push(buildBinary(p, binFile));
    return { product: p, ok: true, bundleSize: statSync(binFile).size, artifacts, ms: Date.now() - started };
  } catch (err) {
    return { product: p, ok: false, artifacts, error: err instanceof Error ? err.message : String(err),
      ms: Date.now() - started };
  }
}

async function main(): Promise<number> {
  let products = discoverProducts();
  if (only) {
    const unknown = [...only].filter((n) => !products.some((p) => p.name === n));
    if (unknown.length) {
      log(`✖ Unknown product(s): ${unknown.join(", ")}. Known: ${products.map((p) => p.name).join(", ") || "(none)"}`);
      return 2;
    }
    products = products.filter((p) => only.has(p.name));
  }
  if (products.length === 0) {
    log("No products found yet. Create one with:  npm run new -- <category> <name>");
    return 0;
  }

  if (flags.typecheck) {
    log("› Type-checking…");
    const tsc = spawnSync(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", join(ROOT, "tsconfig.json"), "--noEmit"],
      { stdio: "inherit" });
    if (tsc.status !== 0) return 1;
  }

  log(`› Building ${products.length} product(s)${flags.binary ? " + binaries" : ""}${flags.pack ? " + tarballs" : ""}…`);
  // esbuild is fast; build in parallel, but keep SEA/pack sequential-ish via per-product awaits.
  const results = await Promise.all(products.map(buildProduct));

  for (const r of results) {
    const head = `${r.ok ? "✔" : "✖"} ${r.product.name}@${r.product.version}`.padEnd(40);
    if (r.ok) {
      log(`${head} ${formatBytes(r.bundleSize ?? 0).padStart(9)}  ${(r.ms / 1000).toFixed(1)}s`);
      for (const a of r.artifacts.slice(1)) log(`    → ${relative(ROOT, a)}`);
    } else {
      log(`${head} ${r.error}`);
    }
  }

  const releaseFiles = results.flatMap((r) => r.artifacts.slice(1));
  if (releaseFiles.length) {
    const lines = releaseFiles.map((f) => `${sha256(f)}  ${relative(releaseDir, f)}`);
    writeFileSync(join(releaseDir, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
    log(`  checksums → ${relative(ROOT, join(releaseDir, "SHA256SUMS.txt"))}`);
  }
  rmSync(join(outRoot, ".smoke-home"), { recursive: true, force: true });
  rmSync(join(outRoot, ".sea"), { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok).length;
  log(failed ? `\n${failed} of ${results.length} failed.` : `\nAll ${results.length} built → ${relative(ROOT, outRoot)}/`);
  return failed ? 1 : 0;
}

process.exitCode = await main();
