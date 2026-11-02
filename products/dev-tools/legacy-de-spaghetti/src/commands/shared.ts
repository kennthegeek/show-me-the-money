import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import chalk from "chalk";
import { createTwoFilesPatch } from "diff";
import ora, { type Ora } from "ora";

import { UserError } from "@products/shared";

import { loadConfig } from "../config.ts";
import { isSourceFile } from "../core/files.ts";

export function out(s = ""): void {
  process.stdout.write(`${s}\n`);
}

export function spinner(text: string, quiet = false): Ora {
  return ora({ text, stream: process.stderr, isSilent: quiet || !process.stderr.isTTY });
}

export function requireFile(p: string): string {
  const abs = resolve(p);
  if (!existsSync(abs)) throw new UserError(`File not found: ${p}`);
  if (!statSync(abs).isFile()) throw new UserError(`${p} is a directory; pass a file.`, "Use `despaghetti scan <dir>` to find the worst files first.");
  if (!isSourceFile(abs)) throw new UserError(`${p} isn't a JavaScript/TypeScript source file.`);
  return abs;
}

export function requirePath(p: string): string {
  const abs = resolve(p);
  if (!existsSync(abs)) throw new UserError(`Path not found: ${p}`);
  return abs;
}

export function configFor(p: string) {
  return loadConfig(p);
}

export function parseIntOption(v: string, name: string, min = 1, max = 10_000): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${name} must be a whole number between ${min} and ${max}.`);
  return n;
}

export function colorDiff(file: string, before: string, after: string, context = 3): string {
  const patch = createTwoFilesPatch(file, file, before, after, "before", "after", { context });
  return patch
    .split("\n")
    .slice(2)
    .map((l) => {
      if (l.startsWith("+++") || l.startsWith("---")) return chalk.bold(l);
      if (l.startsWith("@@")) return chalk.cyan(l);
      if (l.startsWith("+")) return chalk.green(l);
      if (l.startsWith("-")) return chalk.red(l);
      return chalk.dim(l);
    })
    .join("\n");
}

export function pct(n: number | undefined): string {
  return n === undefined ? "n/a" : `${Math.round(n * 100)}%`;
}
