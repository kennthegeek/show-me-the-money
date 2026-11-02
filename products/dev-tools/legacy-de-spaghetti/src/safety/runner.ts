/** Parent side of the recorder: spawn an isolated child, send cases, collect results. */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { UserError } from "@products/shared";

import type { RecorderInput, RecorderOutput } from "./recorder.ts";

declare const __DEV__: boolean | undefined;
const BUNDLED = typeof __DEV__ !== "undefined" && __DEV__ === false;
export const RECORD_COMMAND = "__record";

function isSea(): boolean {
  try {
    const req = typeof require === "function" ? require : createRequire(import.meta.url);
    return Boolean((req("node:sea") as { isSea?: () => boolean }).isSea?.());
  } catch {
    return false;
  }
}

/** How to start ourselves as a recorder: the SEA binary, the bundled .cjs, or tsx in development. */
export function recorderCommand(): { cmd: string; args: string[] } {
  if (BUNDLED) {
    if (isSea()) return { cmd: process.execPath, args: [RECORD_COMMAND] };
    return { cmd: process.execPath, args: [process.argv[1]!, RECORD_COMMAND] };
  }
  const entry = fileURLToPath(new URL("./recorder-main.ts", import.meta.url));
  // Resolve tsx from here so the child can load it whatever its cwd is.
  return { cmd: process.execPath, args: ["--import", import.meta.resolve("tsx"), entry] };
}

export async function record(input: RecorderInput, opts: { cwd?: string } = {}): Promise<RecorderOutput> {
  const { cmd, args } = recorderCommand();
  // Each case runs twice; allow for that plus module load time.
  const budget = input.cases.length * input.timeoutMs * 2 + 15_000;
  return new Promise((resolveP, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, DESPAGHETTI_CHILD: "1" },
    });
    let stderr = "";
    let settled = false;
    child.stderr?.on("data", (d) => {
      stderr = (stderr + String(d)).slice(-4000);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new UserError(
        `Recording timed out after ${Math.round(budget / 1000)}s.`,
        "The code may loop forever or wait on network/database I/O for these inputs. Try --cases with fewer inputs or stub external calls.",
      ));
    }, budget);
    child.on("message", (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP(msg as RecorderOutput);
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new UserError(`Recorder process exited unexpectedly (code ${code}).`, stderr.trim().split("\n").slice(-5).join("\n")));
    });
    child.send(input);
  });
}
