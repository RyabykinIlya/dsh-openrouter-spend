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
const { limitState, balanceState, limitSentence, chipPairFor, pluralCategory, tPlural, withBurnNote, dotState, escalates, toastPeriodKey, periodStartKey, seenLimitKey, fmtDuration, nextResetMs, resetTextFor, median, peakHourlyBurn, windowedBurn, closedDayTotals } = api;

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
  assert.equal(typeof api.chipPairFor, 'function');
  // The array is built inside the vm, so it shares no prototype with ours.
  assert.equal([...api.inject].join(','), 'slots,locale');
  assert.equal(typeof api.apply, 'function');
});

// --------------------------------------------------------------- chip pair
// ADR-0006: the chip's `session/day` pair names one API key on both sides. The
// bug it fixes was a pair whose left half was the session's key and right half
// the whole account's day (`36.44/89.93` beside a popover head reading
// `36.53`), so each case below is one way the halves could name two keys.

/** A `byKey` row as the payload carries it. */
const keyRow = (id, todayUsd, todayRequests = 1) => ({ id, todayUsd, todayRequests });

test('chipPairFor: both halves come from the tracked key', () => {
  const pair = chipPairFor({
    sessionRow: { id: 'chat', todayUsd: 0.4292, todayKeys: [{ id: 'dh', usd: 0.4292, requests: 56 }] },
    keyId: 'dh',
    keys: [keyRow('dh', 0.4302), keyRow('other', 9)],
  });

  // The numerator is this chat's share of `dh`, the denominator is `dh`'s own
  // day — never the account's day, which is what made the pair meaningless.
  // Spread, not compared in place: the object was built inside the vm realm,
  // and a strict deep-equal across realms fails on the prototype alone.
  assert.deepEqual({ ...pair }, { keyId: 'dh', sessionUsd: 0.4292, dayUsd: 0.4302 });
});

test('chipPairFor: with no tracked key a single-key session scopes the pair to its key', () => {
  const pair = chipPairFor({
    sessionRow: { id: 'chat', todayKeys: [{ id: 'dh', usd: 1.5, requests: 3 }] },
    keyId: '',
    keys: [keyRow('dh', 4)],
  });

  assert.deepEqual({ ...pair }, { keyId: 'dh', sessionUsd: 1.5, dayUsd: 4 });
});

test('chipPairFor: a session spanning keys with no tracked key refuses the pair', () => {
  // Picking the larger share would invent an attribution the data does not
  // support: the chat's spend is on two keys, so no single-key day contains it.
  const pair = chipPairFor({
    sessionRow: {
      id: 'chat',
      todayKeys: [{ id: 'dh', usd: 1, requests: 2 }, { id: 'other', usd: 0.5, requests: 1 }],
    },
    keyId: '',
    keys: [keyRow('dh', 4), keyRow('other', 8)],
  });

  assert.equal(pair, undefined);
});

test('chipPairFor: a tracked key this chat never used pairs 0.00 with that key\u2019s day', () => {
  // Honest, not pretty: this chat spent nothing on the tracked key, so its
  // share is zero. Filling in the other key's spend would name a key the chat
  // did not use.
  const pair = chipPairFor({
    sessionRow: { id: 'chat', todayKeys: [{ id: 'other', usd: 2, requests: 4 }] },
    keyId: 'dh',
    keys: [keyRow('dh', 4), keyRow('other', 8)],
  });

  assert.deepEqual({ ...pair }, { keyId: 'dh', sessionUsd: 0, dayUsd: 4 });
});

test('chipPairFor: an absent session, absent split or unknown key refuses the pair', () => {
  // Each is a distinct "cannot name one key" case, and all must fall back to a
  // single figure rather than print a pair that mixes scopes.
  assert.equal(chipPairFor({ sessionRow: undefined, keyId: 'dh', keys: [keyRow('dh', 4)] }), undefined);
  // `todayKeys` absent means the host could not split the session: that is
  // "could not read", which must not collapse into "spent nothing".
  assert.equal(chipPairFor({ sessionRow: { id: 'chat' }, keyId: 'dh', keys: [keyRow('dh', 4)] }), undefined);
  // A tracked key with no row in `byKey`: the denominator is unknown.
  assert.equal(
    chipPairFor({ sessionRow: { id: 'chat', todayKeys: [{ id: 'dh', usd: 1, requests: 1 }] }, keyId: 'ghost', keys: [keyRow('dh', 4)] }),
    undefined,
  );
});

test('chipPairFor: a zero or unusable denominator refuses the pair', () => {
  // `0.00/0.00` is not a share of anything, and a non-numeric day figure is a
  // payload fault rather than a spend of zero.
  const row = { id: 'chat', todayKeys: [{ id: 'dh', usd: 0, requests: 0 }] };
  assert.equal(chipPairFor({ sessionRow: row, keyId: 'dh', keys: [keyRow('dh', 0)] }), undefined);
  assert.equal(chipPairFor({ sessionRow: row, keyId: 'dh', keys: [keyRow('dh', undefined)] }), undefined);
  assert.equal(chipPairFor({ sessionRow: row, keyId: 'dh', keys: [keyRow('dh', 4)] })?.sessionUsd, 0);
});

test('chipPairFor: a numerator larger than its denominator refuses the pair', () => {
  // The chat cannot have spent more of a key's day than that key spent. A
  // payload saying otherwise was built from two different keys — exactly the
  // bug this scoping exists to prevent — so it is refused rather than printed.
  const pair = chipPairFor({
    sessionRow: { id: 'chat', todayKeys: [{ id: 'dh', usd: 5, requests: 9 }] },
    keyId: 'dh',
    keys: [keyRow('dh', 4)],
  });

  assert.equal(pair, undefined);
});

test('chipPairFor: float drift on an exact share does not refuse the pair', () => {
  // 0.1 + 0.2 lands a hair above 0.3 when summed, and a strict comparison
  // would refuse a pair that is arithmetically correct.
  const pair = chipPairFor({
    sessionRow: { id: 'chat', todayKeys: [{ id: 'dh', usd: 0.30000000000000004, requests: 3 }] },
    keyId: 'dh',
    keys: [keyRow('dh', 0.3)],
  });

  assert.deepEqual({ ...pair }, { keyId: 'dh', sessionUsd: 0.30000000000000004, dayUsd: 0.3 });
});

test('chipPairFor: a malformed payload never throws', () => {
  // The payload comes off the wire, so every shape is reachable.
  assert.equal(chipPairFor(), undefined);
  assert.equal(chipPairFor({}), undefined);
  assert.equal(chipPairFor({ sessionRow: { todayKeys: 'nope' }, keyId: 'dh', keys: [keyRow('dh', 4)] }), undefined);
  // Junk entries are skipped, not thrown on: with a tracked key and no entry
  // naming it, the chat's share of that key is honestly zero.
  const junk = chipPairFor({ sessionRow: { todayKeys: [null, 7] }, keyId: 'dh', keys: [keyRow('dh', 4)] });
  assert.deepEqual({ ...junk }, { keyId: 'dh', sessionUsd: 0, dayUsd: 4 });
  assert.equal(chipPairFor({ sessionRow: { todayKeys: [{ id: '', usd: 1 }] }, keyId: '', keys: [keyRow('', 4)] }), undefined);
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
  // The SHIPPED copy, read through the shared brace-matched extractor that
  // builds `dicts` — not a fixed 4000-char slice of the source and a
  // 10-space indentation pattern (N13). A reformat of client.js must not
  // silently hand this test a window into the wrong block; `dictBlock` finds
  // the block by name and matches braces, so the lookup below can only ever
  // miss by the key being genuinely absent.
  const ru = dicts.ru;
  const en = dicts.en;
  const grab = (dict, key) => dict[key];

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
  assert.equal(grab(dicts.zh, 'limitApproxRequests_one'), undefined);

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

/** Mount the chip, let the poll land, open the popover: the rendered panel. */
async function openPanel(stand) {
  const pill = stand.mount('conversation.composer.dock', {});
  let tree = pill.render();
  for (let i = 0; i < 6; i += 1) { await flush(); if (pill.dirty) tree = pill.render(); }
  const chip = findByClass(tree, 'ors-chip');
  assert.ok(chip?.props?.onClick, 'the chip must be there to open the popover');
  chip.props.onClick();
  for (let i = 0; i < 6; i += 1) { await flush(); if (pill.dirty) tree = pill.render(); }
  return tree;
}

test('a key with spend but no matching limit is surfaced as unmatched', async () => {
  // N4: ADR-0002's Confirmation claims a test for exactly this. The join is
  // by NAME and is the decision's stated risk, so the failure it must never
  // have is silence: a key that spent money with no readable cap has to SAY
  // the cap is unknown, not render a healthy-looking block or nothing at all.
  // `limits` is the management `/keys` answer — a name the host could not
  // match simply has no row in it — while `byKey` carries the spend.
  const stand = loadWithFetch(unmatchedPayload(), Date.UTC(2026, 9, 9, 12, 0, 0), {
    'ors.limitNotice': '1',
    'ors.keyId': 'build-bot',
  });
  const tree = await openPanel(stand);
  const quota = findByClass(tree, 'ors-quota');
  assert.ok(quota, 'the limit block must render');
  assert.equal(quota.props['data-level'], 'unknown',
    `the unmatched join must take the unknown state — got ${quota.props['data-level']}`);
  const note = textOf(findByClass(quota, 'ors-quota-note')).join('');
  assert.equal(note, dicts.en.limitUnknownMatch,
    `the reader must be told the limit is unknown — got ${note}`);

  // The contrast that makes the assertion mean something: a JOINED row takes
  // the ordinary limit block instead, and a row with no spend at all says
  // nothing — so the sentence above is produced by the unmatched join and by
  // nothing else.
  const joined = loadWithFetch(
    unmatchedPayload({ limits: { 'build-bot': { limit: 12, limitRemaining: 4.8, limitReset: 'daily', disabled: false } } }),
    Date.UTC(2026, 9, 9, 12, 0, 0),
    { 'ors.limitNotice': '1', 'ors.keyId': 'build-bot' },
  );
  const joinedTree = await openPanel(joined);
  const joinedText = textOf(joinedTree).join(' | ');
  assert.ok(!joinedText.includes('Limit unknown'), `a joined key must not claim to be unmatched: ${joinedText}`);
  assert.match(joinedText, /\$4\.80 of \$12\.00 left/, 'a joined key shows its limit sentence');
  assert.equal(findByClass(joinedTree, 'ors-quota').props['data-level'], 'warn');

  const still = loadWithFetch(unmatchedPayload({ usd: 0 }), Date.UTC(2026, 9, 9, 12, 0, 0), {
    'ors.limitNotice': '1',
    'ors.keyId': 'build-bot',
  });
  const stillTree = await openPanel(still);
  assert.equal(findByClass(stillTree, 'ors-quota'), undefined,
    'a key that spent nothing has no limit to report');
  assert.ok(!textOf(stillTree).join(' | ').includes('Limit unknown'));
});

/**
 * Expand function-typed elements the way React would, one level at a time, so a
 * finder can reach the host elements inside a component the panel renders.
 * `expandComponent` does this once for the toast; the raise row is a component
 * of its own that holds the raise's own state, so a test that wants its buttons
 * has to expand it too. Depth-limited rather than unbounded: a self-referencing
 * element in a broken render must not hang the suite.
 */
function expandDeep(node, depth = 6) {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(child => expandDeep(child, depth));
  if (depth <= 0) return node;
  if (typeof node.type === 'function') return expandDeep(node.type(node.props), depth - 1);
  if (node.children === undefined) return node;
  return { ...node, children: expandDeep(node.children, depth) };
}

test('the raise row renders under the limit block, and only where a raise is possible', async () => {
  // ADR-0008's render path. The pure offer rule is pinned in
  // `key-limit.test.mjs`; what that suite cannot see is whether the row reaches
  // the panel at all, carries the offered figure, and stays away from the
  // shapes that have no cap to raise (a failed limits read, an unmatched key).
  // The warning payload is a `$12` daily cap with `$7.20` burned, so the offer
  // is the cap plus the period burn: `$19.20`.
  const stand = loadWithFetch(warnPayload(), Date.UTC(2026, 9, 9, 12, 0, 0), {
    'ors.limitNotice': '1',
    'ors.keyId': 'build-bot',
  });
  const tree = await openPanel(stand);
  const row = findByClass(expandDeep(tree), 'ors-raise');
  assert.ok(row, 'the limit block must carry the raise row for a tracked key with a limit');
  const buttons = [];
  const walk = node => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'button') buttons.push(node);
    if (node.type === 'input') buttons.push(node);
    walk(node.children);
  };
  walk(row);
  const offer = buttons.find(node => textOf(node).join('').includes('19.2'));
  assert.ok(offer, `the offer button must name the offered cap — got ${JSON.stringify(buttons.map(b => textOf(b).join('')))}`);
  assert.equal(offer.props.disabled, false, 'a tracked key in warn renders an enabled offer');
  assert.ok(!textOf(offer).join('').includes('\u20bd'),
    `with USD display the offer is dollars only — got ${JSON.stringify(textOf(offer).join(''))}`);
  const input = buttons.find(node => node.type === 'input');
  assert.ok(input, 'the custom field must be there beside the offer');
  assert.equal(input.props.placeholder, 'over $12.00',
    `the field must say what "above" means, in the money that will be sent — got ${JSON.stringify(input.props.placeholder)}`);
  const apply = buttons.filter(node => node.type === 'button').find(node => textOf(node).join('') === dicts.en.raiseApply);
  assert.ok(apply, 'the row must carry the apply button for the typed figure');
  assert.equal(apply.props.disabled, true, 'an empty field cannot be applied, and says so by disabling');

  // The reported bug (ADR-0009), rendered: with the display currency set to RUB
  // the offer must still name the USD figure it will SEND, and carry the ruble
  // equivalent as an echo. The sentence above keeps rubles — that is the point —
  // so both units are present and neither is a mistake.
  const rubStand = loadWithFetch(
    { ...warnPayload(), rate: { perUsd: 140.98 } },
    Date.UTC(2026, 9, 9, 12, 0, 0),
    { 'ors.limitNotice': '1', 'ors.keyId': 'build-bot', 'ors.currency': 'RUB' },
  );
  const rubTree = await openPanel(rubStand);
  const rubRow = findByClass(expandDeep(rubTree), 'ors-raise');
  assert.ok(rubRow, 'the raise row renders in RUB display too');
  const rubButtons = [];
  const collect = node => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (node.type === 'button') rubButtons.push(node);
    if (node.type === 'input') rubButtons.push(node);
    collect(node.children);
  };
  collect(rubRow);
  const rubOffer = rubButtons.find(node => node.type === 'button' && textOf(node).join('').includes('$19.20'));
  assert.ok(rubOffer, `the offer must lead with the dollars it sends — got ${JSON.stringify(rubButtons.map(b => textOf(b).join('')))}`);
  const rubWords = textOf(rubOffer).join('');
  assert.ok(rubWords.includes('\u2248') && rubWords.includes('\u20bd'),
    `and echo the reader's own money — got ${JSON.stringify(rubWords)}`);
  const rubInput = rubButtons.find(node => node.type === 'input');
  assert.equal(rubInput.props.placeholder, 'over $12.00',
    `the field stays in the sent money whatever the panel displays — got ${JSON.stringify(rubInput.props.placeholder)}`);
  const sentence = textOf(findByClass(expandDeep(rubTree), 'ors-quota-note')).join('');
  assert.ok(sentence.includes('\u20bd'),
    `the spend sentence beside it keeps the display currency — got ${JSON.stringify(sentence)}`);

  // The shapes with no cap to raise: an unmatched key (no limit row) and a cap
  // the reader is nowhere near. A button that cannot act must not render.
  const unmatched = await openPanel(loadWithFetch(unmatchedPayload(), Date.UTC(2026, 9, 9, 12, 0, 0), {
    'ors.limitNotice': '1',
    'ors.keyId': 'build-bot',
  }));
  assert.equal(findByClass(expandDeep(unmatched), 'ors-raise'), undefined,
    'a key whose limit could not be matched has no cap to raise');

  const comfortable = await openPanel(loadWithFetch(
    unmatchedPayload({ limits: { 'build-bot': { limit: 12, limitRemaining: 11, limitReset: 'daily', disabled: false } } }),
    Date.UTC(2026, 9, 9, 12, 0, 0),
    { 'ors.limitNotice': '1', 'ors.keyId': 'build-bot' },
  ));
  // A cap at rest still shows its block but is not an alarm; the raise belongs to
  // the escalation, and `limitState` returns `none` here, which is the gate.
  assert.equal(findByClass(comfortable, 'ors-raise'), undefined,
    'a cap nowhere near its limit offers no raise — the offer rides the escalation');
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
  // The pref bus works, not just exists: `writePref` dispatches `ors:prefs`
  // and the components re-read the store on it, which is what lets a test
  // switch the tracked key mid-flight the way Settings does. Writes are
  // RECORDED, not dropped: a dismissal is only observable as the seen key it
  // writes (m21), and dispatched events are logged so the toast's "open the
  // popover" action can be asserted rather than assumed.
  const listeners = new Map();
  const writes = [];
  const events = [];
  const windowStub = {
    __ModuleLoader__: { load: () => {} },
    localStorage: {
      getItem: key => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = value; writes.push({ key, value }); },
    },
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener: (type, handler) => { listeners.get(type)?.delete(handler); },
    dispatchEvent: event => {
      events.push(event.type);
      for (const handler of listeners.get(event.type) ?? []) handler(event);
    },
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
    // The poll arms its next tick with `setTimeout`. The stub fires it at once,
    // which is what "the mount effect ran" means under this fake React; the
    // scheduled delay itself is covered by the pure `nextPollMs` tests.
    setTimeout: fn => { fn(); return 0; },
    clearTimeout: () => {},
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
  return {
    counters, mount, advance: ms => { now += ms; }, api, slots, writes, events,
    setPref: (name, value) => { store[name] = value; windowStub.dispatchEvent({ type: 'ors:prefs' }); },
  };
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

/** The first host element with `tag`, for controls that carry no class (a
 * bare `<button>`), where `findByClass` has nothing to hold on to. */
function findByTag(node, tag) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findByTag(child, tag); if (hit !== undefined) return hit; }
    return undefined;
  }
  if (node.type === tag) return node;
  return findByTag(node.children, tag);
}

/**
 * A `<button>` whose text says `label`, for the toast, which now carries two
 * buttons: the raise offer (ADR-0008) lands before the dismissal, so
 * `findByTag('button')` returns the raise and a dismissal test would click the
 * wrong action. Found by what it says, not by where it sits.
 */
function findButtonByText(node, label) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findButtonByText(child, label); if (hit !== undefined) return hit; }
    return undefined;
  }
  if (node.type === 'button' && textOf(node).includes(label)) return node;
  return findButtonByText(node.children, label);
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

/**
 * `ToastOverlay` returns the Toast as a component element (`h(Toast, props)`);
 * this fake React builds elements but never runs component types, so a test
 * that wants the toast's words expands it by one level itself.
 */
function expandComponent(node) {
  return typeof node?.type === 'function' ? node.type(node.props) : node;
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

/** A payload where `build-bot` sits at 60% of a daily cap: a clean warn. */
function warnPayload() {
  return {
    status: 'ok', refreshedAt: '2026-10-09T09:00:00.000Z', refreshSeconds: 60,
    todaySpend: { usd: 2.15, requests: 47 }, last7: { usd: 9, requests: 100 },
    last30: { usd: 20, requests: 400 }, byDay: [], byModel: [],
    byKey: [{ id: 'build-bot', todayUsd: 2.15, todayRequests: 47, todayModels: [], last7: { usd: 9, requests: 100 }, last30: { usd: 20, requests: 400 } }],
    limits: { 'build-bot': { limit: 12, limitRemaining: 4.8, limitReset: 'daily', disabled: false } },
    limitThresholds: { warn: 0.4, critical: 0.8 },
    burnHourly: { 'build-bot': [{ ts: '2026-10-09T08:00:00', usd: 0.5 }] },
    credits: { totalCredits: 1000, totalUsage: 96.75 },
  };
}

/**
 * A payload whose `byKey` row carries spend but whose `limits` map has no
 * entry for it: the two halves of the name join disagree. `limits` IS the
 * management `/keys` answer — a name the host could not match simply has no
 * row there — so `usd` is the window total the host's `byKey` emits, the
 * figure `limitUnknown` tests against.
 */
function unmatchedPayload({ usd = 2.15, limits = {} } = {}) {
  return {
    status: 'ok', refreshedAt: '2026-10-09T09:00:00.000Z', refreshSeconds: 60,
    todaySpend: { usd: 2.15, requests: 47 }, last7: { usd: 9, requests: 100 },
    last30: { usd: 20, requests: 400 }, byDay: [], byModel: [],
    byKey: [{
      id: 'build-bot', usd, requests: 47,
      todayUsd: usd, todayRequests: 47, todayModels: [],
      last7: { usd: 9, requests: 100 }, last30: { usd: 20, requests: 400 },
    }],
    limits,
    limitThresholds: { warn: 0.4, critical: 0.8 },
    burnHourly: {},
    credits: { totalCredits: 1000, totalUsage: 96.75 },
  };
}

test('limitState carries the reset period, and the toast names it', () => {
  // M1: the Toast reads `state.limitReset` to choose between today / this
  // week / this month / lifetime, but `limitState` never returned the field,
  // so every periodic-cap toast introduced the cap as "lifetime". The raw
  // value rides along and the phrase follows it.
  for (const [limitReset, key] of [['daily', 'periodToday'], ['weekly', 'periodWeek'], ['monthly', 'periodMonth']]) {
    const state = limitState({ limit: 100, limitRemaining: 58, limitReset, burn: [], nowMs: NOW });
    assert.equal(state.limitReset, limitReset, `${limitReset} must survive limitState`);
    assert.equal(toastPeriodKey(state), key, `${limitReset} must name its own period`);
  }
  const lifetime = limitState({ limit: 100, limitRemaining: 70, limitReset: null, burn: burnFor(NOW, 30, 5), nowMs: NOW });
  assert.equal(lifetime.limitReset, null);
  assert.equal(lifetime.lifetime, true);
  assert.equal(toastPeriodKey(lifetime), 'limitToastPeriodLifetime');
  // An unrecognised reset value is a lifetime by the same fall-through the
  // Toast has always had; it must not crash the phrase.
  assert.equal(toastPeriodKey({ limitReset: 'yearly' }), 'limitToastPeriodLifetime');
});

test('the seen limit turns with the period, so a dismissal re-arms', () => {
  // M2: the stored key is `${keyId}:${level}:${periodStart}` — the design
  // doc's "Retirement — seen" contract. Each anchor is the UTC midnight the
  // matching budget refills on, so the key turns exactly when the budget
  // does and yesterday's dismissal cannot silence today's escalation.
  const tuesday = Date.UTC(2026, 9, 6, 12, 0, 0);
  const wednesday = Date.UTC(2026, 9, 7, 12, 0, 0);
  assert.equal(periodStartKey('daily', tuesday), '2026-10-06');
  assert.equal(periodStartKey('daily', Date.UTC(2026, 9, 6, 23, 59, 59)), '2026-10-06');
  assert.equal(periodStartKey('daily', Date.UTC(2026, 9, 7, 0, 0, 0)), '2026-10-07', 'the day turns at UTC midnight, where the budget refills');
  // The ISO week turns on Monday 00:00 UTC: Sunday Oct 11 is W41, Monday
  // Oct 12 is W42 — the same boundary `nextResetMs('weekly')` refills on.
  assert.equal(periodStartKey('weekly', Date.UTC(2026, 9, 11, 23, 59, 59)), '2026-W41');
  assert.equal(periodStartKey('weekly', Date.UTC(2026, 9, 12, 0, 0, 0)), '2026-W42');
  // A week straddling New Year belongs to the ISO year of its Thursday.
  assert.equal(periodStartKey('weekly', Date.UTC(2025, 11, 29, 12)), '2026-W01');
  assert.equal(periodStartKey('weekly', Date.UTC(2027, 0, 1, 12)), '2026-W53');
  assert.equal(periodStartKey('monthly', Date.UTC(2026, 9, 31, 23)), '2026-10');
  assert.equal(periodStartKey('monthly', Date.UTC(2026, 10, 1, 0)), '2026-11');
  // A lifetime cap never re-arms: seen once, quiet for good — the doc's trade.
  assert.equal(periodStartKey(null, tuesday), 'ever');
  assert.equal(periodStartKey(undefined, wednesday), 'ever');
  // The full key: yesterday's stored dismissal must not match today's.
  assert.equal(seenLimitKey('build-bot', 'warn', 'daily', tuesday), 'build-bot:warn:2026-10-06');
  assert.notEqual(seenLimitKey('build-bot', 'warn', 'daily', tuesday), seenLimitKey('build-bot', 'warn', 'daily', wednesday),
    'a new period must re-arm the toast');
});

test('a warn escalation fires again the period after it was seen, and names the period', async () => {
  // M1 + M2 through the real overlay: the toast must appear although the
  // level was seen — yesterday (the budget is new today) — and its message
  // must say "today", not "lifetime".
  const stand = loadWithFetch(warnPayload(), Date.UTC(2026, 9, 9, 12, 0, 0), {
    'ors.limitNotice': '1',
    'ors.keyId': 'build-bot',
    'ors.seenLimit': 'build-bot:warn:2026-10-08',
  });
  const toast = stand.mount('shell.overlay', {});
  toast.render();
  let tree = null;
  for (let i = 0; i < 6; i += 1) { await flush(); if (toast.dirty) tree = toast.render(); }
  const text = textOf(expandComponent(tree)).join(' | ');
  assert.ok(text.includes('build-bot'), `the toast must name the key: ${text}`);
  assert.ok(text.includes('today'), `a daily cap must name the day, not "lifetime": ${text}`);
  assert.ok(!text.includes('lifetime'), `a daily cap is not a lifetime: ${text}`);
  assert.ok(text.includes('running low'), `the warn copy must carry the level (m9): ${text}`);
});

test('a seen escalation inside the same period stays quiet', async () => {
  // The other half of M2: the period in the key is what suppresses the
  // repeat, so today's seen key must still silence today's escalation.
  const stand = loadWithFetch(warnPayload(), Date.UTC(2026, 9, 9, 12, 0, 0), {
    'ors.limitNotice': '1',
    'ors.keyId': 'build-bot',
    'ors.seenLimit': 'build-bot:warn:2026-10-09',
  });
  const toast = stand.mount('shell.overlay', {});
  toast.render();
  let tree = null;
  for (let i = 0; i < 6; i += 1) { await flush(); if (toast.dirty) tree = toast.render(); }
  // The lookup goes through `expandComponent`: `ToastOverlay` returns the
  // Toast as a component element, which carries no `ors-toast` class of its
  // own — a `findByClass` on the unexpanded element returns `undefined`
  // whether or not a toast is showing, so it could never fail.
  assert.equal(findByClass(expandComponent(tree), 'ors-toast'), undefined,
    'a seen escalation must not re-toast inside its period');
});

test('switching the tracked key resets the escalation history', async () => {
  // m10: the previous-level ref used to survive a key switch, so a critical
  // key followed by a warn key never fired the warn — the old key's history
  // decided the new key's toast. The history is scoped to the key now, and
  // the toast retires with the key it escalated on.
  const payload = warnPayload();
  payload.byKey.push({ id: 'hot-key', todayUsd: 1, todayRequests: 20, todayModels: [], last7: { usd: 5, requests: 50 }, last30: { usd: 9, requests: 90 } });
  payload.limits['hot-key'] = { limit: 10, limitRemaining: 1, limitReset: 'daily', disabled: false }; // 90%: critical
  payload.limits['build-bot'] = { limit: 12, limitRemaining: 4.8, limitReset: 'daily', disabled: false }; // 60%: warn
  payload.burnHourly['hot-key'] = [{ ts: '2026-10-09T08:00:00', usd: 0.5 }];
  const stand = loadWithFetch(payload, Date.UTC(2026, 9, 9, 12, 0, 0), {
    'ors.limitNotice': '1',
    'ors.keyId': 'hot-key',
  });
  const toast = stand.mount('shell.overlay', {});
  toast.render();
  let tree = null;
  for (let i = 0; i < 6; i += 1) { await flush(); if (toast.dirty) tree = toast.render(); }
  let text = textOf(expandComponent(tree)).join(' | ');
  assert.ok(text.includes('hot-key'), `the critical key must toast: ${text}`);
  assert.ok(text.includes('nearly exhausted'), `the critical copy must carry the level (m9): ${text}`);

  // Switch to the milder key, the way Settings would: its warn must fire on
  // its own history, not on the critical key's.
  stand.setPref('ors.keyId', 'build-bot');
  for (let i = 0; i < 6; i += 1) { await flush(); if (toast.dirty) tree = toast.render(); }
  text = textOf(expandComponent(tree)).join(' | ');
  assert.ok(text.includes('build-bot'), `the new key's toast must fire: ${text}`);
  assert.ok(text.includes('running low'), `a warn must not inherit critical's silence or copy: ${text}`);
  assert.ok(!text.includes('nearly exhausted'), `the old key's escalation must not outlive the switch: ${text}`);
});

test('the toast overlay shows the escalation, and dismissing it retires it', async () => {
  // m21: only the pure `escalates()` was pinned, so the RENDER path could
  // drop the toast without a test noticing. This drives `ToastOverlay`
  // itself: the escalation must ARRIVE as a toast, and the dismiss button
  // must retire it and record the level as seen in the period it fired in —
  // the write (M2's key) that keeps it retired for the rest of that period.
  const stand = loadWithFetch(warnPayload(), Date.UTC(2026, 9, 9, 12, 0, 0), {
    'ors.limitNotice': '1',
    'ors.keyId': 'build-bot',
  });
  const toast = stand.mount('shell.overlay', {});
  toast.render();
  let tree = null;
  for (let i = 0; i < 6; i += 1) { await flush(); if (toast.dirty) tree = toast.render(); }

  const shown = expandComponent(tree);
  assert.ok(findByClass(shown, 'ors-toast'), 'the escalation must render a toast');
  assert.equal(tree.props.level, 'warn', `the toast must carry the level it escalated to — got ${tree.props.level}`);
  assert.equal(tree.props.keyId, 'build-bot', 'and the key it escalated on');
  const words = textOf(shown).join(' | ');
  assert.ok(words.includes('build-bot'), `the toast must name the key: ${words}`);

  findButtonByText(shown, 'Dismiss').props.onClick(); // the dismissal — the raise button sits before it
  for (let i = 0; i < 6; i += 1) { await flush(); if (toast.dirty) tree = toast.render(); }
  assert.equal(expandComponent(tree), null, 'the toast must be gone once dismissed');
  // The seen key is what keeps it gone, and it names the period (M2): a
  // dismissal today must not silence tomorrow's budget.
  assert.deepEqual(
    stand.writes.filter(entry => entry.key === 'ors.seenLimit').map(entry => entry.value),
    ['build-bot:warn:2026-10-09'],
    `the dismissal must record the level in its own period — got ${JSON.stringify(stand.writes)}`,
  );
});

test('opening the popover from the toast retires it and asks the chip to open', async () => {
  // The other retirement path. Clicking the message is not a dismissal — it
  // is "take me there", so it must fire the event the chip listens for AND
  // put the toast away, or the reader gets a popover and a toast about the
  // same key at once. Both halves of that are load-bearing.
  const stand = loadWithFetch(warnPayload(), Date.UTC(2026, 9, 9, 12, 0, 0), {
    'ors.limitNotice': '1',
    'ors.keyId': 'build-bot',
  });
  const toast = stand.mount('shell.overlay', {});
  toast.render();
  let tree = null;
  for (let i = 0; i < 6; i += 1) { await flush(); if (toast.dirty) tree = toast.render(); }
  assert.ok(findByClass(expandComponent(tree), 'ors-toast'), 'the escalation must render a toast');

  findByClass(expandComponent(tree), 'ors-toast-content').props.onClick();
  for (let i = 0; i < 6; i += 1) { await flush(); if (toast.dirty) tree = toast.render(); }

  assert.ok(stand.events.includes('ors:open-popover'),
    `the click must ask the chip to open its popover — dispatched ${JSON.stringify(stand.events)}`);
  assert.equal(expandComponent(tree), null, 'the toast must be retired once the popover is asked for');
  assert.deepEqual(
    stand.writes.filter(entry => entry.key === 'ors.seenLimit').map(entry => entry.value),
    ['build-bot:warn:2026-10-09'],
    'and the level is recorded as seen, exactly as a dismissal does',
  );
});

test('warn and critical toast copy differ in every language', () => {
  // m9: the pairs used to be byte-identical in all three locales, so the
  // toast — the one limit surface with no room for a marker — carried no
  // level distinction at all. The placeholders must survive the rewording.
  const keys = ['limitToastWarn', 'limitToastCritical', 'limitToastWarnNoEstimate', 'limitToastCriticalNoEstimate'];
  for (const lang of ['en', 'zh', 'ru']) {
    assert.notEqual(dicts[lang].limitToastWarn, dicts[lang].limitToastCritical, `${lang}: the warn copy must differ from critical`);
    assert.notEqual(dicts[lang].limitToastWarnNoEstimate, dicts[lang].limitToastCriticalNoEstimate, `${lang}: the no-estimate pair must differ too`);
    for (const key of keys) {
      for (const param of ['{name}', '{percent}', '{period}', '{limit}']) {
        assert.ok(dicts[lang][key].includes(param), `${lang} ${key} must keep ${param}`);
      }
    }
    assert.ok(dicts[lang].limitToastWarn.includes('{estimate}'), `${lang}: the estimate variant keeps its figure`);
    assert.ok(dicts[lang].limitToastCritical.includes('{estimate}'), `${lang}: the estimate variant keeps its figure`);
  }
});

test('the request failure code has a sentence in every language', () => {
  // m8: both halves classify a 4xx as `request`, but no dictionary had a key
  // for it, so a classified failure rendered "the reason is unknown" while
  // the raw detail below told the truth.
  assert.equal(api.failureLabelKey('request'), 'errorRequest');
  for (const lang of ['en', 'zh', 'ru']) {
    assert.ok((dicts[lang].errorRequest ?? '').length > 0, `${lang} must translate errorRequest`);
  }
});

test('the limit-notice hint states the default in every language', () => {
  // N11: en used to omit the default-off statement zh and ru both carry,
  // under the same key. The three cannot be compared word for word; the
  // content contract is that each says the feature ships off.
  const statesDefault = /off by default|默认关闭|По умолчанию выключено/i;
  for (const lang of ['en', 'zh', 'ru']) {
    assert.ok(statesDefault.test(dicts[lang].limitNoticeHint), `${lang} must state the default: ${dicts[lang].limitNoticeHint}`);
  }
});

test('zone-less burn stamps are read as UTC, and the window and the day totals agree', () => {
  // m12: `date__hour` arrives with no designator, and a bare `Date.parse`
  // read it in the reader's zone — on a UTC+3 machine a stamp at the exact
  // window floor landed three hours below it and was dropped. Both helpers
  // now read one UTC clock, and numeric stamps count in both, consistently.
  const nowMs = Date.UTC(2026, 9, 9, 12, 0, 0);
  const burn = [
    { ts: '2026-10-09T11:00:00', usd: 1 }, // an hour before now: inside
    { ts: '2026-10-02T12:00:00', usd: 2 }, // exactly the 7-day floor: inside
    { ts: '2026-10-02T11:00:00', usd: 4 }, // an hour past the floor: outside
    { ts: '2026-10-09T13:00:00', usd: 8 }, // the future: outside
    { ts: Date.UTC(2026, 9, 8, 6), usd: 16 }, // a numeric stamp: counted like a string
    { ts: 'not a date', usd: 32 }, // unparseable: kept by the window, day-less
  ];
  const windowed = windowedBurn(burn, nowMs);
  assert.ok(windowed.some(bucket => bucket.usd === 1), 'the recent bucket is inside');
  assert.ok(windowed.some(bucket => bucket.usd === 2), 'the bucket at the floor is inside');
  assert.ok(!windowed.some(bucket => bucket.usd === 4), 'the bucket past the floor is outside');
  assert.ok(!windowed.some(bucket => bucket.usd === 8), 'the future is outside');
  assert.ok(windowed.some(bucket => bucket.usd === 16), 'a numeric stamp is kept');
  assert.ok(windowed.some(bucket => bucket.usd === 32), 'an unparseable stamp is kept, not silently dropped');
  // The day totals: today's bucket excluded (still filling), the numeric
  // stamp placed on its UTC day, and the day-less stamp skipped — it cannot
  // contribute to a per-day rate.
  const totals = closedDayTotals(windowed, nowMs);
  assert.deepEqual([...totals].sort((a, b) => a - b), [2, 16]);
});

test('a bucket older than the burn window never reaches the day totals or the runway', () => {
  // m17: widening `LIMIT_BURN_WINDOW_MS` to 30 days survived mutation testing.
  // The cutoff is what forgets an old burst instead of letting it inflate the
  // rate for a month. m12 above pins the window's ARITHMETIC (the UTC parse,
  // the floor, the future); this pins the cutoff's EFFECT on the decision —
  // that `closedDayTotals` and the runway are drawn from the windowed list and
  // from nothing older.
  const nowMs = Date.UTC(2026, 9, 9, 12, 0, 0); // the floor is 2026-10-02T12:00Z
  const inWindow = [
    { ts: '2026-10-03T10:00:00', usd: 2 },
    { ts: '2026-10-04T10:00:00', usd: 2 },
    { ts: '2026-10-05T10:00:00', usd: 2 },
    { ts: '2026-10-06T10:00:00', usd: 2 },
    { ts: '2026-10-07T10:00:00', usd: 2 },
  ];
  // Five old days at 250x the current rate: a burst from a fortnight ago.
  const stale = [
    { ts: '2026-09-27T10:00:00', usd: 500 },
    { ts: '2026-09-28T10:00:00', usd: 500 },
    { ts: '2026-09-29T10:00:00', usd: 500 },
    { ts: '2026-09-30T10:00:00', usd: 500 },
    { ts: '2026-10-01T10:00:00', usd: 500 },
  ];
  const burn = [...inWindow, ...stale];

  // The cutoff itself: only the five recent buckets survive.
  const windowed = windowedBurn(burn, nowMs);
  assert.equal(windowed.length, 5,
    `the five stale buckets must be dropped — kept ${JSON.stringify(windowed.map(b => b.ts))}`);
  assert.deepEqual([...windowed].map(bucket => bucket.usd).sort((a, b) => a - b), [2, 2, 2, 2, 2],
    'what survives is the recent spend alone');

  // And the day totals are drawn from that list, so the old days contribute
  // nothing — while the in-window days all count (the second half of m17).
  assert.deepEqual([...closedDayTotals(windowed, nowMs)].sort((a, b) => a - b), [2, 2, 2, 2, 2]);

  // End to end through the real decision, with `limitState` doing its own
  // filtering from the raw payload shape: 50 of 100 left at $2/day is 25 days
  // of runway and no alarm. The stale days would read $251/day and 0.2 days,
  // which is a critical — so a widened window does not merely change a number,
  // it raises a false alarm.
  const state = limitState({ limit: 100, limitRemaining: 50, limitReset: null, burn, nowMs });
  assert.equal(state.level, 'none', `a fortnight-old burst must not flag a healthy key — got ${state.level}`);
  assert.equal(state.perDayUsd, 2, `the rate must come from the window — got ${state.perDayUsd}`);
  assert.equal(state.runwayDays, 25, `the runway must come from the window — got ${state.runwayDays}`);
  // The runway is "how fast can it go", so it follows the heaviest hour INSIDE
  // the window: $50 at $2/h is 25 h. The stale $500 hour would say 6 min.
  assert.equal(state.runwayMs, 90_000_000, `the peak must be the in-window peak — got ${state.runwayMs}`);

  // The contrast, for the reader: counted directly the very same stale days
  // triple the rate. Only the cutoff keeps them out.
  const unwindowed = closedDayTotals(burn, nowMs);
  assert.deepEqual([...unwindowed].sort((a, b) => a - b), [2, 2, 2, 2, 2, 500, 500, 500, 500, 500],
    'closedDayTotals has no cutoff of its own — the window is what forgets');
  assert.equal(median(unwindowed), 251, 'and that is the false rate a widened window would report');
});

/**
 * One dictionary block, found by its `lang: {` line and then brace-matched
 * from the opening brace.
 *
 * Located by pattern rather than by a fixed indentation or a fixed character
 * window (N13): a reformat of `client.js` must fail loudly, never hand a slice
 * of the wrong block to the assertions below. The braces INSIDE the strings
 * balance (`{count}` opens and closes), so plain depth counting ends on the
 * block's own closing brace.
 */
function dictBlock(lang) {
  const open = source.match(new RegExp(`^\\s*${lang}: \\{`, 'm'));
  assert.ok(open, `client.js must keep a ${lang} dictionary block`);
  const start = source.indexOf('{', open.index);
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in the ${lang} dictionary block`);
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
  en: parseDict(dictBlock('en')),
  zh: parseDict(dictBlock('zh')),
  ru: parseDict(dictBlock('ru')),
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
    // `raise*` joins the vocabulary with ADR-0008: the raise's keys are part of
    // this feature's shipped copy, so a missing row for them is the same
    // invisible gap this test exists to catch.
    .filter(key => /^(limit|period|raise)/.test(key) && !rows.has(key))
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

// ---------------------------------------------------------------------------
// ADR-0007: the account balance is judged by runway, not shown as information
// only. The measured account that forced the decision: a $6.58 pool against
// $241 ever credited, a key at a healthy 31% of its own daily cap, a chip with
// no alarm, and a balance line reading "Account balance … 3%" — a percentage
// of nothing in particular. These tests pin the alarm that line became.

/** Burn buckets spread over several keys, as `burnHourly` arrives keyed. */
function unionBurn(nowMs, perDays) {
  const now = new Date(nowMs);
  const days = perDays.map((usd, i) => {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (perDays.length - i)));
    return { ts: `${day.toISOString().slice(0, 10)}T12:00:00`, usd };
  });
  // Two keys sharing the same buckets: the pool is shared, so the union burn
  // is what `balanceState` must read — a per-key read would halve the pace.
  return { 'dh': days, 'assistant': days.map(d => ({ ...d, usd: 0 })) };
}

/** A balance with `left` dollars against `total` ever credited. */
const credits = (left, total = 241) => ({ totalCredits: total, totalUsage: total - left });

test('balanceState: runway at the median daily account burn sets the level', () => {
  // The median branches exactly like the lifetime key metric: warn at ≤ 3
  // days, critical at ≤ 1. Six dollars at $2/day is 3 — the warn boundary.
  const warn = balanceState({ credits: credits(6), burn: unionBurn(NOW, [2, 2, 2, 2, 2]), nowMs: NOW });
  assert.equal(warn.level, 'warn', `3 days of runway must warn — got ${warn.level}`);
  assert.equal(warn.runwayDays, 3);
  assert.equal(warn.balanceUsd, 6);

  const critical = balanceState({ credits: credits(1.5), burn: unionBurn(NOW, [2, 2, 2]), nowMs: NOW });
  assert.equal(critical.level, 'critical', `0.75 days of runway must be critical — got ${critical.level}`);

  // Clear of the thresholds: no alarm, but the figures still ride along.
  const none = balanceState({ credits: credits(20), burn: unionBurn(NOW, [2, 2, 2]), nowMs: NOW });
  assert.equal(none.level, 'none');
  assert.ok(Math.abs(none.percent - (221 / 241) * 100) < 0.01,
    `the CONSUMED share of the credited total rides along — got ${none.percent}`);
  assert.equal(none.lifetime, true, 'the balance never refills on a schedule, so it is a lifetime shape');
});

test('balanceState: the union burn counts unlimited keys, not just the tracked one', () => {
  // The whole point of ADR-0007: a key with `limit: null` is invisible to every
  // per-key metric and is exactly the key that can drain the pool. The burn
  // must therefore be the UNION of the hourly windows, not any single key's.
  const shared = unionBurn(NOW, [2, 2, 2, 2, 2]);
  // The 'assistant' half of the union spends nothing; 'dh' spends $2/day. Both
  // readings agree here, so the union itself is what must be exercised:
  assert.equal(balanceState({ credits: credits(6), burn: shared, nowMs: NOW }).level, 'warn');
  // A second key carrying real spend on top must DOUBLE the pace, not vanish:
  const both = { ...shared, 'assistant': shared['dh'] };
  const doubled = balanceState({ credits: credits(6), burn: both, nowMs: NOW });
  assert.equal(doubled.runwayDays, 1.5,
    `the union burn is $4/day here, so the runway halves — got ${JSON.stringify(doubled)}`);
  // And an idle tracked key must not hide a busy one: the pool does not care
  // which key spent it.
  const idleTracked = balanceState({ credits: credits(6), burn: { 'dh': shared['dh'].map(d => ({ ...d, usd: 0 })), 'assistant': shared['dh'] }, nowMs: NOW });
  assert.equal(idleTracked.level, 'warn', 'the union burn, not the tracked key burn, decides the level');
});

test('balanceState: fewer than 3 closed days or a zero median stays none', () => {
  // The gate a new install sits behind: no median to divide by, no alarm —
  // and never a division by zero. Silence here is correct, not a bug.
  const fresh = balanceState({ credits: credits(6), burn: unionBurn(NOW, [2, 2]), nowMs: NOW });
  assert.equal(fresh.level, 'none', 'two closed days have no median worth trusting');
  const idle = balanceState({ credits: credits(6), burn: unionBurn(NOW, [0, 0, 0, 0, 0]), nowMs: NOW });
  assert.equal(idle.level, 'none', 'a zero median yields no runway, not an alarm');
  // Nothing at all: a summary without credits (the auxiliary read failed) is
  // the same silence — "could not read" must never become "all spent".
  assert.equal(balanceState({ burn: unionBurn(NOW, [2, 2, 2]), nowMs: NOW }).level, 'none');
});

test('balanceState: a balance at or past zero is critical outright', () => {
  // No window read can soften a pool that is already gone: both the exact
  // zero and the overdraft (a refund in flight, or rounding) must alarm.
  for (const usage of [241, 250]) {
    const state = balanceState({ credits: { totalCredits: 241, totalUsage: usage }, burn: unionBurn(NOW, [0, 0, 0]), nowMs: NOW });
    assert.equal(state.level, 'critical', `usage ${usage} must be critical`);
    assert.equal(state.balanceUsd, 0, 'the balance never renders negative — the pool is empty, not less than empty');
  }
});

test('balanceState: the recent-pace escalation catches the ramp the median misses', () => {
  // ADR-0007's deliberate addition over the lifetime key metric. The measured
  // account's own shape: six quiet days and a ramp — a median of ~$0.2/day
  // with $6 left would read "30 days, fine", while the last three closed days
  // average $6.8/day: under a day of runway. The escalation must fire.
  const ramp = unionBurn(NOW, [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 20]);
  const caught = balanceState({ credits: credits(6), burn: ramp, nowMs: NOW });
  assert.equal(caught.level, 'critical',
    `the ramp must escalate to critical — got ${caught.level} (median ${(caught.perDayUsd ?? 0).toFixed(2)}/day)`);
  // The median alone would have said none: the 3-day mean is the whole alarm.
  const medianAlone = balanceState({ credits: credits(6), burn: unionBurn(NOW, [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]), nowMs: NOW });
  assert.equal(medianAlone.level, 'none', 'the premise: the median alone stays quiet on this shape');

  // The escalation only raises, never quiets: a quiet recent weekend must not
  // talk a median-raised warn back down to none.
  const quieted = balanceState({ credits: credits(9), burn: unionBurn(NOW, [3, 3, 3, 3, 3, 3, 0.1, 0.1, 0.1]), nowMs: NOW });
  assert.equal(quieted.level, 'warn', 'a warn the median raised must survive a quiet weekend');
});

test('balanceState: hysteresis in whole days, like the lifetime key branch', () => {
  // A median moves only when a UTC day boundary crosses a bucket, so the
  // flicker risk is at the thresholds: 4 days leaves a warn only with the
  // previous level aboard.
  assert.equal(balanceState({ credits: credits(4), burn: unionBurn(NOW, [1, 1, 1, 1, 1]), nowMs: NOW }).level, 'none',
    'four days of median runway is past the warn threshold');
  assert.equal(balanceState({ credits: credits(4), burn: unionBurn(NOW, [1, 1, 1, 1, 1]), nowMs: NOW, previous: 'warn' }).level, 'warn',
    'a previous warn holds until the leave-margin clears');
});

test('dotState: the dot carries the stricter of the key and the balance alarms', () => {
  // The measured failure: a healthy key (31% of a daily cap) beside a pool
  // with under a day left painted the dot blue. The balance can only raise,
  // never lower, whatever the key's own level shows.
  assert.equal(dotState('ok', 'none', 'critical'), 'limit-critical', 'a pool alarm holds the dot over a healthy key');
  assert.equal(dotState('ok', 'warn', 'critical'), 'limit-critical', 'critical outranks warn');
  assert.equal(dotState('stale', 'none', 'warn'), 'limit-warn', 'the balance outranks stale figures too');
  assert.equal(dotState('ok', 'critical', 'none'), 'limit-critical', 'the key alarm still holds on its own');
  assert.equal(dotState('ok', 'none', 'none'), 'ok', 'two healthy readings keep the data-health state');
  assert.equal(dotState('ok', 'none'), 'ok', 'no balance argument reads as none — the old signature works');
  // A broken reading outranks both alarms, unchanged.
  assert.equal(dotState('error', 'none', 'critical'), 'error');
  assert.equal(dotState('no-credential', 'critical', 'critical'), 'no-credential');
});

/** The measured account, shaped into a summary: a ramping pool and a quiet key. */
function balanceAlarmPayload() {
  return {
    status: 'ok', refreshedAt: '2026-10-11T21:00:00.000Z', refreshSeconds: 60,
    todaySpend: { usd: 3.06, requests: 61 }, last7: { usd: 37, requests: 700 },
    last30: { usd: 120, requests: 2400 }, byDay: [], byModel: [],
    byKey: [{
      id: 'dh', todayUsd: 3.06, todayRequests: 61, todayModels: [],
      last7: { usd: 37, requests: 700 }, last30: { usd: 120, requests: 2400 },
    }],
    // 10% consumed of a $20 daily cap: the key is quiet AND does not bind
    // ($18 remaining beats the $6.58 pool), so the block belongs to the
    // balance by RANK — the measured case where every per-key metric is
    // green and the pool is the only thing about to stop work.
    limits: { 'dh': { limit: 20, limitRemaining: 18, limitReset: 'daily', disabled: false } },
    limitThresholds: { warn: 0.4, critical: 0.8 },
    burnHourly: unionBurn(Date.UTC(2026, 9, 11, 12, 0, 0), [0.2, 0.2, 0.2, 0.2, 0.2, 2, 15, 17]),
    credits: credits(6.58),
  };
}

test('a critical balance takes the block, the dot and the sentence', async () => {
  // The end-to-end rendering of ADR-0007: the key is quiet, the pool is not,
  // and the popover says the pool — with money, days, and a denominator,
  // not the old bare "3%".
  const stand = loadWithFetch(balanceAlarmPayload(), Date.UTC(2026, 9, 11, 21, 0, 0), {
    'ors.limitNotice': '1',
    'ors.keyId': 'dh',
  });
  const tree = await openPanel(stand);
  const text = textOf(tree).join(' | ');

  const quota = findByClass(tree, 'ors-quota');
  assert.ok(quota, 'the block must render');
  assert.equal(quota.props['data-level'], 'critical', `the pool's level must take the block — got ${quota.props['data-level']}`);
  assert.equal(quota.props.title, dicts.en.limitBalanceHint, 'the block must carry the pool tooltip');
  assert.ok(text.includes('Account balance'), `the label must name the pool: ${text}`);
  // The old line's failure was a percent of nothing: the new one states the
  // money, the credited total it is part of, the time left, and the pool fact.
  assert.ok(text.includes('$6.58 of $241.00 left'), `the sentence must carry the money: ${text}`);
  assert.ok(text.includes('shared by all keys'), `the sentence must name the pool: ${text}`);
  assert.ok(text.includes('under a day'), `the runway must be said: ${text}`);
  const pct = textOf(findByClass(quota, 'ors-quota-pct')).join('');
  assert.equal(pct, '97%', `the meter percent is the CONSUMED share of the credited total — got ${pct}`);

  // The dot: the key is at 31% (none), the pool is critical — the dot must
  // carry the pool, which is what stops work first.
  const dot = findByClass(tree, 'ors-chip-dot');
  assert.equal(dot.props['data-state'], 'limit-critical', `the dot must carry the stricter alarm — got ${dot.props['data-state']}`);
  assert.equal(dot.props['aria-label'], dicts.en.limitLevelCritical, 'the label must name the level the colour carries');

  // The key limit stays hidden in this shape: one number beats two, and the
  // action ("top up") does not change with the second.
  assert.ok(!text.includes('API key limit'), `the quiet key must not take the block: ${text}`);
});

test('with All keys selected, a critical balance outranks the tightest key limit', async () => {
  // The rank path in the block picker: no key is tracked, so `keyLimit` is
  // undefined and `balanceBinds` cannot fire. A tightest key limit EXISTS (so
  // the old third alternative does not apply), and it is quiet — but the pool
  // is critical, so the balance takes the block on rank, not on binding.
  // Measured shape: every per-key metric green, the pool a day from empty.
  const stand = loadWithFetch(balanceAlarmPayload(), Date.UTC(2026, 9, 11, 21, 0, 0), {
    'ors.limitNotice': '1',
  });
  const tree = await openPanel(stand);
  const text = textOf(tree).join(' | ');
  assert.ok(text.includes('Account balance'), `the pool must take the block: ${text}`);
  assert.ok(!text.includes('Tightest'), `a quiet tightest key must not win over a critical pool: ${text}`);
  const quota = findByClass(tree, 'ors-quota');
  assert.equal(quota.props['data-level'], 'critical', `the pool's level must show — got ${quota.props['data-level']}`);
});

test('the balance toast fires, names the pool, and retires as seen for ever', async () => {
  const stand = loadWithFetch(balanceAlarmPayload(), Date.UTC(2026, 9, 11, 21, 0, 0), {
    'ors.limitNotice': '1',
    'ors.keyId': 'dh',
  });
  const toast = stand.mount('shell.overlay', {});
  toast.render();
  let tree = null;
  for (let i = 0; i < 6; i += 1) { await flush(); if (toast.dirty) tree = toast.render(); }
  const shown = expandComponent(tree);
  assert.ok(findByClass(shown, 'ors-toast'), 'the pool escalation must render a toast');
  assert.equal(tree.props.balance, true, 'the toast must be the balance kind');
  const words = textOf(shown).join(' | ');
  assert.ok(words.includes('Account balance'), `the toast must name the pool, not a key: ${words}`);
  assert.ok(words.includes('Top up'), `the critical copy must name the action: ${words}`);
  assert.ok(!words.includes('dh'), `a quiet key must not be blamed for the pool: ${words}`);

  findByTag(shown, 'button').props.onClick(); // dismiss
  for (let i = 0; i < 6; i += 1) { await flush(); if (toast.dirty) tree = toast.render(); }
  assert.equal(expandComponent(tree), null, 'the toast must be gone once dismissed');
  // The seen key: the id `balance`, the level, and the `ever` anchor — a real
  // top-up is the only thing that re-arms it.
  assert.deepEqual(
    stand.writes.filter(entry => entry.key === 'ors.seenLimit').map(entry => entry.value),
    ['balance:critical:ever'],
    `the dismissal must record the pool in its own key — got ${JSON.stringify(stand.writes)}`,
  );
});

test('the balance toast survives a tracked-key switch, unlike a key toast', async () => {
  // The pool did not change with the tracked key, so neither must its
  // escalation — while the key toast retires on the switch, as pinned above.
  const stand = loadWithFetch(balanceAlarmPayload(), Date.UTC(2026, 9, 11, 21, 0, 0), {
    'ors.limitNotice': '1',
    'ors.keyId': 'dh',
  });
  const toast = stand.mount('shell.overlay', {});
  toast.render();
  let tree = null;
  for (let i = 0; i < 6; i += 1) { await flush(); if (toast.dirty) tree = toast.render(); }
  assert.ok(findByClass(expandComponent(tree), 'ors-toast'), 'the pool toast must fire first');

  stand.setPref('ors.keyId', 'other-key');
  for (let i = 0; i < 6; i += 1) { await flush(); if (toast.dirty) tree = toast.render(); }
  assert.ok(findByClass(expandComponent(tree), 'ors-toast'), 'the pool toast must survive the key switch');
  assert.ok(textOf(expandComponent(tree)).join(' ').includes('Account balance'), 'and still name the pool');
});
