"use client";
import { useEffect, useRef } from "react";
import { n } from "@/lib/format";

const cssColor = (name: string) => `rgb(${getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim().replace(/ /g, ",")})`;

/** Equity curve with TradingView lightweight-charts. */
export function EquityChart({ points }: { points: { ts: number; equity: string }[] }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let dispose = () => {};
    let cancelled = false;
    void import("lightweight-charts").then(({ createChart, ColorType }) => {
      if (cancelled || !el.current) return;
      const chart = createChart(el.current, {
        height: 240,
        layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: cssColor("muted"), fontFamily: "-apple-system, Inter, sans-serif" },
        grid: { vertLines: { visible: false }, horzLines: { color: cssColor("line") } },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, timeVisible: true },
        autoSize: true,
      });
      const s = chart.addAreaSeries({ lineColor: cssColor("accent"), topColor: cssColor("accent").replace("rgb", "rgba").replace(")", ",0.25)"), bottomColor: "rgba(0,0,0,0)", lineWidth: 2 });
      const seen = new Set<number>();
      const data = points
        .map((p) => ({ time: Math.floor(p.ts / 1000), value: n(p.equity) ?? 0 }))
        .filter((p) => (seen.has(p.time) ? false : (seen.add(p.time), true)))
        .sort((a, b) => a.time - b.time);
      s.setData(data as never);
      chart.timeScale().fitContent();
      dispose = () => chart.remove();
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [points]);
  return <div ref={el} className="h-[240px] w-full" />;
}
