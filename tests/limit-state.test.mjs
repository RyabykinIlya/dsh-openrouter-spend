/**
 * Unit tests for the browser half's limit decision and sentence assembly.
 *
 * `client.js` is a plain script body — the harness compiles it with
 * `new Function(...)` and refuses `import`/`export` — so these tests drive the
 * module loader's factory instead of importing a symbol. The harness's own
 * packages do the same (`ui-sidebar-documentpreview`'s client spec runs a
 * bundled `client.js` through `runInNewContext` with a stubbed
 * `window.__ModuleLoader__`). The factory returns its pure pieces next to
 * `inject`/`apply`, which is the seam a test can reach.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

/** The minimal `react` the factory destructures at module scope. */
const reactStub = {
  createElement: () => null,
  useCallback: fn => fn,
  useEffect: () => undefined,
  useMemo: fn => fn(),
  useRef: initial => ({ current: initial }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => undefined],
};

function load() {
  let captured;
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: registration => { captured = registration; } } },
  });
  return captured.factory(specifier => {
    if (specifier === 'react') return reactStub;
    throw new Error(`Unexpected browser dependency: ${specifier}`);
  });
}

const api = load();
const { limitState, limitSentence, dotState, escalates, fmtDuration, nextResetMs, resetTextFor, median, peakHourlyBurn, closedDayTotals } = api;

/** Burn buckets for `closedDayTotals`: `days` full UTC days ending before `nowMs`. */
function burnFor(nowMs, perDay, days) {
  const now = new Date(nowMs);
  const out = [];
  for (let i = 1; i <= days; i += 1) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push({ ts: `${day.toISOString().slice(0, 10)}T12:00:00`, usd: perDay });
  }
  return out;
}

/** A Wednesday, comfortably mid-week and mid-month, so every anchor is far. */
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

test('the factory exposes the pure pieces alongside inject and apply', () => {
  assert.equal(typeof api.limitState, 'function');
  assert.equal(typeof api.dotState, 'function');
  // The array is built inside the vm, so it shares no prototype with ours.
  assert.equal([...api.inject].join(','), 'slots,locale');
  assert.equal(typeof api.apply, 'function');
});

test('a periodic key at 41% consumed warns and at 39% does not', () => {
  const over = limitState({ limit: 100, limitRemaining: 59, limitReset: 'daily', burn: [], nowMs: NOW });
  assert.equal(over.level, 'warn');
  const under = limitState({ limit: 100, limitRemaining: 61, limitReset: 'daily', burn: [], nowMs: NOW });
  assert.equal(under.level, 'none');
});

test('a periodic key at 81% consumed is critical', () => {
  const state = limitState({ limit: 100, limitRemaining: 19, limitReset: 'daily', burn: [], nowMs: NOW });
  assert.equal(state.level, 'critical');
});

test('the reset veto keeps a critical at warn when the refill lands first', () => {
  // 81% consumed, but the remainder lasts past the reset: waiting is the action.
  const reset = nextResetMs('daily', NOW);
  const untilResetMs = reset - NOW;
  const remaining = 1.9;
  // Money that lasts twice as long as the wait: waiting beats alarm.
  const peak = (remaining * 3_600_000) / (untilResetMs * 2);
  const state = limitState({
    limit: 10, limitRemaining: remaining, limitReset: 'daily',
    burn: [{ ts: 'x', usd: peak }], nowMs: NOW,
  });
  assert.equal(state.level, 'warn');
  assert.equal(state.imminent, true);
});

test('the same figures stay critical when the reset is far away', () => {
  const remaining = 1.9;
  const peak = 3;
  const state = limitState({
    limit: 10, limitRemaining: remaining, limitReset: 'daily',
    burn: [{ ts: 'x', usd: peak }], nowMs: NOW,
  });
  assert.equal(state.level, 'critical');
  assert.equal(state.imminent, false);
});

test('a lifetime key whose runway crosses 3 days warns, and the same figures with a daily reset do not', () => {
  // 70 of 100 left, spending 30/day: 2.33 days of runway — under the 3-day mark.
  const burn = burnFor(NOW, 30, 5);
  const lifetime = limitState({ limit: 100, limitRemaining: 70, limitReset: null, burn, nowMs: NOW });
  assert.equal(lifetime.level, 'warn');
  // The same figures on a daily cap are 30% consumed, which is under 40%.
  const daily = limitState({ limit: 100, limitRemaining: 70, limitReset: 'daily', burn, nowMs: NOW });
  assert.equal(daily.level, 'none');
});

test('a lifetime key with too little history stays none', () => {
  const burn = burnFor(NOW, 30, 2);
  const state = limitState({ limit: 100, limitRemaining: 5, limitReset: null, burn, nowMs: NOW });
  assert.equal(state.level, 'none');
});

test('a key with thousands of requests of headroom but a high consumed share still warns', () => {
  // The request floor the earlier draft had must not reappear: ~1200 requests
  // left on a cheap key is plenty of headroom and still 94% consumed.
  const state = limitState({
    limit: 100, limitRemaining: 6, limitReset: 'daily', burn: [], nowMs: NOW,
    avgRequestUsd: 0.005,
  });
  assert.equal(state.level, 'critical');
  assert.ok(state.requests > 1000, `expected a large count, got ${state.requests}`);
});

test('hysteresis: warn enters at 40% and only leaves at 38%', () => {
  const at39 = limitState({
    limit: 100, limitRemaining: 61, limitReset: 'daily', burn: [], nowMs: NOW, previous: 'warn',
  });
  assert.equal(at39.level, 'warn', 'held just under the threshold');
  const at37 = limitState({
    limit: 100, limitRemaining: 63, limitReset: 'daily', burn: [], nowMs: NOW, previous: 'warn',
  });
  assert.equal(at37.level, 'none', 'released once the margin is cleared');
});

test('zero burn yields no runway and does not crash', () => {
  const state = limitState({ limit: 10, limitRemaining: 2, limitReset: 'daily', burn: [], nowMs: NOW });
  assert.equal(state.runwayMs, undefined);
  const sentence = limitSentence(state, { fmt: v => `$${v.toFixed(2)}` }, k => k);
  assert.ok(sentence.includes('limitLeft'));
  assert.ok(!sentence.includes('undefined'));
});

test('nextResetMs anchors each period to the measured boundary', () => {
  // Wed 2026-10-07: daily resets Thu 00:00Z, weekly the Monday 00:00Z,
  // monthly the 1st 00:00Z. All three were measured against a live account.
  assert.equal(nextResetMs('daily', NOW), Date.UTC(2026, 9, 8));
  assert.equal(nextResetMs('weekly', NOW), Date.UTC(2026, 9, 12));
  assert.equal(nextResetMs('monthly', NOW), Date.UTC(2026, 10, 1));
  assert.equal(nextResetMs(null, NOW), undefined);
});

test('the weekly anchor lands on Monday, the monthly on the 1st', () => {
  // A Sunday: the week resets the next day, not eight days out.
  const sunday = Date.UTC(2026, 9, 11, 12, 0, 0);
  assert.equal(new Date(nextResetMs('weekly', sunday)).getUTCDay(), 1);
  const late = Date.UTC(2026, 9, 30, 12, 0, 0);
  assert.equal(nextResetMs('monthly', late), Date.UTC(2026, 10, 1));
});

test('dotState lets a broken reading outrank a limit level', () => {
  assert.equal(dotState('error', 'critical'), 'error');
  assert.equal(dotState('no-credential', 'warn'), 'no-credential');
  assert.equal(dotState('stale', 'critical'), 'limit-critical');
  assert.equal(dotState('stale', 'warn'), 'limit-warn');
  assert.equal(dotState('stale', 'none'), 'stale');
  assert.equal(dotState(undefined, undefined), 'loading');
});

test('fmtDuration prints one significant figure and refuses non-positive spans', () => {
  assert.equal(fmtDuration(30_000), '<1 min');
  assert.equal(fmtDuration(25 * 60_000), '25 min');
  assert.equal(fmtDuration(2 * 3_600_000), '2 h');
  assert.equal(fmtDuration(3 * 86_400_000), '3 days');
  assert.equal(fmtDuration(0), undefined);
  assert.equal(fmtDuration(-1), undefined);
  assert.equal(fmtDuration(Number.NaN), undefined);
  // Past a year the figure stops being a span and becomes a shrug: a key with
  // $5 left at $0.0002/day would otherwise print "23797 days at this rate".
  assert.equal(fmtDuration(400 * 86_400_000), undefined);
  assert.equal(fmtDuration(365 * 86_400_000), '365 days');
});

test('escalates fires only on the transitions a toast is for', () => {
  // The three worth interrupting for.
  assert.equal(escalates('none', 'warn'), true);
  assert.equal(escalates('none', 'critical'), true);
  assert.equal(escalates('warn', 'critical'), true);
  // De-escalation and a steady level are both silent, or the toast would
  // repeat on every poll and be ignored within a day.
  assert.equal(escalates('critical', 'warn'), false);
  assert.equal(escalates('warn', 'none'), false);
  assert.equal(escalates('critical', 'critical'), false);
  assert.equal(escalates('warn', 'warn'), false);
  assert.equal(escalates('none', 'none'), false);
});

test('a runaway estimate drops its fragment rather than printing undefined', () => {
  // $5 left at $0.0002/day is 23797 days of runway. The span renders as
  // nothing, and so must the fragment: "~undefined at this rate" is a bug.
  const money = { fmt: v => `$${v.toFixed(2)}` };
  const dict = {
    limitLeft: '{left} of {limit} left', limitConsumed: '{percent}% used',
    limitLeftAtRate: '~{duration} at this rate', limitDaysAtRate: '~{days} days at this rate',
    limitUnderADay: 'under a day at this rate',
    limitApproxRequests: '≈ {count} requests',
  };
  const t = (k, p) => {
    const s = dict[k] ?? k;
    return p ? s.replace(/\{(\w+)\}/g, (m, n) => (n in p ? String(p[n]) : m)) : s;
  };
  const state = limitState({
    limit: 5, limitRemaining: 4.99, limitReset: null,
    burn: burnFor(NOW, 0.0002, 5), nowMs: NOW, avgRequestUsd: 0.002,
  });
  assert.equal(state.level, 'none');
  const line = limitSentence(state, money, t);
  assert.ok(!line.includes('undefined'), line);
  assert.ok(!line.includes('at this rate'), line);
  assert.ok(line.includes('requests'), line);
});

test('the reset text names a clock time, never the word midnight', () => {
  const daily = resetTextFor('daily', NOW);
  assert.ok(/^\d{2}:\d{2}$/.test(daily), `expected HH:MM, got ${daily}`);
  const weekly = resetTextFor('weekly', NOW);
  assert.ok(/^\w{2,3} \d{2}:\d{2}$/.test(weekly), `expected "Mon HH:MM", got ${weekly}`);
  assert.ok(!/midnight/i.test(daily) && !/midnight/i.test(weekly));
  assert.equal(resetTextFor(null, NOW), undefined);
});

test('the sentence leads with remaining money and carries the estimate past a threshold', () => {
  const money = { fmt: v => `$${v.toFixed(2)}` };
  const dict = {
    limitLeft: '{left} of {limit} left',
    limitConsumed: '{percent}% used',
    limitResets: 'resets {when}',
    limitResetsIn: 'resets in {minutes} min',
    limitLeftAtRate: '~{duration} at this rate',
    limitDaysAtRate: '~{days} days at this rate',
    limitUnderADay: 'under a day at this rate',
    limitApproxRequests: '≈ {count} requests',
  };
  const t = (key, params) => {
    const template = dict[key] ?? key;
    return params ? template.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m)) : template;
  };

  // 58 of 100 left is 42% consumed: a clean warn, well clear of the boundary.
  const warn = limitState({
    limit: 100, limitRemaining: 58, limitReset: 'daily',
    burn: [{ ts: 'x', usd: 1 }], nowMs: NOW,
  });
  const line = limitSentence(warn, money, t);
  assert.ok(line.startsWith('$58.00 of $100.00 left'), line);
  assert.ok(line.includes('42% used'), line);
  assert.ok(line.includes('resets '), line);
  assert.ok(line.includes('at this rate'), line);

  // At rest the request count is the useful extra and the money still leads.
  const rest = limitState({
    limit: 25, limitRemaining: 20, limitReset: null,
    burn: burnFor(NOW, 2, 5), nowMs: NOW, avgRequestUsd: 0.02,
  });
  assert.equal(rest.level, 'none');
  const restLine = limitSentence(rest, money, t);
  assert.ok(restLine.startsWith('$20.00 of $25.00 left'), restLine);
  assert.ok(restLine.includes('requests'), restLine);
  assert.ok(!restLine.includes('% used'), `no percentage at rest: ${restLine}`);

  // Past a threshold the count is dropped for the estimate, because that is
  // what a decision turns on. 6.4 of 25 left at 2.2/day is 2.9 days of runway.
  const flagged = limitState({
    limit: 25, limitRemaining: 6.4, limitReset: null,
    burn: burnFor(NOW, 2.2, 5), nowMs: NOW, avgRequestUsd: 0.02,
  });
  assert.equal(flagged.level, 'warn');
  const flaggedLine = limitSentence(flagged, money, t);
  assert.ok(flaggedLine.startsWith('$6.40 of $25.00 left'), flaggedLine);
  // A lifetime cap counts down; a share of it is not the figure that decides.
  assert.ok(!flaggedLine.includes('% used'), `no percentage on a lifetime cap: ${flaggedLine}`);
  assert.ok(flaggedLine.includes('~3 days at this rate'), flaggedLine);
  assert.ok(!flaggedLine.includes('requests'), `count dropped past a threshold: ${flaggedLine}`);
});

test('the threshold figures from the spec land on their level, not a float hair below', () => {
  // The shares these amounts are *about* compute a hair under the threshold
  // (`$7.20 of $12` is 0.39999999999999997), so the comparison carries slack:
  // a reader who sees "$7.20 of $12 · 40% used" is owed the warn, not silence.
  const warn = limitState({ limit: 12, limitRemaining: 7.2, limitReset: 'daily', burn: [], nowMs: NOW });
  assert.equal(warn.level, 'warn');
  assert.equal(Math.round(warn.percent), 40);
  const critical = limitState({ limit: 12, limitRemaining: 2.4, limitReset: 'daily', burn: [], nowMs: NOW });
  assert.equal(critical.level, 'critical');
  assert.equal(Math.round(critical.percent), 80);
  // The slack is far below a cent, so it does not drag a genuinely low share up.
  assert.equal(limitState({ limit: 12, limitRemaining: 7.21, limitReset: 'daily', burn: [], nowMs: NOW }).level, 'none');
});

test('the CSS maps both limit states and never blinks indefinitely', () => {
  assert.ok(source.includes('data-state="limit-warn"'));
  assert.ok(source.includes('data-state="limit-critical"'));
  assert.ok(source.includes('prefers-reduced-motion'));
  assert.ok(/animation: ors-pulse 1\.6s ease-in-out 2 forwards/.test(source));
  assert.ok(/animation: ors-pulse 1\.6s ease-in-out 3 forwards/.test(source));
  assert.ok(source.includes('@keyframes ors-pulse'));
});

test('median and peakHourlyBurn are the estimators their names promise', () => {
  assert.equal(median([]), 0);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 2, 3, 100]), 2.5, 'one expensive day does not move it');
  assert.equal(peakHourlyBurn([{ usd: 1 }, { usd: 5 }, { usd: 2 }]), 5);
  assert.equal(peakHourlyBurn([]), 0);
  assert.equal(peakHourlyBurn([{ usd: Number.NaN }]), 0);
});

test('closedDayTotals drops today, which is still filling', () => {
  const today = new Date(NOW).toISOString().slice(0, 10);
  const totals = closedDayTotals([
    { ts: `${today}T01:00:00`, usd: 9 },
    { ts: '2026-10-06T01:00:00', usd: 1 },
    { ts: '2026-10-06T02:00:00', usd: 2 },
    { ts: '2026-10-05T01:00:00', usd: 3 },
  ], NOW);
  // Same vm-prototype caveat: compare values, not array identity.
  assert.deepEqual([...totals].sort((a, b) => a - b), [3, 3]);
});

test('runwayText renders the heaviest-hour span, and no burn means no text', () => {
  // $2.40 left at $1.20/h is two hours, rendered the way the sentence needs it.
  const running = limitState({
    limit: 12, limitRemaining: 2.4, limitReset: 'daily',
    burn: [{ ts: 'x', usd: 1.2 }], nowMs: NOW,
  });
  assert.equal(running.runwayText, '2 h');
  // A still key: no peak, so no division and no fragment — never "Infinity".
  const still = limitState({ limit: 12, limitRemaining: 2.4, limitReset: 'daily', burn: [], nowMs: NOW });
  assert.equal(still.runwayText, undefined);
  assert.equal(still.runwayMs, undefined);
  assert.equal(limitState({ limit: 12, limitRemaining: 2.4, limitReset: null, burn: [], nowMs: NOW }).runwayText, undefined);
});

test('spend booked before the limit was last changed does not set the rate', () => {
  // Every recorded bucket predates the cap as it now stands, so nothing in the
  // history describes this cap: no rate, no runway, no warning.
  const burn = burnFor(NOW, 30, 5);
  const updatedAt = new Date(NOW).toISOString();
  const stale = limitState({ limit: 100, limitRemaining: 70, limitReset: null, burn, nowMs: NOW, updatedAt });
  assert.equal(stale.level, 'none');
  assert.equal(stale.runwayText, undefined);
  // Without the rewrite the very same buckets do warn, so the field is the cause.
  const fresh = limitState({ limit: 100, limitRemaining: 70, limitReset: null, burn, nowMs: NOW });
  assert.equal(fresh.level, 'warn');
  // The snake_case spelling the management payload uses is read too.
  assert.equal(limitState({ limit: 100, limitRemaining: 70, limitReset: null, burn, nowMs: NOW, updated_at: updatedAt }).level, 'none');
  // A rewrite older than the history changes nothing: the buckets still count.
  const older = new Date(NOW - 30 * 86_400_000).toISOString();
  assert.equal(limitState({ limit: 100, limitRemaining: 70, limitReset: null, burn, nowMs: NOW, updatedAt: older }).level, 'warn');
});

test('an imminent reset speaks in minutes, and a far one in clock time', () => {
  const money = { fmt: v => `$${v.toFixed(2)}` };
  const dict = {
    limitLeft: '{left} of {limit} left', limitConsumed: '{percent}% used',
    limitResets: 'resets {when}', limitResetsIn: 'resets in {minutes} min',
    limitLeftAtRate: '~{duration} at this rate',
  };
  const t = (key, params) => (dict[key] ?? key).replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
  // 20 minutes before the UTC boundary: the veto demotes, and the refill leads.
  const justBefore = Date.UTC(2026, 9, 7, 23, 40, 0);
  const state = limitState({
    limit: 12, limitRemaining: 1.2, limitReset: 'daily',
    burn: [{ ts: 'x', usd: 0.36 }], nowMs: justBefore,
  });
  assert.equal(state.imminent, true);
  const line = limitSentence(state, money, t);
  assert.ok(line.includes('resets in 20 min'), line);
  assert.ok(!line.includes('at this rate'), `the refill is the whole sentence: ${line}`);
  // Mid-day the refill is far, so the clock time is what the reader gets. The
  // expected value comes from the renderer itself, so the case holds in any zone.
  const midday = limitState({
    limit: 12, limitRemaining: 7.2, limitReset: 'daily',
    burn: [{ ts: 'x', usd: 1 }], nowMs: NOW,
  });
  const middayLine = limitSentence(midday, money, t);
  assert.ok(middayLine.includes(`resets ${resetTextFor('daily', NOW)}`), middayLine);
  // Never the literal word, which is wrong for most readers (and for everyone
  // just after their own local midnight).
  assert.ok(!/midnight/i.test(middayLine), middayLine);
});

test('the dictionary carries every limit key in all three languages', () => {
  // The host half reads the same list, and the browser half must not ship a key
  // that resolves to itself in one language and a sentence in another.
  const required = [
    'limitKey', 'limitBalance', 'limitLeft', 'limitConsumed',
    'periodToday', 'periodWeek', 'periodMonth',
    'limitResets', 'limitResetsIn', 'limitLeftAtRate', 'limitApproxRequests',
    'limitDaysAtRate', 'limitUnderADay', 'limitShared', 'limitTightest',
    'limitUnavailable', 'limitUnknownMatch',
  ];
  for (const key of required) {
    const count = source.split(`\n`).filter(line => line.trim().startsWith(`${key}:`)).length;
    assert.ok(count >= 3, `${key} must appear in en, zh and ru (found ${count})`);
  }
  // The names the spec fixed, and the ones it replaced must be gone.
  assert.ok(!source.includes('limitAtRate:'), 'the split replaced limitAtRate');
  assert.ok(!source.includes('limitToastPeriodToday'), 'periodToday is the shared key');
});
