"use client";
import type { InputHTMLAttributes, ReactNode } from "react";
import { tone } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "./ui/alert-dialog";
import { ShadButton, type ButtonProps } from "./ui/button";
import { ShadSwitch } from "./ui/switch";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

/**
 * The panel's component API (unchanged names and props), built on shadcn/ui and the Trade Mate tokens
 * (packages/design/tokens.css). Pages import only from here.
 */
export const cx = (...c: (string | false | null | undefined)[]) => cn(...c);

export function Button({ variant = "default", size = "md", ...p }: Omit<ButtonProps, "variant" | "size"> & { variant?: "default" | "primary" | "danger" | "ghost"; size?: "sm" | "md" }) {
  return <ShadButton variant={variant} size={size} {...p} />;
}

export function Card({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-2xl border border-border bg-card p-5 text-card-foreground", className)}>
      {(title || action) && (
        <header className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/** Grouped inset list (Apple Settings / Stocks style): rows separated by hairlines inside one rounded group. */
export function List({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      {(title || action) && (
        <header className="mb-1.5 flex items-end justify-between gap-3 px-1">
          {title && <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>}
          {action}
        </header>
      )}
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">{children}</div>
    </section>
  );
}

export function ListRow({ label, value, sub, action, className }: { label: ReactNode; value?: ReactNode; sub?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-11 items-center gap-3 px-4 py-2.5 text-sm", className)}>
      <div className="min-w-0 flex-1">
        <div className="truncate">{label}</div>
        {sub && <div className="truncate text-xs text-muted tabular">{sub}</div>}
      </div>
      {value !== undefined && <div className="shrink-0 text-right font-medium tabular">{value}</div>}
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

const TONES = { neutral: "bg-line/60 text-muted", pos: "bg-pos/12 text-pos", neg: "bg-neg/12 text-neg", warn: "bg-warn/15 text-warn", live: "bg-live text-white", paper: "bg-paper/12 text-paper", accent: "bg-accent/12 text-accent" } as const;

/** Sentence-case pill (no tracked capitals). */
export function Badge({ children, tone: t = "neutral" }: { children: ReactNode; tone?: keyof typeof TONES }) {
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium first-letter:uppercase", TONES[t])}>{children}</span>;
}

export const ModeBadge = ({ mode }: { mode: string }) => <Badge tone={mode === "live" ? "live" : "paper"}>{mode}</Badge>;

export function StatusBadge({ s }: { s: string }) {
  const t = s === "running" || s === "opened" || s === "OK" || s === "ok" || s === "connected" ? "pos" : s === "paused" || s === "cooldown" || s === "DEGRADED" || s === "unverified" ? "warn" : s === "halted" || s === "rejected" || s === "CHALLENGE" || s === "down" || s === "error" ? "neg" : "neutral";
  return <Badge tone={t}>{s.toLowerCase()}</Badge>;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return <ShadSwitch checked={checked} onCheckedChange={onChange} aria-label={label} disabled={disabled} />;
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <ToggleGroup type="single" value={value} onValueChange={(v) => v && onChange(v as T)}>
      {options.map((o) => <ToggleGroupItem key={o.value} value={o.value}>{o.label}</ToggleGroupItem>)}
    </ToggleGroup>
  );
}

const field = "h-9 w-full rounded-lg border border-input bg-surface px-3 text-sm tabular outline-none transition-colors duration-100 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50";

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cn(field, p.className)} />;
}

/** Numeric field with steppers. Value stays a number in the form; config strings are built at save. */
export function Stepper({ value, onChange, step = 1, min, max, suffix, disabled }: { value: number | null; onChange: (v: number | null) => void; step?: number; min?: number; max?: number; suffix?: string; disabled?: boolean }) {
  // Never clamp silently: the validator rejects out-of-range values with a reason.
  const nudge = (d: number) => onChange(+(((value ?? 0) + d).toFixed(6)));
  const btn = "h-full px-2.5 text-muted hover:text-foreground focus-visible:outline-none focus-visible:text-foreground disabled:opacity-40";
  return (
    <div className="flex h-9 items-center rounded-lg border border-input bg-surface focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
      <button type="button" disabled={disabled} className={btn} onClick={() => nudge(-step)} aria-label="decrease">−</button>
      <input disabled={disabled} className="h-full w-full min-w-0 bg-transparent text-center text-sm tabular outline-none" inputMode="decimal" value={value ?? ""} min={min} max={max}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
      {suffix && <span className="pr-1 text-xs text-muted">{suffix}</span>}
      <button type="button" disabled={disabled} className={btn} onClick={() => nudge(step)} aria-label="increase">+</button>
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
    <div className="rounded-2xl border border-border bg-card px-4 py-3.5">
      <div className="text-xs text-muted">{label}</div>
      <div className={cn("mt-1 text-xl font-semibold tabular tracking-tight", valueTone !== undefined && tone(valueTone))}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted tabular">{sub}</div>}
    </div>
  );
}

export const Loading = ({ label = "Loading" }: { label?: string }) => (
  <div role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
    <span className="h-3 w-3 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />{label}…
  </div>
);
export const Empty = ({ children }: { children: ReactNode }) => <div className="py-10 text-center text-sm text-muted">{children}</div>;
export const ErrorBox = ({ error }: { error: unknown }) => (
  <div role="alert" className="rounded-xl border border-neg/40 bg-neg/10 px-4 py-3 text-sm text-neg">{String((error as Error)?.message ?? error)}</div>
);

/** Inset table: sticky header, hairline rows. Numeric cells use <Td num>. */
export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="-mx-5 overflow-x-auto px-5">
      <table className="w-full text-sm tabular">
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="border-b border-border text-left text-xs text-muted">{head.map((h, i) => <th key={i} className="whitespace-nowrap py-2 pr-4 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody className="[&>tr:hover]:bg-line/25 [&>tr]:border-b [&>tr]:border-border/60 [&>tr:last-child]:border-0">{children}</tbody>
      </table>
    </div>
  );
}
export const Td = ({ children, className, num }: { children: ReactNode; className?: string; num?: boolean }) => (
  <td className={cn("whitespace-nowrap py-2 pr-4", num && "text-right", className)}>{children}</td>
);

/** Props for a table row that opens a detail: works with the mouse and with Enter / Space, focus ring visible. */
export function rowProps(onActivate: () => void) {
  return {
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: { key: string; preventDefault: () => void }) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate();
      }
    },
    className: "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
  };
}

export function Signed({ v, fmt }: { v: string | number | null | undefined; fmt: (v: string | number | null | undefined) => string }) {
  return <span className={tone(v)}>{fmt(v)}</span>;
}

/** Confirmation for actions that move money. onConfirm runs only on the confirm button. */
export function ConfirmDialog({ title, body, confirmLabel, tone: t = "default", onConfirm, trigger }: {
  title: string; body: ReactNode; confirmLabel: string; tone?: "danger" | "default"; onConfirm: () => void | Promise<void>; trigger: ReactNode;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild><div>{body}</div></AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className={t === "danger" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined} onClick={() => void onConfirm()}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
