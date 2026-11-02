/**
 * Friendly terminal onboarding when a license is missing, invalid or expired.
 *
 * Interactive (TTY): welcome box → purchase link → paste key → spinner → success.
 * Non-interactive (CI, pipes): prints concise instructions to stderr and throws, so the
 * CLI exits with a clear code instead of hanging on a prompt.
 */

import { createInterface } from "node:readline/promises";

import chalk from "chalk";
import ora from "ora";

import { capitalize, LicenseError, type LicenseManager, maskKey } from "./auth.ts";
import type { LicenseInfo } from "./types.ts";

export interface OnboardingIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream & { isTTY?: boolean };
  interactive: boolean;
}

export function defaultIO(): OnboardingIO {
  return {
    input: process.stdin,
    output: process.stderr,
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY) && !process.env.CI,
  };
}

const RECOVERABLE = new Set(["missing", "invalid", "revoked", "grace_expired", "test_purchase", "activation_limit"]);

export function box(lines: string[], color: (s: string) => string = chalk.cyan): string {
  // eslint-disable-next-line no-control-regex
  const visible = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "").length;
  const width = Math.min(76, Math.max(...lines.map(visible)) + 2);
  const top = color(`╭${"─".repeat(width)}╮`);
  const bottom = color(`╰${"─".repeat(width)}╯`);
  const body = lines.map((l) => `${color("│")} ${l}${" ".repeat(Math.max(0, width - visible(l) - 1))}${color("│")}`);
  return [top, ...body, bottom].join("\n");
}

export function describeLicense(lic: LicenseInfo): string[] {
  const lines = [
    `${chalk.bold("Tier:")}      ${chalk.green(capitalize(lic.tier))}${lic.variant && lic.variant !== lic.tier ? chalk.dim(` (${lic.variant})`) : ""}`,
    `${chalk.bold("Key:")}       ${maskKey(lic.licenseKey)}`,
  ];
  if (lic.email) lines.push(`${chalk.bold("Licensed to:")} ${lic.email}`);
  lines.push(`${chalk.bold("Verified:")}  ${new Date(lic.lastVerifiedAt).toLocaleString()} ${chalk.dim(`[${lic.source}]`)}`);
  if (lic.source === "offline-grace") {
    lines.push(chalk.yellow(`Offline mode: ${lic.graceDaysLeft} day(s) left before an online check is required.`));
  }
  if (lic.test) lines.push(chalk.yellow("Test purchase"));
  return lines;
}

/**
 * Return a usable license, guiding the user through activation if needed.
 * Throws LicenseError when the user can't or won't activate.
 */
export async function ensureLicense(
  manager: LicenseManager,
  io: OnboardingIO = defaultIO(),
  commandName = manager.config.slug,
): Promise<LicenseInfo> {
  let firstError: LicenseError;
  try {
    const lic = await manager.check();
    if (lic.source === "offline-grace" && (lic.graceDaysLeft ?? 0) <= 3) {
      io.output.write(chalk.yellow(
        `⚠ ${manager.config.productName} is running offline; ${lic.graceDaysLeft} day(s) left before it must re-verify.\n`));
    }
    return lic;
  } catch (err) {
    if (!(err instanceof LicenseError) || !RECOVERABLE.has(err.code)) throw err;
    firstError = err;
  }

  const { productName, purchaseUrl } = manager.config;
  if (!io.interactive) {
    io.output.write(
      `${chalk.red("✖")} ${firstError.message}\n` +
        `  Activate:  ${chalk.cyan(`${commandName} license activate <your-key>`)}\n` +
        `  Or set:    ${chalk.cyan(`${manager.envVar}=<your-key>`)}\n` +
        `  Buy a key: ${chalk.cyan(purchaseUrl)}\n`,
    );
    firstError.reported = true;
    throw firstError;
  }

  const intro =
    firstError.code === "missing"
      ? [chalk.bold(`👋 Welcome to ${productName}!`), "", "Paste the license key from your purchase receipt to get started."]
      : [chalk.bold(`${productName} needs a license check`), "", firstError.message];
  io.output.write(
    "\n" +
      box([
        ...intro,
        "",
        `${chalk.dim("Don't have one yet?")} ${chalk.cyan.underline(purchaseUrl)}`,
        chalk.dim(`Tip: set ${manager.envVar} for CI and scripts.`),
      ]) +
      "\n\n",
  );

  const rl = createInterface({ input: io.input, output: io.output, terminal: Boolean(io.output.isTTY) });
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const key = (await rl.question(chalk.bold("License key: "))).trim();
      if (!key) {
        io.output.write(chalk.dim("No key entered. Exiting.\n"));
        throw firstError;
      }
      const spinner = ora({ text: "Verifying with Gumroad…", stream: io.output, isEnabled: Boolean(io.output.isTTY) }).start();
      try {
        const lic = await manager.activate(key);
        spinner.succeed(`Activated ${productName} ${chalk.green(capitalize(lic.tier))}. Thanks for your support!`);
        io.output.write(`${describeLicense(lic).map((l) => `  ${l}`).join("\n")}\n\n`);
        return lic;
      } catch (err) {
        if (!(err instanceof LicenseError)) {
          spinner.fail("Unexpected error while verifying.");
          throw err;
        }
        spinner.fail(err.message);
        if (err.hint) io.output.write(chalk.dim(`  ${err.hint}\n`));
        if (err.code === "network" || err.code === "revoked" || err.code === "activation_limit") throw err;
        if (attempt < 3) io.output.write(chalk.dim("  Let's try that again.\n"));
        firstError = err;
      }
    }
    throw firstError;
  } finally {
    rl.close();
  }
}
