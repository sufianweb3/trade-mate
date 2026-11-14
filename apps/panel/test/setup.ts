import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

/** Node 26's own (file-backed) localStorage global shadows jsdom's and is undefined without a file: use memory. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}
for (const name of ["localStorage", "sessionStorage"] as const) {
  let ok = false;
  try { ok = typeof globalThis[name]?.getItem === "function"; } catch { ok = false; }
  if (!ok) Object.defineProperty(globalThis, name, { value: memoryStorage(), configurable: true });
}

// findBy* waits up to 5s: in the full suite the agent tests load the machine and renders can take seconds.
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => cleanup());
