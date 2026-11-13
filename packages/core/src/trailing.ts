import { D, Decimal, dmax } from "./decimal";
import { roundTripFeeRoe } from "./math/fees";
import { toRoe } from "./math/roe";
import type { ExitProfile } from "./strategy";

/** Exit levels expressed in ROE % for one position. */
export interface ExitLevels {
  slRoe: Decimal;
  tp1Roe: Decimal;
  tp1ClosePct: Decimal;
  trailEnabled: boolean;
  lockRoe: Decimal;
  trailDistRoe: Decimal;
  /** ROE at which trailing arms without a TP1 fill (T4, or TP1 skipped for min lot). */
  activateRoe: Decimal;
  feeRoe: Decimal;
}

export function exitLevels(p: ExitProfile, takerPct: Decimal.Value): ExitLevels {
  const lev = p.leverage;
  const feeRoe = roundTripFeeRoe(takerPct, lev);
  const lockRoe = p.lockPct === 0 && p.breakevenFees ? feeRoe : toRoe(p.lockPct, p.basis, lev);
  const tp1Roe = toRoe(p.tp1Pct, p.basis, lev);
  return {
    slRoe: toRoe(p.slPct, p.basis, lev).neg(),
    tp1Roe,
    tp1ClosePct: D(p.tp1ClosePct),
    trailEnabled: p.trailEnabled,
    lockRoe,
    trailDistRoe: toRoe(p.trailDistancePct, p.basis, lev),
    activateRoe: p.activatePct != null ? toRoe(p.activatePct, p.basis, lev) : tp1Roe,
    feeRoe,
  };
}

export interface TrailState {
  peakRoe: Decimal;
  troughRoe: Decimal;
  slRoe: Decimal;
  /** Trailing active: SL follows peak - distance, floored at lock. */
  armed: boolean;
  tp1Filled: boolean;
}

export function initTrail(l: ExitLevels): TrailState {
  return { peakRoe: D(0), troughRoe: D(0), slRoe: l.slRoe, armed: false, tp1Filled: false };
}

function trailTarget(s: TrailState, l: ExitLevels): Decimal {
  return dmax(l.lockRoe, s.peakRoe.sub(l.trailDistRoe));
}

export interface TrailStep {
  state: TrailState;
  /** New SL ROE when it moved up, else null. SL never moves down. */
  newSlRoe: Decimal | null;
  armedNow: boolean;
}

/**
 * Mark/last tick. `tp1OrderActive` = a TP1 order is resting, so arming waits for its fill.
 * Without one (close 0% or TP1 skipped) trailing arms when ROE reaches activateRoe.
 */
export function onTick(prev: TrailState, l: ExitLevels, roe: Decimal, tp1OrderActive: boolean): TrailStep {
  const s: TrailState = {
    ...prev,
    peakRoe: dmax(prev.peakRoe, roe),
    troughRoe: roe.lt(prev.troughRoe) ? roe : prev.troughRoe,
  };
  let armedNow = false;
  if (!s.armed && l.trailEnabled && !tp1OrderActive && roe.gte(l.activateRoe)) {
    s.armed = true;
    armedNow = true;
  }
  let newSlRoe: Decimal | null = null;
  if (s.armed) {
    const target = trailTarget(s, l);
    if (target.gt(s.slRoe)) {
      s.slRoe = target;
      newSlRoe = target;
    }
  }
  return { state: s, newSlRoe, armedNow };
}

/** TP1 order filled: lock SL and arm trailing (if enabled). */
export function onTp1Fill(prev: TrailState, l: ExitLevels): TrailStep {
  const s: TrailState = { ...prev, tp1Filled: true, peakRoe: dmax(prev.peakRoe, l.tp1Roe) };
  if (!l.trailEnabled) return { state: s, newSlRoe: null, armedNow: false };
  s.armed = true;
  const target = trailTarget(s, l);
  if (target.gt(s.slRoe)) {
    s.slRoe = target;
    return { state: s, newSlRoe: target, armedNow: true };
  }
  return { state: s, newSlRoe: null, armedNow: true };
}

export function stopHit(roe: Decimal, s: TrailState): boolean {
  return roe.lte(s.slRoe);
}
