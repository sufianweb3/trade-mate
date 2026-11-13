import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { z } from "zod";
import { registerSecret } from "../log";

export const KeySecretSchema = z.object({
  apiKey: z.string().min(8).max(200),
  secret: z.string().min(8).max(400),
  passphrase: z.string().max(200).optional(),
});
export type KeySecret = z.infer<typeof KeySecretSchema>;

export interface DataKeyProvider {
  readonly kind: string;
  get(): Promise<Buffer | null>;
}

/** Data key in the OS keychain (@napi-rs/keyring). Created on first use. */
export class KeychainProvider implements DataKeyProvider {
  readonly kind = "os-keychain";
  async get(): Promise<Buffer | null> {
    try {
      const mod = (await import("@napi-rs/keyring")) as unknown as {
        Entry: new (service: string, user: string) => { getPassword(): string | null; setPassword(p: string): void };
      };
      const e = new mod.Entry("oisniper", "data-key");
      let v = e.getPassword();
      if (!v) {
        v = randomBytes(32).toString("base64");
        e.setPassword(v);
      }
      return Buffer.from(v, "base64");
    } catch (e) {
      const m = String((e as Error).message);
      this.error = /native binding|module could not be found/i.test(m)
        ? "OS keychain module could not load. On Windows install the Microsoft Visual C++ 2015-2022 Redistributable (x64), or set OISNIPER_PASSPHRASE."
        : `OS keychain unavailable: ${m.slice(0, 120)}`;
      return null;
    }
  }
  error: string | null = null;
}

/** Fallback: user passphrase via scrypt, salt kept in settings. */
export class PassphraseProvider implements DataKeyProvider {
  readonly kind = "passphrase";
  constructor(private passphrase: string | undefined, private salt: Buffer) {}
  async get(): Promise<Buffer | null> {
    if (!this.passphrase) return null;
    return scryptSync(this.passphrase, this.salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  }
}

/** AES-256-GCM. Secrets are decrypted only in memory, only to talk to the exchange. */
export class Vault {
  private key: Buffer | null = null;
  kind = "locked";

  constructor(private providers: DataKeyProvider[]) {}

  /** Why the vault is locked, shown on Health / Exchanges. */
  lockReason: string | null = null;

  async unlock(): Promise<boolean> {
    for (const p of this.providers) {
      const k = await p.get();
      if (k && k.length === 32) {
        this.key = k;
        this.kind = p.kind;
        this.lockReason = null;
        return true;
      }
    }
    this.lockReason = this.providers.map((p) => (p as { error?: string | null }).error).find(Boolean) ?? "No OS keychain and no OISNIPER_PASSPHRASE set.";
    return false;
  }

  get unlocked(): boolean {
    return this.key != null;
  }

  encrypt(s: KeySecret): string {
    if (!this.key) throw Object.assign(new Error("vault locked"), { code: "AUTH_FAILED" });
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(s), "utf8"), c.final()]);
    return `v1.${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${ct.toString("base64")}`;
  }

  decrypt(blob: string): KeySecret {
    if (!this.key) throw Object.assign(new Error("vault locked"), { code: "AUTH_FAILED" });
    const [v, iv, tag, ct] = blob.split(".");
    if (v !== "v1" || !iv || !tag || !ct) throw new Error("bad vault blob");
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    const plain = Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
    const s = KeySecretSchema.parse(JSON.parse(plain));
    registerSecret(s.secret);
    registerSecret(s.apiKey);
    registerSecret(s.passphrase);
    return s;
  }
}

/** abcd••••wxyz. The only form of a key that ever leaves the agent. */
export function maskKey(k: string): string {
  return k.length <= 8 ? "••••" : `${k.slice(0, 4)}••••${k.slice(-4)}`;
}
