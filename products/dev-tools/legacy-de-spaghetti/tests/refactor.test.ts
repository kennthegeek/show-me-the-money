import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findFunction, parse, syntaxErrors } from "../src/core/ast.ts";
import { findCandidates } from "../src/refactor/candidates.ts";
import { analyzeSegment } from "../src/refactor/dataflow.ts";
import { refactorFile } from "../src/refactor/engine.ts";
import { heuristicName } from "../src/refactor/naming.ts";
import { applyExtraction } from "../src/refactor/transform.ts";
import { runSafetyNet, planCases } from "../src/safety/safetynet.ts";
import { config, tempProject } from "./helpers.ts";

/** Analyze statements [from, to) of the named function's body. */
function seg(src: string, fnName: string, from: number, to: number, file = "x.js") {
  const sf = parse(file, src);
  const fn = findFunction(sf, fnName)!;
  const body = (fn.body as import("typescript").Block).statements;
  return { sf, fn, a: analyzeSegment(fn, body.slice(from, to), false) };
}

describe("data-flow analysis", () => {
  it("computes params and returns", () => {
    const { a } = seg(`function f(x, y) {
  let total = 0;
  const k = x * 2;
  total += k + y;
  let extra = total * 2;
  return total + extra;
}`, "f", 1, 4);
    expect(a.ok).toBe(true);
    expect(a.params).toEqual(["x", "total", "y"]);
    expect(a.returnsDeclared).toEqual([{ name: "extra", kind: "let" }]);
    expect(a.returnsAssigned).toEqual(["total"]);
  });

  it.each([
    [`function f(a) { if (a) return 1; a++; return a; }`, 0, 2, "contains `return`"],
    [`function f(a) { for (;;) { if (a) break; a++; } }`, 0, 1, undefined],
    [`function f(a) { for (;;) { if (a) break; a++; } }`, -1, -1, undefined],
    [`function f() { var x = arguments[0]; x++; return x; }`, 0, 2, "uses `arguments`"],
    [`function f() { this.a = 1; this.b = 2; return 1; }`, 0, 2, "uses `this` outside a class method"],
    [`function f(a) { use(x); a++; var x = 1; return x; }`, 2, 3, "used before it is declared"],
    [`function f(a) { a++; a--; var g = () => a; return g; }`, 0, 2, "captured by a closure"],
    [`function f(a) { { let t = 1; } { let t = 2; a = t; } return a; }`, 1, 2, undefined], // inner `t` is local to the segment
    [`function f(a) { let t = 1; { let t = 2; a = t; } t += a; t++; return t; }`, 2, 4, "declared more than once"],
  ])("%s", (src, from, to, reason) => {
    if (from < 0) {
      // break inside a loop that is itself inside the segment: inner block of the for statement
      const sf = parse("x.js", src);
      const fn = findFunction(sf, "f")!;
      const loop = (fn.body as import("typescript").Block).statements[0] as import("typescript").ForStatement;
      const inner = (loop.statement as import("typescript").Block).statements;
      const a = analyzeSegment(fn, inner, false);
      expect(a.ok).toBe(false);
      expect(a.reason).toMatch(/break/);
      return;
    }
    const { a } = seg(src, "f", from, to);
    if (reason) {
      expect(a.ok).toBe(false);
      expect(a.reason).toContain(reason);
    } else {
      expect(a.ok).toBe(true);
    }
  });

  it("allows `this` inside class methods and extracts a method", () => {
    const src = `class A {
  run(n) {
    let s = 0;
    this.log = [];
    this.log.push("start");
    this.log.push("n=" + n);
    s = n * 2;
    this.log.push("end");
    return s;
  }
}
module.exports = A;`;
    const sf = parse("a.js", src);
    const fn = findFunction(sf, "A.run")!;
    const { candidates } = findCandidates(fn, sf, { minSegmentLines: 3, maxExtractedParams: 6, maxExtractedReturns: 4 });
    expect(candidates.length).toBeGreaterThan(0);
    const c = candidates[0]!;
    expect(c.analysis.usesThis).toBe(true);
    const out = applyExtraction(sf, fn, c, { name: "logRun", consumeHeading: false });
    expect(syntaxErrors(parse("a.js", out))).toEqual([]);
    expect(out).toContain("this.logRun(");
    expect(out).toMatch(/\n {2}logRun\(/);
  });
});

describe("naming", () => {
  it("derives names from section comments and returned values", () => {
    const src = `function f(o) {
  // ---- 2. Validate the incoming order ----
  if (!o) throw new Error("x");
  let ok = true;
  ok = !!o.id;
  return ok;
}`;
    const sf = parse("x.js", src);
    const fn = findFunction(sf, "f")!;
    const { candidates } = findCandidates(fn, sf, { minSegmentLines: 2, maxExtractedParams: 6, maxExtractedReturns: 4 });
    const named = candidates.map((c) => heuristicName(c, "f", new Set()));
    expect(named).toContain("validateIncomingOrder");
  });
});

describe("refactor engine (end to end, behaviour-verified)", () => {
  it("splits the legacy invoice function and preserves behaviour", async () => {
    const dir = tempProject();
    const file = join(dir, "invoice.js");
    const r = await refactorFile(file, { config: config(), cwd: dir });
    expect(r.functionName).toBe("processOrder");
    expect(r.verification.mode).toBe("behavioral");
    expect(r.steps.map((s) => s.name)).toEqual(["validateOrder", "sumLineItems", "applyCustomerDiscounts", "computeShipping", "computeTax"]);
    expect(r.after.lines).toBeLessThan(r.before.lines / 2);
    expect(r.after.complexity).toBeLessThan(10);
    expect(syntaxErrors(parse(file, r.output))).toEqual([]);
    // Helpers come after the main function (stepdown order).
    expect(r.output.indexOf("function processOrder")).toBeLessThan(r.output.indexOf("function validateOrder"));
    // The source file is untouched by the engine itself.
    expect(readFileSync(file, "utf8")).toBe(r.original);

    // Independent re-check: replay the safety net against the output.
    const { cases } = planCases(file, r.original, 24);
    const a = await runSafetyNet(file, r.original, cases, { timeoutMs: 2000, cwd: dir });
    const b = await runSafetyNet(file, r.output, cases, { timeoutMs: 2000, cwd: dir });
    expect(b.cases.map((c) => JSON.stringify(c.outcome))).toEqual(a.cases.map((c) => JSON.stringify(c.outcome)));
  }, 120_000);

  it("refactors TypeScript with real parameter types and class methods", async () => {
    const dir = tempProject(["inventory.ts"]);
    const file = join(dir, "inventory.ts");
    const report = await refactorFile(file, { config: config({ minSegmentLines: 4 }), cwd: dir, functionName: "buildReport" });
    expect(report.steps.length).toBeGreaterThanOrEqual(2);
    expect(report.output).toMatch(/function collectLowStock\(items: Item\[\], threshold: number, lowStock: string\[\], flags: string\[\]\)/);
    expect(report.output).toMatch(/function computeInventoryValue\(items: Item\[\], value: number\)/);

    const method = await refactorFile(file, { config: config({ minSegmentLines: 4 }), cwd: dir, functionName: "Warehouse.receive" });
    expect(method.steps.length).toBeGreaterThanOrEqual(1);
    expect(method.output).toContain("private putItemsAway(items: Item[], accepted: number)");
    expect(method.output).toContain("accepted = this.putItemsAway(items, accepted);");
  }, 120_000);

  it("refuses to refactor without a way to verify behaviour", async () => {
    const dir = tempProject([]);
    const { writeFileSync } = await import("node:fs");
    const file = join(dir, "script.js");
    writeFileSync(file, `function main() {\n${"  var a = 1;\n  a++;\n".repeat(40)}}\nmain();\n`);
    await expect(refactorFile(file, { config: config(), cwd: dir })).rejects.toThrow(/no exported functions/);
  }, 60_000);
});
