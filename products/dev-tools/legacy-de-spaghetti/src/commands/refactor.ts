import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import chalk from "chalk";
import type { Command } from "commander";
import { simpleGit } from "simple-git";

import { box, type LicenseContext, UserError } from "@products/shared";

import { scan } from "../analysis/scan.ts";
import { createAiNamer } from "../ai/namer.ts";
import type { Config } from "../config.ts";
import { toPosix } from "../core/files.ts";
import { type Namer, refactorFile, type RefactorResult } from "../refactor/engine.ts";
import { colorDiff, configFor, out, parseIntOption, pct, requireFile, requirePath, spinner } from "./shared.ts";

interface RefactorFlags {
  function?: string;
  write?: boolean;
  force?: boolean;
  ai?: boolean;
  maxSteps?: string;
  unverified?: boolean;
  typecheck?: boolean;
  diff?: boolean;
  json?: boolean;
  all?: boolean;
  limit?: string;
}

async function isDirty(file: string): Promise<boolean> {
  try {
    const git = simpleGit(dirname(file));
    if (!(await git.checkIsRepo())) return false;
    const status = await git.status([file]);
    return status.files.length > 0;
  } catch {
    return false;
  }
}

function backup(root: string, file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(root, ".despaghetti", "backups", stamp, toPosix(relative(root, file)).replace(/\.\.\//g, "__/"));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(file, dest);
  return dest;
}

function summarize(r: RefactorResult): string[] {
  const rel = relative(process.cwd(), r.file);
  const lines = [
    chalk.bold(`${r.functionName}()  ${chalk.dim(rel)}`),
    "",
    `Lines       ${r.before.lines} → ${chalk.green.bold(String(r.after.lines))}`,
    `Complexity  ${r.before.complexity} → ${chalk.green.bold(String(r.after.complexity))}`,
    `Nesting     ${r.before.maxDepth} → ${chalk.green.bold(String(r.after.maxDepth))}`,
    `Grade       ${r.before.grade} → ${chalk.green.bold(r.after.grade)}`,
    "",
  ];
  if (r.steps.length) {
    lines.push(chalk.bold(`Extracted ${r.steps.length} function(s)`));
    for (const s of r.steps) {
      lines.push(`  ${chalk.green("›")} ${chalk.bold(s.name)}(${s.params.join(", ")})${s.returns.length ? chalk.dim(` → ${s.returns.join(", ")}`) : ""}` +
        chalk.dim(`  ${s.lines} lines${s.coverage !== undefined ? `, ${pct(s.coverage)} covered` : ""}`));
    }
  } else {
    lines.push(chalk.yellow("Nothing could be extracted safely."));
  }
  lines.push("");
  lines.push(r.verification.mode === "behavioral"
    ? chalk.green(`✔ Behaviour verified after every step: ${r.verification.deterministicCases} recorded cases via ${r.verification.entryPoints.join(", ")}`)
    : chalk.yellow("⚠ Unverified: syntax checks only. Review the diff carefully and run your tests."));
  if (r.blocked) lines.push(chalk.yellow(`Stopped: function ${r.blocked}.`));
  return lines;
}

async function runOne(file: string, o: RefactorFlags, config: Config, root: string, namer: Namer | undefined, functionName?: string): Promise<RefactorResult> {
  const spin = spinner("Analyzing…", o.json).start();
  try {
    return await refactorFile(file, {
      config,
      cwd: root,
      ...(functionName ? { functionName } : {}),
      ...(o.unverified ? { unverified: true } : {}),
      typecheck: o.typecheck !== false,
      ...(namer ? { namer } : {}),
      ...(o.maxSteps ? { maxSteps: parseIntOption(o.maxSteps, "--max-steps", 1, 200) } : {}),
      onProgress: (m) => {
        spin.text = m;
      },
    });
  } finally {
    spin.stop();
  }
}

export function registerRefactor(program: Command, license: LicenseContext): void {
  program
    .command("refactor")
    .description("Split a giant function into well-named helpers, verifying behaviour after every step")
    .argument("<path>", "source file (or directory with --all)")
    .option("-f, --function <name>", "function to refactor (default: the worst one in the file)")
    .option("-w, --write", "apply the changes (Pro); without it, show a dry-run diff")
    .option("--force", "write even if the file has uncommitted changes")
    .option("--ai", "let Claude name the extracted functions (Pro, needs ANTHROPIC_API_KEY)")
    .option("--max-steps <n>", "maximum number of extractions")
    .option("--unverified", "allow refactoring without a behavioural safety net (syntax checks only)")
    .option("--no-typecheck", "skip the TypeScript 'no new errors' gate for .ts files")
    .option("--no-diff", "don't print the diff")
    .option("--all", "refactor every over-threshold function under <path> (Enterprise)")
    .option("--limit <n>", "with --all: at most N functions", "10")
    .option("--json", "machine-readable output")
    .action(async (path: string, o: RefactorFlags) => {
      const lic = await license.current();
      if (o.write) license.requireTier(lic, "pro", "--write");
      if (o.ai) license.requireTier(lic, "pro", "--ai");
      if (o.all) license.requireTier(lic, "enterprise", "--all");

      const target = o.all ? requirePath(path) : requireFile(path);
      const { config, root } = configFor(target);
      const namer = o.ai ? createAiNamer({ ...config.ai, onWarning: (m) => process.stderr.write(chalk.yellow(`⚠ ${m}\n`)) }) : undefined;

      const jobs: { file: string; fn?: string }[] = [];
      if (o.all) {
        const limit = parseIntOption(o.limit ?? "10", "--limit", 1, 1000);
        const result = await scan(target, config);
        for (const f of result.functions.filter((x) => x.violations.length).slice(0, limit)) jobs.push({ file: f.file, fn: f.name });
        if (jobs.length === 0) {
          out(chalk.green("✔ No function exceeds the thresholds."));
          return;
        }
      } else {
        jobs.push({ file: target, ...(o.function ? { fn: o.function } : {}) });
      }

      const results: RefactorResult[] = [];
      for (const job of jobs) {
        if (o.write && !o.force && (await isDirty(job.file))) {
          throw new UserError(`${relative(process.cwd(), job.file)} has uncommitted changes.`,
            "Commit or stash first so the refactor is easy to review and undo, or pass --force.");
        }
        let r: RefactorResult;
        try {
          r = await runOne(job.file, o, config, root, namer, job.fn);
        } catch (e) {
          if (o.all && e instanceof UserError) {
            out(chalk.yellow(`⚠ ${relative(process.cwd(), job.file)} ${job.fn ?? ""}: ${e.message}`));
            continue;
          }
          throw e;
        }
        results.push(r);
        if (o.write && r.output !== r.original) {
          const bak = backup(root, job.file);
          writeFileSync(job.file, r.output);
          if (!o.json) out(chalk.dim(`Backup of the original → ${relative(process.cwd(), bak)}`));
        }
        if (o.json) continue;
        out(box(summarize(r), r.steps.length ? chalk.green : chalk.yellow));
        if (o.diff !== false && r.output !== r.original) out(`\n${colorDiff(relative(process.cwd(), r.file), r.original, r.output)}\n`);
        if (r.rejected.length && r.steps.length === 0) {
          out(chalk.dim("Blocks that couldn't be moved:"));
          for (const x of r.rejected.slice(0, 6)) out(chalk.dim(`  lines ${x.fromLine}-${x.toLine}: ${x.reason}`));
        }
        if (!o.write && r.output !== r.original) out(chalk.bold("Dry run: nothing was written. Re-run with --write to apply."));
        else if (o.write && r.output !== r.original) out(chalk.green.bold(`✔ Wrote ${relative(process.cwd(), r.file)}`));
      }
      if (o.json) {
        out(JSON.stringify(results.map(({ original: _o, ...rest }) => (o.write ? { ...rest, output: undefined } : rest)), null, 2));
      }
    });
}
