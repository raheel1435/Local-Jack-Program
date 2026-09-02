import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { CredentialProviderId, CredentialStatusReport } from "../types/jack.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTECT_SCRIPT = join(__dirname, "..", "..", "scripts", "dpapi-protect.ps1");
const UNPROTECT_SCRIPT = join(__dirname, "..", "..", "scripts", "dpapi-unprotect.ps1");

function defaultBaseDir(): string {
  const appData = process.env.APPDATA;
  const root = appData && appData.trim() ? appData : join(homedir(), "AppData", "Roaming");
  return join(root, "jack-local-ai", "credentials");
}

function runPowerShell(scriptPath: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...args,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${scriptPath} exited with code ${code}: ${stderr.trim()}`));
    });
    if (stdin !== undefined) {
      // The plaintext key is written to stdin and nowhere else -- never as
      // a spawn() argument (which would appear in a process listing) and
      // never through an intermediate temp file.
      child.stdin.write(stdin, "utf8");
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/** DPAPI encrypt/decrypt, factored out so tests can inject a fake
 * implementation and never actually spawn PowerShell. */
export interface DpapiCipher {
  protect(plaintext: string, outFile: string): Promise<void>;
  unprotect(inFile: string): Promise<string>;
}

const realDpapiCipher: DpapiCipher = {
  async protect(plaintext, outFile) {
    await runPowerShell(PROTECT_SCRIPT, ["-OutFile", outFile], plaintext);
  },
  async unprotect(inFile) {
    return runPowerShell(UNPROTECT_SCRIPT, ["-InFile", inFile]);
  },
};

export type VerifyKeyFn = (key: string) => Promise<{ ok: true } | { ok: false; detail: string }>;

interface CredentialMeta {
  status: "connected" | "invalid";
  lastFour: string;
  updatedAt: string;
  detail?: string;
}

/**
 * BYOK API-key storage for the multi-provider AI milestone. Encrypts each
 * provider's key at rest via Windows DPAPI (CurrentUser scope), stored
 * outside the git working tree entirely (%APPDATA%\jack-local-ai\credentials\)
 * -- defense in depth beyond `.env`'s .gitignore-reliance, and DPAPI's
 * CurrentUser scope naturally matches storing the blob in the user's own
 * profile. Two files per provider: `{provider}.dat` (ciphertext, opaque)
 * and `{provider}.meta.json` (non-secret status/lastFour/updatedAt) --
 * status() reads only the meta file and never decrypts, so it's always
 * safe to expose over HTTP.
 *
 * getDecrypted() is the one method that returns the raw key -- it is for
 * internal use only (a provider's own chat()/checkHealth(), and this
 * store's own set()/testConnection()) and must never be serialized into an
 * HTTP response.
 */
export class CredentialStore {
  private readonly baseDir: string;
  private readonly cipher: DpapiCipher;
  private readonly verifiers: Partial<Record<CredentialProviderId, VerifyKeyFn>>;

  constructor(opts?: {
    baseDir?: string;
    cipher?: DpapiCipher;
    verifiers?: Partial<Record<CredentialProviderId, VerifyKeyFn>>;
  }) {
    if (process.platform !== "win32") {
      throw new Error(
        "CredentialStore requires Windows (DPAPI-backed encryption) -- no cross-platform storage is implemented yet.",
      );
    }
    this.baseDir = opts?.baseDir ?? defaultBaseDir();
    this.cipher = opts?.cipher ?? realDpapiCipher;
    this.verifiers = opts?.verifiers ?? {};
  }

  private datPath(provider: CredentialProviderId): string {
    return join(this.baseDir, `${provider}.dat`);
  }

  private metaPath(provider: CredentialProviderId): string {
    return join(this.baseDir, `${provider}.meta.json`);
  }

  private async readMeta(provider: CredentialProviderId): Promise<CredentialMeta | null> {
    try {
      const raw = await readFile(this.metaPath(provider), "utf8");
      return JSON.parse(raw) as CredentialMeta;
    } catch {
      return null;
    }
  }

  private async writeMeta(provider: CredentialProviderId, meta: CredentialMeta): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.metaPath(provider), JSON.stringify(meta, null, 2), "utf8");
  }

  /** Persists the key, then immediately performs one live verification call
   * so status() is accurate right after saving, not merely "assumed good". */
  async set(provider: CredentialProviderId, plaintextKey: string): Promise<CredentialStatusReport> {
    await mkdir(this.baseDir, { recursive: true });
    await this.cipher.protect(plaintextKey, this.datPath(provider));

    const verify = this.verifiers[provider];
    const result = verify ? await verify(plaintextKey) : ({ ok: true } as const);
    const meta: CredentialMeta = {
      status: result.ok ? "connected" : "invalid",
      lastFour: plaintextKey.slice(-4),
      updatedAt: new Date().toISOString(),
      ...(result.ok ? {} : { detail: result.detail }),
    };
    await this.writeMeta(provider, meta);
    return { provider, ...meta };
  }

  /** INTERNAL USE ONLY -- the caller must never serialize this into an HTTP
   * response. Returns null (never throws, never falls back to
   * process.env.OPENAI_API_KEY/ANTHROPIC_API_KEY) whenever no key is
   * stored, or the stored ciphertext can't be decrypted (e.g. it was
   * encrypted under a different Windows account -- DPAPI CurrentUser blobs
   * are not portable, and that is not a reason to fall back to a
   * deploy-time env var with different trust/rotation semantics). */
  async getDecrypted(provider: CredentialProviderId): Promise<string | null> {
    // Deliberately no existsSync() pre-check here -- that would leak
    // filesystem knowledge out of the DpapiCipher abstraction (a test
    // double is free to keep ciphertext anywhere, e.g. in memory, without
    // touching disk). The cipher itself is the sole authority on whether a
    // key exists/is readable; any failure (missing file, wrong Windows
    // account, corrupted blob) is caught here and folded into "null",
    // never re-thrown and never silently substituted with an env var.
    try {
      return await this.cipher.unprotect(this.datPath(provider));
    } catch {
      return null;
    }
  }

  async remove(provider: CredentialProviderId): Promise<void> {
    await rm(this.datPath(provider), { force: true });
    await rm(this.metaPath(provider), { force: true });
  }

  /** Safe for HTTP responses -- reads only the non-secret meta.json, never
   * decrypts the key. */
  async status(provider: CredentialProviderId): Promise<CredentialStatusReport> {
    const meta = await this.readMeta(provider);
    if (!meta) return { provider, status: "not_configured" };
    return { provider, ...meta };
  }

  /** Re-runs the live verification check against the already-stored key
   * (the caller doesn't need to re-enter it) and updates meta.json. */
  async testConnection(provider: CredentialProviderId): Promise<CredentialStatusReport> {
    const key = await this.getDecrypted(provider);
    if (key === null) return { provider, status: "not_configured" };

    const verify = this.verifiers[provider];
    const result = verify ? await verify(key) : ({ ok: true } as const);
    const existing = await this.readMeta(provider);
    const meta: CredentialMeta = {
      status: result.ok ? "connected" : "invalid",
      lastFour: existing?.lastFour ?? key.slice(-4),
      updatedAt: existing?.updatedAt ?? new Date().toISOString(),
      ...(result.ok ? {} : { detail: result.detail }),
    };
    await this.writeMeta(provider, meta);
    return { provider, ...meta };
  }
}