/**
 * Reading the agent's console output. The agent prints its pairing link once at startup:
 *   "  Pair this browser: http://localhost:7777/#pair=<token>"
 * The token is the agent's bearer secret: it is used to open the panel and is never written to a log.
 */

const PAIR_LINE = /Pair this browser:\s*(\S+)/;

/** Returns the pairing URL if the line holds one that points at this machine's agent on `port`. */
export function parsePairUrl(line: string, port: number): string | null {
  const m = PAIR_LINE.exec(line);
  if (!m) return null;
  let u: URL;
  try {
    u = new URL(m[1]!);
  } catch {
    return null;
  }
  if (u.protocol !== "http:") return null;
  if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return null;
  if (Number(u.port || 80) !== port) return null;
  if (!u.hash.startsWith("#pair=") || u.hash.length <= "#pair=".length) return null;
  return u.toString();
}

/** Token value from a pairing URL (for read-only status calls made by the desktop app itself). */
export function tokenFromPairUrl(url: string): string | null {
  const hash = new URL(url).hash;
  if (!hash.startsWith("#pair=")) return null;
  const t = decodeURIComponent(hash.slice("#pair=".length));
  return t.length > 0 ? t : null;
}

/** Strips pairing tokens, pairing phrases and bearer headers from a line before it goes to a log file. */
export function redactLine(line: string): string {
  return line
    .replace(/#pair=[^\s"']+/g, "#pair=[redacted]")
    .replace(/(Pairing phrase:\s*)\S+/g, "$1[redacted]")
    .replace(/(pairToken["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, "$1[redacted]");
}
