"use client";
import type { KeyReport } from "@/lib/types";
import { Badge, cx } from "./ui";

const MARK = { ok: "✓", warn: "!", fail: "✕" } as const;
const WORD = { ok: "OK", warn: "Warning", fail: "Failed" } as const;
const COLOR = { ok: "text-pos", warn: "text-warn", fail: "text-neg" } as const;

export function VerdictBadge({ r }: { r: KeyReport }) {
  return <Badge tone={r.verdict === "connected" ? "pos" : r.verdict === "warning" ? "warn" : "neg"}>{r.verdict === "connected" ? "Connected" : r.verdict === "warning" ? "Connected, check warnings" : "Not connected"}</Badge>;
}

/** Key test result: verdict, one-line summary, one row per check in words (never colour alone). */
export function KeyReportView({ r, showOk = true }: { r: KeyReport; showOk?: boolean }) {
  const rows = showOk ? r.checks : r.checks.filter((c) => c.state !== "ok");
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <VerdictBadge r={r} />
        <span className="text-xs text-muted tabular">{r.masked}{r.testnet ? " · testnet" : ""}</span>
      </div>
      <p className="text-sm">{r.summary}</p>
      {rows.length > 0 && (
        <ul className="divide-y divide-border text-sm">
          {rows.map((c) => (
            <li key={c.id} className="flex items-center gap-2 py-1.5">
              <span aria-hidden className={cx("w-4 shrink-0 text-center font-bold", COLOR[c.state])}>{MARK[c.state]}</span>
              <span className="min-w-0 flex-1">
                <span className="block">{c.label}</span>
                <span className="block text-xs text-muted">{c.detail}</span>
              </span>
              <span className={cx("shrink-0 text-xs font-medium", COLOR[c.state])}>{WORD[c.state]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
