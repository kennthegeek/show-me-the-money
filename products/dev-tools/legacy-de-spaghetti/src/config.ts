import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { UserError } from "@products/shared";

export const CONFIG_FILE = ".despaghettirc.json";

export interface Thresholds {
  /** Logical lines (non-blank, non-comment) per function. */
  maxLines: number;
  /** Cyclomatic complexity. */
  maxComplexity: number;
  /** Max nesting depth of control flow. */
  maxDepth: number;
  maxParams: number;
}

export interface Config {
  thresholds: Thresholds;
  include: string[];
  exclude: string[];
  safetyNet: {
    maxCases: number;
    timeoutMs: number;
    /** Directory for generated characterization tests, relative to the source file ("" = next to it). */
    outDir: string;
  };
  refactor: {
    minSegmentLines: number;
    maxExtractedParams: number;
    maxExtractedReturns: number;
    maxSteps: number;
    /** Minimum share of a segment's statements the safety net must execute before it may be extracted. */
    minCoverage: number;
  };
  ai: {
    model: string;
    effort: "low" | "medium" | "high";
  };
}

export const DEFAULT_CONFIG: Config = {
  thresholds: { maxLines: 60, maxComplexity: 12, maxDepth: 4, maxParams: 5 },
  include: [],
  exclude: [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
    "**/vendor/**",
    "**/*.min.js",
    "**/*.d.ts",
    "**/*.test.*",
    "**/*.spec.*",
    "**/__tests__/**",
    "**/__characterization__/**",
  ],
  safetyNet: { maxCases: 24, timeoutMs: 2000, outDir: "__characterization__" },
  refactor: { minSegmentLines: 5, maxExtractedParams: 6, maxExtractedReturns: 4, maxSteps: 25, minCoverage: 0.5 },
  ai: { model: "claude-opus-5-5", effort: "low" },
};

/** Walk up from `start` to find .despaghettirc.json; return the merged config and project root. */
export function loadConfig(start: string): { config: Config; root: string; file?: string } {
  let dir = resolve(start);
  if (existsSync(dir) && !isDir(dir)) dir = dirname(dir);
  let root = dir;
  for (let d = dir; ; d = dirname(d)) {
    const candidate = join(d, CONFIG_FILE);
    if (existsSync(candidate)) return { config: merge(readJson(candidate)), root: d, file: candidate };
    if (existsSync(join(d, "package.json")) || existsSync(join(d, ".git"))) {
      root = d;
      break;
    }
    if (dirname(d) === d) break;
  }
  return { config: merge({}), root };
}

function isDir(p: string): boolean {
  return statSync(p).isDirectory();
}

function readJson(file: string): Partial<Config> {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Partial<Config>;
  } catch (e) {
    throw new UserError(`Could not parse ${file}: ${(e as Error).message}`);
  }
}

function merge(user: Partial<Config>): Config {
  return {
    thresholds: { ...DEFAULT_CONFIG.thresholds, ...user.thresholds },
    include: user.include ?? DEFAULT_CONFIG.include,
    exclude: [...DEFAULT_CONFIG.exclude, ...(user.exclude ?? [])],
    safetyNet: { ...DEFAULT_CONFIG.safetyNet, ...user.safetyNet },
    refactor: { ...DEFAULT_CONFIG.refactor, ...user.refactor },
    ai: { ...DEFAULT_CONFIG.ai, ...user.ai },
  };
}
