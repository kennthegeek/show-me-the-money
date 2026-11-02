import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EncryptedFileStore } from "../store.ts";
import type { CachedLicense } from "../types.ts";

const LICENSE: CachedLicense = {
  licenseKey: "SECRET-KEY-1234-5678",
  productId: "prod_1",
  tier: "pro",
  variant: "Pro",
  email: "a@b.c",
  purchaseId: "pur",
  uses: 1,
  activatedAt: "2026-01-01T00:00:00.000Z",
  lastVerifiedAt: "2026-01-01T00:00:00.000Z",
};

const tmp = () => mkdtempSync(join(tmpdir(), "indie-store-"));

describe("EncryptedFileStore", () => {
  it("round-trips entries per product", () => {
    const dir = tmp();
    const store = new EncryptedFileStore(dir, "machine-a");
    store.set("tool-a", LICENSE);
    store.set("tool-b", { ...LICENSE, tier: "enterprise" });
    const reopened = new EncryptedFileStore(dir, "machine-a");
    expect(reopened.get("tool-a")).toEqual(LICENSE);
    expect(reopened.get("tool-b")?.tier).toBe("enterprise");
    reopened.delete("tool-a");
    expect(new EncryptedFileStore(dir, "machine-a").get("tool-a")).toBeUndefined();
  });

  it("does not store the key or tier in plain text", () => {
    const dir = tmp();
    const store = new EncryptedFileStore(dir, "machine-a");
    store.set("tool", LICENSE);
    const raw = readFileSync(store.location, "utf8");
    expect(raw).not.toContain("SECRET-KEY");
    expect(raw).not.toContain("pro");
  });

  it("uses private file permissions", () => {
    if (process.platform === "win32") return;
    const dir = tmp();
    const store = new EncryptedFileStore(join(dir, "nested"), "m");
    store.set("tool", LICENSE);
    expect(statSync(store.location).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
  });

  it("discards tampered data instead of trusting it", () => {
    const dir = tmp();
    const store = new EncryptedFileStore(dir, "m");
    store.set("tool", LICENSE);
    const env = JSON.parse(readFileSync(store.location, "utf8"));
    const data = Buffer.from(env.data, "base64");
    data[0] = data[0]! ^ 0xff;
    env.data = data.toString("base64");
    writeFileSync(store.location, JSON.stringify(env));
    expect(store.get("tool")).toBeUndefined();
  });

  it("can't be decrypted on a different machine", () => {
    const dir = tmp();
    new EncryptedFileStore(dir, "machine-a").set("tool", LICENSE);
    expect(new EncryptedFileStore(dir, "machine-b").get("tool")).toBeUndefined();
  });

  it("survives garbage files", () => {
    const dir = tmp();
    const store = new EncryptedFileStore(dir, "m");
    writeFileSync(store.location, "not json");
    expect(store.get("tool")).toBeUndefined();
    store.set("tool", LICENSE);
    expect(store.get("tool")).toEqual(LICENSE);
  });
});
