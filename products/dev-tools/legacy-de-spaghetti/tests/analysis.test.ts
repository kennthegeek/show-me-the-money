import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeSource, grade, spaghettiScore } from "../src/analysis/metrics.ts";
import { renderMarkdown, renderSarif } from "../src/analysis/report.ts";
import { scan } from "../src/analysis/scan.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { FIXTURES } from "./helpers.ts";

const T = DEFAULT_CONFIG.thresholds;

describe("metrics", () => {
  it("measures cyclomatic complexity and nesting per function", () => {
    const src = `
function f(a, b) {
  if (a && b) {
    for (const x of a) {
      while (x) { if (x > 1) break; }
    }
  } else if (b || a) {
    return a ? 1 : 2;
  }
  switch (b) { case 1: return 1; case 2: return 2; default: return 3; }
}`;
    const [fn] = analyzeSource("x.js", src, T).functions;
    // 1 + if + && + for + while + if + else-if + || + ?: + 2 cases = 11
    expect(fn!.complexity).toBe(11);
    expect(fn!.maxDepth).toBe(4);
    expect(fn!.params).toBe(2);
  });

  it("names every kind of function", () => {
    const src = `
function decl() {}
const arrow = () => 1;
const expr = function () {};
module.exports.handler = function () {};
class Svc { run() {} get v() { return 1; } constructor() {} }
const obj = { m() {}, p: () => 2 };
export default function () {}`;
    const names = analyzeSource("x.ts", src, T).functions.map((f) => f.name);
    expect(names).toEqual(["decl", "arrow", "expr", "module.exports.handler", "Svc.run", "Svc.v", "Svc.constructor", "m", "p", "default"]);
  });

  it("scores and grades monotonically", () => {
    const small = spaghettiScore({ lines: 10, complexity: 2, maxDepth: 1, params: 1 }, T);
    const big = spaghettiScore({ lines: 1000, complexity: 120, maxDepth: 9, params: 8 }, T);
    expect(small).toBe(0);
    expect(big).toBeGreaterThan(90);
    expect(grade(small)).toBe("A");
    expect(grade(big)).toBe("F");
  });

  it("flags the legacy fixture's giant function", () => {
    const fm = analyzeSource(join(FIXTURES, "invoice.js"), readFileSync(join(FIXTURES, "invoice.js"), "utf8"), T);
    const worst = [...fm.functions].sort((a, b) => b.score - a.score)[0]!;
    expect(worst.name).toBe("processOrder");
    expect(worst.grade).toBe("F");
    expect(worst.violations.join()).toMatch(/lines/);
  });
});

describe("scan", () => {
  it("ranks functions across a directory and reports totals", async () => {
    const r = await scan(FIXTURES, DEFAULT_CONFIG);
    expect(r.totals.files).toBe(2);
    expect(r.functions[0]!.name).toBe("processOrder");
    expect(r.totals.offenders).toBeGreaterThanOrEqual(1);
    expect(renderMarkdown(r, T, 5)).toContain("`processOrder`");
    const sarif = renderSarif(r, "1.0.0") as { runs: { results: { ruleId: string }[] }[] };
    expect(sarif.runs[0]!.results[0]!.ruleId).toBe("DSP001");
  });

  it("weights hotspots by git churn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "churn-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    const body = (n: number) => `function a(x){\n${"  if (x) { x++; }\n".repeat(n)}  return x;\n}\nmodule.exports = a;\n`;
    writeFileSync(join(dir, "hot.js"), body(20));
    writeFileSync(join(dir, "cold.js"), body(20));
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "1");
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(dir, "hot.js"), `${body(20)}// ${i}\n`);
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", `c${i}`);
    }
    const r = await scan(dir, DEFAULT_CONFIG, { churn: true });
    expect(r.churnAvailable).toBe(true);
    expect(r.functions[0]!.relFile).toBe("hot.js");
    expect(r.functions[0]!.churn).toBe(5);
    expect(r.functions[0]!.hotspot).toBeGreaterThan(r.functions[1]!.hotspot);
  });
});
