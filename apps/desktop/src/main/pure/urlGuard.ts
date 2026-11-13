/** Navigation rules for the panel view: it may only show the local agent; https links open in the system browser. */

export function isAgentUrl(raw: string, port: number): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1") && Number(u.port || 80) === port;
  } catch {
    return false;
  }
}

export function isSafeExternalUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}
