import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { findFunction, parse } from "../src/core/ast.ts";
import { discoverExports } from "../src/safety/exports.ts";
import { candidates, generateCases, inferParamShapes } from "../src/safety/inputs.ts";
import { instrument } from "../src/safety/instrument.ts";
import { buildSafetyNet, loadGolden, planCases, runSafetyNet, saveGolden } from "../src/safety/safetynet.ts";
import { decode, encode } from "../src/safety/serialize.ts";
import { generateTests } from "../src/safety/testgen.ts";
import { tempProject } from "./helpers.ts";

describe("serialize", () => {
  it("round-trips edge values used as inputs", () => {
    const v = { u: undefined, n: Number.NaN, inf: -Infinity, z: -0, d: new Date("2024-01-01T00:00:00Z"), m: new Map([["a", 1]]), s: new Set([1]), big: 10n };
    const back = decode(encode(v)) as typeof v;
    expect(back.u).toBeUndefined();
    expect(back.n).toBeNaN();
    expect(back.inf).toBe(-Infinity);
    expect(Object.is(back.z, -0)).toBe(true);
    expect(back.d.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(back.m.get("a")).toBe(1);
    expect(back.s.has(1)).toBe(true);
    expect(back.big).toBe(10n);
  });

  it("encodes outputs deterministically (sorted keys, classes, errors, cycles, functions)", () => {
    class Point { constructor(public x: number, public y: number) {} }
    const cyc: Record<string, unknown> = { b: 1, a: 2 };
    cyc.self = cyc;
    expect(JSON.stringify(encode({ b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
    expect(encode(new Point(1, 2))).toEqual({ $class: "Point", props: { x: 1, y: 2 } });
    expect(encode(new TypeError("bad"))).toEqual({ $err: { name: "TypeError", message: "bad" } });
    expect(encode(cyc)).toEqual({ a: 2, b: 1, self: { $circ: 0 } });
    expect(encode(function named() {})).toEqual({ $fn: "named" });
  });
});

describe("exports discovery", () => {
  it("finds ESM and CommonJS entry points", () => {
    const sf = parse("m.ts", `
function a() {} const b = () => 1; function c() {} function d() {}
export function e() {}
export const f = function () {};
export { c, d as dee };
module.exports = { a, bee: b, g() {} };
exports.h = function () {};
`);
    expect(discoverExports(sf).map((x) => x.exportName).sort()).toEqual(["a", "bee", "c", "dee", "e", "f", "g", "h"]);
    expect(discoverExports(parse("m.js", "module.exports = function main(x) {}")).map((x) => x.exportName)).toEqual(["<module>"]);
  });
});

describe("input synthesis", () => {
  const src = `
function price(order, opts) {
  var o = opts || {};
  if (order.customer.tier === "gold") {}
  for (const line of order.lines) { if (line.qty > 10) {} total += line.qty * line.price; }
  order.lines.forEach((l) => l.sku.toUpperCase());
  if (o.express) {}
  switch (o.region) { case "EU": break; case "US": break; }
}`;
  const sf = parse("p.js", src);
  const fn = findFunction(sf, "price")!;
  const shapes = inferParamShapes(fn, sf);

  it("infers nested shapes, literals and truthiness from usage", () => {
    const order = shapes.shapes[0]!;
    expect([...order.props.keys()].sort()).toEqual(["customer", "lines"]);
    expect(order.props.get("customer")!.props.get("tier")!.literals).toContain("gold");
    const line = order.props.get("lines")!.element!;
    expect([...line.props.keys()].sort()).toEqual(["price", "qty", "sku"]);
    expect(line.props.get("qty")!.literals).toContain(10);
    expect(line.props.get("sku")!.kinds.has("string")).toBe(true);
    const opts = shapes.shapes[1]!;
    expect(opts.props.get("express")!.truthy).toBe(true);
    expect(opts.props.get("region")!.literals).toEqual(["EU", "US"]);
  });

  it("generates boundary values the code compares against", () => {
    const qty = candidates(shapes.shapes[0]!.props.get("lines")!.element!.props.get("qty")!);
    expect(qty).toEqual(expect.arrayContaining([10, 11, 9, 0]));
  });

  it("varies one parameter at a time within the case budget and dedupes", () => {
    const cases = generateCases(shapes, 12);
    expect(cases.length).toBeLessThanOrEqual(12);
    expect(cases[0]!.label).toBe("typical input");
    expect(new Set(cases.map((c) => JSON.stringify(c.args))).size).toBe(cases.length);
    expect(cases.some((c) => c.label.startsWith("opts="))).toBe(true);
  });

  it("uses TypeScript annotations and same-file interfaces", () => {
    const tsf = parse("t.ts", `interface Cfg { mode: "fast" | "slow"; retries: number }
export function go(cfg: Cfg, tags: string[]) {}`);
    const s = inferParamShapes(findFunction(tsf, "go")!, tsf);
    expect(s.shapes[0]!.props.get("mode")!.literals).toEqual(["fast", "slow"]);
    expect(s.shapes[0]!.props.get("retries")!.kinds.has("number")).toBe(true);
    expect(s.shapes[1]!.element!.kinds.has("string")).toBe(true);
  });
});

describe("instrumentation", () => {
  it("adds probes before statements inside functions without breaking the code", () => {
    const src = `"use strict";\nfunction f(a) {\n  "use strict";\n  let x = 1;\n  if (a) { x++; }\n  return x;\n}\nmodule.exports = f;`;
    const inst = instrument("f.js", src);
    expect(inst.probes.length).toBe(4); // let, if, x++, return
    expect(parse("f.js", inst.source).statements.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-new-func
    expect(inst.source).toContain('"use strict";\n  globalThis.__dsHit');
  });
});

describe("recording (child process)", () => {
  it("records outcomes, throws and statement coverage for a legacy module", async () => {
    const dir = tempProject();
    const file = join(dir, "invoice.js");
    const net = await buildSafetyNet(file, { maxCases: 24, timeoutMs: 2000, cwd: dir });
    expect(net.loadError).toBeUndefined();
    expect(net.entryPoints).toEqual(["processOrder", "formatMoney"]);
    expect(net.cases.length).toBeGreaterThan(20);
    expect(net.cases.every((c) => c.deterministic)).toBe(true);
    expect(net.cases.some((c) => "throws" in c.outcome && c.outcome.throws.message === "order is required")).toBe(true);
    const cov = net.coverage.find((c) => c.name === "processOrder")!.coverage!;
    expect(cov).toBeGreaterThan(0.75);
  }, 60_000);

  it("detects a behaviour change (the whole point of the safety net)", async () => {
    const dir = tempProject();
    const file = join(dir, "invoice.js");
    const original = readFileSync(file, "utf8");
    const { cases } = planCases(file, original, 24);
    const before = await runSafetyNet(file, original, cases, { timeoutMs: 2000, cwd: dir });
    const mutated = original.replace("price = price * 0.9;", "price = price * 0.85;");
    const after = await runSafetyNet(file, mutated, cases, { timeoutMs: 2000, cwd: dir });
    const changed = before.cases.filter((c, i) => JSON.stringify(c.outcome) !== JSON.stringify(after.cases[i]!.outcome));
    expect(changed.length).toBeGreaterThan(0);
  }, 60_000);

  it("contains process.exit, console noise, non-determinism and infinite promises", async () => {
    const dir = tempProject([]);
    const file = join(dir, "weird.js");
    writeFileSync(file, `
module.exports.quits = function (x) { console.log("noise"); if (x) process.exit(1); return 1; };
module.exports.random = function (n) { return Math.random() + n; };
module.exports.hangs = function (n) { return new Promise(() => {}); };
`);
    const net = await buildSafetyNet(file, { maxCases: 3, timeoutMs: 200, cwd: dir });
    const quits = net.cases.filter((c) => c.exportName === "quits");
    expect(quits.some((c) => "throws" in c.outcome && /process\.exit/.test(c.outcome.throws.message ?? ""))).toBe(true);
    expect(net.cases.filter((c) => c.exportName === "random").every((c) => !c.deterministic)).toBe(true);
    const hangs = net.cases.find((c) => c.exportName === "hangs")!;
    expect("throws" in hangs.outcome && hangs.outcome.throws.name).toBe("DespaghettiTimeout");
  }, 60_000);

  it("loads TypeScript sources with interfaces and classes", async () => {
    const dir = tempProject(["inventory.ts"]);
    const net = await buildSafetyNet(join(dir, "inventory.ts"), { maxCases: 12, timeoutMs: 2000, cwd: dir });
    expect(net.loadError).toBeUndefined();
    expect(net.entryPoints).toEqual(["buildReport", "receiveAll"]);
    expect(net.cases.length).toBeGreaterThan(10);
    expect(net.coverage.find((c) => c.name === "Warehouse.receive")!.coverage).toBeGreaterThan(0.5);
  }, 60_000);
});

describe("generated tests", () => {
  it("writes node:test characterization tests that pass against the original code", async () => {
    const dir = tempProject();
    const file = join(dir, "invoice.js");
    const net = await buildSafetyNet(file, { maxCases: 10, timeoutMs: 2000, cwd: dir });
    const t = generateTests(file, net.cases, { outDir: "__characterization__", version: "test" });
    expect(t.testPath.endsWith("invoice.characterization.test.js")).toBe(true);
    mkdirSync(dirname(t.testPath), { recursive: true });
    writeFileSync(t.testPath, t.testSource);
    writeFileSync(t.supportPath, t.supportSource);
    const output = execFileSync(process.execPath, ["--test", t.testPath], { encoding: "utf8" });
    expect(output).toMatch(new RegExp(`# pass ${t.included}`));
    expect(output).toMatch(/# fail 0/);

    // …and fail when the behaviour changes.
    writeFileSync(file, readFileSync(file, "utf8").replace("price = price * 0.9;", "price = price * 0.8;"));
    let failed = false;
    try {
      execFileSync(process.execPath, ["--test", t.testPath], { encoding: "utf8", stdio: "pipe" });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);

    saveGolden(dir, net);
    expect(loadGolden(dir, file)!.cases.length).toBe(net.cases.length);
  }, 60_000);

  it("targets vitest with ESM imports when the project uses vitest", () => {
    const dir = tempProject(["inventory.ts"], { name: "x", devDependencies: { vitest: "^4.0.0" } });
    const t = generateTests(join(dir, "inventory.ts"), [], { outDir: "", version: "test" });
    expect(t.testPath.endsWith("inventory.characterization.test.ts")).toBe(true);
    expect(t.testSource).toContain('import { describe, it, expect } from "vitest";');
    expect(t.testSource).toContain('import * as subject from "./inventory.ts";');
  });
});
