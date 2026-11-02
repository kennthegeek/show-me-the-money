import { runCli } from "@products/shared";

import { buildProgram } from "./cli.ts";
import { recorderMain } from "./safety/recorder.ts";
import { RECORD_COMMAND } from "./safety/runner.ts";

// The same executable doubles as the sandboxed recorder process (see safety/runner.ts).
if (process.argv[2] === RECORD_COMMAND && process.env.DESPAGHETTI_CHILD === "1") {
  recorderMain();
} else {
  void runCli(buildProgram());
}
