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
const { limitState, limitSentence, pluralCategory, tPlural, withBurnNote, dotState, escalates, fmtDuration, nextResetMs, resetTextFor, median, peakHourlyBurn, closedDayTotals } = api;

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

test('a limit timestamp is ignored: neither the level nor the runway moves', () => {
  // The field is deliberately not read. The host does not ship it — `readKeyLimits`
  // in index.js emits only limit, limitRemaining, limitReset and disabled — and on
  // the live API its meaning is unverified, so it cannot be trusted as "this cap was
  // set at". These are the buckets that a pre-cap floor used to discard; under the
  // documented behaviour they must count whether the field is present or not.
  const burn = burnFor(NOW, 30, 5);
  const updatedAt = new Date(NOW).toISOString();
  const bare = limitState({ limit: 100, limitRemaining: 70, limitReset: null, burn, nowMs: NOW });
  assert.equal(bare.level, 'warn');
  assert.equal(bare.runwayDays, 70 / 30);
  // A stamp at the moment of polling no longer erases the history.
  const stamped = limitState({ limit: 100, limitRemaining: 70, limitReset: null, burn, nowMs: NOW, updatedAt });
  assert.equal(stamped.level, 'warn');
  assert.equal(stamped.runwayDays, bare.runwayDays);
  assert.equal(stamped.runwayText, bare.runwayText);
  // The snake_case spelling the management payload uses is ignored just the same.
  const snake = limitState({ limit: 100, limitRemaining: 70, limitReset: null, burn, nowMs: NOW, updated_at: updatedAt });
  assert.equal(snake.level, 'warn');
  assert.equal(snake.runwayDays, bare.runwayDays);
  // An old stamp and an unparseable one change nothing either: the field never gates.
  const older = new Date(NOW - 30 * 86_400_000).toISOString();
  assert.equal(limitState({ limit: 100, limitRemaining: 70, limitReset: null, burn, nowMs: NOW, updatedAt: older }).level, 'warn');
  assert.equal(limitState({ limit: 100, limitRemaining: 70, limitReset: null, burn, nowMs: NOW, updatedAt: 'not a date' }).level, 'warn');
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

test('the shipped Russian forms all carry the numeral, and select correctly', () => {
  // The tests above drive the plural MECHANISM through a local dictionary. This
  // one reads the dictionary that actually ships: a mutation check showed that
  // restoring the old numeral-dropping ru strings left every mechanism test
  // green, so nothing here was pinning the shipped copy. The gap mattered: the
  // old strings silently discarded the count the other two languages show.
  const ru = source.slice(source.indexOf('\n          ru: {'), source.indexOf('\n          ru: {') + 4000);
  const en = source.slice(source.indexOf('\n          en: {'), source.indexOf('\n          zh: {'));
  const grab = (block, key) => {
    const match = block.match(new RegExp(`^\\s+${key}: '((?:[^'\\\\]|\\\\.)*)',`, 'm'));
    return match === null ? undefined : match[1];
  };

  // Both counted keys must interpolate their numeral in Russian. `{count}` and
  // `{days}` are what a dropped numeral loses; a string without it cannot show
  // the figure at all, whatever the plural form.
  assert.ok(grab(ru, 'limitApproxRequests').includes('{count}'), 'ru must show the request count');
  assert.ok(grab(ru, 'limitDaysAtRate').includes('{days}'), 'ru must show the day count');
  // And the suffix forms must carry it too, or `tPlural` would swap in a string
  // that drops the very numeral it was selected to decline.
  for (const key of ['limitApproxRequests_one', 'limitApproxRequests_few']) {
    assert.ok(grab(ru, key).includes('{count}'), `${key} must show the request count`);
  }
  for (const key of ['limitDaysAtRate_one', 'limitDaysAtRate_few']) {
    assert.ok(grab(ru, key).includes('{days}'), `${key} must show the day count`);
  }
  // The tightest-key label counts how many limited keys the pick came from, and
  // the design doc's key table promises that `{count}`. A mutation check showed
  // nothing else pins it: stripping the numeral from all three languages left
  // every test green, because the only other mention is a presence check.
  assert.ok(grab(ru, 'limitTightest').includes('{count}'), 'ru must name how many limits were compared');
  assert.ok(grab(ru, 'limitTightest_one').includes('{count}'), 'ru must take the genitive singular for one');
  assert.ok(grab(en, 'limitTightest').includes('{count}'), 'en must name how many limits were compared');
  assert.ok(grab(en, 'limitTightest_one').includes('{count}'), 'en needs the singular form for one');
  // English gained a singular form; Chinese has only the `other` category and
  // deliberately ships no suffix keys.
  assert.ok(grab(en, 'limitApproxRequests_one').includes('{count}'));
  assert.ok(grab(en, 'limitDaysAtRate_one').includes('{days}'));
  assert.equal(grab(source.slice(source.indexOf('\n          zh: {'), source.indexOf('\n          ru: {')), 'limitApproxRequests_one'), undefined);

  // End to end with the SHIPPED Russian strings and the real selector, not a
  // fixture: 1 request must take the one form, 5 the many form.
  const t = (key, params) => {
    const template = grab(ru, key) ?? key;
    return params ? template.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m)) : template;
  };
  const atRest = wanted => limitState({
    limit: 25, limitRemaining: wanted * 0.02, limitReset: null,
    burn: burnFor(NOW, 0.002, 5), nowMs: NOW, avgRequestUsd: 0.02,
  });
  const oneLine = limitSentence(atRest(1), { fmt: v => `$${v.toFixed(2)}` }, t, 'ru');
  assert.ok(oneLine.includes('1 запрос'), oneLine);
  assert.ok(!oneLine.includes('1 запросов'), `the shipped many form must not take 1: ${oneLine}`);
  const fiveLine = limitSentence(atRest(5), { fmt: v => `$${v.toFixed(2)}` }, t, 'ru');
  assert.ok(fiveLine.includes('5 запросов'), fiveLine);
});

test('the dictionary carries every limit key in all three languages', () => {
  // The host half reads the same list, and the browser half must not ship a key
  // that resolves to itself in one language and a sentence in another.
  const required = [
    'limitKey', 'limitBalance', 'limitLeft', 'limitConsumed',
    'periodToday', 'periodWeek', 'periodMonth',
    'limitResets', 'limitResetsIn', 'limitLeftAtRate', 'limitApproxRequests',
    'limitDaysAtRate', 'limitUnderADay', 'limitShared', 'limitTightest',
    'limitUnavailable', 'limitUnknownMatch', 'limitBurnUnavailable',
  ];
  for (const key of required) {
    const count = source.split(`\n`).filter(line => line.trim().startsWith(`${key}:`)).length;
    assert.ok(count >= 3, `${key} must appear in en, zh and ru (found ${count})`);
  }
  // The names the spec fixed, and the ones it replaced must be gone.
  assert.ok(!source.includes('limitAtRate:'), 'the split replaced limitAtRate');
  assert.ok(!source.includes('limitToastPeriodToday'), 'periodToday is the shared key');
});

test('withBurnNote: a failed hourly read is named, not silently dropped', () => {
  const sentence = '$4.80 of $12.00 left \u00b7 resets 03:00';
  const note = 'the pace of spend is unknown: hourly analytics answered 500';
  // The reason is appended, never substituted: what is left of the limit is
  // still known and is the figure the reader opened the panel for.
  assert.equal(withBurnNote(sentence, note), `${sentence} \u00b7 ${note}`);
  assert.ok(withBurnNote(sentence, note).includes(sentence), 'the limit sentence survives');
});

test('withBurnNote: no burn error leaves the sentence exactly as it was', () => {
  const sentence = '$4.80 of $12.00 left \u00b7 ~3 days at this rate';
  assert.equal(withBurnNote(sentence, undefined), sentence);
  // The toast path assembles its message without a note; undefined must be a
  // pass-through rather than the string "undefined".
  assert.ok(!String(withBurnNote(sentence, undefined)).includes('undefined'));
});

test('withBurnNote: an absent sentence becomes the note alone', () => {
  // No limit to sentence but a failed hourly read: the note is the whole panel
  // text, and it must not render as "undefined · reason".
  const note = 'the pace of spend is unknown: offline';
  assert.equal(withBurnNote(undefined, note), note);
  assert.ok(!String(withBurnNote(undefined, note)).includes('undefined'));
});

test('withBurnNote: both absent renders nothing at all', () => {
  assert.equal(withBurnNote(undefined, undefined), undefined);
});

test('every registered component renders without throwing', () => {
  // This is the regression for a temporal dead zone bug that shipped: `Pill`
  // listed `noticeState?.level` in an effect's dependency array *above* the
  // `const noticeState` declaration. A dependency array is evaluated during
  // render, so reading the binding early threw on every render — the chip never
  // appeared. No test caught it, because every other test here drives the pure
  // functions and nothing ever rendered a component. The stub's `useEffect` is a
  // no-op, which is enough: the throw happened while evaluating its arguments,
  // before the callback was reached.
  const slots = {};
  api.apply({
    effect: fn => { fn(); return () => {}; },
    locale: { register: () => () => {}, bind: () => key => key },
    slots: {
      inject: (name, thunk) => { thunk(); },
      register: (definition, Component) => { slots[definition.name] = Component; return () => {}; },
    },
  });
  const names = Object.keys(slots);
  assert.deepEqual(
    names.sort(),
    ['conversation.composer.dock', 'settings.section', 'shell.overlay'],
    'the three registrations must all be reachable',
  );
  for (const name of names) {
    assert.doesNotThrow(
      () => slots[name]({ t: key => key, sessionId: 'session' }),
      `${name} must render`,
    );
  }
});

test('the tightest-key label names how many limits it compared', async () => {
  // The dictionary test proves the string CONTAINS `{count}`; this proves the
  // rendered label actually substitutes it, which is what a reader sees. The
  // branch only renders with "All keys" selected, so the pref is left unset and
  // two limited keys are supplied — without the numeral the reader is told
  // "tightest" with nothing to weigh it against.
  const payload = {
    status: 'ok', refreshedAt: '2026-10-09T09:00:00.000Z', refreshSeconds: 60,
    todaySpend: { usd: 2.15, requests: 47 }, last7: { usd: 9, requests: 100 },
    last30: { usd: 20, requests: 400 }, byDay: [], byModel: [], byKey: [],
    limits: {
      'build-bot': { limit: 12, limitRemaining: 7.2, limitReset: 'daily', disabled: false },
      'batch-key': { limit: 25, limitRemaining: 20, limitReset: null, disabled: false },
    },
    limitThresholds: { warn: 0.4, critical: 0.8 },
    burnHourly: {},
    // A balance well clear of both keys, so the balance branch does not win.
    credits: { totalCredits: 1000, totalUsage: 10 },
  };
  const stand = loadWithFetch(payload, Date.UTC(2026, 9, 9, 12, 0, 0), { 'ors.limitNotice': '1' });
  // No `ors.keyId`: the tightest-key branch is the one for "All keys".
  const pill = stand.mount('conversation.composer.dock', {});
  let tree = pill.render();
  for (let i = 0; i < 6; i += 1) { await flush(); if (pill.dirty) tree = pill.render(); }
  const chip = findByClass(tree, 'ors-chip');
  assert.ok(chip?.props?.onClick, 'the chip must be there to open the popover');
  chip.props.onClick();
  for (let i = 0; i < 6; i += 1) { await flush(); if (pill.dirty) tree = pill.render(); }
  const text = textOf(tree).join(' | ');
  assert.ok(/Tightest of 2 limited keys/.test(text), `the label must name the count: ${text}`);
  assert.ok(text.includes('batch-key') || text.includes('build-bot'), `a key must be named: ${text}`);
});

test('pluralCategory reads the CLDR category, and refuses to guess', () => {
  // Russian is the reason the helper exists: one/few/many are three distinct
  // forms of the same noun, and which one a numeral takes is a rule about its
  // last digits, not a comparison against 1.
  assert.equal(pluralCategory(1, 'ru'), 'one');
  assert.equal(pluralCategory(2, 'ru'), 'few');
  assert.equal(pluralCategory(5, 'ru'), 'many');
  // 21 and 22 are the cases a hand-rolled `count === 1` gets wrong.
  assert.equal(pluralCategory(21, 'ru'), 'one');
  assert.equal(pluralCategory(22, 'ru'), 'few');
  assert.equal(pluralCategory(25, 'ru'), 'many');
  // English has two, and Chinese only `other`.
  assert.equal(pluralCategory(1, 'en'), 'one');
  assert.equal(pluralCategory(2, 'en'), 'other');
  assert.equal(pluralCategory(1, 'zh'), 'other');
  // An unusable locale id must not throw into a render: `other` is the category
  // every language has, so the base string is what comes out.
  const bogus = 'not a locale!';
  assert.throws(() => new Intl.PluralRules(bogus), 'the fixture must really be invalid');
  assert.equal(pluralCategory(1, bogus), 'other');
  // A missing locale id behaves as English.
  assert.equal(pluralCategory(1, undefined), 'one');
});

test('tPlural picks the suffixed key, and falls back to the base one', () => {
  // A flat `t` with no `has()`: a miss returns the key itself, which is the only
  // signal a probe can read.
  const dict = {
    limitApproxRequests: '≈ {count} requests',
    limitApproxRequests_one: '≈ {count} request',
  };
  const t = (key, params) => {
    const template = dict[key] ?? key;
    return params ? template.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m)) : template;
  };

  // Present: the category-specific form wins.
  assert.equal(tPlural(t, 'limitApproxRequests', 1, 'en', { count: 1 }), '≈ 1 request');
  // Absent (`limitApproxRequests_other` is not in the dictionary): the base form.
  assert.equal(tPlural(t, 'limitApproxRequests', 5, 'en', { count: 5 }), '≈ 5 requests');
  // A language with no variants at all still resolves through the base key.
  assert.equal(tPlural(t, 'limitApproxRequests', 2, 'zh', { count: 2 }), '≈ 2 requests');
  // A key with no base variant either comes back as the key itself, untouched —
  // the same thing a flat `t` does everywhere else, so nothing new breaks.
  assert.equal(tPlural(t, 'noSuchKey', 1, 'en'), 'noSuchKey');
  // An unsupported locale id falls back to the base form rather than throwing.
  assert.equal(tPlural(t, 'limitApproxRequests', 1, 'not a locale!', { count: 1 }), '≈ 1 requests');
});

test('the Russian sentence counts requests in the right form for 1, 2 and 5', () => {
  const money = { fmt: v => `$${v.toFixed(2)}` };
  // The dictionary the ru block ships, with only the keys the sentence reaches.
  const dict = {
    limitLeft: 'Осталось {left} из {limit}',
    limitConsumed: 'израсходовано {percent}%',
    limitResets: 'сброс {when}',
    limitResetsIn: 'сброс через {minutes} мин',
    limitLeftAtRate: '~{duration} при таком темпе',
    limitDaysAtRate: '~{days} дней при таком темпе',
    limitDaysAtRate_one: '~{days} день при таком темпе',
    limitDaysAtRate_few: '~{days} дня при таком темпе',
    limitUnderADay: 'меньше суток при таком темпе',
    limitApproxRequests: '≈ {count} запросов',
    limitApproxRequests_one: '≈ {count} запрос',
    limitApproxRequests_few: '≈ {count} запроса',
  };
  const t = (key, params) => {
    const template = dict[key] ?? key;
    return params ? template.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m)) : template;
  };

  // A remainder worth exactly `wanted` requests: $0.02 each, and a burn of
  // $0.002/day over five closed days, which leaves the cap unflagged so the
  // count is the extra the sentence carries.
  const atRest = wanted => limitState({
    limit: 25, limitRemaining: wanted * 0.02, limitReset: null,
    burn: burnFor(NOW, 0.002, 5), nowMs: NOW, avgRequestUsd: 0.02,
  });

  const one = atRest(1);
  assert.equal(one.level, 'none');
  assert.equal(one.requests, 1);
  const oneLine = limitSentence(one, money, t, 'ru');
  assert.ok(oneLine.includes('≈ 1 запрос'), oneLine);
  // The whole bug: the many form next to a numeral that takes the one form.
  assert.ok(!oneLine.includes('запросов'), `no many form for 1: ${oneLine}`);

  const two = atRest(2);
  assert.equal(two.requests, 2);
  const twoLine = limitSentence(two, money, t, 'ru');
  assert.ok(twoLine.includes('≈ 2 запроса'), twoLine);
  assert.ok(!twoLine.includes('запросов'), `no many form for 2: ${twoLine}`);

  const five = atRest(5);
  assert.equal(five.requests, 5);
  const fiveLine = limitSentence(five, money, t, 'ru');
  assert.ok(fiveLine.includes('≈ 5 запросов'), fiveLine);

  // The day count has the same problem, and the form must follow the ROUNDED
  // figure that is actually on screen: 1.4 days prints "1", so it reads "1 день".
  const days = limitState({
    limit: 25, limitRemaining: 0.0028, limitReset: null,
    burn: burnFor(NOW, 0.002, 5), nowMs: NOW,
  });
  assert.equal(Math.round(days.runwayDays), 1);
  const daysLine = limitSentence(days, money, t, 'ru');
  assert.ok(daysLine.includes('~1 день при таком темпе'), daysLine);
  assert.ok(!daysLine.includes('дней при таком темпе'), `no many form for 1 day: ${daysLine}`);

  // Three arguments still renders: an absent locale id means English, and the
  // other tests in this file call it that way. The dictionary here is Russian,
  // so only the CATEGORY is English — the wording comes from `t`.
  const threeArg = limitSentence(one, money, t);
  assert.equal(threeArg, limitSentence(one, money, t, 'en'));
  assert.ok(threeArg.startsWith('Осталось $0.02 из $25.00'), threeArg);
  assert.ok(threeArg.includes('≈ 1 запрос'), threeArg);
});

test('apply reads the active locale, and survives a host that offers neither', () => {
  // The positive path: a real locale plugin, with a snapshot and an event bus.
  // This is the branch the components read, and unlike the negative path below
  // it was uncovered — an unguarded call would have thrown here.
  const handlers = {};
  const slots = {};
  assert.doesNotThrow(() => api.apply({
    effect: fn => { fn(); return () => {}; },
    on: (event, handler) => { handlers[event] = handler; },
    locale: {
      getSnapshot: () => ({ active: 'ru' }),
      register: () => () => {},
      bind: () => key => key,
    },
    slots: {
      inject: (name, thunk) => { thunk(); },
      register: (definition, Component) => { slots[definition.name] = Component; return () => {}; },
    },
  }), 'apply must accept a locale plugin that has a snapshot');
  assert.equal(typeof handlers['locale/change'], 'function', 'the locale change must be subscribed');
  // The handler is what keeps the plural form current, so it must be callable
  // and must not throw on the snapshot shape the plugin documents.
  assert.doesNotThrow(() => handlers['locale/change']({ active: 'en' }));
  assert.doesNotThrow(() => Object.values(slots).forEach(
    Component => Component({ t: key => key, sessionId: 'session' }),
  ), 'the components must render after a locale change');
});

/**
 * A fuller stand than `load()`: a working React (effects run, state persists
 * across re-renders), a counting `fetch`, and a controllable clock, so the two
 * summary pollers can actually be mounted and watched. `load()` above is enough
 * for pure helpers — it never renders anything — but a poll is a side effect.
 */
function loadWithFetch(payload, startMs, prefs = { 'ors.limitNotice': '1', 'ors.keyId': 'build-bot' }) {
  const counters = { fetch: 0 };
  const store = { ...prefs };
  let now = startMs;
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(now); else super(...args); }
    static now() { return now; }
  }
  const windowStub = {
    __ModuleLoader__: { load: () => {} },
    localStorage: { getItem: key => (key in store ? store[key] : null), setItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  };
  let captured;
  windowStub.__ModuleLoader__.load = registration => { captured = registration; };
  runInNewContext(source, {
    window: windowStub,
    document: { addEventListener: () => {}, removeEventListener: () => {} },
    fetch: () => {
      counters.fetch += 1;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    },
    setInterval: () => 0,
    clearInterval: () => {},
    CustomEvent: class { constructor(type) { this.type = type; } },
    Date: FakeDate,
    console,
  });

  // One instance: hooks persist between renders, the cursor resets each render.
  let cursor = null;
  let index = 0;
  let dirty = false;
  const hooksStub = {
    createElement: (type, props, ...kids) => ({ type, props: props || {}, children: kids.flat(Infinity) }),
    useRef: initial => {
      const hook = cursor[index] || (cursor[index] = {}); index += 1;
      if (!('ref' in hook)) hook.ref = { current: initial };
      return hook.ref;
    },
    useState: initial => {
      const hook = cursor[index] || (cursor[index] = {}); index += 1;
      if (!('s' in hook)) hook.s = typeof initial === 'function' ? initial() : initial;
      return [hook.s, value => { hook.s = typeof value === 'function' ? value(hook.s) : value; dirty = true; }];
    },
    useMemo: (fn, deps) => {
      const hook = cursor[index] || (cursor[index] = {}); index += 1;
      const changed = !('m' in hook) || deps === undefined
        || deps.length !== (hook.deps || []).length
        || deps.some((value, i) => !Object.is(value, (hook.deps || [])[i]));
      if (changed) { hook.m = fn(); hook.deps = deps; }
      return hook.m;
    },
    useCallback: fn => fn,
    useEffect: (fn, deps) => {
      const hook = cursor[index] || (cursor[index] = {}); index += 1;
      const first = !('deps' in hook);
      const changed = first || deps === undefined
        || deps.length !== hook.deps.length
        || deps.some((value, i) => !Object.is(value, hook.deps[i]));
      if (changed) { hook.deps = deps; fn(); }
    },
  };

  const api = captured.factory(specifier => {
    if (specifier === 'react') return hooksStub;
    throw new Error(`Unexpected browser dependency: ${specifier}`);
  });
  const dicts = [];
  const slots = {};
  api.apply({
    effect: fn => { fn(); return () => {}; },
    locale: { register: (ns, dict) => { dicts.push(dict); return () => {}; }, bind: () => key => key },
    slots: {
      inject: (name, thunk) => { thunk(); },
      register: (definition, Component) => { slots[definition.name] = Component; return () => {}; },
    },
  });
  const english = dicts.find(entry => entry.en)?.en ?? {};
  const t = (key, params) => {
    const template = english[key] ?? key;
    return params ? template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : template;
  };
  const mount = (name, extraProps = {}) => {
    const instance = {
      render() {
        cursor = instance.hooks; index = 0; dirty = false;
        return slots[name]({ t, sessionId: 'session', ...extraProps });
      },
      get dirty() { return dirty; },
      hooks: [],
    };
    return instance;
  };
  return { counters, mount, advance: ms => { now += ms; }, api, slots };
}

/** The first node carrying `className`, so a test can click what it renders. */
function findByClass(node, className) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findByClass(child, className); if (hit !== undefined) return hit; }
    return undefined;
  }
  const own = node.props?.className;
  if (typeof own === 'string' && own.split(/\s+/).includes(className)) return node;
  return findByClass(node.children, className);
}

/** Every text node under a tree, skipping the CSS the components inline. */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach(child => textOf(child, out)); return out; }
  if (node.type === 'style') return out;
  if (node.children) textOf(node.children, out);
  return out;
}

const flush = () => new Promise(resolve => { setTimeout(resolve, 0); });

test('the two summary pollers share one request inside the coalescing window', async () => {
  // `Pill` and `ToastOverlay` each poll the summary on their own interval. They
  // used to issue two requests per tick for one answer; `fetchSummary` now hands
  // callers inside `SUMMARY_COALESCE_MS` the request already in flight. This is
  // the only test that renders a poller, so it is the only one that can see it:
  // `fetchSummary` is not exported from the factory.
  const payload = {
    status: 'ok', refreshedAt: '2026-10-09T09:00:00.000Z', refreshSeconds: 60,
    todaySpend: { usd: 2.15, requests: 47 }, last7: { usd: 9, requests: 100 },
    last30: { usd: 20, requests: 400 }, byDay: [], byModel: [],
    byKey: [{ id: 'build-bot', todayUsd: 2.15, todayRequests: 47, todayModels: [], last7: { usd: 9, requests: 100 }, last30: { usd: 20, requests: 400 } }],
    limits: { 'build-bot': { limit: 12, limitRemaining: 7.2, limitReset: 'daily', disabled: false } },
    limitThresholds: { warn: 0.4, critical: 0.8 },
    burnHourly: { 'build-bot': [{ ts: '2026-10-09T08:00:00.000Z', usd: 1 }] },
    credits: { totalCredits: 1000, totalUsage: 96.75 },
  };

  // Both pollers mounted in the same instant: one request between them.
  const first = loadWithFetch(payload, Date.UTC(2026, 9, 9, 12, 0, 0));
  const pill = first.mount('conversation.composer.dock');
  const toast = first.mount('shell.overlay');
  pill.render();
  toast.render();
  await flush();
  assert.equal(first.counters.fetch, 1, 'two pollers mounting together must cost one request');

  // A caller outside the window must fetch again rather than reuse a stale reply.
  const second = loadWithFetch(payload, Date.UTC(2026, 9, 9, 12, 0, 0));
  const soloPill = second.mount('conversation.composer.dock');
  soloPill.render();
  await flush();
  assert.equal(second.counters.fetch, 1);
  // Move the clock past the window: the mounted poller does not re-render on its
  // own here (intervals are stubbed and effects only run on a change), which is
  // exactly the "a later caller arrives" case the window has to let through.
  second.advance(5_000);
  const laterPill = second.mount('conversation.composer.dock');
  laterPill.render();
  await flush();
  assert.equal(second.counters.fetch, 2, 'a caller past the window must fetch again');

  // And a caller INSIDE the window reuses the reply rather than re-fetching.
  const third = loadWithFetch(payload, Date.UTC(2026, 9, 9, 12, 0, 0));
  const a = third.mount('conversation.composer.dock');
  a.render();
  await flush();
  assert.equal(third.counters.fetch, 1);
  const b = third.mount('conversation.composer.dock');
  b.render();
  await flush();
  assert.equal(third.counters.fetch, 1, 'a caller inside the window must reuse the reply');
});

/** One dictionary block, found by brace matching from its opening line. */
function dictBlock(openIndex) {
  let depth = 0;
  let started = false;
  let out = '';
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    out += ch;
    if (ch === '{') { depth += 1; started = true; } else if (ch === '}') { depth -= 1; }
    if (started && depth === 0) break;
  }
  return out;
}

const unescapeUnicode = value => value.replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));

/** `name: 'template',` pairs from a dictionary block, first occurrence wins. */
function parseDict(block) {
  const out = {};
  for (const m of block.matchAll(/^\s+(\w+):\s*'((?:[^'\\]|\\.)*)',\s*$/gm)) {
    if (!(m[1] in out)) out[m[1]] = unescapeUnicode(m[2]);
  }
  return out;
}

const dicts = {
  en: parseDict(dictBlock(source.indexOf('\n          en: {') + 1)),
  zh: parseDict(dictBlock(source.indexOf('\n          zh: {') + 1)),
  ru: parseDict(dictBlock(source.indexOf('\n          ru: {') + 1)),
};

const designDoc = readFileSync(join(here, '..', 'docs', 'design', 'limit-notice.md'), 'utf8');

/** Rows of the `| Key | en | ru | zh |` tables, as key -> {en, ru, zh}. */
function docRows() {
  const rows = new Map();
  const lines = designDoc.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    // Split on the cell separator rather than matching a fixed pattern: a cell
    // may itself contain backticks (the `other`-only marker) or an em dash.
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.length !== 4 || cells[0] !== 'Key') continue;
    // This is a locale table: `| Key | en | ru | zh |`. Read until the table
    // ends, so other four-column tables in the document are not swept in.
    for (let j = i + 2; j < lines.length && lines[j].startsWith('|'); j += 1) {
      const row = lines[j].split('|').slice(1, -1).map(cell => cell.trim());
      if (row.length !== 4) continue;
      const key = row[0].match(/^`(\w+)`$/);
      if (key === null) continue;
      rows.set(key[1], {
        en: normaliseQuotes(stripBackticks(row[1])),
        ru: normaliseQuotes(stripBackticks(row[2])),
        zh: normaliseQuotes(stripBackticks(row[3])),
      });
    }
  }
  return rows;
}

/** A quoted cell is wrapped in single backticks; a marker cell is not. */
function stripBackticks(cell) {
  const m = cell.match(/^`([\s\S]*)`$/);
  return m === null ? cell : m[1];
}

/**
 * A markdown cell cannot express the typographic apostrophe the dictionaries
 * use without the reader seeing an escape, so the doc writes a plain `'`. Both
 * sides are folded to one character before comparing.
 */
function normaliseQuotes(value) {
  return value.replace(/[\u2018\u2019]/g, "'");
}

test('the design doc documents every key the limit feature ships', () => {
  // The doc is the only place a translator or a reviewer can see the whole
  // vocabulary at once, and it had fallen behind: 17 keys the feature ships —
  // the toast copy, the Settings toggle, the level names, the plural forms —
  // appeared in no table at all. A missing row is invisible by nature, so the
  // check has to be mechanical rather than a reading.
  //
  // Checked against the union of the three dictionaries, not English alone: a
  // category-suffixed key may exist in one language only (`_few` is Russian's,
  // and English rightly does not define it).
  const union = new Set([...Object.keys(dicts.en), ...Object.keys(dicts.zh), ...Object.keys(dicts.ru)]);
  const rows = docRows();
  const missing = [...union]
    .filter(key => /^(limit|period)/.test(key) && !rows.has(key))
    .sort();
  assert.deepEqual(missing, [], 'every limit-feature key must have a row in the doc table');
});

test('the design doc quotes the strings that actually ship', () => {
  // The table is a transcription, so it can drift by a word without anyone
  // noticing — and it did: four rows disagreed with the code, and one of them
  // (`limitUsedPeriod`) named a key that has never existed in any commit.
  // Compared per language, because a row can be right in English and wrong in
  // Russian, which is exactly how the dropped numerals survived.
  const rows = docRows();
  const mismatches = [];
  for (const [key, quoted] of rows) {
    for (const lang of ['en', 'ru', 'zh']) {
      const shipped = dicts[lang][key];
      if (shipped === undefined) {
        // A language may legitimately not define a category, but then the doc
        // has to say so rather than quoting a translation that is not shipped.
        if (!/none|other/.test(quoted[lang])) {
          mismatches.push(`${key} [${lang}]\n      doc quotes a string, code defines none`);
        }
        continue;
      }
      if (normaliseQuotes(quoted[lang]) === normaliseQuotes(shipped)) continue;
      mismatches.push(`${key} [${lang}]\n      doc:  ${quoted[lang]}\n      code: ${shipped}`);
    }
  }
  assert.deepEqual(mismatches, [], 'the doc must quote the shipped strings verbatim');
});

test('every key the design doc names exists in the code', () => {
  // The other direction. `limitUsedPeriod` was documented for months and had
  // never been in any commit, so a reader could look for a string that does not
  // exist, or "fix" the code to match a key that was never meant to ship.
  // Any language counts: a Russian-only `_few` form is still a shipped key.
  const union = new Set([...Object.keys(dicts.en), ...Object.keys(dicts.zh), ...Object.keys(dicts.ru)]);
  const rows = docRows();
  const absent = [...rows.keys()].filter(key => !union.has(key)).sort();
  assert.deepEqual(absent, [], 'a documented key must exist in the shipped dictionary');
});
