window.__ModuleLoader__.load({
  id: 'dsh-openrouter-spend',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    /** Dictionary namespace declared on the registrations, so `t` reaches the components. */
    const NS = 'openrouter-spend';

    /** Preferences are viewing choices: a browser-local store, not host state. */
    const PREF_KEY_ID = 'ors.keyId';
    const PREF_INTERVAL = 'ors.intervalSeconds';
    const PREF_CURRENCY = 'ors.currency';
    /** The limit warning ships opt-in: unset reads as off (ADR-0004). */
    const PREF_LIMIT_NOTICE = 'ors.limitNotice';
    const PREF_SEEN_LIMIT = 'ors.seenLimit';
    const PREFS_CHANGED = 'ors:prefs';
    const EVENT_OPEN_POPOVER = 'ors:open-popover';

    /**
     * The locale `apply` last saw. Factory scope, not component state: a plural
     * form is chosen while building a string, and the components read the active
     * locale only to pick one. English until `apply` hears otherwise, so a host
     * with no locale plugin still renders a sentence.
     */
    let activeLocaleId = 'en';

    const CSS = `
.ors-root { position: relative; display: inline-flex; }
.ors-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px; border: 0; border-radius: 999px; cursor: pointer;
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12, 12px/1.4 system-ui);
}
.ors-chip:hover { background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover)); }
.ors-chip[aria-expanded="true"] { color: var(--dsw-alias-label-primary); }
.ors-chip-amount { color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.ors-chip-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-business-primary); }
.ors-chip-dot[data-state="stale"] { background: var(--dsw-alias-state-warn-primary, #c08b00); }
.ors-chip-dot[data-state="loading"] { background: var(--dsw-alias-label-tertiary); }
.ors-chip-dot[data-state="error"], .ors-chip-dot[data-state="no-credential"] { background: var(--dsw-alias-state-error-primary); }
/* The limit states sit beside the health states rather than replacing them. The
   dot is the only at-a-glance signal, so its colour is always doubled by text in
   the panel: colour is never the sole carrier of the level. */
.ors-chip-dot { animation: none; }
.ors-chip-dot[data-state="limit-warn"] { background: var(--dsw-alias-state-warn-primary, #c08b00); }
.ors-chip-dot[data-state="limit-critical"] { background: var(--dsw-alias-state-error-primary); }
/* A finite pulse, not a beacon. The iteration count is the whole budget — the
   dot then rests in its level colour. The forwards fill mode holds that resting
   state, so a re-render every refresh cannot restart the animation indefinitely. */
@media (prefers-reduced-motion: no-preference) {
  .ors-chip-dot[data-state="limit-warn"] { animation: ors-pulse 1.6s ease-in-out 2 forwards; }
  .ors-chip-dot[data-state="limit-critical"] { animation: ors-pulse 1.6s ease-in-out 3 forwards; }
}
@keyframes ors-pulse { 50% { opacity: 0.25; } }
.ors-panel {
  position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 40; width: 340px;
  padding: 12px; border-radius: 12px; text-align: left;
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  border: 0.5px solid var(--dsw-alias-border-l2);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xs-13, 13px/1.45 system-ui);
}
.ors-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ors-label { color: var(--dsw-alias-label-tertiary); font: var(--dsw-font-xxs-12, 12px/1.4 system-ui); }
.ors-figure { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ors-sub { margin-top: 2px; color: var(--dsw-alias-label-tertiary); font: var(--dsw-font-xxs-12, 12px/1.4 system-ui); }
.ors-range, .ors-keyrow { display: flex; flex-wrap: wrap; gap: 4px; margin: 10px 0 8px; }
.ors-range button, .ors-key {
  padding: 3px 8px; border-radius: 6px; cursor: pointer; border: 0;
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12, 12px/1.4 system-ui);
}
.ors-range button[aria-pressed="true"], .ors-key[aria-pressed="true"] {
  background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover));
  color: var(--dsw-alias-label-primary);
}
.ors-table { width: 100%; border-collapse: collapse; }
.ors-table th {
  padding: 4px 0; text-align: left; color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12, 12px/1.4 system-ui); font-weight: 400;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.ors-table th:last-child, .ors-table td:last-child { text-align: right; }
.ors-table td { padding: 4px 0; border-bottom: 0.5px solid var(--dsw-alias-separator-primary); vertical-align: top; }
.ors-table td:first-child { padding-right: 8px; word-break: break-word; }
.ors-num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.ors-bars { display: flex; align-items: flex-end; gap: 1px; height: 34px; margin-top: 10px; }
.ors-bar { flex: 1 1 0; min-height: 1px; border-radius: 1px; background: var(--dsw-alias-state-business-primary); opacity: 0.65; }
.ors-bar[data-today="true"] { opacity: 1; }
.ors-note { margin-top: 8px; color: var(--dsw-alias-state-warn-primary, #c08b00); font: var(--dsw-font-xxs-12, 12px/1.4 system-ui); }
/* The limit block. The meter shows what is *consumed*, so it fills as the cap
   approaches and agrees with the percentage printed beside it. */
.ors-quota { margin: 10px 0 8px; padding-top: 9px; border-top: 0.5px solid var(--dsw-alias-separator-primary); }
.ors-quota-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ors-quota-key { font: var(--dsw-font-xxs-12, 12px/1.4 system-ui); }
.ors-quota-pct {
  font: var(--dsw-font-xxs-12, 12px/1.4 system-ui);
  font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary);
}
.ors-quota-meter {
  position: relative; height: 5px; border-radius: 999px; margin: 7px 0 6px;
  background: var(--dsw-alias-separator-primary); overflow: hidden;
}
.ors-quota-fill {
  position: absolute; inset: 0 auto 0 0; border-radius: 999px;
  background: var(--dsw-alias-state-business-primary);
}
.ors-quota-note { font: var(--dsw-font-xxs-12, 12px/1.4 system-ui); color: var(--dsw-alias-label-secondary); }
.ors-quota[data-level="warn"] .ors-quota-fill { background: var(--dsw-alias-state-warn-primary, #c08b00); }
.ors-quota[data-level="critical"] .ors-quota-fill { background: var(--dsw-alias-state-error-primary); }
.ors-quota[data-level="warn"] .ors-quota-pct,
.ors-quota[data-level="warn"] .ors-quota-note { color: var(--dsw-alias-state-warn-primary, #c08b00); font-weight: 600; }
.ors-quota[data-level="critical"] .ors-quota-pct,
.ors-quota[data-level="critical"] .ors-quota-note { color: var(--dsw-alias-state-error-primary); font-weight: 600; }
/* An unattributable limit: the meter is greyed and empty because nothing is
   known. It is rendered rather than omitted — silence reads as health. */
.ors-quota[data-level="unknown"] .ors-quota-fill { background: var(--dsw-alias-label-tertiary); }
.ors-quota[data-level="unknown"] .ors-quota-pct { color: var(--dsw-alias-label-tertiary); }
.ors-toast {
  position: fixed; bottom: 24px; right: 24px; z-index: 1000; max-width: 400px;
  padding: 14px 16px; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  border: 0.5px solid var(--dsw-alias-border-l2);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xs-13, 13px/1.45 system-ui);
  display: flex; flex-direction: column; gap: 10px;
  animation: ors-toast-in 0.3s ease-out;
}
@keyframes ors-toast-in {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}
.ors-toast-content { cursor: pointer; }
.ors-toast-content:hover { text-decoration: underline; }
.ors-toast-actions { display: flex; gap: 6px; justify-content: flex-end; }
.ors-toast-actions button {
  padding: 4px 10px; border-radius: 6px; cursor: pointer; border: 0;
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12, 12px/1.4 system-ui);
}
.ors-toast-actions button:hover {
  background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover));
}
.ors-settings { display: flex; flex-direction: column; gap: 14px; padding: 4px 0; }
.ors-field { display: flex; flex-direction: column; gap: 4px; }
.ors-field input, .ors-field select {
  padding: 6px 8px; border-radius: 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xs-13, 13px/1.45 system-ui);
}
.ors-actions { display: flex; gap: 6px; align-items: center; }
.ors-actions button {
  padding: 5px 10px; border-radius: 8px; cursor: pointer; border: 0;
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  color: var(--dsw-alias-label-primary); font: var(--dsw-font-xxs-12, 12px/1.4 system-ui);
}
`;

    /**
     * Money with the precision a sub-cent figure needs, and none it does not.
     * USD prints as an invoice writes it (`$1.23`), RUB as a receipt does
     * (`1.23 ₽`).
     */
    function fmtMoney(value, currency) {
      const amount = Number(value) || 0;
      const magnitude = Math.abs(amount);
      const digits = magnitude === 0 ? 2 : magnitude < 0.01 ? 4 : magnitude < 1 ? 3 : 2;
      return currency === 'RUB' ? `${amount.toFixed(digits)} ₽` : `$${amount.toFixed(digits)}`;
    }

    /**
     * The display money for one currency choice. OpenRouter bills USD and the
     * wire stays USD; RUB is that figure at the cbr.ru rate. Without a rate the
     * USD presentation is kept — the caller adds the "check cbr.ru" note — so a
     * dead cbr.ru costs the conversion, never the numbers.
     */
    function makeMoney(currency, perUsd) {
      const rate = Number(perUsd);
      const rub = currency === 'RUB' && Number.isFinite(rate) && rate > 0;
      const scale = value => (Number(value) || 0) * (rub ? rate : 1);
      const fmt = value => fmtMoney(scale(value), rub ? 'RUB' : 'USD');
      return {
        rub,
        perUsd: rub ? rate : undefined,
        symbol: rub ? '₽' : '$',
        fmt,
        /**
         * Two figures under one currency sign — `session/day` reads as one
         * money pair, not as two amounts (`$0.85/$1.50`, `0.85/1.50 ₽`).
         * The pair shares one precision: mixing `$0.600/$1.50` would read as
         * two unrelated figures. Below a hundredth both halves keep 4 digits
         * so a rounding to zero does not claim a session spent nothing.
         */
        fmtPair: (first, second) => {
          const scale = value => (Number(value) || 0) * (rub ? rate : 1);
          const magnitude = value => Math.abs(scale(value));
          const anyCents = magnitude(first) >= 0.01 || magnitude(second) >= 0.01;
          const digits = anyCents ? 2 : 4;
          const left = scale(first).toFixed(digits);
          const right = scale(second).toFixed(digits);
          return rub ? `${left}/${right} ₽` : `$${left}/$${right}`;
        },
      };
    }

    /**
     * The analytics row for this chat. The harness stamps its Session id as the
     * `x-session-id` header, so OpenRouter echoes it verbatim; the bare-UUID
     * match is kept for clients that send the id unprefixed.
     */
    function findSession(bySession, sessionId) {
      if (!Array.isArray(bySession) || typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
      return bySession.find(row => row.id === sessionId
        || row.id === `session-${sessionId}`
        || sessionId === `session-${row.id}`);
    }

    const fmtInt = value => Number(value || 0).toLocaleString('en-US');

    /** A stable color per API key, so one key keeps its hue across reloads. */
    function keyTint(id) {
      let hash = 0;
      for (const char of String(id)) hash = (hash * 31 + char.codePointAt(0)) % 360;
      return `hsl(${hash} 62% 55%)`;
    }

    /** Read one viewing preference; private mode reads as the default. */
    function readPref(name, fallback) {
      try {
        const stored = window.localStorage.getItem(name);
        return stored === null ? fallback : stored;
      } catch {
        return fallback;
      }
    }

    /** The display currency preference; anything else in storage reads as USD. */
    function readCurrency() {
      return readPref(PREF_CURRENCY, 'USD') === 'RUB' ? 'RUB' : 'USD';
    }

    /** The limit-notice preference; anything but an explicit `1` reads as off. */
    function readLimitNotice() {
      return readPref(PREF_LIMIT_NOTICE, '0') === '1';
    }

    /** Read the last seen limit escalation. */
    function readSeenLimit() {
      return readPref(PREF_SEEN_LIMIT, '');
    }

    /** Write the seen limit as `${keyId}:${level}`. */
    function writeSeenLimit(keyId, level) {
      writePref(PREF_SEEN_LIMIT, `${keyId}:${level}`);
    }

    /** The ADR-0001 thresholds, used when the host sends none. */
    const DEFAULT_LIMIT_THRESHOLDS = { warn: 0.4, critical: 0.8 };

    /** Below this many closed days there is no rate to divide by, so no state. */
    const LIMIT_MIN_CLOSED_DAYS = 3;

    /**
     * A consumption share is a ratio of two floats, and the ratios a percentage
     * is *about* land a hair under it: `$7.20 of $12` computes to
     * 0.39999999999999997, which would miss a 40% threshold the figure plainly
     * reads as. The comparisons carry a slack far smaller than any real cent, so
     * the boundary values behave and nothing else moves.
     */
    const LIMIT_EPSILON = 1e-9;

    /** Leaving a level needs a margin, or a key on the boundary flickers. */
    const LIMIT_HYSTERESIS = 0.02;
    const LIFETIME_LEAVE_WARN_DAYS = 4;
    const LIFETIME_LEAVE_CRITICAL_DAYS = 1.5;

    const MS_PER_HOUR = 3_600_000;
    const MS_PER_DAY = 86_400_000;
    /** The rate window: a week of hours, long enough to catch a burst, short enough to forget one. */
    const LIMIT_BURN_WINDOW_MS = 7 * MS_PER_DAY;

    /**
     * An instant from either shape the payload uses: epoch milliseconds, epoch
     * seconds, or a date string. A bare number below a millisecond epoch is read
     * as seconds, because that is the only other thing an API sends for a time.
     */
    function parseInstant(value) {
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return undefined;
        return value > 1e12 ? value : value * 1000;
      }
      if (typeof value === 'string') {
        const at = Date.parse(value);
        return Number.isFinite(at) ? at : undefined;
      }
      return undefined;
    }

    /**
     * The buckets a rate may be drawn from: the trailing window, and never the
     * future. A stamp that will not parse is kept rather than dropped: it carries
     * a figure someone measured, and dropping it on a parse failure would
     * silently understate the burn.
     *
     * There is deliberately no pre-cap floor here. The management `/keys`
     * payload carries no trustworthy "this limit was set at" timestamp: the
     * record's own last-modified field was null for 7 of the 9 limited keys on
     * the measured account, and where it is present it reads as a
     * record-mutation time rather than the moment a cap was set. A floor built
     * on it would drop real spend on the strength of a field whose meaning is
     * unverified on the live API, so no floor is applied.
     */
    function windowedBurn(burn, nowMs) {
      const list = Array.isArray(burn) ? burn : [];
      const floor = nowMs - LIMIT_BURN_WINDOW_MS;
      return list.filter(bucket => {
        const at = parseInstant(bucket?.ts);
        if (at === undefined) return true;
        if (at > nowMs) return false;
        return at >= floor;
      });
    }

    /**
     * Median of a numeric list, or 0 for none. A median and not a mean: one
     * expensive session moves a mean for a week, and the rate must not follow it.
     */
    function median(values) {
      const sorted = (Array.isArray(values) ? values : []).filter(Number.isFinite).sort((l, r) => l - r);
      if (sorted.length === 0) return 0;
      const middle = sorted.length >> 1;
      return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    }

    /**
     * One significant figure, because these are estimates: `1.87 h` would claim a
     * precision the input does not have. Undefined for a non-positive span, so the
     * caller drops the phrase rather than printing a zero.
     */
    function fmtDuration(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return undefined;
      const minutes = ms / 60_000;
      if (minutes < 1) return '<1 min';
      if (minutes < 60) return `${Math.round(minutes)} min`;
      const hours = minutes / 60;
      if (hours < 24) return `${Math.round(hours)} h`;
      const days = hours / 24;
      // Past a year the estimate stops being a span and becomes a shrug. The
      // caller drops the fragment, and the line stays honest without printing
      // "23797 days at this rate" for a key that barely moves.
      if (days > 365) return undefined;
      return `${Math.round(days)} days`;
    }

    /** The heaviest single hour in the window: the pace the remainder could go at. */
    function peakHourlyBurn(burn) {
      let peak = 0;
      for (const bucket of Array.isArray(burn) ? burn : []) {
        const usd = Number(bucket?.usd);
        if (Number.isFinite(usd) && usd > peak) peak = usd;
      }
      return peak;
    }

    /** Spend per closed UTC day, today excluded because it is still filling. */
    function closedDayTotals(burn, nowMs) {
      const today = new Date(nowMs).toISOString().slice(0, 10);
      const totals = new Map();
      for (const bucket of Array.isArray(burn) ? burn : []) {
        const stamp = bucket?.ts;
        const usd = Number(bucket?.usd);
        if (typeof stamp !== 'string' || stamp.length < 10 || !Number.isFinite(usd)) continue;
        const day = stamp.slice(0, 10);
        if (day === today) continue;
        totals.set(day, (totals.get(day) ?? 0) + usd);
      }
      return [...totals.values()];
    }

    /**
     * The epoch of the next refill, in UTC. Measured, not documented: `usage_daily`
     * matches the UTC calendar day, `usage_weekly` the ISO week from Monday, and
     * `usage_monthly` the calendar month from the 1st — each to about the lag
     * between two calls, while rolling windows are off by dollars.
     */
    function nextResetMs(limitReset, nowMs) {
      const now = new Date(nowMs);
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth();
      const day = now.getUTCDate();
      if (limitReset === 'daily') return Date.UTC(year, month, day + 1);
      if (limitReset === 'weekly') {
        const weekday = now.getUTCDay();
        return Date.UTC(year, month, day + (weekday === 0 ? 1 : 8 - weekday));
      }
      if (limitReset === 'monthly') return Date.UTC(year, month + 1, 1);
      return undefined;
    }

    /** The refill moment in the reader's own zone and format, never the word "midnight". */
    function resetTextFor(limitReset, nowMs) {
      const at = nextResetMs(limitReset, nowMs);
      if (at === undefined) return undefined;
      const date = new Date(at);
      try {
        if (limitReset === 'daily') {
          return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
        }
        if (limitReset === 'weekly') {
          return new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
        }
        return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
      } catch {
        // A runtime without Intl still gets a usable, if blunter, moment.
        return date.toISOString().slice(11, 16);
      }
    }

    /**
     * The level of one key's limit, or `none` when nothing is known. Pure: the
     * caller supplies the clock and the previous level, which is what makes the
     * hysteresis testable rather than a side effect.
     *
     * A lifetime cap counts down and never refills, so its metric is runway in
     * days. A periodic cap refills, so the risk is running out inside the period
     * and its metric is the share already consumed (ADR-0001).
     */
    function limitState(input) {
      const {
        limit,
        limitRemaining,
        limitReset,
        burn,
        nowMs = Date.now(),
        previous,
        thresholds,
      } = input ?? {};
      const cap = Number(limit);
      const remainingRaw = Number(limitRemaining);
      if (!Number.isFinite(cap) || cap <= 0) return { level: 'none' };
      if (!Number.isFinite(remainingRaw)) return { level: 'none' };
      const remainingUsd = Math.max(0, remainingRaw);
      const percent = Math.min(100, Math.max(0, ((cap - remainingUsd) / cap) * 100));
      const resetAtMs = nextResetMs(limitReset, nowMs);
      const burnWindow = windowedBurn(burn, nowMs);
      const peak = peakHourlyBurn(burnWindow);
      const runwayMs = peak > 0 ? (remainingUsd / peak) * MS_PER_HOUR : undefined;
      const avgRequestUsd = Number(input?.avgRequestUsd);
      const lifetime = limitReset === null || limitReset === undefined;
      const shared = {
        limitUsd: cap,
        remainingUsd,
        percent,
        lifetime,
        resetAtMs,
        untilResetMs: resetAtMs === undefined ? undefined : resetAtMs - nowMs,
        resetText: resetTextFor(limitReset, nowMs),
        // The actionable figure: how long the remainder lasts at the heaviest
        // recent hour, not at the median — this answers "how fast can it go".
        runwayMs,
        // The same span, already rendered. Undefined for a still cap, so no caller
        // can divide a zero burn and print "Infinity at this rate".
        runwayText: fmtDuration(runwayMs),
        // A count of requests is only meaningful against what one costs, so it
        // appears when the caller can supply the per-request figure.
        requests: Number.isFinite(avgRequestUsd) && avgRequestUsd > 0
          ? Math.floor(remainingUsd / avgRequestUsd)
          : undefined,
      };

      if (lifetime) {
        const days = closedDayTotals(burnWindow, nowMs);
        if (days.length < LIMIT_MIN_CLOSED_DAYS) return { level: 'none', ...shared };
        const perDay = median(days);
        if (!(perDay > 0)) return { level: 'none', ...shared };
        const runwayDays = remainingUsd / perDay;
        let level = runwayDays <= 1 + LIMIT_EPSILON ? 'critical' : runwayDays <= 3 + LIMIT_EPSILON ? 'warn' : 'none';
        // Hysteresis in whole days, where this branch's thresholds live.
        if (level === 'none' && previous === 'warn' && runwayDays <= LIFETIME_LEAVE_WARN_DAYS + LIMIT_EPSILON) level = 'warn';
        if (level === 'warn' && previous === 'critical' && runwayDays <= LIFETIME_LEAVE_CRITICAL_DAYS + LIMIT_EPSILON) level = 'critical';
        return { level, ...shared, perDayUsd: perDay, runwayDays };
      }

      const warnAt = Number(thresholds?.warn) > 0 ? Number(thresholds.warn) : DEFAULT_LIMIT_THRESHOLDS.warn;
      const criticalAt = Number(thresholds?.critical) > 0 ? Number(thresholds.critical) : DEFAULT_LIMIT_THRESHOLDS.critical;
      const consumed = (cap - remainingUsd) / cap;
      let level = consumed + LIMIT_EPSILON >= criticalAt ? 'critical' : consumed + LIMIT_EPSILON >= warnAt ? 'warn' : 'none';
      if (level === 'none' && previous === 'warn' && consumed + LIMIT_EPSILON >= warnAt - LIMIT_HYSTERESIS) level = 'warn';
      if (level === 'warn' && previous === 'critical' && consumed + LIMIT_EPSILON >= criticalAt - LIMIT_HYSTERESIS) level = 'critical';
      // The reset veto: a cap that refills before the remainder runs out is not an
      // emergency. Applied only where the refill moment is measured — the daily
      // case — so no claim rests on an unverified anchor.
      const untilResetMs = shared.untilResetMs;
      let imminent = false;
      if (level === 'critical' && limitReset === 'daily' && untilResetMs !== undefined
        && runwayMs !== undefined && runwayMs >= untilResetMs) {
        level = 'warn';
        // The ordinary warn sentence would promise hours the reader does not
        // have; this says what actually happens next, which is the refill.
        imminent = true;
      }
      return { level, ...shared, consumed, imminent };
    }

    /**
     * The CLDR plural category for `count` in `localeId`.
     *
     * The dictionary layer is a flat map with `{name}` substitution and no plural
     * support at all, so the form a language needs cannot live in the string: it
     * has to be chosen here, in code. `Intl.PluralRules` is the correct source for
     * that choice — Russian alone has one/few/many, and which one a numeral takes
     * is a rule about its last digits (21 takes the one form), not something a
     * sentence can read off the number. An unsupported locale id, or a runtime
     * without `Intl`, falls back to `other`, the category every language has.
     */
    function pluralCategory(count, localeId) {
      try {
        return new Intl.PluralRules(localeId || 'en').select(count);
      } catch {
        return 'other';
      }
    }

    /**
     * Resolve a pluralised dictionary key through a flat `t`.
     *
     * The category-specific key is probed first (`limitApproxRequests_few`) and
     * the base key is the fallback, so a language that adds no variants — Chinese
     * has only the `other` category — keeps working with the base string alone.
     *
     * The locale plugin's `t` returns the KEY ITSELF when a lookup misses and
     * exposes no `has()`, so comparing the result against the suffixed name is
     * the only way to test key presence through a flat `t`.
     */
    function tPlural(t, key, count, localeId, params) {
      const suffixed = `${key}_${pluralCategory(count, localeId)}`;
      const resolved = t(suffixed, params);
      return resolved === suffixed ? t(key, params) : resolved;
    }

    /**
     * The line under the meter. The remaining money always leads: it is the figure
     * the reader asked for, and the consumed share alone never says how much is
     * left. Past a threshold the estimate of time takes over from a count of
     * requests, because that is what a decision turns on. At `critical` the refill
     * moment is dropped too — the runway is the only number that changes what the
     * reader does next.
     *
     * `localeId` selects the plural form for the two numerals in the sentence; it
     * is optional so the three-argument call still works, and defaults to English.
     */
    function limitSentence(state, money, t, localeId) {
      // The active locale decides the plural form. Absent means English, so the
      // three-argument call the older tests use still renders a sentence.
      const locale = localeId || 'en';
      if (state === undefined) return undefined;
      const flagged = state.level !== 'none';
      const parts = [t('limitLeft', {
        left: money.fmt(state.remainingUsd),
        limit: money.fmt(state.limitUsd),
      })];
      // A share of a lifetime cap is not the figure a decision turns on: the
      // countdown is. The percentage rides only on a cap that refills.
      if (flagged && !state.lifetime && state.percent !== undefined) {
        parts.push(t('limitConsumed', { percent: Math.round(state.percent) }));
      }
      if (state.lifetime) {
        const days = state.runwayDays;
        // At rest the count of requests is the useful extra; past a threshold the
        // time estimate replaces it, because that is what a decision turns on.
        if (!flagged && state.requests !== undefined) {
          parts.push(tPlural(t, 'limitApproxRequests', state.requests, locale, { count: state.requests }));
        }
        if (days !== undefined && days <= 1) parts.push(t('limitUnderADay'));
        else if (days !== undefined) {
          // A span past a year renders as nothing, and the fragment has to go
          // with it: "~undefined at this rate" is worse than no estimate at all.
          const span = fmtDuration(days * MS_PER_DAY);
          if (span !== undefined) {
            // The ROUNDED day count is the one on screen, so it is the one the
            // plural rule has to see: `select(2.9)` is `other` in Russian, which
            // would print "~3 дней" for a numeral that reads "3 дня".
            const rounded = Math.round(days);
            parts.push(tPlural(t, 'limitDaysAtRate', rounded, locale, { days: rounded }));
          }
        }
        else if (flagged && state.requests !== undefined) {
          parts.push(tPlural(t, 'limitApproxRequests', state.requests, locale, { count: state.requests }));
        }
      } else if (state.imminent) {
        // Minutes to the refill, which is sooner than any runway: the refill is
        // the thing that happens next, so it is the whole sentence.
        const minutes = Math.max(1, Math.round(state.untilResetMs / 60_000));
        parts.push(t('limitResetsIn', { minutes }));
      } else {
        if (state.resetText !== undefined && state.level !== 'critical') {
          parts.push(t('limitResets', { when: state.resetText }));
        }
        if (flagged && state.runwayMs !== undefined) {
          const span = fmtDuration(state.runwayMs);
          if (span !== undefined) parts.push(t('limitLeftAtRate', { duration: span }));
        }
      }
      return parts.join(' \u00b7 ');
    }

    /**
     * Append the reason the runway estimate is missing, when the hourly read
     * failed. Without this a failed read and a key that simply has no burn to
     * report look identical — both render a sentence with no estimate — and the
     * panel stays silent about a figure the reader is expecting. The reason is
     * appended rather than substituted: what is left of the limit is still known
     * and is the figure the reader came for.
     */
    function withBurnNote(sentence, burnNote) {
      if (burnNote === undefined) return sentence;
      if (sentence === undefined) return burnNote;
      return `${sentence} \u00b7 ${burnNote}`;
    }

    /**
     * Whether a level change is an escalation worth interrupting for. Pure, so
     * the rule is testable and cannot drift between the two components that use
     * it. De-escalation and an unchanged level are both silent.
     */
    function escalates(previous, current) {
      return (previous === 'none' && (current === 'warn' || current === 'critical'))
        || (previous === 'warn' && current === 'critical');
    }

    /**
     * The dot state. A broken reading outranks a full budget — `error` and
     * `no-credential` stay visible — and a limit level outranks `stale`, because
     * stale figures beside an exhausted cap still need to say so.
     */
    function dotState(status, level) {
      if (status === 'error' || status === 'no-credential') return status;
      if (level === 'critical') return 'limit-critical';
      if (level === 'warn') return 'limit-warn';
      return status ?? 'loading';
    }

    /** Store one viewing preference and tell the other component about it. */
    function writePref(name, value) {
      try {
        window.localStorage.setItem(name, value);
      } catch {
        // Private mode keeps the session usable; the choice simply does not persist.
      }
      window.dispatchEvent(new CustomEvent(PREFS_CHANGED));
    }

    /**
     * How long one summary reply stands in for another. `Pill` and `ToastOverlay`
     * each poll on their own interval, so two components would otherwise mean two
     * HTTP requests per tick for one answer. The host already coalesces upstream,
     * so this only removes the duplicate request; it never changes what is asked.
     */
    const SUMMARY_COALESCE_MS = 1000;
    let summaryInflight;
    let summaryInflightAt = 0;

    /**
     * One shared fetch of the host summary. Callers arriving within
     * `SUMMARY_COALESCE_MS` of each other share the one request.
     *
     * `force` is for a caller the window must not answer: the Settings Reload
     * button is an explicit request for the current figures, so it must not be
     * handed a reply that was already in flight.
     */
    function fetchSummary(force) {
      const at = Date.now();
      if (!force && summaryInflight !== undefined && at - summaryInflightAt < SUMMARY_COALESCE_MS) {
        return summaryInflight;
      }
      summaryInflightAt = at;
      summaryInflight = fetch('/openrouter-spend/summary', {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      }).then(response => (response.ok ? response.json() : undefined)).catch(() => undefined);
      return summaryInflight;
    }

    /**
     * The limit escalation toast. Shown frame-wide when a tracked key crosses a
     * threshold, dismissed on click or explicit close, retired when the popover
     * opens or the same escalation is seen.
     */
    function Toast(props) {
      const { keyId, level, state, money, t, onDismiss, onOpen } = props;
      if (!state || level === 'none') return null;

      const percent = Math.round(state.percent ?? 0);
      const limit = money.fmt(state.limitUsd);
      const period = state.lifetime ? t('limitToastPeriodLifetime')
        : state.limitReset === 'daily' ? t('periodToday')
        : state.limitReset === 'weekly' ? t('periodWeek')
        : state.limitReset === 'monthly' ? t('periodMonth')
        : t('limitToastPeriodLifetime');
      
      const estimate = state.runwayMs !== undefined
        ? fmtDuration(state.runwayMs)
        : state.runwayDays !== undefined
        ? fmtDuration(state.runwayDays * MS_PER_DAY)
        : undefined;

      const message = estimate !== undefined
        ? t(level === 'critical' ? 'limitToastCritical' : 'limitToastWarn', {
            name: keyId,
            percent,
            period,
            limit,
            estimate,
          })
        : t(level === 'critical' ? 'limitToastCriticalNoEstimate' : 'limitToastWarnNoEstimate', {
            name: keyId,
            percent,
            period,
            limit,
          });

      return h('div', { className: 'ors-toast' },
        h('style', null, CSS),
        h('div', {
          className: 'ors-toast-content',
          onClick: onOpen,
          role: 'button',
          tabIndex: 0,
          onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') onOpen(); },
        }, message),
        h('div', { className: 'ors-toast-actions' },
          h('button', { type: 'button', onClick: onDismiss }, t('limitToastDismiss'))));
    }

    function Pill(props) {
      const { t, sessionId } = props;
      const [data, setData] = useState(null);
      const [open, setOpen] = useState(false);
      const [range, setRange] = useState('today');
      const [keyId, setKeyId] = useState(() => readPref(PREF_KEY_ID, ''));
      const [intervalSeconds, setIntervalSeconds] = useState(() => Number(readPref(PREF_INTERVAL, '0')));
      const [currency, setCurrency] = useState(readCurrency);
      // The limit warning is opt-in, and reads the same store Settings writes.
      const [noticeOn, setNoticeOn] = useState(readLimitNotice);
      const rootRef = useRef(null);
      // The previous level, so `limitState` can apply its hysteresis without
      // becoming stateful. A ref and not state: it must not trigger a render.
      const levelRef = useRef('none');

      useEffect(() => { void fetchSummary().then(reply => { if (reply !== undefined) setData(reply); }); }, []);

      const seconds = intervalSeconds > 0 ? intervalSeconds : Number(data?.refreshSeconds) || 60;
      useEffect(() => {
        const timer = setInterval(() => {
          void fetchSummary().then(reply => { if (reply !== undefined) setData(reply); });
        }, seconds * 1000);
        return () => clearInterval(timer);
      }, [seconds]);

      // The Settings section writes the same preferences; follow it live.
      useEffect(() => {
        const sync = () => {
          setKeyId(readPref(PREF_KEY_ID, ''));
          setIntervalSeconds(Number(readPref(PREF_INTERVAL, '0')));
          setCurrency(readCurrency());
          setNoticeOn(readLimitNotice());
        };
        window.addEventListener(PREFS_CHANGED, sync);
        return () => window.removeEventListener(PREFS_CHANGED, sync);
      }, []);

      // Listen for the toast requesting to open the popover.
      useEffect(() => {
        const handler = () => {
          setOpen(true);
        };
        window.addEventListener(EVENT_OPEN_POPOVER, handler);
        return () => window.removeEventListener(EVENT_OPEN_POPOVER, handler);
      }, []);

      useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = event => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        const onKeyDown = event => { if (event.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('mousedown', onPointerDown);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      const chooseKey = useCallback(id => {
        setKeyId(id);
        writePref(PREF_KEY_ID, id);
      }, []);

      const keys = data?.byKey ?? [];
      const selected = keys.find(entry => entry.id === keyId);

      const view = useMemo(() => {
        if (selected !== undefined) {
          if (range === 'today') return { usd: selected.todayUsd, requests: selected.todayRequests };
          if (range === 'last7') return selected.last7;
          return selected.last30;
        }
        if (range === 'today') return data?.todaySpend ?? { usd: 0, requests: 0 };
        if (range === 'last7') return data?.last7 ?? { usd: 0, requests: 0 };
        return data?.last30 ?? { usd: 0, requests: 0 };
      }, [data, selected, range]);

      const rows = selected !== undefined ? selected.todayModels : (data?.byModel ?? []);
      const bars = data?.byDay ?? [];
      const peak = bars.reduce((max, entry) => Math.max(max, entry.usd), 0);
      const balance = data?.credits ? data.credits.totalCredits - data.credits.totalUsage : undefined;
      const rangeLabel = range === 'today' ? t('today') : range === 'last7' ? t('last7') : t('last30');
      const money = makeMoney(currency, data?.rate?.perUsd);
      // RUB was chosen but cbr.ru answered no rate: figures stay in USD and say so.
      const rubUnavailable = currency === 'RUB' && data !== null && !money.rub;
      // This chat's spend today over the whole day's spend; the pair only lands
      // when the host read a session split — otherwise the chip stays a single
      // figure rather than showing an unverifiable zero.
      const sessionRow = findSession(data?.bySession, sessionId);
      const chipPair = data?.bySession !== undefined && sessionRow !== undefined
        ? money.fmtPair(sessionRow.todayUsd, data?.todaySpend?.usd ?? 0)
        : undefined;

      // The limit block follows the key the user is tracking, because that is
      // the cap that stops them. With "All keys" there is no single cap, so the
      // shared pool is the honest figure; the ADR-0002 minimum is honoured by
      // showing the balance whenever it binds harder than the key's own limit.
      const limits = noticeOn ? data?.limits : undefined;
      const keyLimit = keyId !== '' ? limits?.[keyId] : undefined;
      const keyBurn = keyId !== '' ? data?.burnHourly?.[keyId] : undefined;
      // One cost per request, from this key's own window; without it the block
      // says money and time and leaves the count out rather than guessing.
      const avgRequestUsd = selected !== undefined && selected.requests > 0
        ? selected.usd / selected.requests
        : undefined;
      // The host writes `burnError` when the hourly window could not be read, and
      // every runway estimate rides on that window. Said out loud, because the
      // alternative is a sentence that quietly drops the estimate.
      const burnNote = noticeOn && data !== null && data?.burnError !== undefined
        ? t('limitBurnUnavailable', { reason: data.burnError })
        : undefined;
      const noticeState = noticeOn && data !== null
        ? limitState({
          limit: keyLimit?.limit,
          limitRemaining: keyLimit?.limitRemaining,
          limitReset: keyLimit?.limitReset,
          burn: keyBurn,
          avgRequestUsd,
          previous: levelRef.current,
          thresholds: data?.limitThresholds,
        })
        : undefined;
      // Carry the level forward so the next poll's hysteresis has a previous.
      // The escalation check lives in `ToastOverlay`, which is the component that
      // actually renders a toast; a second copy here would be a second place for
      // the rule to drift, and this component's `toastLevel` had no surface to
      // appear on.
      useEffect(() => {
        if (noticeState === undefined) return;
        levelRef.current = noticeState.level;
      });
      // When the popover opens, mark the current level as seen. This effect must
      // stay *below* the `noticeState` declaration: its dependency array is read
      // during render, and reading a `const` above its own declaration is a
      // temporal dead zone reference that throws on every render.
      useEffect(() => {
        if (open && noticeOn && keyId !== '' && noticeState?.level && noticeState.level !== 'none') {
          writeSeenLimit(keyId, noticeState.level);
        }
      }, [open, noticeOn, keyId, noticeState?.level]);
      // A key with spend but no readable limit must say so. Silence reads as
      // health, which is the one thing this block must never lie about.
      const limitUnknown = noticeOn && data !== null && (data.limitsError !== undefined
        || (keyId !== '' && keyLimit === undefined && selected !== undefined && selected.usd > 0));

      // With no key singled out there is still a limit worth naming: the one
      // closest to its cap. Severity first, then the larger share consumed, so a
      // critical key always outranks a warn whatever the percentages say.
      const tightest = noticeOn && data !== null && keyId === '' && limits !== undefined
        ? Object.entries(limits)
          .map(([id, entry]) => ({
            id,
            state: limitState({
              limit: entry?.limit,
              limitRemaining: entry?.limitRemaining,
              limitReset: entry?.limitReset,
              burn: data?.burnHourly?.[id],
              previous: 'none',
              thresholds: data?.limitThresholds,
            }),
          }))
          .sort((left, right) => {
            const rank = { critical: 2, warn: 1, none: 0 };
            const gap = rank[right.state.level] - rank[left.state.level];
            return gap !== 0 ? gap : (right.state.percent ?? 0) - (left.state.percent ?? 0);
          })[0]
        : undefined;

      // One block, three shapes. It reports what is known and names the gap when
      // nothing is — a missing limit must never read as a healthy one. The shared
      // pool is informational rather than alarmed: ADR-0001's thresholds are
      // about a cap that refills, and the account balance is not that.
      let quota;
      if (noticeOn && data !== null) {
        const balanceBinds = balance !== undefined && keyLimit !== undefined
          && balance < keyLimit.limitRemaining;
        if (limitUnknown) {
          quota = {
            level: 'unknown',
            key: t('limitKey'),
            pct: undefined,
            note: data.limitsError !== undefined
              ? t('limitUnavailable', { reason: data.limitsError })
              : t('limitUnknownMatch'),
          };
        } else if (keyLimit !== undefined && !balanceBinds) {
          quota = {
            level: noticeState?.level ?? 'none',
            key: [`${t('limitKey')} · `, h('span', { key: 'k', style: { color: keyTint(keyId) } }, keyId)],
            pct: noticeState?.percent,
            note: withBurnNote(limitSentence(noticeState, money, t, activeLocaleId), burnNote),
          };
        } else if (tightest !== undefined && !balanceBinds) {
          // The label names how many limits the pick was made from, because
          // "tightest" is otherwise a claim with nothing to compare against: with
          // two limited keys it is barely a choice, with twenty it means something.
          // Counted through `tPlural` so Russian takes the right genitive.
          const limitedCount = Object.keys(limits ?? {}).length;
          quota = {
            level: tightest.state.level,
            key: [`${tPlural(t, 'limitTightest', limitedCount, activeLocaleId, { count: limitedCount })} · `,
              h('span', { key: 'k', style: { color: keyTint(tightest.id) } }, tightest.id)],
            pct: tightest.state.percent,
            note: withBurnNote(limitSentence(tightest.state, money, t, activeLocaleId), burnNote),
          };
        } else if (balanceBinds || (keyId === '' && balance !== undefined)) {
          const total = data.credits?.totalCredits;
          quota = {
            level: 'none',
            key: t('limitBalance'),
            pct: Number.isFinite(total) && total > 0 ? (balance / total) * 100 : undefined,
            note: t('limitShared'),
          };
        }
      }

      if (data !== null && data.status === 'no-credential') {
        return h('span', { className: 'ors-root' },
          h('style', null, CSS),
          h('span', { className: 'ors-chip', title: t('noCredential') },
            h('span', { className: 'ors-chip-dot', 'data-state': 'no-credential' }),
            t('noCredential')));
      }

      return h('div', { className: 'ors-root', ref: rootRef },
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: 'ors-chip',
          'aria-expanded': open,
          'aria-label': t('open'),
          title: t('open'),
          onClick: () => setOpen(value => !value),
        },
        h('span', {
          className: 'ors-chip-dot',
          role: 'img',
          'data-state': dotState(data?.status, noticeState?.level),
          // The dot is the only at-a-glance signal, so its colour is always
          // doubled by a label naming the level.
          'aria-label': noticeState?.level === 'critical' ? t('limitLevelCritical')
            : noticeState?.level === 'warn' ? t('limitLevelWarn')
            : undefined,
        }),
        h('span', { className: 'ors-chip-amount' },
          data === null ? t('loading') : chipPair ?? money.fmt(view.usd))),
        open && h('div', { className: 'ors-panel' },
          h('div', { className: 'ors-head' },
            h('span', { className: 'ors-label' }, rangeLabel),
            h('span', { className: 'ors-figure' }, money.fmt(view.usd))),
          h('div', { className: 'ors-sub' },
            `${fmtInt(view.requests)} ${t('requests')}`
            + (data?.refreshedAt === undefined
              ? ''
              : ` · ${t('updated')} ${new Date(data.refreshedAt).toLocaleTimeString()}`)),
          money.rub && h('div', { className: 'ors-sub' },
            `${t('cbrRate')}: 1 USD = ${money.perUsd.toFixed(2)} ₽`),
          rubUnavailable && h('div', { className: 'ors-note' }, t('rubFallback')),
          rubUnavailable && data?.rateError !== undefined
            ? h('div', { className: 'ors-sub' }, data.rateError)
            : null,
          h('div', { className: 'ors-range' },
            ['today', 'last7', 'last30'].map(id => h('button', {
              key: id,
              type: 'button',
              'aria-pressed': range === id,
              onClick: () => setRange(id),
            }, id === 'today' ? t('today') : id === 'last7' ? t('last7') : t('last30')))),
          quota === undefined ? null : h('div', { className: 'ors-quota', 'data-level': quota.level },
            h('div', { className: 'ors-quota-head' },
              h('span', { className: 'ors-quota-key ors-label' }, quota.key),
              h('span', { className: 'ors-quota-pct' },
                quota.pct === undefined ? '—' : `${Math.round(quota.pct)}%`)),
            h('div', { className: 'ors-quota-meter' },
              h('div', {
                className: 'ors-quota-fill',
                style: { width: `${Math.max(0, Math.min(100, quota.pct ?? 0))}%` },
              })),
            h('div', { className: 'ors-quota-note' }, quota.note)),
          balance === undefined ? null : h('div', { className: 'ors-sub' },
            `${t('balance')}: ${money.fmt(balance)} · ${t('lifetime')}: ${money.fmt(data.credits.totalUsage)}`),
          keys.length > 0 && h('div', null,
            h('div', { className: 'ors-sub' }, t('byKey')),
            h('div', { className: 'ors-keyrow' },
              [null, ...keys.map(entry => entry.id)].map(id => h('button', {
                key: id ?? '__all__',
                type: 'button',
                className: 'ors-key',
                'aria-pressed': keyId === (id ?? ''),
                style: id === null ? undefined : { color: keyTint(id) },
                onClick: () => chooseKey(id ?? ''),
              }, id === null ? t('allKeys') : id))),
            h('div', { className: 'ors-sub' }, t('byModel'))),
          h('table', { className: 'ors-table' },
            h('thead', null, h('tr', null,
              h('th', null, t('byModel')),
              h('th', null, money.symbol),
              h('th', null, t('requests')))),
            h('tbody', null, rows.length === 0
              ? h('tr', null, h('td', { colSpan: 3, className: 'ors-label' }, '—'))
              : rows.map(entry => h('tr', { key: entry.id },
                h('td', null, entry.id),
                h('td', { className: 'ors-num' }, money.fmt(entry.usd)),
                h('td', { className: 'ors-num' }, fmtInt(entry.requests)))))),
          bars.length > 0 && peak > 0 && h('div', { className: 'ors-bars' },
            bars.map(entry => h('div', {
              key: entry.date,
              className: 'ors-bar',
              'data-today': entry.date === data.today,
              style: { height: `${Math.max(2, Math.round((entry.usd / peak) * 34))}px` },
              title: `${entry.date} · ${money.fmt(entry.usd)}`,
            }))),
          data?.error === undefined ? null : h('div', { className: 'ors-note' }, data.error)));
    }

    /**
     * The toast overlay: a frame-wide component that listens for limit
     * escalations and shows a dismissible notice. Registered in shell.overlay.
     */
    function ToastOverlay(props) {
      const { t } = props;
      const [data, setData] = useState(null);
      const [keyId, setKeyId] = useState(() => readPref(PREF_KEY_ID, ''));
      const [currency, setCurrency] = useState(readCurrency);
      const [noticeOn, setNoticeOn] = useState(readLimitNotice);
      const [seenLimit, setSeenLimit] = useState(() => readSeenLimit());
      const [toastLevel, setToastLevel] = useState('none');
      const levelRef = useRef('none');

      // Fetch summary on mount and on interval.
      useEffect(() => { void fetchSummary().then(reply => { if (reply !== undefined) setData(reply); }); }, []);

      const seconds = Number(data?.refreshSeconds) || 60;
      useEffect(() => {
        const timer = setInterval(() => {
          void fetchSummary().then(reply => { if (reply !== undefined) setData(reply); });
        }, seconds * 1000);
        return () => clearInterval(timer);
      }, [seconds]);

      // Sync preferences from other components.
      useEffect(() => {
        const sync = () => {
          setKeyId(readPref(PREF_KEY_ID, ''));
          setCurrency(readCurrency());
          setNoticeOn(readLimitNotice());
          setSeenLimit(readSeenLimit());
        };
        window.addEventListener(PREFS_CHANGED, sync);
        return () => window.removeEventListener(PREFS_CHANGED, sync);
      }, []);

      const limits = noticeOn ? data?.limits : undefined;
      const keyLimit = keyId !== '' ? limits?.[keyId] : undefined;
      const keyBurn = keyId !== '' ? data?.burnHourly?.[keyId] : undefined;
      const keys = data?.byKey ?? [];
      const selected = keys.find(entry => entry.id === keyId);
      const avgRequestUsd = selected !== undefined && selected.requests > 0
        ? selected.usd / selected.requests
        : undefined;

      const noticeState = noticeOn && data !== null
        ? limitState({
          limit: keyLimit?.limit,
          limitRemaining: keyLimit?.limitRemaining,
          limitReset: keyLimit?.limitReset,
          burn: keyBurn,
          avgRequestUsd,
          previous: levelRef.current,
          thresholds: data?.limitThresholds,
        })
        : undefined;

      // Carry the level forward and read the escalation in one pass: the previous
      // level must be captured before it is overwritten, and two effects cannot
      // promise that order — the first one to run would hand the second the
      // current level as its own history, and no escalation would ever fire.
      useEffect(() => {
        if (noticeState === undefined) return;
        const current = noticeState.level;
        const previous = levelRef.current;
        levelRef.current = current;
        if (!noticeOn || keyId === '') return;
        if (escalates(previous, current) && seenLimit !== `${keyId}:${current}`) {
          setToastLevel(current);
        }
      });

      const money = makeMoney(currency, data?.rate?.perUsd);

      const handleDismiss = useCallback(() => {
        if (keyId !== '' && toastLevel !== 'none') {
          writeSeenLimit(keyId, toastLevel);
          setToastLevel('none');
        }
      }, [keyId, toastLevel]);

      const handleOpen = useCallback(() => {
        window.dispatchEvent(new CustomEvent(EVENT_OPEN_POPOVER));
        if (keyId !== '' && toastLevel !== 'none') {
          writeSeenLimit(keyId, toastLevel);
          setToastLevel('none');
        }
      }, [keyId, toastLevel]);

      if (!noticeOn || toastLevel === 'none' || !noticeState) return null;

      return h(Toast, {
        keyId,
        level: toastLevel,
        state: noticeState,
        money,
        t,
        onDismiss: handleDismiss,
        onOpen: handleOpen,
      });
    }

    function Settings(props) {
      const { t } = props;
      const [data, setData] = useState(null);
      const [keyId, setKeyId] = useState(() => readPref(PREF_KEY_ID, ''));
      const [intervalSeconds, setIntervalSeconds] = useState(() => readPref(PREF_INTERVAL, '0'));
      const [currency, setCurrency] = useState(readCurrency);
      const [limitNotice, setLimitNotice] = useState(readLimitNotice);
      const [draft, setDraft] = useState('');
      const [notice, setNotice] = useState(null);

      const reload = useCallback(async (force) => {
        const reply = await fetchSummary(force);
        if (reply !== undefined) setData(reply);
      }, []);

      useEffect(() => { void reload(); }, [reload]);

      const submit = useCallback(async body => {
        setNotice(null);
        try {
          const response = await fetch('/openrouter-spend/credential', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          const reply = await response.json();
          if (!response.ok) {
            setNotice(reply?.error ?? `${response.status}`);
            return;
          }
          setData(reply);
          setDraft('');
          setNotice(t('saved'));
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error));
        }
      }, [t]);

      const credential = data?.credential;
      const keys = data?.byKey ?? [];
      const money = makeMoney(currency, data?.rate?.perUsd);
      // RUB was chosen but cbr.ru answered no rate: figures stay in USD and say so.
      const rubUnavailable = currency === 'RUB' && data !== null && !money.rub;
      const selectKey = value => {
        setKeyId(value);
        writePref(PREF_KEY_ID, value);
      };
      const selectInterval = value => {
        setIntervalSeconds(value);
        writePref(PREF_INTERVAL, value);
      };
      const selectCurrency = value => {
        setCurrency(value);
        writePref(PREF_CURRENCY, value);
      };
      // The limit warning is opt-in, so the switch starts off and says so.
      const selectLimitNotice = value => {
        setLimitNotice(value);
        writePref(PREF_LIMIT_NOTICE, value ? '1' : '0');
      };

      return h('div', { className: 'ors-settings' },
        h('style', null, CSS),
        h('div', null,
          h('div', { className: 'ors-head' },
            h('span', { className: 'ors-label' }, t('today')),
            h('span', { className: 'ors-figure' },
              money.fmt(data?.todaySpend?.usd ?? 0))),
          h('div', { className: 'ors-sub' },
            `${fmtInt(data?.todaySpend?.requests ?? 0)} ${t('requests')}`
            + (data?.credits === undefined
              ? ''
              : ` · ${t('balance')}: ${money.fmt(data.credits.totalCredits - data.credits.totalUsage)}`)),
          data?.error === undefined ? null : h('div', { className: 'ors-note' }, data.error)),
        h('div', { className: 'ors-field' },
          h('label', { className: 'ors-sub' }, t('currency')),
          h('select', { value: currency, onChange: event => selectCurrency(event.target.value) },
            h('option', { value: 'USD' }, t('currencyUsd')),
            h('option', { value: 'RUB' }, t('currencyRub'))),
          money.rub
            ? h('div', { className: 'ors-sub' }, `${t('cbrRate')}: 1 USD = ${money.perUsd.toFixed(2)} ₽`)
            : null,
          rubUnavailable ? h('div', { className: 'ors-note' }, t('rubFallback')) : null,
          rubUnavailable && data?.rateError !== undefined
            ? h('div', { className: 'ors-sub' }, data.rateError)
            : null),
        h('div', { className: 'ors-field' },
          h('label', { className: 'ors-sub' }, t('countByKey')),
          h('select', { value: keyId, onChange: event => selectKey(event.target.value) },
            h('option', { value: '' }, t('allKeys')),
            keys.map(entry => h('option', { key: entry.id, value: entry.id },
              `${entry.id} · ${money.fmt(entry.todayUsd)} ${t('today')}`)),
            keyId !== '' && keys.every(entry => entry.id !== keyId)
              ? h('option', { value: keyId }, `${keyId} · ${t('unknownKey')}`)
              : null)),
        h('div', { className: 'ors-field' },
          h('label', { className: 'ors-sub' }, t('refreshEvery')),
          h('select', { value: intervalSeconds, onChange: event => selectInterval(event.target.value) },
            h('option', { value: '0' }, `${t('serverDefault')} (${data?.refreshSeconds ?? 60}s)`),
            ['30', '60', '300', '900'].map(value => h('option', { key: value, value }, `${value}s`)))),
        h('div', { className: 'ors-field' },
          h('label', { className: 'ors-sub' }, t('limitNotice')),
          h('select', {
            value: limitNotice ? '1' : '0',
            onChange: event => selectLimitNotice(event.target.value === '1'),
          },
            h('option', { value: '0' }, t('limitNoticeOff')),
            h('option', { value: '1' }, t('limitNoticeOn'))),
          h('div', { className: 'ors-sub' }, t('limitNoticeHint'))),
        h('div', { className: 'ors-field' },
          h('label', { className: 'ors-sub' }, t('managementKey')),
          h('input', {
            type: 'password',
            value: draft,
            placeholder: credential?.configured === true ? '••••••••' : '',
            autoComplete: 'off',
            spellCheck: false,
            onChange: event => setDraft(event.target.value),
          }),
          credential?.configured === true
            ? h('div', { className: 'ors-sub' },
              `${t('keyStored')} (${credential.ref}${credential.source === undefined ? '' : ` · ${credential.source}`})`)
            : h('div', { className: 'ors-sub' }, t('keyHint')),
          h('div', { className: 'ors-actions' },
            h('button', {
              type: 'button',
              disabled: draft.length === 0,
              onClick: () => { void submit({ value: draft }); },
            }, t('save')),
            credential?.configured === true && h('button', {
              type: 'button',
              onClick: () => { void submit({ clear: true }); },
            }, t('clear')),
            h('button', { type: 'button', onClick: () => { void reload(true); } }, t('reload'))),
          credential?.writable === false
            ? h('div', { className: 'ors-note' }, t('keyReadOnly'))
            : null,
          notice === null ? null : h('div', { className: 'ors-sub' }, notice)));
    }

    return {
      inject: ['slots', 'locale'],
      // The pure pieces ride along on the plugin object so a test can drive the
      // factory and reach them. The harness's own packages expose render pieces
      // the same way; `client.js` cannot be an ES module, so this is the seam.
      limitState,
      limitSentence,
      pluralCategory,
      tPlural,
      withBurnNote,
      dotState,
      escalates,
      fmtDuration,
      nextResetMs,
      resetTextFor,
      median,
      peakHourlyBurn,
      closedDayTotals,
      apply(ctx) {
        // The active locale drives the plural form, so it is tracked here rather
        // than read per render. Both reads are feature-detected: a host (or a
        // test) may expose a `locale` with only register/bind and no event bus,
        // and the sentence must still render.
        if (typeof ctx.locale?.getSnapshot === 'function') {
          activeLocaleId = ctx.locale.getSnapshot().active;
        }
        if (typeof ctx.on === 'function') {
          ctx.on('locale/change', snapshot => { activeLocaleId = snapshot.active; });
        }
        // The nav label is read through a thunk so it follows the active locale.
        let tr = key => key;
        ctx.effect(() => {
          const dispose = ctx.locale.register(NS, {
          en: {
            today: 'Today',
            last7: '7 days',
            last30: '30 days',
            requests: 'requests',
            balance: 'Balance',
            lifetime: 'Lifetime',
            byModel: 'Model',
            byKey: 'API key',
            allKeys: 'All keys',
            unknownKey: 'not seen today',
            noCredential: 'No management key',
            loading: 'Loading…',
            updated: 'Updated',
            open: 'OpenRouter spend',
            countByKey: 'Count only this API key',
            refreshEvery: 'Refresh every',
            serverDefault: 'Plugin default',
            currency: 'Display currency',
            currencyUsd: 'USD (billed by OpenRouter)',
            currencyRub: 'RUB (converted at the CBR rate)',
            cbrRate: 'CBR rate',
            rubFallback: 'RUB is unavailable: the rate could not be fetched from cbr.ru. Amounts are shown in USD — check that cbr.ru is reachable.',
            managementKey: 'Management API key',
            keyStored: 'Stored as',
            keyHint: 'Needs an OpenRouter management key: Settings → API keys → Management.',
            keyReadOnly: 'A read-only source shadows this reference, so Settings cannot store it.',
            save: 'Save',
            clear: 'Clear',
            reload: 'Reload',
            saved: 'Saved',
            limitKey: 'API key limit',
            limitBalance: 'Account balance',
            limitLeft: '{left} of {limit} left',
            limitConsumed: '{percent}% used',
            periodToday: 'today',
            periodWeek: 'this week',
            periodMonth: 'this month',
            limitResets: 'resets {when}',
            limitResetsIn: 'resets in {minutes} min',
            limitLeftAtRate: '~{duration} at this rate',
            limitDaysAtRate: '~{days} days at this rate',
            limitDaysAtRate_one: '~{days} day at this rate',
            limitUnderADay: 'under a day at this rate',
            limitApproxRequests: '\u2248 {count} requests',
            limitApproxRequests_one: '\u2248 {count} request',
            limitShared: 'shared by all keys',
            limitTightest: 'Tightest of {count} limited keys',
            limitTightest_one: 'Tightest of {count} limited key',
            limitUnavailable: 'Key limits unavailable: {reason}',
            limitBurnUnavailable: 'the pace of spend is unknown: {reason}',
            limitUnknownMatch: 'Limit unknown: this key\u2019s name did not match the account\u2019s key list.',
            limitLevelWarn: 'Limit is running low',
            limitLevelCritical: 'Limit is nearly exhausted',
            limitNotice: 'Limit warning',
            limitNoticeOff: 'Off',
            limitNoticeOn: 'On \u2014 warn when a key limit is running out',
            limitNoticeHint: 'Shows a warning when a tracked key is close to its limit.',
            limitToastPeriodLifetime: 'lifetime',
            limitToastWarn: 'Key "{name}" is at {percent}% of {period}\u2019s {limit} \u2014 ~{estimate} left at this rate.',
            limitToastCritical: 'Key "{name}" is at {percent}% of {period}\u2019s {limit} \u2014 ~{estimate} left at this rate.',
            limitToastWarnNoEstimate: 'Key "{name}" is at {percent}% of {period}\u2019s {limit}.',
            limitToastCriticalNoEstimate: 'Key "{name}" is at {percent}% of {period}\u2019s {limit}.',
            limitToastDismiss: 'Dismiss',
          },
          zh: {
            today: '今天',
            last7: '7 天',
            last30: '30 天',
            requests: '请求',
            balance: '余额',
            lifetime: '累计',
            byModel: '模型',
            byKey: 'API 密钥',
            allKeys: '全部密钥',
            unknownKey: '今天未出现',
            noCredential: '未配置管理密钥',
            loading: '读取中…',
            updated: '更新于',
            open: 'OpenRouter 花费',
            countByKey: '只统计这个 API 密钥',
            refreshEvery: '刷新间隔',
            serverDefault: '插件默认',
            currency: '显示货币',
            currencyUsd: 'USD（OpenRouter 计费货币）',
            currencyRub: 'RUB（按俄罗斯央行汇率换算）',
            cbrRate: '央行汇率',
            rubFallback: 'RUB 不可用：无法从 cbr.ru 获取汇率。金额以 USD 显示——请检查到 cbr.ru 的连接。',
            managementKey: '管理密钥',
            keyStored: '已保存为',
            keyHint: '需要 OpenRouter 管理密钥：Settings → API keys → Management。',
            keyReadOnly: '该引用被只读来源遮蔽，无法在设置中保存。',
            save: '保存',
            clear: '清除',
            reload: '刷新',
            saved: '已保存',
            limitKey: '密钥限额',
            limitBalance: '账户余额',
            limitLeft: '剩余 {left}，共 {limit}',
            limitConsumed: '已用 {percent}%',
            periodToday: '今天',
            periodWeek: '本周',
            periodMonth: '本月',
            limitResets: '{when}重置',
            limitResetsIn: '{minutes} 分钟后重置',
            limitLeftAtRate: '按此速度约 {duration}',
            limitDaysAtRate: '按此速度约 {days} 天',
            limitUnderADay: '按此速度不足一天',
            limitApproxRequests: '约 {count} 个请求',
            limitShared: '所有密钥共用',
            limitTightest: '{count} 个限额密钥中最紧的',
            limitUnavailable: '无法获取密钥限额：{reason}',
            limitBurnUnavailable: '无法确定消耗速度：{reason}',
            limitUnknownMatch: '限额未知：该密钥名称未匹配到账户密钥列表。',
            limitLevelWarn: '限额偏低',
            limitLevelCritical: '限额即将耗尽',
            limitNotice: '限额提醒',
            limitNoticeOff: '关闭',
            limitNoticeOn: '开启 — 密钥限额将耗尽时提醒',
            limitNoticeHint: '默认关闭。开启后芯片显示警示状态，面板显示剩余额度。',
            limitToastPeriodLifetime: '总计',
            limitToastWarn: '密钥"{name}"已用{period}{limit}的{percent}% — 按此速度约剩{estimate}。',
            limitToastCritical: '密钥"{name}"已用{period}{limit}的{percent}% — 按此速度约剩{estimate}。',
            limitToastWarnNoEstimate: '密钥"{name}"已用{period}{limit}的{percent}%。',
            limitToastCriticalNoEstimate: '密钥"{name}"已用{period}{limit}的{percent}%。',
            limitToastDismiss: '关闭',
          },
          ru: {
            today: 'Сегодня',
            last7: '7 дней',
            last30: '30 дней',
            requests: 'запросов',
            balance: 'Баланс',
            lifetime: 'Всего',
            byModel: 'Модель',
            byKey: 'API-ключ',
            allKeys: 'Все ключи',
            unknownKey: 'сегодня не было',
            noCredential: 'Ключ не настроен',
            loading: 'Загрузка…',
            updated: 'Обновлено',
            open: 'Расходы OpenRouter',
            countByKey: 'Учитывать только этот API-ключ',
            refreshEvery: 'Обновлять каждые',
            serverDefault: 'По умолчанию',
            currency: 'Валюта',
            currencyUsd: 'USD (как списывает OpenRouter)',
            currencyRub: 'RUB (по курсу ЦБ РФ)',
            cbrRate: 'Курс ЦБ',
            rubFallback: 'RUB недоступен: не удалось получить курс с cbr.ru. Суммы показаны в USD — проверьте подключение к cbr.ru.',
            managementKey: 'Управляющий API-ключ',
            keyStored: 'Сохранён как',
            keyHint: 'Нужен управляющий ключ OpenRouter: Settings → API keys → Management.',
            keyReadOnly: 'Эта ссылка перекрыта источником только для чтения, настройки не могут её сохранить.',
            save: 'Сохранить',
            clear: 'Очистить',
            reload: 'Обновить',
            saved: 'Сохранено',
            limitKey: 'Лимит ключа',
            limitBalance: 'Баланс аккаунта',
            limitLeft: 'Осталось {left} из {limit}',
            limitConsumed: 'израсходовано {percent}%',
            periodToday: 'сегодня',
            periodWeek: 'на этой неделе',
            periodMonth: 'в этом месяце',
            limitResets: 'сброс {when}',
            limitResetsIn: 'сброс через {minutes} мин',
            limitLeftAtRate: '~{duration} при таком темпе',
            // The base key is the `other`/`many` form; the suffix keys carry the
            // one and few forms `tPlural` selects. Russian needs all three, which
            // is why the numeral cannot be hardcoded in a single string.
            limitDaysAtRate: '~{days} дней при таком темпе',
            limitDaysAtRate_one: '~{days} день при таком темпе',
            limitDaysAtRate_few: '~{days} дня при таком темпе',
            limitUnderADay: 'меньше суток при таком темпе',
            limitApproxRequests: '\u2248 {count} запросов',
            limitApproxRequests_one: '\u2248 {count} запрос',
            limitApproxRequests_few: '\u2248 {count} запроса',
            limitShared: 'общий для всех ключей',
            limitTightest: 'Самый жёсткий из {count} ключей с лимитом',
            limitTightest_one: 'Самый жёсткий из {count} ключа с лимитом',
            limitUnavailable: 'Лимиты ключей недоступны: {reason}',
            limitBurnUnavailable: 'темп расхода неизвестен: {reason}',
            limitUnknownMatch: 'Лимит неизвестен: имя ключа не совпало со списком ключей аккаунта.',
            limitLevelWarn: 'Лимит подходит к концу',
            limitLevelCritical: 'Лимит почти исчерпан',
            limitNotice: 'Предупреждение о лимите',
            limitNoticeOff: 'Выключено',
            limitNoticeOn: 'Включено — предупреждать, когда лимит ключа заканчивается',
            limitNoticeHint: 'По умолчанию выключено. При включении чип показывает предупреждение, а панель — сколько лимита осталось.',
            limitToastPeriodLifetime: 'всего',
            limitToastWarn: 'Ключ "{name}" израсходовал {percent}% лимита {period} ({limit}) — при таком темпе осталось ~{estimate}.',
            limitToastCritical: 'Ключ "{name}" израсходовал {percent}% лимита {period} ({limit}) — при таком темпе осталось ~{estimate}.',
            limitToastWarnNoEstimate: 'Ключ "{name}" израсходовал {percent}% лимита {period} ({limit}).',
            limitToastCriticalNoEstimate: 'Ключ "{name}" израсходовал {percent}% лимита {period} ({limit}).',
            limitToastDismiss: 'Закрыть',
          },
        });
          tr = ctx.locale.bind(NS);
          return dispose;
        });
        const section = { id: 'openrouter-spend', order: 30, label: () => tr('open'), locale: NS };
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'openrouter-spend', order: 2, label: section.label, locale: NS,
        }, Pill));
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', ...section,
        }, Settings));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'openrouter-spend-limit-toast', locale: NS,
        }, ToastOverlay));
      },
    };
  },
});