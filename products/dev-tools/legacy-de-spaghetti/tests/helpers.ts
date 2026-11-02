import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG, type Config } from "../src/config.ts";

export const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** Copy fixtures into a fresh temp project so tests can write freely. */
export function tempProject(files: string[] = ["invoice.js"], pkg: object = { name: "fixture", version: "1.0.0" }): string {
  const dir = mkdtempSync(join(tmpdir(), "despaghetti-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  for (const f of files) cpSync(join(FIXTURES, f), join(dir, f));
  return dir;
}

export function config(overrides: Partial<Config["refactor"]> = {}): Config {
  return { ...DEFAULT_CONFIG, refactor: { ...DEFAULT_CONFIG.refactor, ...overrides } };
}
