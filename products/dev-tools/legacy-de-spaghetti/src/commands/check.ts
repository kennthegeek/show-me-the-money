import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import chalk from "chalk";
import type { Command } from "commander";

import { EXIT, type LicenseContext, UserError } from "@products/shared";

import { scan } from "../analysis/scan.ts";
import { configFor, out, requirePath, spinner } from "./shared.ts";

interface Baseline {
  version: 1;
  functions: Record<string, number>;
}

/** CI gate: fail when new spaghetti appears or existing spaghetti gets worse (ratchet). */
export function registerCheck(program: Command, license: LicenseContext): void {
  program
    .command("check")
    .description("CI gate: fail if functions exceed thresholds or get worse than the baseline (Enterprise)")
    .argument("[path]", "file or directory", ".")
    .option("-b, --baseline <file>", "baseline file", ".despaghetti/baseline.json")
    .option("--update-baseline", "record the current state as the new baseline")
    .option("--json", "machine-readable output")
    .action(async (path: string, o: { baseline: string; updateBaseline?: boolean; json?: boolean }) => {
      license.requireTier(await license.current(), "enterprise", "check");
      const target = requirePath(path);
      const { config } = configFor(target);
      const spin = spinner("Scanning…", o.json).start();
      const result = await scan(target, config);
      spin.stop();

      const current: Record<string, number> = {};
      for (const f of result.functions) if (f.violations.length) current[`${f.relFile}#${f.name}`] = f.score;

      if (o.updateBaseline) {
        mkdirSync(dirname(o.baseline), { recursive: true });
        writeFileSync(o.baseline, `${JSON.stringify({ version: 1, functions: current } satisfies Baseline, null, 2)}\n`);
        out(`${chalk.green("✔")} Baseline with ${Object.keys(current).length} known offender(s) → ${o.baseline}`);
        return;
      }

      let baseline: Baseline = { version: 1, functions: {} };
      if (existsSync(o.baseline)) {
        try {
          baseline = JSON.parse(readFileSync(o.baseline, "utf8")) as Baseline;
        } catch {
          throw new UserError(`Couldn't parse ${o.baseline}.`);
        }
      }
      const added = Object.entries(current).filter(([k]) => baseline.functions[k] === undefined);
      const worse = Object.entries(current).filter(([k, v]) => baseline.functions[k] !== undefined && v > baseline.functions[k]!);
      const fixed = Object.keys(baseline.functions).filter((k) => current[k] === undefined);

      if (o.json) {
        out(JSON.stringify({ added, worse, fixed, ok: added.length + worse.length === 0 }, null, 2));
      } else {
        for (const [k, v] of added) out(`${chalk.red("✖ new")}    ${k} ${chalk.dim(`(score ${v})`)}`);
        for (const [k, v] of worse) out(`${chalk.red("✖ worse")}  ${k} ${chalk.dim(`(${baseline.functions[k]} → ${v})`)}`);
        for (const k of fixed) out(`${chalk.green("✔ fixed")}  ${k}`);
        if (added.length + worse.length === 0) out(chalk.green(`✔ No new or worsening spaghetti (${Object.keys(current).length} known offender(s) in baseline).`));
        else if (fixed.length) out(chalk.dim("Tip: run with --update-baseline after merging fixes to lock in the improvement."));
      }
      if (added.length + worse.length > 0) process.exitCode = EXIT.ERROR;
    });
}
