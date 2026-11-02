import { readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

import picomatch from "picomatch";
import { simpleGit } from "simple-git";

export const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const ALWAYS_SKIP = new Set(["node_modules", ".git", ".hg", ".svn", ".despaghetti"]);

export function isSourceFile(file: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(file).toLowerCase()) && !file.endsWith(".d.ts");
}

export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/**
 * List source files under `target` (a file or directory).
 * Uses `git ls-files` when available, so .gitignore is respected; otherwise walks the tree.
 */
export async function listSourceFiles(
  target: string,
  opts: { include: string[]; exclude: string[] },
): Promise<string[]> {
  const abs = resolve(target);
  const st = statSync(abs);
  if (st.isFile()) return [abs];

  let files: string[] | undefined;
  try {
    const git = simpleGit(abs);
    if (await git.checkIsRepo()) {
      const out = await git.raw(["ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "-z", "."]);
      const top = (await git.revparse(["--show-toplevel"])).trim();
      files = out.split("\0").filter(Boolean).map((f) => join(top, f));
    }
  } catch {
    files = undefined;
  }
  files ??= walk(abs);

  const isExcluded = picomatch(opts.exclude, { dot: true });
  const isIncluded = opts.include.length ? picomatch(opts.include, { dot: true }) : () => true;
  return files
    .filter((f) => f.startsWith(abs))
    .filter(isSourceFile)
    .filter((f) => {
      const rel = toPosix(relative(abs, f));
      return isIncluded(rel) && !isExcluded(rel);
    })
    .sort();
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ALWAYS_SKIP.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile()) out.push(p);
  }
  return out;
}
