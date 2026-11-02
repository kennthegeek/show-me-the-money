import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { categories, discoverProducts, formatBytes, parseFlags } from "../lib.ts";

describe("parseFlags", () => {
  it("handles positionals, values, booleans and negation", () => {
    expect(parseFlags(["dev-tools", "x", "--only", "a,b", "--pack", "--no-minify", "--out=build"])).toEqual({
      positional: ["dev-tools", "x"],
      flags: { only: "a,b", pack: true, minify: false, out: "build" },
    });
  });
});

describe("discoverProducts", () => {
  it("finds products with a `product` manifest in category workspaces", () => {
    const root = mkdtempSync(join(tmpdir(), "mono-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["shared", "dev-tools/*", "lifestyle/*"] }));
    const add = (rel: string, pkg: object) => {
      mkdirSync(join(root, rel), { recursive: true });
      writeFileSync(join(root, rel, "package.json"), JSON.stringify(pkg));
    };
    add("dev-tools/b-tool", { name: "b-tool", version: "1.0.0", product: { entry: "src/main.ts", bin: "b" } });
    add("dev-tools/a-tool", { name: "a-tool", version: "2.0.0", product: { entry: "src/main.ts", bin: "a" } });
    add("dev-tools/lib-only", { name: "lib-only" });
    expect(categories(root)).toEqual(["dev-tools", "lifestyle"]);
    const found = discoverProducts(root);
    expect(found.map((p) => [p.name, p.version, p.manifest.category])).toEqual([
      ["a-tool", "2.0.0", "dev-tools"],
      ["b-tool", "1.0.0", "dev-tools"],
    ]);
  });
});

it("formats sizes", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(2048)).toBe("2.0 KB");
  expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
});
