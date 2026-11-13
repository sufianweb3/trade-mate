"use client";
import { useState } from "react";
import { api } from "@/lib/agent";
import { Button } from "./ui";

/**
 * Downloads the AI Analysis Pack (zip) built by the local agent: trades, every signal with all variants' gate
 * values (signals.csv + signals.jsonl), config versions, KPIs and the data dictionary. Nothing leaves the device.
 */
export function ExportButton({ bot, run, label = "Download data" }: { bot: string; run?: string | null; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      const blob = await api<Blob>("/api/export", { method: "POST", json: { ...(bot !== "all" && { botId: bot }), ...(run && { runId: run }) } });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `oisniper-export-${bot}${run ? `-${run}` : ""}-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex items-center gap-2">
      {err && <span className="text-xs text-neg">Export failed: {err}</span>}
      <Button variant="primary" onClick={go} disabled={busy} title="Zip with trades, all signals incl. every gate value per variant, configs and KPIs">
        {busy ? "Building…" : label}
      </Button>
    </span>
  );
}
