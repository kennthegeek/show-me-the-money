/** Repository scan: metrics for every file, optional git churn, hotspot ranking. */

import { relative } from "node:path";

import { simpleGit } from "simple-git";

import type { Config } from "../config.ts";
import { listSourceFiles, toPosix } from "../core/files.ts";
import { analyzeFile, type FileMetrics, type FunctionMetrics } from "./metrics.ts";

export interface Hotspot extends FunctionMetrics {
  relFile: string;
  churn: number;
  /** score weighted by how often the file changes (Tornhill-style hotspot). */
  hotspot: number;
}

export interface ScanResult {
  root: string;
  files: FileMetrics[];
  functions: Hotspot[];
  totals: {
    files: number;
    functions: number;
    lines: number;
    offenders: number;
    worstScore: number;
    debtLines: number;
    parseErrors: number;
  };
  churnAvailable: boolean;
}

/** Commits touching each file in the last `months` months (empty map when not a git repo). */
export async function gitChurn(root: string, months = 12): Promise<Map<string, number> | undefined> {
  try {
    const git = simpleGit(root);
    if (!(await git.checkIsRepo())) return undefined;
    const top = (await git.revparse(["--show-toplevel"])).trim();
    const out = await git.raw(["log", `--since=${months}.months`, "--format=", "--name-only", "--no-renames"]);
    const counts = new Map<string, number>();
    for (const line of out.split("\n")) {
      const f = line.trim();
      if (f) counts.set(toPosix(`${top}/${f}`), (counts.get(toPosix(`${top}/${f}`)) ?? 0) + 1);
    }
    return counts;
  } catch {
    return undefined;
  }
}

export async function scan(target: string, config: Config, opts: { churn?: boolean } = {}): Promise<ScanResult> {
  const files = await listSourceFiles(target, config);
  const metrics = files.map((f) => analyzeFile(f, config.thresholds));
  const churn = opts.churn ? await gitChurn(target) : undefined;

  const functions: Hotspot[] = metrics.flatMap((fm) =>
    fm.functions.map((fn) => {
      const c = churn?.get(toPosix(fm.file)) ?? 0;
      return {
        ...fn,
        relFile: toPosix(relative(target, fm.file)) || toPosix(fm.file).split("/").pop()!,
        churn: c,
        hotspot: Math.round(fn.score * (churn ? Math.log2(2 + c) : 1)),
      };
    }),
  );
  functions.sort((a, b) => b.hotspot - a.hotspot || b.score - a.score || b.lines - a.lines);

  const offenders = functions.filter((f) => f.violations.length > 0);
  return {
    root: target,
    files: metrics,
    functions,
    totals: {
      files: metrics.length,
      functions: functions.length,
      lines: metrics.reduce((s, f) => s + f.lines, 0),
      offenders: offenders.length,
      worstScore: functions[0]?.score ?? 0,
      debtLines: offenders.reduce((s, f) => s + Math.max(0, f.lines - config.thresholds.maxLines), 0),
      parseErrors: metrics.filter((m) => m.parseError).length,
    },
    churnAvailable: Boolean(churn),
  };
}
