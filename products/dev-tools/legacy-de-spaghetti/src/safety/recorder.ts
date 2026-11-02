/**
 * Recorder: runs inside an isolated child process. Loads the target module (optionally from
 * an in-memory override of its source), calls each case twice with fresh copies of the
 * inputs, and reports outcomes, argument mutations, determinism and coverage probe hits.
 *
 * Running in a child means user code can't corrupt the CLI, `process.exit()` calls are
 * contained, and a runaway loop is killed by the parent's timeout.
 */

import { readFileSync } from "node:fs";
import Module from "node:module";
import { extname, resolve, sep } from "node:path";

import ts from "typescript";

import { capture, decode, encode, type Encoded, fingerprint, type Outcome } from "./serialize.ts";

export interface RecorderCase {
  exportName: string;
  args: Encoded[];
}

export interface RecorderInput {
  file: string;
  /** Replaces the target file's contents (refactored and/or instrumented code). */
  source?: string;
  cases: RecorderCase[];
  timeoutMs: number;
}

export interface CaseResult {
  outcome: Outcome;
  argsAfter?: Encoded[];
  deterministic: boolean;
}

export interface RecorderOutput {
  loadError?: string;
  results: CaseResult[];
  hits: number[];
}

const MODULE_ITSELF = "<module>";
const TRANSPILE_EXT = [".ts", ".tsx", ".mts", ".cts", ".jsx"];
const JS_EXT = [".js", ".mjs", ".cjs"];

type Ext = (module: NodeJS.Module & { _compile(code: string, file: string): void }, filename: string) => void;

function installHooks(target: string, override: string | undefined): void {
  const M = Module as unknown as {
    _extensions: Record<string, Ext>;
    _resolveFilename: (request: string, parent: unknown, ...rest: unknown[]) => string;
  };
  const originalJs = M._extensions[".js"]!;
  const compile: Ext = (module, filename) => {
    if (filename.includes(`${sep}node_modules${sep}`)) {
      originalJs(module, filename);
      return;
    }
    let code = filename === target && override !== undefined ? override : readFileSync(filename, "utf8");
    const ext = extname(filename);
    if (TRANSPILE_EXT.includes(ext) || ext === ".mjs" || /^\s*(import|export)\s/m.test(code)) {
      code = ts.transpileModule(code, {
        fileName: filename,
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
          esModuleInterop: true,
          jsx: ts.JsxEmit.React,
          sourceMap: false,
        },
      }).outputText;
    }
    module._compile(code, filename);
  };
  for (const ext of [...TRANSPILE_EXT, ...JS_EXT]) M._extensions[ext] = compile;

  // TS-style ESM imports name the emitted file ("./util.js") while the source is util.ts.
  const originalResolve = M._resolveFilename;
  M._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]) {
    try {
      return originalResolve.call(this, request, parent, ...rest);
    } catch (err) {
      if (/\.(c|m)?js$/.test(request)) {
        for (const alt of [".ts", ".tsx", ".mts", ".cts"]) {
          try {
            return originalResolve.call(this, request.replace(/\.(c|m)?js$/, alt), parent, ...rest);
          } catch {
            /* try next */
          }
        }
      }
      throw err;
    }
  };
}

function pick(mod: unknown, name: string): unknown {
  const m = mod as Record<string, unknown> | ((...a: unknown[]) => unknown);
  if (name === MODULE_ITSELF) return typeof m === "function" ? m : (m as Record<string, unknown>).default;
  const obj = m as Record<string, unknown>;
  if (name === "default") return obj.default ?? m;
  if (typeof obj[name] === "function") return obj[name];
  const def = obj.default as Record<string, unknown> | undefined;
  if (def && typeof def[name] === "function") return def[name];
  return undefined;
}

function withTimeout(p: Promise<Outcome>, ms: number): Promise<Outcome> {
  return new Promise((resolveP) => {
    const t = setTimeout(
      () => resolveP({ throws: { name: "DespaghettiTimeout", message: `did not settle within ${ms}ms` } }),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolveP(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        resolveP({ throws: { name: "Error", message: String(e) } });
      },
    );
  });
}

async function runOnce(fn: unknown, c: RecorderCase, timeoutMs: number): Promise<{ outcome: Outcome; argsAfter?: Encoded[] }> {
  if (typeof fn !== "function") {
    return { outcome: { throws: { name: "DespaghettiError", message: `export "${c.exportName}" is not callable` } } };
  }
  const args = decode(c.args) as unknown[];
  const outcome = await withTimeout(capture(() => (fn as (...a: unknown[]) => unknown)(...args)), timeoutMs);
  const after = args.map((a) => encode(a));
  return fingerprint(after) === fingerprint(c.args) ? { outcome } : { outcome, argsAfter: after };
}

export async function runRecorder(input: RecorderInput): Promise<RecorderOutput> {
  const target = resolve(input.file);
  const hits = new Set<number>();
  (globalThis as Record<string, unknown>).__dsHit = (id: number) => hits.add(id);

  // Silence the subject: its console output must not interleave with ours, and it must not exit us.
  const quiet = () => {};
  for (const k of ["log", "info", "warn", "error", "debug", "trace", "table", "dir"] as const) {
    (console as unknown as Record<string, unknown>)[k] = quiet;
  }
  const realExit = process.exit.bind(process);
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code ?? ""}) called`);
  }) as typeof process.exit;
  process.on("uncaughtException", () => {});
  process.on("unhandledRejection", () => {});

  installHooks(target, input.source);

  let mod: unknown;
  try {
    mod = Module.createRequire(target)(target);
  } catch (e) {
    process.exit = realExit;
    return { loadError: e instanceof Error ? `${e.name}: ${e.message}` : String(e), results: [], hits: [] };
  }

  const results: CaseResult[] = [];
  for (const c of input.cases) {
    const fn = pick(mod, c.exportName);
    const first = await runOnce(fn, c, input.timeoutMs);
    const second = await runOnce(fn, c, input.timeoutMs);
    const deterministic =
      fingerprint(first.outcome) === fingerprint(second.outcome) && fingerprint(first.argsAfter) === fingerprint(second.argsAfter);
    results.push({ ...first, deterministic });
  }
  process.exit = realExit;
  return { results, hits: [...hits].sort((a, b) => a - b) };
}

/** Child-process entry: receive one RecorderInput over IPC, reply, exit. */
export function recorderMain(): void {
  process.once("message", (input: RecorderInput) => {
    runRecorder(input)
      .then((out) => process.send?.(out, () => process.exit(0)))
      .catch((e: unknown) => process.send?.({ loadError: String(e), results: [], hits: [] }, () => process.exit(0)));
  });
}
