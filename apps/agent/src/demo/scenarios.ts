import { D } from "@oisniper/core";
import type { Harness } from "./harness";

const legsOf = (t: { exit: { legs: { reason: string }[] } }) => t.exit.legs.map((l) => l.reason).join(">");
const nextUtcMidnight = (ts: number) => {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

/** Day 1, 08:00 UTC: winners, losers, cooldown, gaps, liquidation, daily loss limit. */
export async function day1(h: Harness): Promise<void> {
  const b1 = h.bot("paper");

  h.begin("S1 SOL pump: TP1 partial, lock, trail (Bot 1) + grid entry (Bot 2)");
  h.pump("SOL");
  await h.nextScrape();
  const s1 = h.lastSignal("paper", "SOL");
  h.check("Bot 1 signal opened", s1?.status === "opened", { status: s1?.status, reasons: s1?.reject_reasons, exchange: s1?.exchange });
  const scored = s1?.router.filter((c) => c.score) ?? [];
  const chosen = scored.find((c) => c.exchange === s1?.exchange);
  h.check("router scored listed venues and picked the lowest score", scored.length >= 3 && !!chosen && scored.every((c) => D(c.score!).gte(chosen.score!)), scored.map((c) => `${c.exchange}:${c.score}`).join(" "));
  const s2 = h.lastSignal("test", "SOL");
  h.check("Bot 2 grid opened many variants on one venue", (s2?.opened_trades ?? 0) >= 15 && new Set(h.trades("test", "SOL").map((t) => t.exchange)).size === 1, { opened: s2?.opened_trades, venue: s2?.exchange });
  const cost = (v: string) => s2?.gate_results.find((g) => g.gate === "cost_to_target" && g.variant_id === v);
  h.check("cost-to-target measured per variant and scales with leverage", !!cost("5x-T0") && !!cost("50x-T0") && D(cost("50x-T0")!.value!).gt(D(cost("5x-T0")!.value!).mul(9)), { "5x": cost("5x-T0")?.value, "50x": cost("50x-T0")?.value, limit: cost("50x-T0")?.limit, venue: s2?.exchange });
  h.check("Bot 2 grid uses the 5x-50x set at $100 margin", (s2?.opened_trades ?? 0) <= 30 && h.trades("test", "SOL").every((t) => [5, 10, 15, 20, 30, 50].includes(t.config.leverage) && D(t.config.margin).lte(100) && D(t.config.margin).gt(99)), { leverages: [...new Set(h.trades("test", "SOL").map((t) => t.config.leverage))].join(",") });
  const t1 = h.trades("paper", "SOL")[0];
  h.check("signal-to-fill inside the 1.5s target", !!t1 && t1.timing.signal_to_fill_ms <= 1500, { ms: t1?.timing.signal_to_fill_ms });
  h.check("exchange stop placed right after the fill", !!t1 && h.events(t1.trade_id).some((e) => e.type === "SL_PLACED"), { sl: t1?.config.sl_price, liq: t1?.config.liq_price, entry: t1?.execution.avg_entry_price });
  await h.nextScrape(); // still pumping -> dedupe
  h.check("consecutive re-match folded into one signal", (h.lastSignal("paper", "SOL")?.rematch_count ?? 0) >= 1 && h.signals("paper", "SOL").length === 1, { rematch: h.lastSignal("paper", "SOL")?.rematch_count });
  h.quiet("SOL");
  const p0 = h.price("SOL");
  h.hub.path("SOL", [[90_000, p0 * 1.005], [240_000, p0 * 1.0095], [330_000, p0 * 1.002]]);
  await h.wait(360_000);
  const t1c = h.trades("paper", "SOL")[0]!;
  h.check("closed by trailing stop after TP1", t1c.exit.reason === "TRAIL" && legsOf(t1c) === "TP1_PARTIAL>TRAIL", { reason: t1c.exit.reason, legs: legsOf(t1c) });
  const moves = h.events(t1c.trade_id).filter((e) => e.type === "SL_MOVED").map((e) => (e.data as { price: string }).price);
  h.check("SL moved up (lock, then trail), never down", moves.length >= 2 && moves.every((p, i) => i === 0 || D(p).gte(moves[i - 1]!)), moves.join(" -> "));
  h.check("net PnL positive after fees", D(t1c.result.net_pnl!).gt(0), { net: t1c.result.net_pnl, fees: t1c.result.fees, roe: t1c.result.net_roe_pct, peak_roe: t1c.path.peak_roe });
  h.check("MFE / MAE recorded", D(t1c.path.mfe_pct).gt("0.8"), { mfe: t1c.path.mfe_pct, mae: t1c.path.mae_pct, t_mfe: t1c.path.time_to_mfe_s });

  h.begin("S2 AVAX dump: plain stop loss");
  h.pump("AVAX");
  await h.nextScrape();
  h.quiet("AVAX");
  h.hub.path("AVAX", [[60_000, h.price("AVAX") * 0.994]]);
  await h.wait(90_000);
  const t2 = h.trades("paper", "AVAX")[0];
  h.check("Bot 1 AVAX closed by SL", t2?.exit.reason === "SL", { reason: t2?.exit.reason });
  h.check("loss is about -20% ROE plus fees/slippage", !!t2 && D(t2.result.net_roe_pct!).lt(-20) && D(t2.result.net_roe_pct!).gt(-30), { roe: t2?.result.net_roe_pct });
  const g30 = h.trades("test", "AVAX").find((t) => t.variant_id === "30x-T2");
  h.check("Bot 2 30x variant survives (its SL is -0.67% price)", g30?.status === "open", { status: g30?.status });

  h.begin("S3 Cooldown: SOL matches again 9 minutes after entry");
  h.pump("SOL");
  await h.nextScrape();
  h.quiet("SOL");
  const c1 = h.lastSignal("paper", "SOL");
  h.check("Bot 1: new signal (not consecutive) logged as cooldown", c1?.status === "cooldown" && c1.reject_reasons.includes("COOLDOWN") && h.signals("paper", "SOL").length === 2, { status: c1?.status, reasons: c1?.reject_reasons });
  const c2 = h.lastSignal("test", "SOL");
  h.check("Bot 2: inside its 15 min entry window (open positions do not block)", c2?.status === "cooldown" && c2.cooldown?.cause === "entry" && !c2.reject_reasons.includes("OPEN_POSITION"), { reasons: c2?.reject_reasons, cause: c2?.cooldown?.cause, until: c2?.cooldown?.until && new Date(c2.cooldown.until).toISOString() });

  h.begin("S4 DOGE gap through stop: fill at real book price");
  h.pump("DOGE");
  await h.nextScrape();
  h.quiet("DOGE");
  h.hub.jump("DOGE", h.price("DOGE") * 0.991);
  await h.wait(10_000);
  const t3 = h.trades("paper", "DOGE")[0];
  const leg = t3?.exit.legs[0];
  h.check("stop filled below its trigger (gap)", t3?.exit.reason === "SL" && !!leg && D(leg.price).lt(t3.config.sl_price), { sl: t3?.config.sl_price, fill: leg?.price, slip_pct: leg?.slippage_pct });
  h.check("gap loss bigger than the -20% ROE stop", !!t3 && D(t3.result.net_roe_pct!).lt(-40), { roe: t3?.result.net_roe_pct });

  h.begin("S5 WIF crash through liquidation");
  h.pump("WIF");
  await h.nextScrape();
  h.quiet("WIF");
  const w2 = h.lastSignal("test", "WIF");
  h.check("Bot 2 opened every leverage up to 50x on WIF (max 75x), none skipped for leverage", [5, 10, 15, 20, 30, 50].every((l) => h.trades("test", "WIF").some((t) => t.config.leverage === l)) && !w2?.skipped_variants.some((v) => v.code === "LEVERAGE_UNAVAILABLE"), { opened: w2?.opened_trades, skipped: w2?.skipped_variants.map((v) => `${v.variant_id}:${v.code}`).join(" ") });
  h.hub.jump("WIF", h.price("WIF") * 0.978);
  await h.wait(10_000);
  const t4 = h.trades("paper", "WIF")[0];
  h.check("Bot 1 50x liquidated, whole margin lost", t4?.exit.reason === "LIQUIDATION" && D(t4.result.net_pnl!).neg().gte(D(t4.config.margin)), { net: t4?.result.net_pnl, margin: t4?.config.margin, liq: t4?.config.liq_price });
  // -2.2% gap: 50x liq is about -1.6% (liquidated), 30x liq about -2.9% (its -0.67% stop fills at the book)
  const w50 = h.trades("test", "WIF").find((t) => t.variant_id === "50x-T0");
  const w30 = h.trades("test", "WIF").find((t) => t.variant_id === "30x-T0");
  h.check("Bot 2: 50x liquidated, 30x stopped at the book", w50?.exit.reason === "LIQUIDATION" && w30?.exit.reason === "SL", { "50x": w50?.exit.reason, "30x": w30?.exit.reason });

  h.begin("S6 Max daily loss: 15% of day-start balance pauses until next UTC day");
  await h.wait(65_000); // equity is sampled every 60s and on every close
  const before = b1.run();
  h.note(`  equity check before 4th loss: cash ${before.cash}, day start ${before.day_start_equity}`);
  h.check("still running below the limit", b1.row().status === "running", { cash: before.cash, day_start: before.day_start_equity });
  h.pump("LINK");
  await h.nextScrape();
  h.quiet("LINK");
  h.hub.path("LINK", [[40_000, h.price("LINK") * 0.994], [300_000, h.price("LINK") * 0.995]]);
  await h.wait(65_000);
  const r = b1.run();
  h.check("Bot 1 paused DAILY_LOSS_PAUSE", b1.row().status === "paused" && b1.row().status_reason === "DAILY_LOSS_PAUSE", { status: b1.row().status, cash: r.cash, day_start: r.day_start_equity, until: r.paused_until && new Date(r.paused_until).toISOString() });
  h.pump("ARB");
  await h.nextScrape();
  h.quiet("ARB");
  h.check("new signals rejected while paused", h.lastSignal("paper", "ARB")?.reject_reasons.includes("DAILY_LOSS_PAUSE") === true, h.lastSignal("paper", "ARB")?.reject_reasons);
}

/** Overnight: funding, after-exit job, daily reset. */
export async function overnight(h: Harness): Promise<void> {
  h.begin("S7 Overnight: Bot 2 re-entry after 15 min, funding timestamps, price-after-exit, UTC day rollover");
  // Bot 2 re-enters SOL once 15 min have passed since its last entry, while earlier SOL positions may still be open.
  const solEntry = h.signals("test", "SOL").find((s) => s.status === "opened")!.ts;
  await h.wait(Math.max(0, solEntry + 15 * 60_000 + 5_000 - h.clock.now()));
  const openBefore = h.trades("test", "SOL", { status: "open" }).length;
  h.pump("SOL");
  await h.nextScrape();
  h.quiet("SOL");
  const again = h.lastSignal("test", "SOL");
  h.check("Bot 2 opened a new SOL grid 15 min after its last entry", again?.status === "opened" && h.signals("test", "SOL").filter((s) => s.status === "opened").length === 2 && h.trades("test", "SOL", { status: "open" }).length > openBefore, { status: again?.status, reasons: again?.reject_reasons, open_before: openBefore, opened: again?.opened_trades, minutes_after_entry: again && ((again.ts - solEntry) / 60_000).toFixed(1) });
  await h.wait(nextUtcMidnight(h.clock.now()) - h.clock.now() + 90_000);
  const fund = h.trades("test", undefined, { status: "open" }).filter((t) => D(t.result.funding).gt(0));
  const ev = fund.flatMap((t) => h.events(t.trade_id).filter((e) => e.type === "FUNDING"));
  h.check("funding charged on Bot 2 open positions at 16:00 and 00:00 UTC", fund.length > 0 && ev.length >= fund.length * 2, { positions: fund.length, events: ev.length, example: fund[0] && `${fund[0].variant_id} ${fund[0].result.funding}` });
  const closed = h.trades("paper", undefined, { status: "closed" });
  h.check("price after exit (+15m/+1h/+4h) filled for every closed trade", closed.length >= 4 && closed.every((t) => t.after_exit.chg_15m != null && t.after_exit.chg_4h != null), closed.map((t) => `${t.symbol}:${t.after_exit.chg_4h}`).join(" "));
  const arb = h.lastSignal("paper", "ARB");
  h.check("rejected signal got a counterfactual", arb?.counterfactual?.chg_4h != null && arb.counterfactual.first_hit != null, arb?.counterfactual);
  h.check("Bot 1 resumed at the new UTC day", h.bot("paper").row().status === "running", h.bot("paper").row().status);
}

/** Day 2: gates, max positions, mapping, versioning, data gap, cooldown expiry, loss streak pause. */
export async function day2(h: Harness): Promise<void> {
  const b1 = h.bot("paper");
  h.begin("S8 Pre-trade gates reject with measured values");
  for (const s of ["THIN", "FUNDX", "WIDE", "LOWV"]) h.pump(s);
  h.pump("LINK", { price: h.price("LINK") * 0.983 }); // CoinGlass price lags the exchange -> chase
  await h.nextScrape();
  for (const s of ["THIN", "FUNDX", "WIDE", "LOWV", "LINK"]) h.quiet(s);
  const expect: Record<string, string> = { THIN: "GATE_ENTRY_DEPTH", FUNDX: "GATE_FUNDING", WIDE: "GATE_SPREAD", LOWV: "GATE_VOLUME_24H", LINK: "GATE_CHASE" };
  for (const [s, code] of Object.entries(expect)) {
    const sig = h.lastSignal("paper", s);
    const g = sig?.gate_results.find((x) => x.code === code);
    h.check(`${s} rejected by ${code}`, sig?.status === "rejected" && sig.reject_reasons.includes(code) && g?.pass === false && g.value != null, { reasons: sig?.reject_reasons, value: g?.value, limit: g?.limit });
  }
  await h.nextScrape(); // one quiet scrape so the next matches are new signals, not dedupe re-matches

  h.begin("S9 Six signals at once: max 5 open positions, 1000PEPE mapping");
  const six = ["BTC", "PEPE", "ETH", "SUI", "LINK", "ARB"];
  for (const s of six) h.pump(s);
  await h.nextScrape();
  for (const s of six) h.quiet(s);
  h.check("Bot 1 holds exactly 5 positions", b1.pm.openCount() === 5, b1.pm.openTrades().map((t) => `${t.symbol}@${t.exchange}`).join(" "));
  const arb = h.lastSignal("paper", "ARB");
  h.check("6th signal rejected MAX_OPEN_POSITIONS", arb?.reject_reasons.includes("MAX_OPEN_POSITIONS") === true, arb?.reject_reasons);
  const pepe = h.trades("paper", "PEPE")[0];
  const mult = pepe?.exchange_symbol.startsWith("1000") ? 1000 : 1;
  h.check("PEPE trade priced consistently with its venue's multiplier", !!pepe && D(pepe.execution.avg_entry_price).div(D(pepe.signal.price!).mul(mult)).sub(1).abs().lt("0.02"), { venue: pepe?.exchange, symbol: pepe?.exchange_symbol, entry: pepe?.execution.avg_entry_price, cg: pepe?.signal.price });
  const pc = h.lastSignal("paper", "PEPE")?.router ?? [];
  h.check("1000PEPE venues mapped and price-ratio verified by the router", pc.filter((c) => c.exchange_symbol?.startsWith("1000PEPE") && c.score != null).length >= 2, pc.map((c) => `${c.exchange}:${c.exchange_symbol}:${c.score ?? c.excluded}`).join(" "));

  h.begin("S10 Strategy edit while positions are open");
  const oldV = b1.versionId();
  const newV = b1.saveConfig({ ...b1.config(), name: "Sniper (edited)" });
  h.check("save creates a new immutable version", newV !== oldV && h.app.store.getVersion(oldV) != null, { oldV, newV });
  h.check("open positions keep their opening version", b1.pm.openTrades().every((t) => t.strategy_version_id === oldV));

  h.begin("S11 WebSocket outage on SUI: DATA_GAP + replay");
  const sui = h.trades("paper", "SUI", { status: "open" })[0];
  h.hub.pauseStream("SUI", 12_000);
  h.hub.path("SUI", [[4_000, h.price("SUI") * 0.993]]);
  await h.wait(20_000);
  const suiC = sui ? h.app.store.records.getTrade(sui.trade_id) : null;
  h.check("gap detected and logged on the trade", !!sui && h.events(sui.trade_id).some((e) => e.type === "DATA_GAP"));
  h.check("stop resolved after reconnect at the real book price", suiC?.exit.reason === "SL", { reason: suiC?.exit.reason, fill: suiC?.exit.legs[0]?.price, sl: suiC?.config.sl_price });

  h.begin("S12 Loss streak: 5 consecutive losses pause 1h");
  await h.wait(65_000);
  h.check("5 consecutive losses -> paused", b1.row().status === "paused" && b1.row().status_reason === "CONSECUTIVE_LOSS_PAUSE", { status: b1.row().status, reason: b1.row().status_reason, exits: h.trades("paper", undefined, { status: "closed" }).map((t) => t.exit.reason).join(",") });
  h.pump("AVAX");
  await h.nextScrape();
  h.quiet("AVAX");
  h.check("signals during the pause carry the pause code", h.lastSignal("paper", "AVAX")?.reject_reasons.includes("CONSECUTIVE_LOSS_PAUSE") === true, h.lastSignal("paper", "AVAX")?.reject_reasons);
  await h.wait(61 * 60_000);
  h.check("bot resumes after 1h", b1.row().status === "running", b1.row().status);

  h.begin("S13 Cooldown expired (>12h): SOL tradable again with the new version");
  h.pump("SOL");
  await h.nextScrape();
  h.quiet("SOL");
  const re = h.lastSignal("paper", "SOL");
  h.check("SOL opened again with the new version", re?.status === "opened" && re.strategy_version_id === newV, { status: re?.status, reasons: re?.reject_reasons });

  h.begin("S14 Bot 2 on a 25x coin: 30x / 50x skipped, never clamped");
  h.pump("OP");
  await h.nextScrape();
  h.quiet("OP");
  const op = h.lastSignal("test", "OP");
  const opSkip = op?.skipped_variants ?? [];
  // OP max 25x: 6 leverages x 5 trails, the 10 variants at 30x and 50x skip; 5x-20x open at their own leverage.
  h.check("30x and 50x variants skipped LEVERAGE_UNAVAILABLE, 5x-20x opened unclamped", opSkip.filter((v) => v.code === "LEVERAGE_UNAVAILABLE").length === 10 && opSkip.every((v) => /^(30|50)x/.test(v.variant_id)) && op?.opened_trades === 20 && h.trades("test", "OP").every((t) => t.config.leverage <= 20), { venue: op?.exchange, opened: op?.opened_trades, skipped: opSkip.map((v) => `${v.variant_id}:${v.code}`).join(" ") });
  // At 0.05% taker the 20x cost is 0.10% / 1.0% = 10%, far under the 40% limit.
  const opCost = op?.gate_results.find((g) => g.gate === "cost_to_target" && g.variant_id === "20x-T0");
  h.check("cost-to-target passes at 20x on a 0.05% fee venue", opCost?.pass === true, { value: opCost?.value, limit: opCost?.limit });

  h.begin("S15 Counterfactuals on gate rejections (+4h)");
  await h.wait(3 * 3_600_000);
  const rej = h.signals("paper").filter((s) => s.status === "rejected" && Object.keys(expect).includes(s.symbol));
  h.check("each gate rejection has +15m/+1h/+4h and TP1/SL first-hit", rej.length >= 5 && rej.every((s) => s.counterfactual?.chg_4h != null && s.counterfactual.first_hit != null), rej.map((s) => `${s.symbol}:${s.counterfactual?.first_hit}`).join(" "));
  const pepeF = h.trades("paper", "PEPE", { status: "open" })[0];
  h.check("4h-interval funding charged on PEPE", !!pepeF && !D(pepeF.result.funding).isZero(), { funding: pepeF?.result.funding });
}
