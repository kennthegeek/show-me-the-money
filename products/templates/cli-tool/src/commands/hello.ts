import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";

import { type LicenseContext, UserError } from "@products/shared";

export interface HelloOptions {
  shout?: boolean;
  times?: string;
  json?: boolean;
}

/** Pure logic, kept separate from I/O so it is trivially testable. */
export function greet(name: string, opts: { shout?: boolean; times?: number } = {}): string[] {
  const clean = name.trim();
  if (!clean) throw new UserError("Name cannot be empty.", "Example: {{bin}} hello Ada");
  const line = `Hello, ${clean}!`;
  return Array.from({ length: opts.times ?? 1 }, () => (opts.shout ? line.toUpperCase() : line));
}

export function registerHello(program: Command, license: LicenseContext): void {
  program
    .command("hello")
    .description("Example command: greets someone (replace with your product's real commands)")
    .argument("<name>", "who to greet")
    .option("-s, --shout", "SHOUT the greeting (Pro tier)")
    .option("-n, --times <n>", "repeat N times (Enterprise tier for N > 3)", "1")
    .option("--json", "machine-readable output")
    .action(async (name: string, opts: HelloOptions) => {
      const lic = await license.current();
      const times = Number.parseInt(opts.times ?? "1", 10);
      if (!Number.isInteger(times) || times < 1 || times > 100) {
        throw new UserError("--times must be a whole number between 1 and 100.");
      }
      if (opts.shout) license.requireTier(lic, "pro", "--shout");
      if (times > 3) license.requireTier(lic, "enterprise", "--times > 3");

      const spinner = ora({ text: "Thinking…", isSilent: !process.stderr.isTTY || Boolean(opts.json) }).start();
      const lines = greet(name, { shout: Boolean(opts.shout), times });
      spinner.stop();

      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ lines, tier: lic.tier })}\n`);
      } else {
        for (const l of lines) process.stdout.write(`${chalk.green("›")} ${l}\n`);
      }
    });
}
