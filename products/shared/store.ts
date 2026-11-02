/**
 * Encrypted, machine-bound license cache in a hidden directory under $HOME.
 *
 *   ~/.indie-cli/licenses.enc      (dir 0700, file 0600; override with INDIE_CLI_HOME)
 *
 * The file is AES-256-GCM encrypted with a key derived (scrypt) from a per-file random
 * salt plus a machine fingerprint (hostname, OS user, home dir). What this buys you:
 *   - tamper detection: editing the JSON (e.g. "tier": "enterprise") breaks the GCM
 *     auth tag, the cache is discarded, and the CLI re-verifies online;
 *   - soft machine binding: copying the file to another computer doesn't decrypt there;
 *   - keys are not readable in plain text by casual inspection or in screenshots.
 * It is NOT protection against a determined attacker with code access on the same
 * machine (the key inputs are local). No client-side licensing can be; see README.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";

import type { CachedLicense } from "./types.ts";

const FILE_VERSION = 1;
const APP_PEPPER = "indie-cli/license-cache/v1";

export interface LicenseStore {
  get(slug: string): CachedLicense | undefined;
  set(slug: string, value: CachedLicense): void;
  delete(slug: string): void;
  /** Where the data lives (for status output). */
  readonly location: string;
}

interface Envelope {
  v: number;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

type Contents = Record<string, CachedLicense>;

export function defaultStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.INDIE_CLI_HOME || join(homedir(), ".indie-cli");
}

export function machineFingerprint(): string {
  let user = "unknown";
  try {
    user = userInfo().username;
  } catch {
    /* some containers have no passwd entry */
  }
  return [APP_PEPPER, hostname(), user, homedir()].join("|");
}

export class EncryptedFileStore implements LicenseStore {
  readonly location: string;
  private readonly fingerprint: string;

  constructor(dir: string = defaultStoreDir(), fingerprint: string = machineFingerprint()) {
    this.location = join(dir, "licenses.enc");
    this.fingerprint = fingerprint;
  }

  get(slug: string): CachedLicense | undefined {
    return this.read()[slug];
  }

  set(slug: string, value: CachedLicense): void {
    const all = this.read();
    all[slug] = value;
    this.write(all);
  }

  delete(slug: string): void {
    const all = this.read();
    if (!(slug in all)) return;
    delete all[slug];
    if (Object.keys(all).length === 0) {
      rmSync(this.location, { force: true });
    } else {
      this.write(all);
    }
  }

  private key(salt: Buffer): Buffer {
    return scryptSync(this.fingerprint, salt, 32, { N: 2 ** 14, r: 8, p: 1 });
  }

  /** Any corruption, tampering or machine change yields an empty cache, never a crash. */
  private read(): Contents {
    if (!existsSync(this.location)) return {};
    try {
      const env = JSON.parse(readFileSync(this.location, "utf8")) as Envelope;
      if (env.v !== FILE_VERSION) return {};
      const decipher = createDecipheriv("aes-256-gcm", this.key(Buffer.from(env.salt, "base64")),
        Buffer.from(env.iv, "base64"));
      decipher.setAuthTag(Buffer.from(env.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(env.data, "base64")), decipher.final()]);
      const parsed = JSON.parse(plain.toString("utf8")) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Contents) : {};
    } catch {
      return {};
    }
  }

  private write(all: Contents): void {
    const dir = dirname(this.location);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(salt), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(all), "utf8"), cipher.final()]);
    const env: Envelope = {
      v: FILE_VERSION,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    // Atomic replace so a crash mid-write never corrupts an existing activation.
    const tmp = `${this.location}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
    renameSync(tmp, this.location);
    try {
      chmodSync(this.location, 0o600);
    } catch {
      /* best effort on filesystems without POSIX modes (Windows) */
    }
  }
}

/** In-memory store for tests and for embedding. */
export class MemoryStore implements LicenseStore {
  readonly location = "memory";
  readonly data = new Map<string, CachedLicense>();
  get(slug: string) {
    return this.data.get(slug);
  }
  set(slug: string, value: CachedLicense) {
    this.data.set(slug, structuredClone(value));
  }
  delete(slug: string) {
    this.data.delete(slug);
  }
}
