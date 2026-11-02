import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProgram, EXIT, runCli, UserError } from "../cli.ts";
import { ensureLicense, type OnboardingIO } from "../onboarding.ts";
import { LicenseManager } from "../auth.ts";
import { MemoryStore } from "../store.ts";
import { CONFIG, Clock, deps, KEY, notFound, ok, scriptedFetch } from "./helpers.ts";

function captureIO(interactive: boolean, answers: string[] = []): OnboardingIO & { text(): string } {
  const input = new PassThrough();
  const output = new PassThrough() as PassThrough & { isTTY?: boolean };
  let text = "";
  output.on("data", (c) => {
    text += String(c);
    // Answer each prompt as it appears.
    if (String(c).includes("License key:")) {
      const next = answers.shift();
      if (next !== undefined) setImmediate(() => input.write(`${next}\n`));
    }
  });
  return { input, output, interactive, text: () => text };
}

function captureStd() {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c) => ((out += String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c) => ((err += String(c)), true));
  return { out: () => out, err: () => err };
}

afterEach(() => {
  process.exitCode = 0;
});

describe("ensureLicense onboarding", () => {
  it("prints instructions and fails fast when not interactive", async () => {
    const io = captureIO(false);
    const lm = new LicenseManager(CONFIG, deps(scriptedFetch(ok()).fetch));
    await expect(ensureLicense(lm, io)).rejects.toMatchObject({ code: "missing" });
    expect(io.text()).toContain("TEST_TOOL_LICENSE_KEY=<your-key>");
    expect(io.text()).toContain(CONFIG.purchaseUrl);
  });

  it("walks an interactive user through activation, retrying a typo", async () => {
    const io = captureIO(true, ["typo", KEY]);
    const { fetch, calls } = scriptedFetch(notFound, ok({ variants: "(Enterprise)" }));
    const lm = new LicenseManager(CONFIG, deps(fetch));
    const lic = await ensureLicense(lm, io);
    expect(lic.tier).toBe("enterprise");
    expect(calls.map((c) => c.params.get("license_key"))).toEqual(["typo", KEY]);
    expect(io.text()).toContain("Welcome to TestTool");
    expect(io.text()).toContain("Let's try that again");
  });

  it("returns immediately when a license is cached", async () => {
    const store = new MemoryStore();
    const { fetch } = scriptedFetch(ok());
    await new LicenseManager(CONFIG, deps(fetch, new Clock(), store)).activate(KEY);
    const io = captureIO(true);
    const lic = await ensureLicense(new LicenseManager(CONFIG, deps(fetch, new Clock(), store)), io);
    expect(lic.source).toBe("cache");
    expect(io.text()).toBe("");
  });
});

describe("createProgram / runCli", () => {
  function build(fetchReplies: Parameters<typeof scriptedFetch>, store = new MemoryStore()) {
    const { fetch, calls } = scriptedFetch(...fetchReplies);
    const io = captureIO(false);
    const { program, license } = createProgram({
      name: "test-tool",
      version: "1.2.3",
      description: "demo",
      licensing: CONFIG,
      deps: deps(fetch, new Clock(), store),
      io,
      freeCommands: ["about"],
    });
    const ran: string[] = [];
    program.command("about").action(() => void ran.push("about"));
    program.command("work").action(async () => {
      const lic = await license.current();
      ran.push(`work:${lic.tier}`);
    });
    program.command("batch").action(async () => {
      license.requireTier(await license.current(), "enterprise", "Batch mode");
      ran.push("batch");
    });
    program.command("boom").action(() => {
      throw new UserError("File not found: x.txt", "Check the path", EXIT.USAGE);
    });
    return { program, ran, calls, store, io };
  }

  const argv = (...a: string[]) => ["node", "test-tool", ...a];

  it("gates commands behind the license and exits with code 3 when missing", async () => {
    const std = captureStd();
    const { program, ran, io } = build([ok()]);
    expect(await runCli(program, argv("work"))).toBe(EXIT.LICENSE);
    expect(ran).toEqual([]);
    // Onboarding explains it once (with the real command name); runCli doesn't repeat it.
    expect(io.text()).toContain("No TestTool license found");
    expect(io.text()).toContain("test-tool license activate <your-key>");
    expect(std.err()).toBe("");
  });

  it("lets free commands run without a license", async () => {
    captureStd();
    const { program, ran } = build([ok()]);
    expect(await runCli(program, argv("about"))).toBe(EXIT.OK);
    expect(ran).toEqual(["about"]);
  });

  it("activates, then runs gated commands and enforces tiers", async () => {
    const std = captureStd();
    const store = new MemoryStore();
    const first = build([ok({ variants: "(Pro)" })], store);
    expect(await runCli(first.program, argv("license", "activate", KEY))).toBe(EXIT.OK);
    expect(std.out()).toContain("TestTool activated");

    const second = build([ok()], store);
    expect(await runCli(second.program, argv("work"))).toBe(EXIT.OK);
    expect(second.ran).toEqual(["work:pro"]);
    expect(second.calls).toHaveLength(0); // served from cache

    const third = build([ok()], store);
    expect(await runCli(third.program, argv("batch"))).toBe(EXIT.TIER);
    expect(std.err()).toContain('"Batch mode" requires the Enterprise tier');
  });

  it("shows status as JSON without leaking the full key", async () => {
    const std = captureStd();
    const store = new MemoryStore();
    await runCli(build([ok()], store).program, argv("license", "activate", KEY));
    await runCli(build([ok()], store).program, argv("license", "status", "--json"));
    const json = JSON.parse(std.out().slice(std.out().indexOf("{\n")));
    expect(json).toMatchObject({ tier: "pro", source: "cache", licenseKey: "AAAA…" });
    expect(std.out()).not.toContain(KEY);
  });

  it("deactivates", async () => {
    const std = captureStd();
    const store = new MemoryStore();
    await runCli(build([ok()], store).program, argv("license", "activate", KEY));
    await runCli(build([ok()], store).program, argv("license", "deactivate"));
    expect(std.out()).toContain("License removed");
    expect(store.get("test-tool")).toBeUndefined();
  });

  it("maps user errors and usage errors to exit codes", async () => {
    const std = captureStd();
    expect(await runCli(build([ok()]).program, argv("about", "--nope"))).toBe(EXIT.USAGE);
    const store = new MemoryStore();
    await runCli(build([ok()], store).program, argv("license", "activate", KEY));
    expect(await runCli(build([ok()], store).program, argv("boom"))).toBe(EXIT.USAGE);
    expect(std.err()).toContain("File not found: x.txt");
  });

  it("prints the version", async () => {
    const std = captureStd();
    expect(await runCli(build([ok()]).program, argv("--version"))).toBe(EXIT.OK);
    expect(std.out()).toContain("1.2.3");
  });
});
