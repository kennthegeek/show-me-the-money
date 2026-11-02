import { writeFileSync } from "node:fs";

import chalk from "chalk";
import type { Command } from "commander";

import type { LicenseContext } from "@products/shared";

import { renderMarkdown, renderSarif, renderTable } from "../analysis/report.ts";
import { scan } from "../analysis/scan.ts";
import { configFor, out, parseIntOption, requirePath, spinner } from "./shared.ts";

export function registerScan(program: Command, license: LicenseContext, version: string): void {
  program
    .command("scan")
    .description("Rank the most tangled functions in a file or codebase")
    .argument("[path]", "file or directory", ".")
    .option("-n, --top <n>", "how many functions to show", "15")
    .option("--hotspots", "weight by git churn: tangled code that changes often (Pro)")
    .option("--json", "machine-readable output")
    .option("--md <file>", "also write a Markdown report (Pro)")
    .option("--sarif <file>", "also write SARIF for GitHub code scanning (Enterprise)")
    .action(async (path: string, o: { top: string; hotspots?: boolean; json?: boolean; md?: string; sarif?: string }) => {
      const lic = await license.current();
      if (o.hotspots) license.requireTier(lic, "pro", "--hotspots");
      if (o.md) license.requireTier(lic, "pro", "Markdown reports");
      if (o.sarif) license.requireTier(lic, "enterprise", "SARIF output");
      const top = parseIntOption(o.top, "--top");
      const target = requirePath(path);
      const { config } = configFor(target);

      const spin = spinner("Scanning…", o.json).start();
      const result = await scan(target, config, { churn: Boolean(o.hotspots) });
      spin.stop();

      if (o.md) writeFileSync(o.md, renderMarkdown(result, config.thresholds, Math.max(top, 50)));
      if (o.sarif) writeFileSync(o.sarif, `${JSON.stringify(renderSarif(result, version), null, 2)}\n`);
      if (o.json) {
        out(JSON.stringify({ totals: result.totals, churnAvailable: result.churnAvailable, functions: result.functions.slice(0, top) }, null, 2));
        return;
      }
      out(renderTable(result, top));
      if (o.hotspots && !result.churnAvailable) out(chalk.yellow("(not a git repository: --hotspots had no history to use)"));
      if (o.md) out(chalk.dim(`Markdown report → ${o.md}`));
      if (o.sarif) out(chalk.dim(`SARIF → ${o.sarif}`));
    });
}
