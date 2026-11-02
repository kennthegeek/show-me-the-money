import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

import chalk from "chalk";
import type { Command } from "commander";

import { box, type LicenseContext, UserError } from "@products/shared";

import { buildSafetyNet, saveGolden } from "../safety/safetynet.ts";
import { type Framework, generateTests } from "../safety/testgen.ts";
import { configFor, out, parseIntOption, pct, requireFile, spinner } from "./shared.ts";

export function registerSafetyNet(program: Command, license: LicenseContext, version: string): void {
  program
    .command("safety-net")
    .description("Record what a file does today and write characterization tests that lock it in")
    .argument("<file>", "source file")
    .option("-f, --function <names...>", "only drive these exported functions")
    .option("-c, --cases <n>", "max generated inputs per exported function")
    .option("--framework <name>", "vitest | jest | node (default: detected from package.json)")
    .option("-o, --out <dir>", "test directory, relative to the source file")
    .option("--dry-run", "record and report, but don't write files")
    .action(async (file: string, o: { function?: string[]; cases?: string; framework?: string; out?: string; dryRun?: boolean }) => {
      await license.current();
      const abs = requireFile(file);
      const { config, root } = configFor(abs);
      if (o.framework && !["vitest", "jest", "node"].includes(o.framework)) throw new UserError("--framework must be vitest, jest or node.");
      const maxCases = o.cases ? parseIntOption(o.cases, "--cases", 1, 500) : config.safetyNet.maxCases;

      const spin = spinner(`Generating inputs and recording ${relative(process.cwd(), abs)}…`).start();
      const net = await buildSafetyNet(abs, { maxCases, timeoutMs: config.safetyNet.timeoutMs, cwd: root, ...(o.function ? { only: o.function } : {}) });
      spin.stop();

      if (net.entryPoints.length === 0) {
        throw new UserError("This file exports no functions, so there's nothing for tests to call.",
          "Export the function you want to protect (or a function that calls it) and run again.");
      }
      if (net.loadError) throw new UserError(`Couldn't load the module: ${net.loadError}`, "Characterization needs the file to import cleanly in Node.");

      const det = net.cases.filter((c) => c.deterministic);
      const throwing = det.filter((c) => "throws" in c.outcome).length;
      const lines = [
        chalk.bold(`Safety net for ${relative(process.cwd(), abs)}`),
        "",
        `Entry points:  ${net.entryPoints.join(", ")}`,
        `Cases:         ${det.length} recorded${net.cases.length - det.length ? chalk.yellow(` (${net.cases.length - det.length} non-deterministic, skipped)`) : ""}` +
          chalk.dim(` · ${det.length - throwing} return, ${throwing} throw`),
        "",
        chalk.bold("Statement coverage"),
        ...net.coverage
          .filter((c) => c.coverage !== undefined)
          .sort((a, b) => a.startLine - b.startLine)
          .map((c) => {
            const v = c.coverage!;
            const color = v >= 0.8 ? chalk.green : v >= config.refactor.minCoverage ? chalk.yellow : chalk.red;
            return `  ${color(pct(v).padStart(4))}  ${c.name}${chalk.dim(`:${c.startLine}`)}`;
          }),
      ];
      out(box(lines));

      if (o.dryRun) return;
      const tests = generateTests(abs, net.cases, {
        outDir: o.out ?? config.safetyNet.outDir,
        ...(o.framework ? { framework: o.framework as Framework } : {}),
        version,
      });
      mkdirSync(dirname(tests.testPath), { recursive: true });
      writeFileSync(tests.testPath, tests.testSource);
      writeFileSync(tests.supportPath, tests.supportSource);
      const golden = saveGolden(root, net);
      out(`${chalk.green("✔")} Tests   → ${relative(process.cwd(), tests.testPath)} ${chalk.dim(`(${tests.included} cases)`)}`);
      out(`${chalk.green("✔")} Golden  → ${relative(process.cwd(), golden)} ${chalk.dim("(reused by `refactor`)")}`);
      const low = net.coverage.filter((c) => c.coverage !== undefined && c.coverage < config.refactor.minCoverage);
      if (low.length) {
        out(chalk.yellow(`\n${low.length} function(s) are barely exercised. Raise --cases, or add hand-written cases for those paths before refactoring them.`));
      }
    });
}
