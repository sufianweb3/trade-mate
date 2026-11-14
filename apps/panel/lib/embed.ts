"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** The panel runs inside the Trade Mate desktop app when opened with ?embed=desktop (remembered for the session). */
const KEY = "trademate.embed";

export function isEmbedded(search: string, stored: string | null): boolean {
  return new URLSearchParams(search).get("embed") === "desktop" || stored === "desktop";
}

function readStored(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/**
 * True inside the desktop app. There the desktop's sidebar replaces the panel's navigation bar and drives routes
 * through window.__tradeMateNavigate (only the panel's own pages are accepted).
 */
export function useEmbedded(routes: readonly string[]): boolean {
  const router = useRouter();
  const [embedded] = useState(() => typeof window !== "undefined" && isEmbedded(window.location.search, readStored()));
  useEffect(() => {
    if (!embedded) return;
    try {
      sessionStorage.setItem(KEY, "desktop");
    } catch {
      /* private mode: the query string still marks this load */
    }
    const w = window as unknown as { __tradeMateNavigate?: (route: string) => void };
    w.__tradeMateNavigate = (route: string) => {
      if (routes.includes(route)) router.push(route);
    };
    return () => {
      delete w.__tradeMateNavigate;
    };
  }, [embedded, router, routes]);
  return embedded;
}
