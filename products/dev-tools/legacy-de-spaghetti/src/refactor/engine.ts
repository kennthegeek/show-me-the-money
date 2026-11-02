/**
 * The refactor loop.
 *
 *   baseline  ← record current behaviour (safety net) + statement coverage
 *   repeat:
 *     candidates ← seams in the target function that data-flow analysis accepts
 *                  and that the safety net actually executes (coverage gate)
 *     for each candidate, best first:
 *        extract → syntax check → (TS) no new type errors → replay safety net
 *        identical outcomes on every deterministic case?  accept, re-plan
 *        otherwise reject this candidate and try the next
 *   until nothing more can be extracted safely or maxSteps
 *
 * Every accepted step is individually verified, so a bad extraction never stacks on top of
 * another. The source file is only written by the caller, after the whole run succeeded.
 */

import { readFileSync } from "node:fs";

import { UserError } from "@products/shared";

import type { Config } from "../config.ts";
import {
  allIdentifiers,
  collectFunctions,
  findFunction,
  type FunctionLike,
  functionName,
  isTsFile,
  isValidIdentifier,
  parse,
  syntaxErrors,
} from "../core/ast.ts";
import { type FunctionMetrics, measureFunction } from "../analysis/metrics.ts";
import { coverageOf, type Probe } from "../safety/instrument.ts";
import type { RecorderCase } from "../safety/recorder.ts";
import { loadGolden, planCases, runSafetyNet, type SafetyCase } from "../safety/safetynet.ts";
import { fingerprint } from "../safety/serialize.ts";
import { type Candidate, findCandidates } from "./candidates.ts";
import { heuristicName, unique } from "./naming.ts";
import { stepdown } from "./layout.ts";
import { applyExtraction } from "./transform.ts";
import { TypeChecker } from "./typecheck.ts";

export interface NameSuggestion {
  name: string;
  summary?: string;
}

export type Namer = (input: {
  functionName: string;
  code: string;
  params: string[];
  returns: string[];
  heading?: string;
  taken: Set<string>;
}) => Promise<NameSuggestion | undefined>;

export interface RefactorOptions {
  functionName?: string;
  config: Config;
  cwd: string;
  /** Skip behavioural verification (only when there is no way to drive the code). */
  unverified?: boolean;
  typecheck?: boolean;
  namer?: Namer;
  maxSteps?: number;
  onProgress?: (msg: string) => void;
}

export interface Step {
  name: string;
  summary?: string;
  fromLine: number;
  toLine: number;
  lines: number;
  params: string[];
  returns: string[];
  coverage?: number;
}

export interface RejectedStep {
  fromLine: number;
  toLine: number;
  reason: string;
}

export interface RefactorResult {
  file: string;
  functionName: string;
  original: string;
  output: string;
  steps: Step[];
  rejected: RejectedStep[];
  before: FunctionMetrics;
  after: FunctionMetrics;
  verification: {
    mode: "behavioral" | "syntax-only";
    cases: number;
    deterministicCases: number;
    coverageBefore?: number;
    entryPoints: string[];
  };
  blocked?: string;
}

function pickTarget(sf: ReturnType<typeof parse>, cfg: Config, name?: string): FunctionLike {
  if (name) {
    const fn = findFunction(sf, name);
    if (!fn) throw new UserError(`No function named "${name}" in ${sf.fileName}.`, "Run `despaghetti scan <file>` to list functions.");
    return fn;
  }
  const ranked = collectFunctions(sf)
    .map((fn) => ({ fn, m: measureFunction(fn, sf, cfg.thresholds) }))
    .sort((a, b) => b.m.score - a.m.score);
  const worst = ranked[0];
  if (!worst || worst.m.violations.length === 0) {
    throw new UserError("No function in this file exceeds the thresholds.", "Pass --function <name> to refactor one anyway.");
  }
  return worst.fn;
}

function compareOutcomes(baseline: SafetyCase[], run: SafetyCase[]): string | undefined {
  for (let i = 0; i < baseline.length; i++) {
    const b = baseline[i]!;
    if (!b.deterministic) continue;
    const r = run[i];
    if (!r) return `case "${b.label}" did not run`;
    if (fingerprint(b.outcome) !== fingerprint(r.outcome)) return `case "${b.exportName}: ${b.label}" returned a different result`;
    if (fingerprint(b.argsAfter) !== fingerprint(r.argsAfter)) return `case "${b.exportName}: ${b.label}" mutated its inputs differently`;
  }
  return undefined;
}

export async function refactorFile(file: string, opts: RefactorOptions): Promise<RefactorResult> {
  const cfg = opts.config;
  const progress = opts.onProgress ?? (() => {});
  const original = readFileSync(file, "utf8");
  const errs = syntaxErrors(parse(file, original));
  if (errs.length) throw new UserError(`${file} has syntax errors; fix them first.`, errs[0]);

  let sf = parse(file, original);
  const target = pickTarget(sf, cfg, opts.functionName);
  const fnName = functionName(target, sf);
  const before = measureFunction(target, sf, cfg.thresholds);

  // ---- baseline behaviour ----
  const golden = loadGolden(opts.cwd, file);
  const planned = planCases(file, original, cfg.safetyNet.maxCases);
  const cases: (RecorderCase & { label: string })[] = golden?.cases.length
    ? golden.cases.map((c) => ({ exportName: c.exportName, args: c.args, label: c.label }))
    : planned.cases;

  let probes: Probe[] = [];
  let hits = new Set<number>();
  let baseline: SafetyCase[] = [];
  let mode: RefactorResult["verification"]["mode"] = "behavioral";
  if (cases.length && !opts.unverified) {
    progress(`Recording baseline behaviour (${cases.length} cases)…`);
    const net = await runSafetyNet(file, original, cases, { timeoutMs: cfg.safetyNet.timeoutMs, cwd: opts.cwd });
    if (net.loadError) {
      throw new UserError(`Couldn't load ${file} to record its behaviour: ${net.loadError}`,
        "Fix the import error, or pass --unverified to refactor with syntax checks only (not recommended).");
    }
    baseline = net.cases;
    probes = net.probes;
    hits = net.hits;
    if (baseline.filter((c) => c.deterministic).length === 0) {
      throw new UserError("None of the recorded cases behave deterministically, so changes can't be verified.",
        "Pass --unverified to proceed with syntax checks only.");
    }
  } else if (!opts.unverified) {
    throw new UserError(`${file} has no exported functions the safety net can call, so behaviour can't be verified.`,
      "Export the function (or a caller of it), or pass --unverified to refactor with syntax checks only.");
  } else {
    mode = "syntax-only";
  }
  const coverageBefore = probes.length ? coverageOf(probes, hits, target.getStart(sf), target.getEnd()) : undefined;
  if (mode === "behavioral" && (coverageBefore ?? 0) === 0) {
    throw new UserError(`The safety net never executes ${fnName}(), so a refactor couldn't be verified.`,
      `It's only reachable through code paths the generated inputs don't hit. Run \`despaghetti safety-net ${file}\` to inspect coverage.`);
  }

  const checker = opts.typecheck !== false && isTsFile(file) ? new TypeChecker(file) : undefined;
  const baseErrors = checker?.errorCount(original);

  // ---- extraction loop ----
  let text = original;
  const steps: Step[] = [];
  const rejected: RejectedStep[] = [];
  const rejectedPrints = new Set<string>();
  const maxSteps = opts.maxSteps ?? cfg.refactor.maxSteps;
  let blocked: string | undefined;

  for (let step = 0; step < maxSteps; step++) {
    sf = parse(file, text);
    const fn = findFunction(sf, fnName);
    if (!fn) break;
    const found = findCandidates(fn, sf, cfg.refactor);
    if (found.blocked) {
      blocked = found.blocked;
      break;
    }
    if (step === 0) for (const r of found.rejected) rejected.push({ fromLine: r.startLine, toLine: r.endLine, reason: r.reason });

    let accepted = false;
    for (const c of found.candidates) {
      if (rejectedPrints.has(c.fingerprint)) continue;
      const cov = probes.length ? coverageOf(probes, hits, c.start, c.end) : undefined;
      if (mode === "behavioral" && (cov ?? 0) < cfg.refactor.minCoverage) {
        rejectedPrints.add(c.fingerprint);
        rejected.push({ fromLine: c.startLine, toLine: c.endLine,
          reason: `only ${Math.round((cov ?? 0) * 100)}% exercised by the safety net (min ${Math.round(cfg.refactor.minCoverage * 100)}%)` });
        continue;
      }

      const taken = allIdentifiers(sf);
      const returns = [...c.analysis.returnsDeclared.map((r) => r.name), ...c.analysis.returnsAssigned];
      let name = heuristicName(c, fnName, taken);
      let summary: string | undefined = c.heading ? summaryFromHeading(c.heading, name) : undefined;
      if (opts.namer) {
        const s = await opts.namer({ functionName: fnName, code: text.slice(c.start, c.end), params: c.analysis.params, returns, ...(c.heading ? { heading: c.heading } : {}), taken });
        if (s && isValidIdentifier(s.name)) {
          name = unique(s.name, taken);
          summary = s.summary ?? summary;
        }
      }
      const paramTypes = checker ? checker.paramTypes(text, fnName, c) : undefined;
      const next = applyExtraction(sf, fn, c, {
        name,
        ...(summary ? { summary: tidySummary(summary) } : {}),
        consumeHeading: Boolean(c.heading),
        ...(paramTypes ? { paramTypes } : {}),
      });

      const reject = (reason: string) => {
        rejectedPrints.add(c.fingerprint);
        rejected.push({ fromLine: c.startLine, toLine: c.endLine, reason });
      };
      const syn = syntaxErrors(parse(file, next));
      if (syn.length) {
        reject(`produced invalid syntax (${syn[0]})`);
        continue;
      }
      if (checker && baseErrors !== undefined && checker.errorCount(next) > baseErrors) {
        reject("would introduce TypeScript errors");
        continue;
      }
      if (mode === "behavioral") {
        progress(`Verifying ${name}() (lines ${c.startLine}-${c.endLine})…`);
        const run = await runSafetyNet(file, next, cases, { timeoutMs: cfg.safetyNet.timeoutMs, cwd: opts.cwd });
        const diff = run.loadError ? `module failed to load: ${run.loadError}` : compareOutcomes(baseline, run.cases);
        if (diff) {
          reject(`behaviour changed: ${diff}`);
          continue;
        }
        probes = run.probes;
        hits = run.hits;
      }
      steps.push({
        name, ...(summary ? { summary: tidySummary(summary) } : {}),
        fromLine: c.startLine, toLine: c.endLine, lines: c.lines,
        params: c.analysis.params, returns, ...(cov !== undefined ? { coverage: cov } : {}),
      });
      text = next;
      accepted = true;
      progress(`✔ Extracted ${name}()`);
      break;
    }
    if (!accepted) break;
  }

  // Re-layout is purely cosmetic (hoisted declarations), but keep it only if it parses cleanly.
  const laidOut = stepdown(file, text, fnName, steps.map((s) => s.name));
  if (laidOut !== text && syntaxErrors(parse(file, laidOut)).length === 0) {
    let ok = true;
    if (mode === "behavioral") {
      const run = await runSafetyNet(file, laidOut, cases, { timeoutMs: cfg.safetyNet.timeoutMs, cwd: opts.cwd });
      ok = !run.loadError && !compareOutcomes(baseline, run.cases);
    }
    if (ok) text = laidOut;
  }

  const finalSf = parse(file, text);
  const finalFn = findFunction(finalSf, fnName)!;
  // Report steps in the order the refactored function calls them.
  const body = finalFn.getText(finalSf);
  const callIndex = (n: string) => {
    const i = body.search(new RegExp(`\\b${n}\\s*\\(`));
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  steps.sort((x, y) => callIndex(x.name) - callIndex(y.name));
  return {
    file,
    functionName: fnName,
    original,
    output: text,
    steps,
    rejected: dedupeRejected(rejected),
    before,
    after: measureFunction(finalFn, finalSf, cfg.thresholds),
    verification: {
      mode,
      cases: baseline.length,
      deterministicCases: baseline.filter((c) => c.deterministic).length,
      ...(coverageBefore !== undefined ? { coverageBefore } : {}),
      entryPoints: [...new Set(cases.map((c) => c.exportName))],
    },
    ...(blocked ? { blocked } : {}),
  };
}

/** Use a section comment as the doc summary, upgrading bare nouns ("shipping") to sentences ("Compute shipping."). */
function summaryFromHeading(heading: string, name: string): string {
  const first = heading.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (/^[a-z]+(e|s|ize|ate|ify)?$/.test(first) && name.toLowerCase().startsWith(first)) return heading;
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

function tidySummary(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  const sentence = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

function dedupeRejected(r: RejectedStep[]): RejectedStep[] {
  const seen = new Set<string>();
  return r.filter((x) => {
    const k = `${x.fromLine}-${x.toLine}-${x.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export type { Candidate };
