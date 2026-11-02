import { readFileSync } from "node:fs";

import chalk from "chalk";
import type { Command } from "commander";

import { type LicenseContext, UserError } from "@products/shared";

import { measureFunction } from "../analysis/metrics.ts";
import { allIdentifiers, collectFunctions, findFunction, functionName, parse } from "../core/ast.ts";
import { findCandidates } from "../refactor/candidates.ts";
import { heuristicName } from "../refactor/naming.ts";
import { coverageOf } from "../safety/instrument.ts";
import { buildSafetyNet } from "../safety/safetynet.ts";
import { configFor, out, pct, requireFile, spinner } from "./shared.ts";

export function registerPlan(program: Command, license: LicenseContext): void {
  program
    .command("plan")
    .description("Preview how a function would be split up, without changing anything")
    .argument("<file>", "source file")
    .option("-f, --function <name>", "function to plan (default: the worst one in the file)")
    .option("--coverage", "run the safety net to show which parts it can verify")
    .option("--json", "machine-readable output")
    .action(async (file: string, o: { function?: string; coverage?: boolean; json?: boolean }) => {
      await license.current();
      const abs = requireFile(file);
      const { config, root } = configFor(abs);
      const text = readFileSync(abs, "utf8");
      const sf = parse(abs, text);
      const fn = o.function
        ? findFunction(sf, o.function)
        : collectFunctions(sf).sort((a, b) => measureFunction(b, sf, config.thresholds).score - measureFunction(a, sf, config.thresholds).score)[0];
      if (!fn) throw new UserError(o.function ? `No function named "${o.function}".` : "No functions in this file.");
      const name = functionName(fn, sf);
      const metrics = measureFunction(fn, sf, config.thresholds);
      const { candidates, rejected, blocked } = findCandidates(fn, sf, config.refactor);

      let cover: ((s: number, e: number) => number | undefined) | undefined;
      if (o.coverage) {
        const spin = spinner("Running the safety net…", o.json).start();
        const net = await buildSafetyNet(abs, { maxCases: config.safetyNet.maxCases, timeoutMs: config.safetyNet.timeoutMs, cwd: root, text });
        spin.stop();
        cover = (s, e) => coverageOf(net.probes, net.hits, s, e);
      }

      // Show non-overlapping candidates in source order: what a refactor would most likely do first.
      const chosen: typeof candidates = [];
      for (const c of candidates) if (!chosen.some((x) => c.start < x.end && x.start < c.end)) chosen.push(c);
      chosen.sort((a, b) => a.start - b.start);
      const taken = allIdentifiers(sf);

      if (o.json) {
        out(JSON.stringify({
          function: metrics,
          blocked,
          candidates: chosen.map((c) => ({
            name: heuristicName(c, name, taken), startLine: c.startLine, endLine: c.endLine, lines: c.lines,
            params: c.analysis.params, returns: [...c.analysis.returnsDeclared.map((r) => r.name), ...c.analysis.returnsAssigned],
            ...(cover ? { coverage: cover(c.start, c.end) } : {}),
          })),
          rejected,
        }, null, 2));
        return;
      }

      out(chalk.bold(`${name}()`) + chalk.dim(` · lines ${metrics.startLine}-${metrics.endLine} · ${metrics.lines} lines · complexity ${metrics.complexity} · nesting ${metrics.maxDepth} · grade ${metrics.grade}`));
      if (blocked) {
        out(chalk.yellow(`Can't be split automatically: ${blocked}.`));
        return;
      }
      if (chosen.length === 0) {
        out(chalk.yellow("No safe extraction found."));
      } else {
        out("");
        out(chalk.bold("Proposed extractions"));
        for (const c of chosen) {
          const returns = [...c.analysis.returnsDeclared.map((r) => r.name), ...c.analysis.returnsAssigned];
          const cov = cover?.(c.start, c.end);
          const covText = cover ? (cov !== undefined && cov >= config.refactor.minCoverage ? chalk.green(` covered ${pct(cov)}`) : chalk.yellow(` covered ${pct(cov)} (too low to verify)`)) : "";
          out(`  ${chalk.green("›")} ${chalk.bold(heuristicName(c, name, taken))}(${c.analysis.params.join(", ")})` +
            `${returns.length ? chalk.dim(` → ${returns.join(", ")}`) : ""}` +
            chalk.dim(`  lines ${c.startLine}-${c.endLine}, ${c.lines} lines`) + covText);
        }
      }
      if (rejected.length) {
        out("");
        out(chalk.dim(`${rejected.length} other block(s) can't move safely, e.g.:`));
        for (const r of rejected.slice(0, 5)) out(chalk.dim(`  lines ${r.startLine}-${r.endLine}: ${r.reason}`));
      }
      out("");
      out(chalk.dim(`Next: despaghetti refactor ${file} --function ${name}   (dry run; add --write to apply)`));
    });
}
