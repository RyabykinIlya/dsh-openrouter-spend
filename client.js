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

    /** The host's one summary route; `?force=1` asks it to skip its own cache. */
    const SUMMARY_URL = '/openrouter-spend/summary';

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
/* The refresh failure block: the sentence, the wire's own detail under it, the
   countdown to the next automatic attempt, and the button that asks for one now.
   It replaces the bare error line, which named the fault but never the schedule. */
.ors-refresh { margin-top: 8px; padding-top: 8px; border-top: 0.5px solid var(--dsw-alias-separator-primary); }
.ors-detail { word-break: break-word; }
.ors-refresh-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; }
.ors-retry {
  padding: 3px 10px; border: 0; border-radius: 6px; cursor: pointer;
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xxs-12, 12px/1.4 system-ui);
}
.ors-retry:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover)); }
.ors-retry:disabled { cursor: default; color: var(--dsw-alias-label-tertiary); }
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

    /**
     * The one key the chip's `session/day` pair is scoped to, and the two
     * figures on it (ADR-0006).
     *
     * The pair is `this chat / its key's day`. Both halves must name the same
     * key: `36.44/36.53` says "this chat is most of what that key spent today",
     * while `36.44/89.93` (this chat over the whole account's day) is a share of
     * something the chat is not part of, and it contradicted the popover, whose
     * head is the tracked key's day. So the key is resolved first, then both
     * figures are read from it.
     *
     * Refusal over guesswork, in the order the ambiguity bites:
     *  - no session row in the payload: nothing to pair.
     *  - `todayKeys` absent: the host could not split this session by key, so
     *    no key can be honestly named. The caller shows one figure instead.
     *  - no tracked key and the session spans several keys: picking the largest
     *    would invent an attribution the data does not support.
     *  - the resolved key has no row in `byKey`: the denominator is unknown, and
     *    a pair with a guessed denominator misreports cost.
     *  - a zero denominator: the pair would read `0.00/0.00`, which is not a
     *    share of anything.
     *
     * Pure and payload-fed so every branch is testable without a live host.
     * @returns `{ keyId, sessionUsd, dayUsd }`, or `undefined` when no honest
     * pair exists — the caller then falls back to a single scoped figure.
     */
    function chipPairFor({ sessionRow, keyId, keys } = {}) {
      if (sessionRow === undefined || sessionRow === null) return undefined;
      const shares = sessionRow.todayKeys;
      // An absent split is "could not read", never "no key spent": those two
      // must not collapse into the same zero (the containment rule the host's
      // `limitsError` / `burnError` follow).
      if (!Array.isArray(shares)) return undefined;
      const tracked = typeof keyId === 'string' && keyId.length > 0 ? keyId : undefined;
      const resolved = tracked ?? (shares.length === 1 ? shares[0]?.id : undefined);
      if (typeof resolved !== 'string' || resolved.length === 0) return undefined;
      const keyRow = (Array.isArray(keys) ? keys : []).find(entry => entry?.id === resolved);
      if (keyRow === undefined) return undefined;
      const dayUsd = Number(keyRow.todayUsd);
      if (!Number.isFinite(dayUsd) || dayUsd <= 0) return undefined;
      const share = shares.find(entry => entry?.id === resolved);
      const sessionUsd = Number(share?.usd ?? 0);
      if (!Number.isFinite(sessionUsd) || sessionUsd < 0) return undefined;
      // The chat's share of a key cannot exceed that key's day. A payload that
      // says otherwise was built from two different keys, which is the very bug
      // this scoping exists to prevent, so the pair is refused rather than
      // printed with a numerator that cannot belong to its denominator.
      if (sessionUsd > dayUsd * (1 + 1e-9)) return undefined;
      return { keyId: resolved, sessionUsd, dayUsd };
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

    /**
     * The period a seen limit was seen in, as the design doc pins it
     * (docs/design/limit-notice.md, "Retirement — seen"): the UTC day for
     * `daily`, the ISO week for `weekly`, the ISO month for `monthly`, and
     * the literal `ever` for a lifetime cap. Each anchor is the same UTC
     * midnight `nextResetMs` refills the budget on, so the key turns exactly
     * when the budget does.
     */
    function periodStartKey(limitReset, nowMs) {
      if (limitReset === 'daily') return new Date(nowMs).toISOString().slice(0, 10);
      if (limitReset === 'weekly') {
        // The ISO week runs Monday to Sunday, and the Thursday of the week
        // decides the ISO year: a week straddling New Year belongs to the
        // year that holds more of it. Jan 4 always sits inside week 1, which
        // is what makes the count a subtraction rather than a calendar walk.
        const date = new Date(nowMs);
        const weekday = (date.getUTCDay() + 6) % 7;
        const thursday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - weekday + 3);
        const year = new Date(thursday).getUTCFullYear();
        const week = 1 + Math.round((thursday - Date.UTC(year, 0, 4)) / (7 * MS_PER_DAY));
        return `${year}-W${String(week).padStart(2, '0')}`;
      }
      if (limitReset === 'monthly') return new Date(nowMs).toISOString().slice(0, 7);
      return 'ever';
    }

    /**
     * The full seen-limit key, `` `${keyId}:${level}:${periodStart}` `` — the
     * design doc's contract. The period in the key is what re-arms the toast:
     * a daily cap exhausted yesterday warns again today, because the budget
     * is genuinely new. Pure and clock-fed so the turn of a period is
     * testable without a component. A value stored by an older build
     * (`${keyId}:${level}`, no period) matches nothing, which re-arms every
     * key once on upgrade — the honest direction: one extra warning beats a
     * permanently muted one.
     */
    function seenLimitKey(keyId, level, limitReset, nowMs = Date.now()) {
      return `${keyId}:${level}:${periodStartKey(limitReset, nowMs)}`;
    }

    /** Write the seen limit as `${keyId}:${level}:${periodStart}`. */
    function writeSeenLimit(keyId, level, limitReset) {
      writePref(PREF_SEEN_LIMIT, seenLimitKey(keyId, level, limitReset));
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
        // A zone-less date-time — the `date__hour` shape the analytics wire
        // sends — is UTC by contract: OpenRouter aggregates the UTC day. A
        // bare `Date.parse` reads it in the READER's zone, skewing the burn
        // window by the local offset (m12), so the designator is supplied
        // here and both helpers that read these stamps share one clock.
        const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value) ? `${value}Z` : value;
        const at = Date.parse(utc);
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

    /**
     * Spend per closed UTC day, today excluded because it is still filling.
     * Stamps go through `parseInstant` so the day is the UTC day for every
     * shape the wire uses: a numeric epoch counts here exactly as it counts
     * in `windowedBurn`'s window (m12 made the siblings consistent — they
     * used to disagree about numeric stamps). A stamp that will not parse is
     * skipped while `windowedBurn` keeps it: a figure with no day must not
     * vanish from the window, but it cannot contribute to a per-day rate.
     */
    function closedDayTotals(burn, nowMs) {
      const today = new Date(nowMs).toISOString().slice(0, 10);
      const totals = new Map();
      for (const bucket of Array.isArray(burn) ? burn : []) {
        const usd = Number(bucket?.usd);
        const at = parseInstant(bucket?.ts);
        if (at === undefined || !Number.isFinite(usd)) continue;
        const day = new Date(at).toISOString().slice(0, 10);
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
        // The raw `limitReset` rides along (M1): the toast reads it to name
        // the period the cap refills on, and without it every periodic-cap
        // toast introduced itself as "lifetime". Raw and unparsed on purpose
        // — the consumers compare it against the wire's own vocabulary.
        limitReset,
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
     * The level of the ACCOUNT BALANCE — the prepaid pool every key spends
     * from, the unlimited ones included (ADR-0007). The key limits above answer
     * "can this key spend"; this answers "can the ACCOUNT spend", which is the
     * question that actually stops work on the day the pool runs dry.
     *
     * The balance never refills on a schedule — only a top-up moves it — so it
     * is a lifetime cap by shape and is judged by the same runway metric: the
     * remainder over the median daily account burn. The burn is the union of
     * every key's hourly window, unlimited keys included, because the pool is
     * shared: a key with `limit: null` is exactly the one that can drain it.
     *
     * One deliberate asymmetry with `limitState`: no hysteresis on the recent
     * escalation below. The median moves only when a UTC day boundary crosses a
     * bucket in or out of the window, so the level cannot flicker on a poll the
     * way a consumed share can, and a margin here would only delay the one
     * warning this function exists to raise.
     */
    function balanceState(input) {
      const { credits, burn, nowMs = Date.now(), previous } = input ?? {};
      const total = Number(credits?.totalCredits);
      const used = Number(credits?.totalUsage);
      if (!Number.isFinite(total) || !Number.isFinite(used)) return { level: 'none' };
      const balance = Math.max(0, total - used);
      const shared = {
        lifetime: true,
        balanceUsd: balance,
        remainingUsd: balance,
        // `of {limit} left` reads as "of what was ever credited", which is the
        // honest denominator for a pool that only refills by hand.
        limitUsd: total,
        // The consumed share of the credited total — the percentage the balance
        // block shows, so its meter fills like the key meters instead of
        // counting down a number nobody recognises.
        percent: total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : undefined,
      };
      if (!(balance > 0)) {
        // A pool at or past zero stops work now; no window can make that mild.
        return { level: 'critical', ...shared };
      }
      // `burnHourly` arrives keyed by key; the pool question needs the union.
      const burnList = Array.isArray(burn) ? burn
        : Object.values(burn ?? {}).flatMap(list => (Array.isArray(list) ? list : []));
      const days = closedDayTotals(windowedBurn(burnList, nowMs), nowMs);
      if (days.length < LIMIT_MIN_CLOSED_DAYS) return { level: 'none', ...shared };
      const perDay = median(days);
      if (!(perDay > 0)) return { level: 'none', ...shared };
      const runwayDays = balance / perDay;
      let level = runwayDays <= 1 + LIMIT_EPSILON ? 'critical' : runwayDays <= 3 + LIMIT_EPSILON ? 'warn' : 'none';
      // Hysteresis in whole days, same margins and same reason as the lifetime
      // key branch: a median sitting on the boundary must not flicker the dot.
      if (level === 'none' && previous === 'warn' && runwayDays <= LIFETIME_LEAVE_WARN_DAYS + LIMIT_EPSILON) level = 'warn';
      if (level === 'warn' && previous === 'critical' && runwayDays <= LIFETIME_LEAVE_CRITICAL_DAYS + LIMIT_EPSILON) level = 'critical';
      // The recent-pace escalation: a ramp spends the pool faster than the
      // seven-day median admits, and the median would notice a week late —
      // after the pool is gone. The mean of the last three closed days is the
      // noisiest short window worth trusting; it can only escalate, never
      // quiet a level the median raised, because a quiet weekend must not
      // talk the alarm down. When it escalates, the published runway switches
      // to its own pace, so the sentence's days agree with the level beside
      // them — "~6 days at this rate" beside a critical meter would read as
      // a contradiction.
      let runwayOf = perDay;
      if (level !== 'critical') {
        const recent = days.slice(-3);
        const recentPerDay = recent.reduce((sum, value) => sum + value, 0) / recent.length;
        if (recentPerDay > 0) {
          const recentRunwayDays = balance / recentPerDay;
          if (recentRunwayDays <= 1 + LIMIT_EPSILON) level = 'critical';
          else if (level === 'none' && recentRunwayDays <= 3 + LIMIT_EPSILON) level = 'warn';
          if (recentPerDay > perDay) runwayOf = recentPerDay;
        }
      }
      return { level, ...shared, perDayUsd: runwayOf, runwayDays: balance / runwayOf };
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
     * The dictionary key naming the period a limit toast speaks about. Pure,
     * so the phrase cannot drift from the period the state carries: the Toast
     * used to read `state.limitReset`, which `limitState` never returned, so
     * every periodic cap introduced itself as "lifetime" (M1). Lifetime is
     * checked first because it is the derived truth, not one more string
     * comparison against the wire's vocabulary.
     */
    function toastPeriodKey(state) {
      if (state?.lifetime) return 'limitToastPeriodLifetime';
      if (state?.limitReset === 'daily') return 'periodToday';
      if (state?.limitReset === 'weekly') return 'periodWeek';
      if (state?.limitReset === 'monthly') return 'periodMonth';
      return 'limitToastPeriodLifetime';
    }

    /**
     * The dot state. A broken reading outranks a full budget — `error` and
     * `no-credential` stay visible — and a limit level outranks `stale`, because
     * stale figures beside an exhausted cap still need to say so.
     *
     * `balanceLevel` (ADR-0007) can only raise, never lower what the tracked
     * key's own level shows: a pool with under a day left stops work before any
     * key limit does, so it holds the dot even while the tracked key looks
     * healthy. No parameter means `none`, which is the old behaviour exactly.
     *
     * `error` stays mapped although today's host turns its 502s into client
     * failures before a payload is ever rendered (N1): the mapping describes
     * the status vocabulary the route documents, and a host that ever serves
     * `status: 'error'` with a 200 must still get the red dot. The cost is one
     * CSS rule; the alternative is a status the wire can name but the dot
     * cannot show.
     */
    function dotState(status, level, balanceLevel) {
      if (status === 'error' || status === 'no-credential') return status;
      // The stricter of the two alarms holds the dot: rank and compare, so a
      // healthy key cannot amber over a nearly-empty pool and vice versa.
      const rank = { critical: 2, warn: 1, none: 0 };
      const effective = (rank[balanceLevel] ?? 0) > (rank[level] ?? 0) ? balanceLevel : level;
      if (effective === 'critical') return 'limit-critical';
      if (effective === 'warn') return 'limit-warn';
      return status ?? 'loading';
    }

    /**
     * Milliseconds to the next attempt after `failures` consecutive failures.
     * The host schedules its own retries and announces them as `nextRefreshAt`;
     * this mirror only covers a host that never answered at all, where there is
     * no announcement to follow. The ladder matches the host's: quick once,
     * then the ordinary cadence, never longer than it.
     */
    function retryDelayMs(failures, refreshSeconds) {
      const ladder = failures <= 1 ? 15 : failures === 2 ? 30 : refreshSeconds;
      return Math.min(ladder, refreshSeconds) * 1000;
    }

    /**
     * When the next poll is due. A failed read follows the host's own
     * `nextRefreshAt`, because that is where the retry ladder lives; an explicit
     * interval preference is the user's cadence and governs healthy reads.
     * `nowMs` is a parameter so the schedule is testable without a clock.
     */
    function nextPollMs(data, intervalSeconds, nowMs) {
      const announced = Date.parse(data?.nextRefreshAt ?? '');
      const failed = data?.status === 'stale' || data?.status === 'error';
      if (failed && Number.isFinite(announced)) return announced;
      if (intervalSeconds > 0) return nowMs + intervalSeconds * 1000;
      if (Number.isFinite(announced)) return announced;
      return nowMs + (Number(data?.refreshSeconds) || 60) * 1000;
    }

    /** `m:ss` for a countdown. Zero and negatives read as `0:00`, never `-1`. */
    function formatCountdown(ms) {
      const total = Math.max(0, Math.ceil(ms / 1000));
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    }

    /**
     * The dictionary key naming a failure code. The code comes from the host
     * (`describeFailure`) or from this half for a reply that never arrived; the
     * raw detail always rides beside the sentence, so an unrecognised code
     * still leaves the reader something to act on.
     */
    function failureLabelKey(code) {
      switch (code) {
        case 'network': return 'errorNetwork';
        case 'timeout': return 'errorTimeout';
        case 'auth': return 'errorAuth';
        case 'rate-limit': return 'errorRateLimit';
        case 'request': return 'errorRequest';
        case 'server': return 'errorServer';
        case 'data': return 'errorData';
        case 'host': return 'errorHost';
        default: return 'errorUnknown';
      }
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
     * button and the popover's Retry are explicit requests for the current
     * figures, so they must not be handed a reply that was already in flight.
     * The host skips its own cache for them as well.
     *
     * The answer is a result rather than a payload: a reply that never arrived
     * is a state the chip has to show, and it cannot share the `undefined` that
     * "nothing to change" used to mean.
     */
    function fetchSummary(force) {
      const at = Date.now();
      if (!force && summaryInflight !== undefined && at - summaryInflightAt < SUMMARY_COALESCE_MS) {
        return summaryInflight;
      }
      summaryInflightAt = at;
      summaryInflight = fetch(force ? `${SUMMARY_URL}?force=1` : SUMMARY_URL, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      }).then(async response => {
        if (!response.ok) {
          // The plugin's own route answered badly; its body carries the reason.
          const detail = await response.json().catch(() => undefined);
          return {
            ok: false,
            reason: typeof detail?.error === 'string' ? detail.error : `HTTP ${response.status}`,
            code: response.status === 502 ? 'host' : 'request',
          };
        }
        return { ok: true, data: await response.json() };
      }).catch(error => ({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        code: 'network',
      }));
      return summaryInflight;
    }

    /**
     * The one poll the two live components share. Every reply announces its own
     * schedule (`nextRefreshAt`), so the timer follows the host rather than a
     * fixed interval — that is what makes the shorter retry after a failure both
     * real and visible. `failure` is the last read that did not succeed: the
     * host's own `stale` verdict, or a reply that never arrived.
     *
     * `intervalSeconds` is the user's explicit preference; it governs healthy
     * reads and is passed through to `nextPollMs`.
     */
    function useSummaryPoll(intervalSeconds) {
      const [data, setData] = useState(null);
      const [failure, setFailure] = useState(null);
      const [busy, setBusy] = useState(false);
      const [dueAt, setDueAt] = useState(0);
      const [nowMs, setNowMs] = useState(() => Date.now());
      const failuresRef = useRef(0);
      const busyRef = useRef(false);
      const aliveRef = useRef(true);

      // Reset on mount as well as cleared on unmount: a development double-mount
      // runs the cleanup once, and a flag that only ever goes false would leave
      // the component unable to render a reply for the rest of its life.
      useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
      }, []);

      const load = useCallback(async force => {
        // One read at a time per component: a manual Retry while a poll is in
        // flight must not become two upstream queries. The in-flight read sets
        // the next `dueAt` itself, so a dropped tick cannot stall the poll.
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        const reply = await fetchSummary(force);
        busyRef.current = false;
        if (!aliveRef.current) return;
        setBusy(false);
        setNowMs(Date.now());
        if (reply.ok) {
          const payload = reply.data;
          setData(payload);
          const failed = payload.status === 'stale' || payload.status === 'error';
          failuresRef.current = failed ? failuresRef.current + 1 : 0;
          setFailure(failed ? { reason: payload.error ?? '', code: payload.errorCode } : null);
          setDueAt(nextPollMs(payload, intervalSeconds, Date.now()));
        } else {
          failuresRef.current += 1;
          setFailure({ reason: reply.reason, code: reply.code });
          const seconds = intervalSeconds > 0 ? intervalSeconds : 60;
          setDueAt(Date.now() + retryDelayMs(failuresRef.current, seconds));
        }
      }, [intervalSeconds]);

      // The timer follows `dueAt`, which every completed read rewrites.
      useEffect(() => {
        const delay = dueAt === 0 ? 0 : Math.max(1000, dueAt - Date.now());
        const timer = setTimeout(() => { void load(false); }, delay);
        return () => clearTimeout(timer);
      }, [dueAt, load]);

      // The countdown needs a clock only while something is wrong.
      useEffect(() => {
        if (failure === null) return undefined;
        const timer = setInterval(() => setNowMs(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [failure]);

      const refresh = useCallback(() => { void load(true); }, [load]);

      return { data, failure, busy, dueAt, nowMs, refresh };
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
      const period = t(toastPeriodKey(state));
      const estimate = state.runwayMs !== undefined
        ? fmtDuration(state.runwayMs)
        : state.runwayDays !== undefined
        ? fmtDuration(state.runwayDays * MS_PER_DAY)
        : undefined;

      // The balance toast (ADR-0007) speaks in money and days, not in a
      // percentage of a period the pool does not have: there is no period.
      // {left} is the remaining balance and {limit} the total ever credited,
      // the same "of what was ever credited" reading the popover sentence has.
      const message = props.balance === true
        ? (estimate !== undefined
          ? t(level === 'critical' ? 'limitToastBalanceCritical' : 'limitToastBalanceWarn', {
            left: money.fmt(state.remainingUsd),
            limit: money.fmt(state.limitUsd),
            estimate,
          })
          : t(level === 'critical' ? 'limitToastBalanceCriticalNoEstimate' : 'limitToastBalanceWarnNoEstimate', {
            left: money.fmt(state.remainingUsd),
            limit: money.fmt(state.limitUsd),
          }))
        : (estimate !== undefined
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
          }));

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
      const [open, setOpen] = useState(false);
      const [range, setRange] = useState('today');
      const [keyId, setKeyId] = useState(() => readPref(PREF_KEY_ID, ''));
      const [intervalSeconds, setIntervalSeconds] = useState(() => Number(readPref(PREF_INTERVAL, '0')));
      const [currency, setCurrency] = useState(readCurrency);
      // The limit warning is opt-in, and reads the same store Settings writes.
      const [noticeOn, setNoticeOn] = useState(readLimitNotice);
      const rootRef = useRef(null);
      // The previous BALANCE level, for `balanceState`'s hysteresis. Kept apart
      // from the key level ref on purpose: the two metrics move on different
      // inputs, and a top-up must be able to quiet the balance alarm even while
      // the tracked key sits at the same level.
      const balanceLevelRef = useRef('none');
      // The previous level, so `limitState` can apply its hysteresis without
      // becoming stateful. A ref and not state: it must not trigger a render.
      // The history also names the key it belongs to: a key switch must not
      // carry the old key's level into the new key's hysteresis (m10) — a
      // critical key followed by a warn key would otherwise hold the warn
      // at critical's leave-margin and misreport it.
      const levelRef = useRef({ keyId: '', level: 'none' });
      // The figures, the last failure, and the schedule the host announced.
      const { data, failure, busy, dueAt, nowMs, refresh } = useSummaryPoll(intervalSeconds);
      // How long until the next automatic attempt, and the two sentences that
      // carry it: the chip's tooltip and the panel's status block.
      const retryIn = formatCountdown(Math.max(0, dueAt - nowMs));
      const failureText = failure === null
        ? undefined
        : t('refreshFailed', { reason: t(failureLabelKey(failure.code)) });
      const chipTitle = failure === null
        ? t('open')
        : t('refreshFailedTitle', { reason: t(failureLabelKey(failure.code)), time: retryIn });
      // With nothing read yet, a failure is still amber rather than grey: the
      // chip is not loading, it is waiting for a retry, and the tooltip says
      // so. A failure beside a good read is amber too (ADR-0005: "the last
      // good figures are still on screen, but the latest read failed") — the
      // blue dot would say healthy exactly when the reader stopped being
      // served. The broken statuses outrank it: `no-credential` keeps its red.
      const dotStatus = failure === null
        ? data?.status
        : data?.status === 'ok' || data?.status === undefined ? 'stale' : data?.status;

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
      // A failed lineage read leaves the session figure holding only the
      // session's own requests, not what it delegated (ADR-0003): the number
      // understates. Pairing an understated numerator against a complete day
      // would read as a share that is silently too small, so the pair is
      // dropped and the single scoped figure stands instead.
      const sessionSplitTrusted = data?.bySession !== undefined && data?.lineageError === undefined;
      const pair = sessionSplitTrusted ? chipPairFor({ sessionRow, keyId, keys }) : undefined;
      // Both figures of the pair name one key: this chat's spend on it over
      // that same key's day (ADR-0006). Without a pair that holds together the
      // chip keeps a single figure — the figure whose scope the popover head
      // already shows — rather than dividing across two keys.
      const chipPair = pair === undefined ? undefined : money.fmtPair(pair.sessionUsd, pair.dayUsd);

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
          previous: levelRef.current.keyId === keyId ? levelRef.current.level : 'none',
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
        levelRef.current = { keyId, level: noticeState.level };
      });
      // The account balance is its own cap (ADR-0007): the pool every key
      // spends from, judged by the same runway metric a lifetime key limit is.
      // Computed from data the summary already carries — `credits` and the
      // union of `burnHourly` — so the feature adds no request of its own.
      const balanceNotice = noticeOn && data !== null && data?.credits !== undefined
        ? balanceState({
          credits: data.credits,
          burn: data?.burnHourly,
          previous: balanceLevelRef.current,
        })
        : undefined;
      // Carry the balance level forward the same way the key level rides its
      // ref, for the same reason: the hysteresis needs a previous, and state
      // would re-render on a figure nothing displays.
      useEffect(() => {
        if (balanceNotice === undefined) return;
        balanceLevelRef.current = balanceNotice.level;
      });
      // When the popover opens, mark the current level as seen, in the period
      // the cap is currently running (M2: the design doc's key). This effect must
      // stay *below* the `noticeState` declaration: its dependency array is read
      // during render, and reading a `const` above its own declaration is a
      // temporal dead zone reference that throws on every render.
      useEffect(() => {
        if (open && noticeOn && keyId !== '' && noticeState?.level && noticeState.level !== 'none') {
          writeSeenLimit(keyId, noticeState.level, noticeState.limitReset);
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

      // One block, four shapes. It reports what is known and names the gap when
      // nothing is — a missing limit must never read as a healthy one.
      //
      // The account balance used to be shown as information only (ADR-0007
      // supersedes that reading): a bare "3% left · shared by all keys" that
      // told the reader neither what the percent was of, nor how long the
      // money lasts. The balance is now judged by the same runway metric as a
      // lifetime key limit, and when it is the stricter alarm it takes the
      // block — with days in the sentence, a consumed meter beside it, and a
      // tooltip saying what the pool is.
      let quota;
      if (noticeOn && data !== null) {
        const balanceBinds = balance !== undefined && keyLimit !== undefined
          && balance < keyLimit.limitRemaining;
        const levelRank = { critical: 2, warn: 1, none: 0 };
        const balanceLevel = balanceNotice?.level ?? 'none';
        const keyLevel = noticeState?.level ?? 'none';
        // The balance takes the block when it is the stricter alarm — the pool
        // stops work before any key limit does — or when nothing else has a
        // block to show. One number beats two: the key limit stays hidden in
        // this shape, because "top up" is the action and the key's remainder
        // is not what decides it.
        const balanceTakes = balance !== undefined
          && (levelRank[balanceLevel] > levelRank[keyLevel]
            || balanceBinds
            || (keyId === '' && tightest === undefined));
        if (limitUnknown) {
          quota = {
            level: 'unknown',
            key: t('limitKey'),
            pct: undefined,
            note: data.limitsError !== undefined
              ? t('limitUnavailable', { reason: data.limitsError })
              : t('limitUnknownMatch'),
          };
        } else if (balanceTakes) {
          // The sentence speaks in money and days: "… of … left · ~N days at
          // this rate", with "shared by all keys" naming the pool, because
          // that is what the reader came for and what the block used to omit.
          const sentence = balanceNotice !== undefined
            ? limitSentence(balanceNotice, money, t, activeLocaleId)
            : undefined;
          const parts = [sentence, t('limitShared')].filter(part => part !== undefined);
          quota = {
            level: balanceLevel,
            key: t('limitBalance'),
            hint: t('limitBalanceHint'),
            pct: balanceNotice?.percent,
            note: withBurnNote(parts.join(' \u00b7 '), burnNote),
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
          'aria-label': chipTitle,
          title: chipTitle,
          onClick: () => setOpen(value => !value),
        },
        h('span', {
          className: 'ors-chip-dot',
          role: 'img',
          'data-state': dotState(dotStatus, noticeState?.level, balanceNotice?.level),
          // The dot is the only at-a-glance signal, so its colour is always
          // doubled by a label naming the level — or, when there is no level to
          // name, by the reason the figures are stale. The label names the
          // stricter of the two alarms, matching the colour `dotState` picked.
          'aria-label': (noticeState?.level === 'critical' || balanceNotice?.level === 'critical') ? t('limitLevelCritical')
            : (noticeState?.level === 'warn' || balanceNotice?.level === 'warn') ? t('limitLevelWarn')
            : failureText,
        }),
        h('span', { className: 'ors-chip-amount' },
          data === null
            ? (failure === null ? t('loading') : '\u2014')
            : chipPair ?? money.fmt(view.usd))),
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
          quota === undefined ? null : h('div', {
            className: 'ors-quota',
            'data-level': quota.level,
            // The balance block's only explanation of what the pool IS: the
            // percentage alone says "3%" of nothing in particular, so the hint
            // rides along as a tooltip rather than as a second sentence.
            title: quota.hint,
          },
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
          // A session read that failed must say so: the chip silently drops its
          // pair, and without a sentence here that would look like a chat that
          // spent nothing rather than one whose split could not be read.
          data?.sessionsError === undefined ? null : h('div', { className: 'ors-note' },
            t('sessionsUnavailable', { reason: data.sessionsError })),
          data?.lineageError === undefined ? null : h('div', { className: 'ors-note' },
            t('lineageUnavailable', { reason: data.lineageError })),
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
          failure === null ? null : h('div', { className: 'ors-refresh' },
            h('div', { className: 'ors-note' }, failureText),
            // The wire's own words, so a fault nobody classified is still
            // actionable rather than rounded off to "something went wrong".
            failure.reason === '' ? null : h('div', { className: 'ors-sub ors-detail' }, failure.reason),
            h('div', { className: 'ors-refresh-row' },
              h('span', { className: 'ors-sub' }, t('nextAttemptIn', { time: retryIn })),
              h('button', {
                type: 'button',
                className: 'ors-retry',
                // Disabled for any read in flight, not just a forced one: a
                // click during a poll would be dropped, and a button that does
                // nothing when pressed is worse than one that says why.
                disabled: busy,
                onClick: () => refresh(),
                // The label derives from the same state that disables the
                // button (m11): it used to read "Retry now" while a background
                // poll held it disabled, promising the action it refuses.
              }, busy ? t('retrying') : t('retryNow'))))));
    }

    /**
     * The toast overlay: a frame-wide component that listens for limit
     * escalations and shows a dismissible notice. Registered in shell.overlay.
     */
    function ToastOverlay(props) {
      const { t } = props;
      const [keyId, setKeyId] = useState(() => readPref(PREF_KEY_ID, ''));
      const [currency, setCurrency] = useState(readCurrency);
      const [noticeOn, setNoticeOn] = useState(readLimitNotice);
      const [seenLimit, setSeenLimit] = useState(() => readSeenLimit());
      // The live toast: `{ kind: 'key' | 'balance', level }`. A key toast names
      // the tracked key; a balance toast (ADR-0007) names the pool, and its
      // seen-key is written under the id `balance`. One live toast at a time:
      // a newer escalation replaces the previous, whichever kind it is.
      const [toast, setToast] = useState(null);
      // The escalation history, scoped to the tracked key (m10): the old key's
      // level must not decide the new key's hysteresis or swallow its toast.
      const levelRef = useRef({ keyId: '', level: 'none' });
      // The balance's own escalation history. It is not scoped to any key — the
      // pool is shared — so a plain level rides the ref.
      const balanceLevelRef = useRef('none');
      // The overlay has no interval preference of its own: it reads on the
      // host's schedule, which is the same one the chip follows.
      const { data } = useSummaryPoll(0);

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
          previous: levelRef.current.keyId === keyId ? levelRef.current.level : 'none',
          thresholds: data?.limitThresholds,
        })
        : undefined;
      // The balance alarm rides the same poll (ADR-0007): the pool every key
      // spends from, unlimited keys included, judged by the same runway metric.
      const balanceNotice = noticeOn && data !== null && data?.credits !== undefined
        ? balanceState({
          credits: data.credits,
          burn: data?.burnHourly,
          previous: balanceLevelRef.current,
        })
        : undefined;

      // A toast belongs to the key it escalated on. When the tracked key
      // changes, retire it rather than re-render the old escalation against
      // the new key's figures; a fresh escalation for the new key re-fires in
      // the effect below. Declared above that effect so the reset lands first
      // within one commit. The BALANCE toast survives the switch: the pool did
      // not change with the tracked key, so neither does its escalation.
      useEffect(() => { setToast(value => (value === null || value.kind === 'key' ? null : value)); }, [keyId]);

      // Carry the levels forward and read both escalations in one pass: the
      // previous level must be captured before it is overwritten, and two
      // effects cannot promise that order — the first one to run would hand
      // the second the current level as its own history, and no escalation
      // would ever fire.
      useEffect(() => {
        if (noticeState !== undefined) {
          const current = noticeState.level;
          const previous = levelRef.current.keyId === keyId ? levelRef.current.level : 'none';
          levelRef.current = { keyId, level: current };
          // The seen key names the period the cap is running in (M2), so a
          // dismissal last period does not silence this one: a budget that
          // refilled is genuinely new and must be allowed to warn again.
          if (noticeOn && keyId !== ''
            && escalates(previous, current) && seenLimit !== seenLimitKey(keyId, current, noticeState.limitReset)) {
            setToast({ kind: 'key', level: current });
          }
        }
        if (balanceNotice !== undefined) {
          const current = balanceNotice.level;
          const previous = balanceLevelRef.current;
          balanceLevelRef.current = current;
          // The balance never refills on a schedule, so its seen key has no
          // period to turn: `ever` is the anchor, and only a real top-up
          // (which moves `balanceUsd` and usually de-escalates the level)
          // re-arms it. The pool's alarm outranks a key's when both fire in
          // one commit — the pool stops work first.
          if (noticeOn
            && escalates(previous, current) && seenLimit !== seenLimitKey('balance', current, undefined)) {
            setToast({ kind: 'balance', level: current });
          }
        }
      });

      const money = makeMoney(currency, data?.rate?.perUsd);

      // Retire the live toast and record the level as seen, in the period the
      // cap it named is running. The balance's `limitReset` is undefined, so
      // its seen key lands on the literal `ever` — one dismissal holds until
      // the balance itself moves.
      const retireToast = useCallback(() => {
        if (toast === null) return;
        if (toast.kind === 'balance') {
          writeSeenLimit('balance', toast.level, undefined);
        } else {
          writeSeenLimit(keyId, toast.level, noticeState?.limitReset);
        }
        setToast(null);
      }, [keyId, toast, noticeState?.limitReset]);

      const handleDismiss = useCallback(() => { retireToast(); }, [retireToast]);

      const handleOpen = useCallback(() => {
        window.dispatchEvent(new CustomEvent(EVENT_OPEN_POPOVER));
        retireToast();
      }, [retireToast]);

      if (!noticeOn || toast === null) return null;
      if (toast.kind === 'balance') {
        return h(Toast, {
          balance: true,
          keyId: 'balance',
          level: toast.level,
          state: balanceNotice,
          money,
          t,
          onDismiss: handleDismiss,
          onOpen: handleOpen,
        });
      }
      if (!noticeState) return null;

      return h(Toast, {
        keyId,
        level: toast.level,
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
        if (reply.ok) setData(reply.data);
        else setNotice(reply.reason);
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
      balanceState,
      limitSentence,
      chipPairFor,
      pluralCategory,
      tPlural,
      withBurnNote,
      dotState,
      escalates,
      toastPeriodKey,
      periodStartKey,
      seenLimitKey,
      retryDelayMs,
      nextPollMs,
      formatCountdown,
      failureLabelKey,
      fmtDuration,
      nextResetMs,
      resetTextFor,
      median,
      peakHourlyBurn,
      windowedBurn,
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
            refreshFailed: 'Could not refresh: {reason}',
            refreshFailedTitle: 'OpenRouter spend \u2014 could not refresh: {reason}. Next attempt in {time}.',
            nextAttemptIn: 'Next attempt in {time}',
            retryNow: 'Retry now',
            retrying: 'Retrying\u2026',
            errorNetwork: 'OpenRouter is unreachable from this machine',
            errorTimeout: 'OpenRouter did not answer in time',
            errorAuth: 'the management key was rejected',
            errorRateLimit: 'OpenRouter is rate-limiting the request',
            errorRequest: 'OpenRouter rejected the request',
            errorServer: 'OpenRouter answered with a server error',
            errorData: 'OpenRouter answered in an unexpected shape',
            errorHost: 'the plugin route did not answer',
            errorUnknown: 'the reason is unknown',
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
            // The balance block's own explanation: the percentage alone says
            // "3%" of nothing in particular, so the tooltip names the pool.
            limitBalanceHint: 'Prepaid pool shared by every key; refills only when you top up.',
            limitTightest: 'Tightest of {count} limited keys',
            limitTightest_one: 'Tightest of {count} limited key',
            limitUnavailable: 'Key limits unavailable: {reason}',
            sessionsUnavailable: 'Per-session spend unavailable, so the chip shows one figure: {reason}',
            lineageUnavailable: 'Delegated subagent spend could not be read, so this chat\u2019s figure may be low: {reason}',
            limitBurnUnavailable: 'the pace of spend is unknown: {reason}',
            limitUnknownMatch: 'Limit unknown: this key\u2019s name did not match the account\u2019s key list.',
            limitLevelWarn: 'Limit is running low',
            limitLevelCritical: 'Limit is nearly exhausted',
            limitNotice: 'Limit warning',
            limitNoticeOff: 'Off',
            limitNoticeOn: 'On \u2014 warn when a key limit is running out',
            limitNoticeHint: 'Off by default. When on, the chip shows the warning state and the panel shows how much of the limit is left.',
            limitToastPeriodLifetime: 'lifetime',
            // The warn and critical copy differ (m9): the toast is the only
            // limit surface with no room for a marker, so the wording itself
            // has to carry the level, in the terms the panel and the dot's
            // aria-label already use.
            limitToastWarn: 'Key "{name}" is running low: {percent}% of {period}\u2019s {limit} \u2014 ~{estimate} left at this rate.',
            limitToastCritical: 'Key "{name}" is nearly exhausted: {percent}% of {period}\u2019s {limit} \u2014 ~{estimate} left at this rate.',
            limitToastWarnNoEstimate: 'Key "{name}" is running low: {percent}% of {period}\u2019s {limit}.',
            limitToastCriticalNoEstimate: 'Key "{name}" is nearly exhausted: {percent}% of {period}\u2019s {limit}.',
            // The balance toast (ADR-0007): money and days, never a percentage
            // of a period the pool does not have. {limit} is the total ever
            // credited — the honest denominator for a pool that refills by hand.
            limitToastBalanceWarn: 'Account balance is running low: {left} of {limit} left \u2014 ~{estimate} at the recent pace.',
            limitToastBalanceCritical: 'Account balance is nearly exhausted: {left} of {limit} left \u2014 ~{estimate} at the recent pace. Top up to keep working.',
            limitToastBalanceWarnNoEstimate: 'Account balance is running low: {left} of {limit} left.',
            limitToastBalanceCriticalNoEstimate: 'Account balance is nearly exhausted: {left} of {limit} left. Top up to keep working.',
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
            refreshFailed: '无法刷新：{reason}',
            refreshFailedTitle: 'OpenRouter 花费 — 无法刷新：{reason}。{time} 后进行下次尝试。',
            nextAttemptIn: '{time} 后自动重试',
            retryNow: '立即重试',
            retrying: '重试中…',
            errorNetwork: '无法从本机连接 OpenRouter',
            errorTimeout: 'OpenRouter 未及时响应',
            errorAuth: '管理密钥被拒绝',
            errorRateLimit: 'OpenRouter 正在限制请求频率',
            errorRequest: 'OpenRouter 拒绝了该请求',
            errorServer: 'OpenRouter 返回服务器错误',
            errorData: 'OpenRouter 返回的数据结构异常',
            errorHost: '插件路由未响应',
            errorUnknown: '原因未知',
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
            limitBalanceHint: '所有密钥共用的预付池；仅手动充值。',
            limitTightest: '{count} 个限额密钥中最紧的',
            limitUnavailable: '无法获取密钥限额：{reason}',
            sessionsUnavailable: '无法获取按会话的支出，芯片只显示一个数值：{reason}',
            lineageUnavailable: '无法读取委派子代理的支出，本对话的数值可能偏低：{reason}',
            limitBurnUnavailable: '无法确定消耗速度：{reason}',
            limitUnknownMatch: '限额未知：该密钥名称未匹配到账户密钥列表。',
            limitLevelWarn: '限额偏低',
            limitLevelCritical: '限额即将耗尽',
            limitNotice: '限额提醒',
            limitNoticeOff: '关闭',
            limitNoticeOn: '开启 — 密钥限额将耗尽时提醒',
            limitNoticeHint: '默认关闭。开启后芯片显示警示状态，面板显示剩余额度。',
            limitToastPeriodLifetime: '总计',
            limitToastWarn: '密钥"{name}"限额偏低：已用{period}{limit}的{percent}% — 按此速度约剩{estimate}。',
            limitToastCritical: '密钥"{name}"限额即将耗尽：已用{period}{limit}的{percent}% — 按此速度约剩{estimate}。',
            limitToastWarnNoEstimate: '密钥"{name}"限额偏低：已用{period}{limit}的{percent}%。',
            limitToastCriticalNoEstimate: '密钥"{name}"限额即将耗尽：已用{period}{limit}的{percent}%。',
            limitToastBalanceWarn: '账户余额偏低：{limit} 中剩余 {left} — 按此速度约 {estimate}。',
            limitToastBalanceCritical: '账户余额即将耗尽：{limit} 中剩余 {left} — 按此速度约 {estimate}。请充值以继续使用。',
            limitToastBalanceWarnNoEstimate: '账户余额偏低：{limit} 中剩余 {left}。',
            limitToastBalanceCriticalNoEstimate: '账户余额即将耗尽：{limit} 中剩余 {left}。请充值以继续使用。',
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
            refreshFailed: 'Не удалось обновить: {reason}',
            refreshFailedTitle: 'Расходы OpenRouter — не удалось обновить: {reason}. Следующая попытка через {time}.',
            nextAttemptIn: 'Следующая попытка через {time}',
            retryNow: 'Повторить сейчас',
            retrying: 'Повторяю…',
            errorNetwork: 'OpenRouter недоступен с этой машины',
            errorTimeout: 'OpenRouter не ответил вовремя',
            errorAuth: 'управляющий ключ отклонён',
            errorRateLimit: 'OpenRouter ограничивает частоту запросов',
            errorRequest: 'OpenRouter отклонил запрос',
            errorServer: 'OpenRouter ответил ошибкой сервера',
            errorData: 'OpenRouter ответил неожиданной структурой',
            errorHost: 'маршрут плагина не ответил',
            errorUnknown: 'причина неизвестна',
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
            limitBalanceHint: 'Предоплаченный пул, общий для всех ключей; пополняется только вручную.',
            limitTightest: 'Самый жёсткий из {count} ключей с лимитом',
            limitTightest_one: 'Самый жёсткий из {count} ключа с лимитом',
            limitUnavailable: 'Лимиты ключей недоступны: {reason}',
            sessionsUnavailable: 'Расход по сессиям недоступен, чип показывает одну цифру: {reason}',
            lineageUnavailable: 'Расход делегированных субагентов не прочитан, цифра этого чата может быть занижена: {reason}',
            limitBurnUnavailable: 'темп расхода неизвестен: {reason}',
            limitUnknownMatch: 'Лимит неизвестен: имя ключа не совпало со списком ключей аккаунта.',
            limitLevelWarn: 'Лимит подходит к концу',
            limitLevelCritical: 'Лимит почти исчерпан',
            limitNotice: 'Предупреждение о лимите',
            limitNoticeOff: 'Выключено',
            limitNoticeOn: 'Включено — предупреждать, когда лимит ключа заканчивается',
            limitNoticeHint: 'По умолчанию выключено. При включении чип показывает предупреждение, а панель — сколько лимита осталось.',
            limitToastPeriodLifetime: 'всего',
            limitToastWarn: 'Лимит ключа "{name}" подходит к концу: израсходовано {percent}% лимита {period} ({limit}) — при таком темпе осталось ~{estimate}.',
            limitToastCritical: 'Лимит ключа "{name}" почти исчерпан: израсходовано {percent}% лимита {period} ({limit}) — при таком темпе осталось ~{estimate}.',
            limitToastWarnNoEstimate: 'Лимит ключа "{name}" подходит к концу: израсходовано {percent}% лимита {period} ({limit}).',
            limitToastCriticalNoEstimate: 'Лимит ключа "{name}" почти исчерпан: израсходовано {percent}% лимита {period} ({limit}).',
            limitToastBalanceWarn: 'Баланс аккаунта подходит к концу: осталось {left} из {limit} — при таком темпе ~{estimate}.',
            limitToastBalanceCritical: 'Баланс аккаунта почти исчерпан: осталось {left} из {limit} — при таком темпе ~{estimate}. Пополните, чтобы продолжить работу.',
            limitToastBalanceWarnNoEstimate: 'Баланс аккаунта подходит к концу: осталось {left} из {limit}.',
            limitToastBalanceCriticalNoEstimate: 'Баланс аккаунта почти исчерпан: осталось {left} из {limit}. Пополните, чтобы продолжить работу.',
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