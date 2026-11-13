import pino, { type Logger } from "pino";

/** Values (API secrets, passphrases, tokens) that must never appear in any log line. */
const secretValues = new Set<string>();

export function registerSecret(v: string | null | undefined): void {
  if (v && v.length >= 6) secretValues.add(v);
}
export function unregisterSecret(v: string | null | undefined): void {
  if (v) secretValues.delete(v);
}

const SECRET_KEY = /^(secret|apiSecret|api_secret|password|passphrase|token|apiKey|api_key|authorization|privateKey|enc)$/i;

export function scrubString(s: string): string {
  let out = s;
  for (const v of secretValues) if (out.includes(v)) out = out.split(v).join("[REDACTED]");
  return out;
}

/** Deep-copy with secret keys masked and registered secret values scrubbed. */
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth]";
  if (typeof v === "string") return scrubString(v);
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (v instanceof Error) return { name: v.name, message: scrubString(v.message), code: (v as { code?: unknown }).code };
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>))
      o[k] = SECRET_KEY.test(k) ? "[REDACTED]" : redact(val, depth + 1);
    return o;
  }
  return v;
}

export interface LogSink {
  write(line: string): void;
}

export function createLogger(opts: { level?: string; sink?: LogSink } = {}): Logger {
  return pino(
    {
      level: opts.level ?? process.env.LOG_LEVEL ?? "info",
      base: undefined,
      formatters: {
        log: (obj) => redact(obj) as Record<string, unknown>,
      },
      hooks: {
        logMethod(args, method) {
          const scrubbed = args.map((a) => (typeof a === "string" ? scrubString(a) : a)) as Parameters<typeof method>;
          method.apply(this, scrubbed);
        },
      },
    },
    opts.sink ? { write: (s: string) => opts.sink!.write(scrubString(s)) } : undefined,
  );
}

export let log: Logger = createLogger();
export function setLogger(l: Logger): void {
  log = l;
}
