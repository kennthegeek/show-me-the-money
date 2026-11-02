import { createProgram, type LicenseManagerDeps } from "@products/shared";

import { LICENSING, VERSION } from "../product.config.ts";
import { registerCheck } from "./commands/check.ts";
import { registerInit } from "./commands/init.ts";
import { registerPlan } from "./commands/plan.ts";
import { registerRefactor } from "./commands/refactor.ts";
import { registerSafetyNet } from "./commands/safety-net.ts";
import { registerScan } from "./commands/scan.ts";

/** Builds the CLI. Kept free of side effects so tests can drive it directly. */
export function buildProgram(deps?: LicenseManagerDeps) {
  const { program, license } = createProgram({
    name: "despaghetti",
    version: VERSION,
    description:
      "Legacy-De-Spaghetti: find the worst functions in a legacy JS/TS codebase, lock in their behaviour\n" +
      "with generated characterization tests, and split them into clean helpers, verified at every step.",
    licensing: LICENSING,
    freeCommands: ["init"],
    ...(deps ? { deps } : {}),
  });
  registerScan(program, license, VERSION);
  registerPlan(program, license);
  registerSafetyNet(program, license, VERSION);
  registerRefactor(program, license);
  registerCheck(program, license);
  registerInit(program);
  program.addHelpText(
    "after",
    `
Workflow:
  $ despaghetti scan src/                       find the worst offenders
  $ despaghetti plan src/billing.js             preview how the worst function would be split
  $ despaghetti safety-net src/billing.js       record behaviour + write characterization tests
  $ despaghetti refactor src/billing.js         dry run: verified diff
  $ despaghetti refactor src/billing.js --write apply it (Pro)`,
  );
  return program;
}
