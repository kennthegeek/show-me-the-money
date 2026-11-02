/**
 * Commander scaffolding shared by every product:
 *   - `license activate|status|deactivate` subcommands
 *   - a preAction hook that resolves the license (with onboarding) before any gated command
 *   - consistent error output and exit codes
 *
 *   const { program, license } = createProgram({ name, version, description, licensing });
 *   program.command("run").action(async () => { license.requireTier(await license.current(), "pro") });
 *   await runCli(program);
 */

import chalk from "chalk";
import { Command, CommanderError } from "commander";

import { LicenseError, LicenseManager, type LicenseManagerDeps } from "./auth.ts";
import { box, defaultIO, describeLicense, ensureLicense, type OnboardingIO } from "./onboarding.ts";
import type { LicenseInfo, ProductLicenseConfig, Tier } from "./types.ts";

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  LICENSE: 3,
  TIER: 4,
  NETWORK: 5,
} as const;

export class UserError extends Error {
  constructor(message: string, readonly hint?: string, readonly exitCode: number = EXIT.ERROR) {
    super(message);
    this.name = "UserError";
  }
}

export interface ProgramOptions {
  name: string;
  version: string;
  description: string;
  licensing: ProductLicenseConfig;
  /** Commands that run without a license (besides `license *`, help and version). */
  freeCommands?: string[];
  deps?: LicenseManagerDeps;
  io?: OnboardingIO;
}

export interface LicenseContext {
  manager: LicenseManager;
  /** Resolved license for this invocation (resolves lazily, once). */
  current(): Promise<LicenseInfo>;
  /** Throws a friendly LicenseError if the tier is too low. */
  requireTier(license: LicenseInfo, tier: Tier, feature?: string): void;
}

export function createProgram(opts: ProgramOptions): { program: Command; license: LicenseContext } {
  const manager = new LicenseManager(opts.licensing, opts.deps);
  const io = opts.io ?? defaultIO();
  let resolved: Promise<LicenseInfo> | undefined;
  const license: LicenseContext = {
    manager,
    current: () => (resolved ??= ensureLicense(manager, io, opts.name)),
    requireTier: (lic, tier, feature) => manager.requireTier(lic, tier, feature),
  };

  const program = new Command(opts.name)
    .description(opts.description)
    .version(opts.version, "-v, --version")
    .showHelpAfterError("(add --help for usage)")
    .configureOutput({ outputError: (str, write) => write(chalk.red(str)) });

  const free = new Set(["license", "help", ...(opts.freeCommands ?? [])]);
  program.hook("preAction", async (_root, action) => {
    let cmd: Command | null = action;
    while (cmd && cmd.parent && cmd.parent !== program) cmd = cmd.parent;
    if (cmd && free.has(cmd.name())) return;
    await license.current();
  });

  const lic = program.command("license").description(`Manage your ${opts.licensing.productName} license`);

  lic
    .command("activate")
    .argument("<key>", "license key from your purchase receipt")
    .description("Activate this machine")
    .action(async (key: string) => {
      const info = await manager.activate(key);
      process.stdout.write(`${box([chalk.green.bold(`✔ ${opts.licensing.productName} activated`), "", ...describeLicense(info)], chalk.green)}\n`);
    });

  lic
    .command("status")
    .description("Show the license on this machine")
    .option("--online", "force an online re-check")
    .option("--json", "machine-readable output")
    .action(async (o: { online?: boolean; json?: boolean }) => {
      const info = await manager.check({ forceOnline: Boolean(o.online) });
      if (o.json) {
        const { licenseKey, ...rest } = info;
        process.stdout.write(`${JSON.stringify({ ...rest, licenseKey: `${licenseKey.slice(0, 4)}…` }, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${box(describeLicense(info))}\n${chalk.dim(`Stored in ${manager.store.location}`)}\n`);
    });

  lic
    .command("deactivate")
    .description("Remove the license from this machine")
    .action(() => {
      const had = manager.deactivate();
      process.stdout.write(had ? `${chalk.green("✔")} License removed from this machine.\n` : "No license was stored.\n");
    });

  return { program, license };
}

export function exitCodeFor(err: unknown): number {
  if (err instanceof LicenseError) {
    if (err.code === "tier") return EXIT.TIER;
    if (err.code === "network") return EXIT.NETWORK;
    return EXIT.LICENSE;
  }
  if (err instanceof UserError) return err.exitCode;
  // Commander uses exit code 1 for usage errors; follow the Unix convention of 2 instead.
  if (err instanceof CommanderError) return err.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
  return EXIT.ERROR;
}

/** Parse argv, print friendly errors, and return the exit code (also sets process.exitCode). */
export async function runCli(program: Command, argv: string[] = process.argv): Promise<number> {
  // Subcommands copy settings only at creation time, so apply the override to the whole tree.
  const override = (cmd: Command) => {
    cmd.exitOverride();
    cmd.commands.forEach(override);
  };
  override(program);
  try {
    await program.parseAsync(argv);
    return (process.exitCode = EXIT.OK);
  } catch (err) {
    const code = exitCodeFor(err);
    if (err instanceof CommanderError) {
      // Commander already printed help/usage/version.
      return (process.exitCode = code);
    }
    if (err instanceof LicenseError && err.reported) {
      // Onboarding already explained what to do.
    } else if (err instanceof LicenseError || err instanceof UserError) {
      process.stderr.write(`${chalk.red("✖")} ${err.message}\n`);
      if (err.hint) process.stderr.write(chalk.dim(`  ${err.hint}\n`));
    } else {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${chalk.red("✖ Unexpected error:")} ${message}\n`);
      if (process.env.DEBUG) process.stderr.write(`${(err as Error)?.stack ?? ""}\n`);
      else process.stderr.write(chalk.dim("  Re-run with DEBUG=1 for details.\n"));
    }
    return (process.exitCode = code);
  }
}
