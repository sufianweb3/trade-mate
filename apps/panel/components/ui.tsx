"use client";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { tone } from "@/lib/format";

/** shadcn-style primitives, Tailwind tokens only. */
export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function Button({ variant = "default", size = "md", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "danger" | "ghost"; size?: "sm" | "md" }) {
  return (
    <button
      {...p}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-xl font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
        size === "sm" ? "h-8 px-3 text-xs" : "h-9 px-4 text-sm",
        variant === "primary" && "bg-accent text-white hover:bg-accent/90",
        variant === "danger" && "bg-neg text-white hover:bg-neg/90",
        variant === "ghost" && "text-fg hover:bg-line/50",
        variant === "default" && "bg-elevated border border-line text-fg hover:bg-line/40",
        className,
      )}
    />
  );
}

export function Card({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-2xl bg-surface border border-line/70 shadow-soft p-5", className)}>
      {(title || action) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Badge({ children, tone: t = "neutral" }: { children: ReactNode; tone?: "neutral" | "pos" | "neg" | "warn" | "live" | "paper" | "accent" }) {
  const m = { neutral: "bg-line/60 text-muted", pos: "bg-pos/15 text-pos", neg: "bg-neg/15 text-neg", warn: "bg-warn/15 text-warn", live: "bg-live text-white", paper: "bg-paper/15 text-paper", accent: "bg-accent/15 text-accent" };
  return <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide", m[t])}>{children}</span>;
}

export const ModeBadge = ({ mode }: { mode: string }) => <Badge tone={mode === "live" ? "live" : "paper"}>{mode}</Badge>;

export function StatusBadge({ s }: { s: string }) {
  const t = s === "running" || s === "opened" || s === "OK" || s === "ok" || s === "connected" ? "pos" : s === "paused" || s === "cooldown" || s === "DEGRADED" || s === "unverified" ? "warn" : s === "halted" || s === "rejected" || s === "CHALLENGE" || s === "down" || s === "error" ? "neg" : "neutral";
  return <Badge tone={t}>{s}</Badge>;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cx("relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-40", checked ? "bg-pos" : "bg-line")}>
      <span className={cx("absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-xl bg-line/50 p-0.5" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={cx("rounded-[10px] px-3 py-1 text-sm font-medium", value === o.value ? "bg-accent text-white shadow-sm" : "text-muted hover:text-fg")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx("h-9 w-full rounded-xl border border-line bg-elevated px-3 text-sm outline-none focus:border-accent tabular", p.className)} />;
}

/** Numeric field with steppers. Value stays a number in the form; config strings are built at save. */
export function Stepper({ value, onChange, step = 1, min, max, suffix, disabled }: { value: number | null; onChange: (v: number | null) => void; step?: number; min?: number; max?: number; suffix?: string; disabled?: boolean }) {
  // Never clamp silently: the validator rejects out-of-range values with a reason.
  const clamp = (v: number) => v;
  return (
    <div className="flex h-9 items-center rounded-xl border border-line bg-elevated">
      <button type="button" disabled={disabled} className="h-full px-2.5 text-muted hover:text-fg" onClick={() => onChange(clamp(+(((value ?? 0) - step).toFixed(6))))} aria-label="decrease">−</button>
      <input disabled={disabled} className="h-full w-full min-w-0 bg-transparent text-center text-sm outline-none tabular" inputMode="decimal" value={value ?? ""} min={min} max={max}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
      {suffix && <span className="pr-1 text-xs text-muted">{suffix}</span>}
      <button type="button" disabled={disabled} className="h-full px-2.5 text-muted hover:text-fg" onClick={() => onChange(clamp(+(((value ?? 0) + step).toFixed(6))))} aria-label="increase">+</button>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-muted tabular">{hint}</span>}
    </label>
  );
}

export function Kpi({ label, value, sub, valueTone }: { label: string; value: ReactNode; sub?: ReactNode; valueTone?: string | number | null }) {
  return (
    <div className="rounded-2xl bg-surface border border-line/70 shadow-soft px-4 py-3.5">
      <div className="text-xs text-muted">{label}</div>
      <div className={cx("mt-1 text-xl font-semibold tabular tracking-tight", valueTone !== undefined && tone(valueTone))}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted tabular">{sub}</div>}
    </div>
  );
}

export const Loading = ({ label = "Loading" }: { label?: string }) => (
  <div className="flex items-center gap-2 py-10 justify-center text-sm text-muted"><span className="h-3 w-3 animate-pulse rounded-full bg-accent" />{label}…</div>
);
export const Empty = ({ children }: { children: ReactNode }) => <div className="py-10 text-center text-sm text-muted">{children}</div>;
export const ErrorBox = ({ error }: { error: unknown }) => (
  <div className="rounded-xl border border-neg/40 bg-neg/10 px-4 py-3 text-sm text-neg">{String((error as Error)?.message ?? error)}</div>
);

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto -mx-5 px-5">
      <table className="w-full text-sm tabular">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">{head.map((h, i) => <th key={i} className="whitespace-nowrap py-2 pr-4 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-line/50">{children}</tbody>
      </table>
    </div>
  );
}
export const Td = ({ children, className }: { children: ReactNode; className?: string }) => <td className={cx("whitespace-nowrap py-2 pr-4", className)}>{children}</td>;

export function Signed({ v, fmt }: { v: string | number | null | undefined; fmt: (v: string | number | null | undefined) => string }) {
  return <span className={tone(v)}>{fmt(v)}</span>;
}
