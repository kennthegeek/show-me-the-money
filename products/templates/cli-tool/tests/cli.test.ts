import { afterEach, describe, expect, it, vi } from "vitest";

import { EXIT, MemoryStore, runCli, UserError } from "@products/shared";

import { buildProgram } from "../src/cli.ts";
import { greet } from "../src/commands/hello.ts";

const argv = (...a: string[]) => ["node", "{{bin}}", ...a];

function devLicense(tier: string) {
  return { store: new MemoryStore(), env: { INDIE_CLI_DEV_LICENSE: tier } };
}

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

describe("greet", () => {
  it("greets, shouts and repeats", () => {
    expect(greet("Ada")).toEqual(["Hello, Ada!"]);
    expect(greet("Ada", { shout: true, times: 2 })).toEqual(["HELLO, ADA!", "HELLO, ADA!"]);
  });
  it("rejects empty names", () => {
    expect(() => greet("  ")).toThrow(UserError);
  });
});

describe("{{bin}} CLI", () => {
  it("runs the hello command for a hobbyist", async () => {
    const io = capture();
    expect(await runCli(buildProgram(devLicense("hobbyist")), argv("hello", "Ada", "--json"))).toBe(EXIT.OK);
    expect(JSON.parse(io.out())).toEqual({ lines: ["Hello, Ada!"], tier: "hobbyist" });
  });

  it("gates --shout behind Pro", async () => {
    const io = capture();
    expect(await runCli(buildProgram(devLicense("hobbyist")), argv("hello", "Ada", "--shout"))).toBe(EXIT.TIER);
    expect(io.err()).toContain("requires the Pro tier");
    expect(await runCli(buildProgram(devLicense("pro")), argv("hello", "Ada", "--shout"))).toBe(EXIT.OK);
    expect(io.out()).toContain("HELLO, ADA!");
  });

  it("validates --times", async () => {
    const io = capture();
    expect(await runCli(buildProgram(devLicense("enterprise")), argv("hello", "Ada", "-n", "zero"))).toBe(EXIT.ERROR);
    expect(io.err()).toContain("--times must be");
  });

  it("asks for a license when none is present", async () => {
    capture();
    const code = await runCli(buildProgram({ store: new MemoryStore(), env: {} }), argv("hello", "Ada"));
    expect(code).toBe(EXIT.LICENSE);
  });
});
