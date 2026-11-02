import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import chalk from "chalk";
import type { Command } from "commander";

import { UserError } from "@products/shared";

import { CONFIG_FILE, DEFAULT_CONFIG } from "../config.ts";
import { out } from "./shared.ts";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description(`Write a ${CONFIG_FILE} with the default thresholds`)
    .argument("[dir]", "project directory", ".")
    .option("--force", "overwrite an existing file")
    .action((dir: string, o: { force?: boolean }) => {
      const file = join(resolve(dir), CONFIG_FILE);
      if (existsSync(file) && !o.force) throw new UserError(`${CONFIG_FILE} already exists.`, "Pass --force to overwrite it.");
      const { exclude: _defaults, ...rest } = DEFAULT_CONFIG;
      writeFileSync(file, `${JSON.stringify({ ...rest, exclude: [] }, null, 2)}\n`);
      out(`${chalk.green("✔")} Wrote ${file}`);
      out(chalk.dim("Built-in excludes (node_modules, dist, tests, *.min.js…) always apply; add your own under \"exclude\"."));
    });
}
