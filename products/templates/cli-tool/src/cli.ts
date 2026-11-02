import { createProgram, type LicenseManagerDeps } from "@products/shared";

import { LICENSING, VERSION } from "../product.config.ts";
import { registerHello } from "./commands/hello.ts";

/** Builds the CLI. Kept free of side effects so tests can drive it directly. */
export function buildProgram(deps?: LicenseManagerDeps) {
  const { program, license } = createProgram({
    name: "{{bin}}",
    version: VERSION,
    description: "{{description}}",
    licensing: LICENSING,
    ...(deps ? { deps } : {}),
  });
  registerHello(program, license);
  return program;
}
