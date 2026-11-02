/** Orchestrates a characterization run: find entry points → synthesize inputs → record behaviour + coverage. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type ts from "typescript";

import { collectFunctions, functionName, parse } from "../core/ast.ts";
import { toPosix } from "../core/files.ts";
import { discoverExports } from "./exports.ts";
import { generateCases, inferParamShapes } from "./inputs.ts";
import { coverageOf, instrument, type Probe } from "./instrument.ts";
import type { RecorderCase } from "./recorder.ts";
import { record } from "./runner.ts";
import type { Encoded, Outcome } from "./serialize.ts";

export interface SafetyCase {
  exportName: string;
  label: string;
  args: Encoded[];
  outcome: Outcome;
  argsAfter?: Encoded[];
  deterministic: boolean;
}

export interface FunctionCoverage {
  name: string;
  startLine: number;
  coverage: number | undefined;
}

export interface SafetyNet {
  file: string;
  sourceHash: string;
  entryPoints: string[];
  cases: SafetyCase[];
  loadError?: string;
  probes: Probe[];
  hits: Set<number>;
  coverage: FunctionCoverage[];
}

export function hashSource(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function functionCoverage(sf: ts.SourceFile, probes: Probe[], hits: Set<number>): FunctionCoverage[] {
  return collectFunctions(sf).map((fn) => ({
    name: functionName(fn, sf),
    startLine: sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1,
    coverage: coverageOf(probes, hits, fn.getStart(sf), fn.getEnd()),
  }));
}

/** Build input cases for every exported function (or reuse the inputs from a stored golden master). */
export function planCases(file: string, text: string, maxCases: number, only?: string[]): { cases: (RecorderCase & { label: string })[]; entryPoints: string[] } {
  const sf = parse(file, text);
  let exports = discoverExports(sf);
  if (only?.length) {
    const wanted = exports.filter((e) => only.includes(e.exportName) || only.includes(functionName(e.fn, sf)));
    // If the requested function isn't exported, drive every export and let coverage show whether it's reached.
    if (wanted.length) exports = wanted;
  }
  const cases = exports.flatMap((e) =>
    generateCases(inferParamShapes(e.fn, sf), maxCases).map((c) => ({ exportName: e.exportName, args: c.args, label: c.label })),
  );
  return { cases, entryPoints: exports.map((e) => e.exportName) };
}

export async function runSafetyNet(
  file: string,
  text: string,
  cases: (RecorderCase & { label: string })[],
  opts: { timeoutMs: number; cwd: string },
): Promise<Omit<SafetyNet, "entryPoints">> {
  const inst = instrument(file, text);
  const out = await record({ file, source: inst.source, cases, timeoutMs: opts.timeoutMs }, { cwd: opts.cwd });
  const hits = new Set(out.hits);
  const results: SafetyCase[] = out.loadError
    ? []
    : cases.map((c, i) => ({
        exportName: c.exportName,
        label: c.label,
        args: c.args,
        ...out.results[i]!,
      }));
  return {
    file,
    sourceHash: hashSource(text),
    cases: results,
    ...(out.loadError ? { loadError: out.loadError } : {}),
    probes: inst.probes,
    hits,
    coverage: functionCoverage(parse(file, text), inst.probes, hits),
  };
}

export async function buildSafetyNet(
  file: string,
  opts: { maxCases: number; timeoutMs: number; cwd: string; only?: string[]; text?: string },
): Promise<SafetyNet> {
  const text = opts.text ?? readFileSync(file, "utf8");
  const { cases, entryPoints } = planCases(file, text, opts.maxCases, opts.only);
  if (cases.length === 0) {
    return { file, sourceHash: hashSource(text), entryPoints, cases: [], probes: [], hits: new Set(), coverage: [] };
  }
  return { ...(await runSafetyNet(file, text, cases, opts)), entryPoints };
}

// ---- golden master persistence -------------------------------------------------------------

export interface GoldenFile {
  version: 1;
  file: string;
  sourceHash: string;
  createdAt: string;
  cases: SafetyCase[];
}

export function goldenPath(root: string, file: string): string {
  return join(root, ".despaghetti", "golden", `${toPosix(relative(root, file)).replace(/\.\.\//g, "__/")}.json`);
}

export function saveGolden(root: string, net: SafetyNet): string {
  const p = goldenPath(root, net.file);
  mkdirSync(dirname(p), { recursive: true });
  const g: GoldenFile = {
    version: 1,
    file: toPosix(relative(root, net.file)),
    sourceHash: net.sourceHash,
    createdAt: new Date().toISOString(),
    cases: net.cases,
  };
  writeFileSync(p, `${JSON.stringify(g, null, 2)}\n`);
  return p;
}

export function loadGolden(root: string, file: string): GoldenFile | undefined {
  const p = goldenPath(root, file);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as GoldenFile;
  } catch {
    return undefined;
  }
}
