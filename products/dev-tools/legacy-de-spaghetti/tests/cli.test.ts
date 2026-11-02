import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EXIT, MemoryStore, runCli } from "@products/shared";

import { buildProgram } from "../src/cli.ts";
import { tempProject } from "./helpers.ts";

const argv = (...a: string[]) => ["node", "despaghetti", ...a];
const dev = (tier: string) => ({ store: new MemoryStore(), env: { INDIE_CLI_DEV_LICENSE: tier } });

function capture() {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c) => ((out += String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c) => ((err += String(c)), true));
  return { out: () => out, err: () => err };
}

afterEach(() => {
  process.exitCode = 0;
});

describe("despaghetti CLI", () => {
  it("scan --json lists the worst function first", async () => {
    const dir = tempProject();
    const io = capture();
    expect(await runCli(buildProgram(dev("hobbyist")), argv("scan", dir, "--json"))).toBe(EXIT.OK);
    const json = JSON.parse(io.out());
    expect(json.functions[0].name).toBe("processOrder");
    expect(json.totals.offenders).toBe(1);
  });

  it("gates Pro and Enterprise features", async () => {
    const dir = tempProject();
    const io = capture();
    expect(await runCli(buildProgram(dev("hobbyist")), argv("refactor", join(dir, "invoice.js"), "--write"))).toBe(EXIT.TIER);
    expect(await runCli(buildProgram(dev("pro")), argv("scan", dir, "--sarif", join(dir, "x.sarif")))).toBe(EXIT.TIER);
    expect(await runCli(buildProgram(dev("pro")), argv("check", dir))).toBe(EXIT.TIER);
    expect(io.err()).toContain("requires the Pro tier");
    expect(io.err()).toContain("requires the Enterprise tier");
  });

  it("plan previews extractions without touching the file", async () => {
    const dir = tempProject();
    const file = join(dir, "invoice.js");
    const before = readFileSync(file, "utf8");
    const io = capture();
    expect(await runCli(buildProgram(dev("hobbyist")), argv("plan", file, "--json"))).toBe(EXIT.OK);
    const plan = JSON.parse(io.out());
    expect(plan.candidates.map((c: { name: string }) => c.name)).toContain("applyCustomerDiscounts");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("safety-net → refactor --write, and the generated tests still pass afterwards", async () => {
    const dir = tempProject();
    const file = join(dir, "invoice.js");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    capture();
    expect(await runCli(buildProgram(dev("pro")), argv("safety-net", file))).toBe(EXIT.OK);
    const testFile = join(dir, "__characterization__", "invoice.characterization.test.js");
    expect(existsSync(testFile)).toBe(true);
    expect(existsSync(join(dir, ".despaghetti", "golden", "invoice.js.json"))).toBe(true);
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "tests");

    expect(await runCli(buildProgram(dev("pro")), argv("refactor", file, "--write", "--no-diff"))).toBe(EXIT.OK);
    expect(readFileSync(file, "utf8")).toContain("function applyCustomerDiscounts(");
    const output = execFileSync(process.execPath, ["--test", testFile], { encoding: "utf8" });
    expect(output).toMatch(/# fail 0/);

    // A dirty file is protected unless --force.
    writeFileSync(file, `${readFileSync(file, "utf8")}\n// local edit\n`);
    expect(await runCli(buildProgram(dev("pro")), argv("refactor", file, "--write"))).toBe(EXIT.ERROR);
  }, 120_000);

  it("check ratchets against a baseline (Enterprise)", async () => {
    const dir = tempProject();
    const baseline = join(dir, "baseline.json");
    capture();
    expect(await runCli(buildProgram(dev("enterprise")), argv("check", dir, "-b", baseline, "--update-baseline"))).toBe(EXIT.OK);
    expect(await runCli(buildProgram(dev("enterprise")), argv("check", dir, "-b", baseline))).toBe(EXIT.OK);
    writeFileSync(join(dir, "new.js"), `function worse(a){\n${"  if (a) { a++; } else { a--; }\n".repeat(30)}  return a;\n}\nmodule.exports = worse;\n`);
    expect(await runCli(buildProgram(dev("enterprise")), argv("check", dir, "-b", baseline))).toBe(EXIT.ERROR);
  });

  it("init writes a config file (no license needed)", async () => {
    const dir = tempProject([]);
    capture();
    expect(await runCli(buildProgram({ store: new MemoryStore(), env: {} }), argv("init", dir))).toBe(EXIT.OK);
    expect(JSON.parse(readFileSync(join(dir, ".despaghettirc.json"), "utf8")).thresholds.maxLines).toBe(60);
  });

  it("asks for a license for everything else", async () => {
    capture();
    expect(await runCli(buildProgram({ store: new MemoryStore(), env: {} }), argv("scan", "."))).toBe(EXIT.LICENSE);
  });
});
