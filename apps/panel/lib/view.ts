"use client";
import { create } from "zustand";

/** Which account the dashboard shows. Paper = Bot 1 on the simulator, Real = Bot 1 live, Test = Bot 2 research grid. */
export type View = "paper" | "real" | "test";
export const VIEWS: { value: View; label: string }[] = [
  { value: "paper", label: "Paper" },
  { value: "real", label: "Real" },
  { value: "test", label: "Test" },
];
export const VIEW_LABEL: Record<View, string> = { paper: "Paper", real: "Real", test: "Test" };

const read = (): View => {
  try {
    const v = localStorage.getItem("oisniper.view");
    return v === "real" || v === "test" ? v : "paper";
  } catch {
    return "paper";
  }
};

/**
 * History, Signals and Analytics show the current run by default, so "Reset stats" looks like a fresh start.
 * Archived runs are never deleted; "All runs" shows them.
 */
export const useRunScope = create<{ allRuns: boolean; setAllRuns: (v: boolean) => void }>((set) => ({
  allRuns: false,
  setAllRuns: (v) => set({ allRuns: v }),
}));

export const useView = create<{ view: View; setView: (v: View) => void; hydrate: () => void }>((set) => ({
  view: "paper",
  setView: (v) => {
    try {
      localStorage.setItem("oisniper.view", v);
    } catch {
      /* private mode */
    }
    set({ view: v });
  },
  hydrate: () => set({ view: read() }),
}));
