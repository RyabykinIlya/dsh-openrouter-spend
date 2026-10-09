/**
 * Unit tests for the failed-refresh state: what went wrong, and when the next
 * attempt is due.
 *
 * Both halves decide this, so both are pinned here. The host classifies the
 * error (`describeFailure`), schedules the retry ladder, and decides whether a
 * request is served from cache (`scheduleRefresh`, `serveFromCache`); the
 * browser mirrors the ladder for a host that never answered, turns the
 * announced schedule into a delay, and names the fault in the reader's
 * language (`retryDelayMs`, `nextPollMs`, `formatCountdown`,
 * `failureLabelKey`).
 *
 * `client.js` is a plain script body — the harness compiles it with
 * `new Function(...)` and refuses `import`/`export` — so the browser half is
 * driven through the module loader's factory, the same seam
 * `limit-state.test.mjs` uses.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { apply, describeFailure, retryDelaySeconds, retryHintSeconds, scheduleRefresh, serveFromCache } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

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
const { retryDelayMs, nextPollMs, formatCountdown, failureLabelKey } = api;

/** An error carrying the `cause` undici uses to hide the errno. */
function withCause(message, code, name = 'TypeError') {
  const error = new Error(message);
  error.name = name;
  error.cause = { code };
  return error;
}

test('describeFailure names the fault the reader has to act on', () => {
  const timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';
  assert.equal(describeFailure(timeout).code, 'timeout');

  const aborted = new Error('This operation was aborted');
  aborted.name = 'AbortError';
  assert.equal(describeFailure(aborted).code, 'timeout');

  // A harness started before its VPN: undici says only `fetch failed`, and the
  // errno behind it is the difference between "no network" and "bad key".
  assert.equal(describeFailure(withCause('fetch failed', 'ENOTFOUND')).code, 'network');
  assert.equal(describeFailure(withCause('fetch failed', 'ECONNREFUSED')).code, 'network');
  assert.equal(describeFailure(withCause('fetch failed', 'EAI_AGAIN')).code, 'network');
  assert.equal(describeFailure(new Error('fetch failed')).code, 'network');
  assert.equal(describeFailure(new Error('socket hang up')).code, 'network');

  assert.equal(describeFailure(new Error('analytics/query answered 401: nope')).code, 'auth');
  assert.equal(describeFailure(new Error('credits answered 403')).code, 'auth');
  assert.equal(describeFailure(new Error('analytics/query answered 429: slow down')).code, 'rate-limit');
  assert.equal(describeFailure(new Error('analytics/query answered 503: down')).code, 'server');
  assert.equal(describeFailure(new Error('credits answered 400')).code, 'request');

  assert.equal(describeFailure(new Error('analytics/query returned no data rows')).code, 'data');
  assert.equal(describeFailure(new Error('keys returned no data array')).code, 'data');
  assert.equal(describeFailure(new Error('credits returned no total_credits/total_usage')).code, 'data');

  assert.equal(describeFailure(new Error('something nobody classified')).code, 'unknown');
  // A thrown string is not an Error; it still must not crash the classifier.
  assert.deepEqual(describeFailure('boom'), { code: 'unknown', detail: 'boom' });
  // The wire's own words always survive for the reader who needs them.
  assert.equal(describeFailure(new Error('credits answered 403')).detail, 'credits answered 403');
});

test('retryDelaySeconds is quick once, then the ordinary cadence', () => {
  assert.equal(retryDelaySeconds(1, 60), 15);
  assert.equal(retryDelaySeconds(2, 60), 30);
  assert.equal(retryDelaySeconds(3, 60), 60);
  assert.equal(retryDelaySeconds(9, 60), 60);
  // A short interval is the user's choice and is not stretched by the ladder.
  assert.equal(retryDelaySeconds(1, 10), 10);
  assert.equal(retryDelaySeconds(2, 10), 10);
  // A long one still gets the fast first attempt.
  assert.equal(retryDelaySeconds(1, 3600), 15);
  assert.equal(retryDelaySeconds(2, 3600), 30);
  assert.equal(retryDelaySeconds(3, 3600), 3600);
});

test('retryDelaySeconds takes the server hint over the ladder, bounded', () => {
  // the hint wins upwards, even past refreshSeconds: an earlier retry is
  // just another 429
  assert.equal(retryDelaySeconds(1, 60, 90), 90);
  assert.equal(retryDelaySeconds(3, 60, 90), 90);
  // a hint below the ladder changes nothing
  assert.equal(retryDelaySeconds(1, 60, 5), 15);
  // a hostile or misparsed hint is capped rather than obeyed for hours
  assert.equal(retryDelaySeconds(1, 60, 999_999), 3600);
  // garbage reads as no hint at all
  assert.equal(retryDelaySeconds(1, 60, Number.NaN), 15);
  assert.equal(retryDelaySeconds(1, 60, -30), 15);
  assert.equal(retryDelaySeconds(1, 60), 15);
});

test('retryHintSeconds reads Retry-After and X-RateLimit-Reset, taking the later', () => {
  const now = Date.UTC(2026, 9, 9, 12, 0, 0);
  const headers = entries => ({ get: name => entries[name.toLowerCase()] ?? null });

  // plain delay-seconds
  assert.equal(retryHintSeconds(headers({ 'retry-after': '90' }), now), 90);
  // an HTTP-date is measured against the clock
  assert.equal(retryHintSeconds(headers({ 'retry-after': new Date(now + 45_000).toUTCString() }), now), 45);
  // a date already in the past reads as "no hint"
  assert.equal(retryHintSeconds(headers({ 'retry-after': new Date(now - 60_000).toUTCString() }), now), 0);
  // X-RateLimit-Reset is a unix epoch in seconds…
  assert.equal(retryHintSeconds(headers({ 'x-ratelimit-reset': String(Math.round(now / 1000) + 30) }), now), 30);
  // …though some deployments send milliseconds
  assert.equal(retryHintSeconds(headers({ 'x-ratelimit-reset': String(now + 20_000) }), now), 20);
  // both present: the later one wins
  assert.equal(retryHintSeconds(headers({ 'retry-after': '10', 'x-ratelimit-reset': String(Math.round(now / 1000) + 40) }), now), 40);
  // nothing usable
  assert.equal(retryHintSeconds(headers({}), now), 0);
  assert.equal(retryHintSeconds(headers({ 'retry-after': 'soon' }), now), 0);
});

test('scheduleRefresh stamps the announced schedule and walks the ladder', () => {
  const config = { refreshSeconds: 60 };
  const now = Date.UTC(2026, 9, 9, 12, 0, 0);
  const ok = scheduleRefresh({ status: 'ok' }, 4, config, now);
  assert.equal(ok.failures, 0, 'a good read resets the ladder');
  assert.equal(ok.expiresAt, now + 60_000);
  assert.equal(ok.payload.lastAttemptAt, new Date(now).toISOString());
  assert.equal(ok.payload.nextRefreshAt, new Date(now + 60_000).toISOString());
  assert.equal(ok.payload.status, 'ok');

  const first = scheduleRefresh({ status: 'stale', error: 'fetch failed' }, 0, config, now);
  assert.equal(first.failures, 1);
  assert.equal(first.expiresAt, now + 15_000, 'the first retry is the fast one');
  assert.equal(first.payload.nextRefreshAt, new Date(now + 15_000).toISOString());

  const second = scheduleRefresh({ status: 'stale' }, first.failures, config, now);
  assert.equal(second.expiresAt, now + 30_000);

  const third = scheduleRefresh({ status: 'stale' }, second.failures, config, now);
  assert.equal(third.expiresAt, now + 60_000, 'the ladder settles on the cadence');

  const fourth = scheduleRefresh({ status: 'stale' }, third.failures, config, now);
  assert.equal(fourth.expiresAt, now + 60_000, 'and stays there');

  // `no-credential` is a state, not a fault: it keeps the ordinary cadence.
  const noKey = scheduleRefresh({ status: 'no-credential' }, 3, config, now);
  assert.equal(noKey.failures, 0);
  assert.equal(noKey.expiresAt, now + 60_000);
});

test('scheduleRefresh honours a server retry hint riding the stale payload', () => {
  const config = { refreshSeconds: 60 };
  const now = Date.UTC(2026, 9, 9, 12, 0, 0);
  const hinted = scheduleRefresh({ status: 'stale', retryAfterSeconds: 90 }, 1, config, now);
  assert.equal(hinted.expiresAt, now + 90_000, 'the hint overrides the ladder upwards');
  assert.equal(hinted.payload.nextRefreshAt, new Date(now + 90_000).toISOString());
  // a good read ignores any hint that rode the last stale payload
  const ok = scheduleRefresh({ status: 'ok', retryAfterSeconds: 90 }, 2, config, now);
  assert.equal(ok.expiresAt, now + 60_000);
  // no hint: the ladder alone
  const plain = scheduleRefresh({ status: 'stale' }, 1, config, now);
  assert.equal(plain.expiresAt, now + 30_000);
});

test('serveFromCache answers a poll from the entry and a Retry only inside the floor', () => {
  const now = 1_000_000;
  const cached = { expiresAt: now + 60_000, payload: { status: 'ok' } };
  const floorMs = 2000;

  assert.equal(
    serveFromCache({ cached, now, force: false, lastAttemptMs: now - 10_000, floorMs }),
    true,
    'a fresh entry answers a plain poll',
  );
  assert.equal(
    serveFromCache({ cached, now: now + 60_000, force: false, lastAttemptMs: now, floorMs }),
    false,
    'an expired entry does not',
  );
  assert.equal(
    serveFromCache({ cached, now, force: true, lastAttemptMs: now - 500, floorMs }),
    true,
    'a Retry inside the floor is answered from the entry',
  );
  assert.equal(
    serveFromCache({ cached, now, force: true, lastAttemptMs: now - floorMs, floorMs }),
    false,
    'a Retry at the floor reads again',
  );
  assert.equal(
    serveFromCache({ cached: undefined, now, force: false, lastAttemptMs: 0, floorMs }),
    false,
    'nothing cached means nothing to serve',
  );
});

test('retryDelayMs mirrors the host ladder for a host that never answered', () => {
  assert.equal(retryDelayMs(1, 60), 15_000);
  assert.equal(retryDelayMs(2, 60), 30_000);
  assert.equal(retryDelayMs(3, 60), 60_000);
  assert.equal(retryDelayMs(1, 10), 10_000);
  assert.equal(retryDelayMs(3, 10), 10_000);
});

test('nextPollMs follows the host after a failure and the preference when healthy', () => {
  const now = Date.UTC(2026, 9, 9, 12, 0, 0);
  const announced = new Date(now + 15_000).toISOString();

  // A failed read takes the host's ladder, which is the shorter one.
  assert.equal(
    nextPollMs({ status: 'stale', nextRefreshAt: announced, refreshSeconds: 60 }, 300, now),
    now + 15_000,
  );
  // A healthy read with an explicit interval keeps the user's cadence.
  assert.equal(
    nextPollMs({ status: 'ok', nextRefreshAt: new Date(now + 60_000).toISOString(), refreshSeconds: 60 }, 300, now),
    now + 300_000,
  );
  // A healthy read without one follows the host.
  assert.equal(
    nextPollMs({ status: 'ok', nextRefreshAt: new Date(now + 60_000).toISOString(), refreshSeconds: 60 }, 0, now),
    now + 60_000,
  );
  // A host too old to announce a schedule falls back to its cadence, then to 60s.
  assert.equal(nextPollMs({ status: 'stale', refreshSeconds: 90 }, 0, now), now + 90_000);
  assert.equal(nextPollMs({ status: 'ok' }, 0, now), now + 60_000);
  assert.equal(nextPollMs(null, 0, now), now + 60_000);
});

test('formatCountdown reads as m:ss and never counts below zero', () => {
  assert.equal(formatCountdown(0), '0:00');
  assert.equal(formatCountdown(-5_000), '0:00');
  assert.equal(formatCountdown(1), '0:01');
  assert.equal(formatCountdown(1_500), '0:02', 'a partial second still has to elapse');
  assert.equal(formatCountdown(43_000), '0:43');
  assert.equal(formatCountdown(60_000), '1:00');
  assert.equal(formatCountdown(65_000), '1:05');
  assert.equal(formatCountdown(3_599_000), '59:59');
});

test('failureLabelKey names every code, and leaves the raw detail to the panel', () => {
  assert.equal(failureLabelKey('network'), 'errorNetwork');
  assert.equal(failureLabelKey('timeout'), 'errorTimeout');
  assert.equal(failureLabelKey('auth'), 'errorAuth');
  assert.equal(failureLabelKey('rate-limit'), 'errorRateLimit');
  // A classified 4xx is `request` on both halves (m8): the browser emits it
  // for a non-502 HTTP failure and the host for a 4xx, and it used to fall
  // through to "the reason is unknown" while the raw detail told the truth.
  assert.equal(failureLabelKey('request'), 'errorRequest');
  assert.equal(failureLabelKey('server'), 'errorServer');
  assert.equal(failureLabelKey('data'), 'errorData');
  assert.equal(failureLabelKey('host'), 'errorHost');
  // An unrecognised code still gets a sentence rather than an empty line.
  assert.equal(failureLabelKey('something-new'), 'errorUnknown');
  assert.equal(failureLabelKey(undefined), 'errorUnknown');
});

/**
 * The render harness's fixed epoch. Both the harness clock and the payload's
 * `nextRefreshAt` are measured from it, so the countdown a reader sees is
 * exactly knowable: `Date.now() + 15s` in the payload and a real clock in the
 * harness left the assertion a ~5 s budget for however long the machine took
 * to get from the one to the other (m20). Nothing here reads the real clock,
 * so the value is `0:15` on any machine at any load.
 */
const CLOCK = Date.UTC(2026, 9, 9, 12, 0, 0);

/**
 * A render harness for the failure block. The pure functions above say when the
 * next attempt is due; this says what the reader actually sees — the sentence,
 * the countdown, and the button that asks the host to read again now.
 *
 * `setTimeout` is captured rather than fired so the test drives the poll tick by
 * tick: the component arms its next read, the test fires it, and no timer races
 * the click. `fetchImpl` overrides the default always-OK fetch when a test
 * needs to script the wire itself (a read that fails after a good one, a poll
 * that hangs); it keeps its own request log. The clock is controllable for the
 * same reason as in `limit-state.test.mjs`: a second poll inside the 1 s
 * coalescing window would legitimately reuse the first reply, so a test that
 * wants a second read has to step `advance` past it first.
 */
function renderHarness(payload, fetchImpl) {
  let captured;
  const timers = [];
  const fetches = [];
  const dicts = [];
  const slots = {};
  let now = CLOCK;
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(now); else super(...args); }
    static now() { return now; }
  }

  runInNewContext(source, {
    window: {
      __ModuleLoader__: { load: registration => { captured = registration; } },
      localStorage: { getItem: () => null, setItem: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    },
    document: { addEventListener: () => {}, removeEventListener: () => {} },
    fetch: fetchImpl ?? (url => {
      fetches.push(url);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    }),
    setTimeout: fn => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    CustomEvent: class { constructor(type) { this.type = type; } },
    Date: FakeDate,
    console,
  });

  let cursor = null;
  let index = 0;
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
      return [hook.s, value => { hook.s = typeof value === 'function' ? value(hook.s) : value; }];
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

  const instance = { hooks: [] };
  const render = () => {
    cursor = instance.hooks; index = 0;
    return slots['conversation.composer.dock']({ t, sessionId: 'session' });
  };
  const tick = () => { const pending = timers.splice(0, timers.length); pending.forEach(fn => fn()); };

  return { render, tick, fetches, advance: ms => { now += ms; } };
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

/** A stale reply: the last good figures, the reason, and the retry schedule. */
function stalePayload() {
  return {
    status: 'stale',
    error: 'fetch failed',
    errorCode: 'network',
    refreshSeconds: 60,
    nextRefreshAt: new Date(CLOCK + 15_000).toISOString(),
    today: '2026-10-09',
    todaySpend: { usd: 1.5, requests: 3 },
    last7: { usd: 4, requests: 9 },
    last30: { usd: 9, requests: 30 },
    byDay: [],
    byModel: [],
    byKey: [],
    bySession: [],
    limits: {},
    burnHourly: {},
    limitThresholds: { warn: 0.4, critical: 0.8 },
    rate: null,
  };
}

test('a stale reply shows the reason, the countdown, and a Retry that forces a read', async () => {
  const harness = renderHarness(stalePayload());
  harness.render();
  harness.tick();
  await flush();
  const chipTree = harness.render();

  // The chip itself: amber, the last good figure, and a tooltip that says why
  // without the reader having to open anything.
  const chip = findByClass(chipTree, 'ors-chip');
  assert.match(chip.props.title, /could not refresh: OpenRouter is unreachable/);
  // Exactly `0:15`, not `0:1[0-9]`: the harness clock and the announced
  // schedule both come from `CLOCK`, so the 15 s first retry is knowable to
  // the second (m20).
  assert.match(chip.props.title, /Next attempt in 0:15/);
  assert.equal(findByClass(chipTree, 'ors-chip-dot').props['data-state'], 'stale');
  assert.match(textOf(chipTree).join(' | '), /\$1\.50/, 'the last good figures stay on screen');

  // The popover: the sentence, the wire's own words, the countdown, the button.
  chip.props.onClick();
  const tree = harness.render();
  const text = textOf(tree).join(' | ');
  assert.match(text, /Could not refresh: OpenRouter is unreachable from this machine/,
    'the fault is named in the reader\'s language, not as the wire\'s words');
  assert.match(text, /fetch failed/, 'the raw detail stays under the sentence');
  assert.match(text, /Next attempt in 0:15/, 'the countdown to the next attempt is shown');

  const retry = findByClass(tree, 'ors-retry');
  assert.equal(textOf(retry).join(''), 'Retry now');
  assert.equal(retry.props.disabled, false);

  // Pressing it must ask the host for a fresh read, not another cached reply.
  retry.props.onClick();
  await flush();
  assert.equal(harness.fetches.length, 2);
  assert.equal(harness.fetches[0], '/openrouter-spend/summary');
  assert.equal(harness.fetches[1], '/openrouter-spend/summary?force=1');
});

/** The good counterpart of `stalePayload`: figures on screen, nothing wrong. */
function okPayload() {
  return { ...stalePayload(), status: 'ok', error: undefined, errorCode: undefined };
}

test('a failed refresh turns the dot amber while the good figures stay on screen', async () => {
  // M3 / ADR-0005: amber is "the last good figures are still on screen, but
  // the latest read failed". The stale fallback used to apply only when no
  // data had ever arrived, so this combination kept the blue `ok` dot — the
  // one at-a-glance signal saying healthy exactly when serving stopped.
  // The rejections are created inside the fetch call (a thunk, not a parked
  // promise): a rejected promise with no handler yet in the same turn would
  // surface as an unhandled rejection before `fetchSummary` catches it.
  const reads = [
    () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(okPayload()) }),
    () => Promise.reject(new TypeError('fetch failed')),
  ];
  const harness = renderHarness(null, () => reads.shift()());

  harness.render();
  harness.tick(); // the first read lands: good figures, no failure
  await flush();
  let tree = harness.render();
  assert.equal(findByClass(tree, 'ors-chip-dot').props['data-state'], 'ok');
  assert.match(textOf(tree).join(' | '), /\$1\.50/, 'the good read is on screen');

  harness.advance(5_000); // past the coalescing window: the next poll must really read
  harness.tick(); // and that read fails
  await flush();
  tree = harness.render();
  assert.equal(
    findByClass(tree, 'ors-chip-dot').props['data-state'], 'stale',
    'a failed read with good data on screen must be the amber dot',
  );
  assert.match(textOf(tree).join(' | '), /\$1\.50/, 'the last good figures stay');
  assert.match(findByClass(tree, 'ors-chip').props.title, /could not refresh: OpenRouter is unreachable/);
});

test('the Retry label says what the disabled button is doing during a background poll', async () => {
  // m11: the button is disabled for ANY read in flight, but the label used to
  // read "Retry now" unless the read had been forced — a disabled button
  // promising the very action it refuses. The label must derive from the
  // same state that does the disabling.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  // Same thunk discipline as the M3 test: the rejection must be born inside
  // the fetch call, with `fetchSummary`'s catch attached in the same turn.
  const reads = [
    () => Promise.reject(new TypeError('fetch failed')), // the first read fails: the block appears
    () => gate,                                          // the next poll hangs until released
  ];
  const harness = renderHarness(null, () => reads.shift()());

  harness.render();
  harness.tick();
  await flush();
  let tree = harness.render();
  const chip = findByClass(tree, 'ors-chip');
  chip.props.onClick(); // the retry button lives in the popover, so open it
  tree = harness.render();
  const idle = findByClass(tree, 'ors-retry');
  assert.equal(textOf(idle).join(''), 'Retry now');
  assert.equal(idle.props.disabled, false);

  harness.advance(5_000); // past the coalescing window: the next poll must really read
  harness.tick(); // the scheduled poll fires and parks on the gate
  tree = harness.render();
  const busy = findByClass(tree, 'ors-retry');
  assert.equal(busy.props.disabled, true, 'a poll in flight disables the button');
  assert.equal(textOf(busy).join(''), 'Retrying\u2026', 'the label must follow the disabled state');

  release({ ok: true, status: 200, json: () => Promise.resolve(stalePayload()) });
  await flush();
});

/**
 * A route harness for the host half: `apply()` against a stub context and a
 * scripted OpenRouter, driving the registered handlers the way the web server
 * would. Scoped to the interleavings the pure helpers cannot see — a
 * credential written while a read is in flight, and the POST route's error
 * reply — since the fuller route-level suite is pinned elsewhere.
 *
 * The scripted API answers spend by credential, so which key produced a
 * payload is observable in the figures; `holdOldCredits` parks the old key's
 * credits read on a gate, which is what makes a read provably in flight.
 */
function routeHarness({ credentials, figures = { old: 1, fresh: 9 }, holdOldCredits = false }) {
  const handlers = {};
  const fetches = [];
  const originalFetch = globalThis.fetch;
  const day = new Date().toISOString().slice(0, 10);
  let releaseOldCredits = () => undefined;
  let oldCreditsStarted = () => undefined;
  const reply = (status, body) => ({
    ok: status < 300,
    status,
    headers: { get: name => (name === 'content-length' ? '1234' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    const auth = init.headers?.authorization ?? '';
    fetches.push({ target, auth });
    const spend = auth.includes('old-key') ? figures.old : figures.fresh;
    if (target.startsWith('https://cbr.test')) return reply(404, {});
    if (target.endsWith('/credits')) {
      if (holdOldCredits && auth.includes('old-key')) {
        oldCreditsStarted();
        await new Promise(resolve => { releaseOldCredits = resolve; });
      }
      return reply(200, { data: { total_credits: 100, total_usage: 10 } });
    }
    if (target.endsWith('/analytics/query')) {
      const body = JSON.parse(init.body);
      if (body.dimensions.includes('model')) {
        return reply(200, {
          data: {
            data: [{ date__day: day, api_key_id: 'k', model: 'm', total_usage: String(spend), request_count: '1' }],
            metadata: {},
          },
        });
      }
      return reply(200, { data: { data: [], metadata: {} } });
    }
    // /keys (with its pagination query) and anything else
    return reply(200, { data: [] });
  };
  const ctx = {
    logger: { warn: () => undefined },
    effect: fn => fn(),
    webServer: { register: definition => { handlers[definition.path] = definition.handler; return () => undefined; } },
    connection: { requestRejection: () => undefined },
    credentials,
    sessionQuery: { listSessions: async () => [] },
  };
  const config = {
    credentialRef: 'REF', apiBase: 'https://api.test/v1', refreshSeconds: 60, historyDays: 30,
    cbrUrl: 'https://cbr.test/rates', rateRefreshSeconds: 3600, timeoutMs: 15_000,
    warnConsumedFraction: 0.4, criticalConsumedFraction: 0.8, burnWindowDays: 7,
  };
  return {
    handlers, fetches, ctx, config,
    oldCreditsStarted: new Promise(resolve => { oldCreditsStarted = resolve; }),
    releaseOldCredits: () => releaseOldCredits(),
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

/** A response recorder the handlers can end() into. */
function makeRes() {
  const res = { statusCode: 0, setHeader: () => undefined, end(body) { this.body = body; } };
  return res;
}

/** Drive the registered GET /summary handler. */
async function getSummary(harness, url = '/openrouter-spend/summary') {
  const res = makeRes();
  await harness.handlers['/openrouter-spend/summary']({ method: 'GET', url }, res);
  return { status: res.statusCode, payload: JSON.parse(res.body) };
}

/** Drive the registered POST /credential handler with a JSON body. */
async function postCredential(harness, body) {
  const res = makeRes();
  const req = {
    method: 'POST',
    url: '/openrouter-spend/credential',
    resume() {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  };
  await harness.handlers['/openrouter-spend/credential'](req, res);
  return { status: res.statusCode, payload: JSON.parse(res.body) };
}

const tick = () => new Promise(resolve => { setTimeout(resolve, 0); });

test('saving a key while a read is in flight answers with the new key and never caches the old one', async () => {
  const store = { value: 'old-key' };
  const harness = routeHarness({
    credentials: {
      resolve: async () => (store.value === undefined ? undefined : { value: store.value }),
      describe: async () => ({ configured: store.value !== undefined, writable: true }),
      set: async (ref, value) => { store.value = value; },
      unset: async () => { store.value = undefined; },
    },
    holdOldCredits: true,
  });
  try {
    apply(harness.ctx, harness.config); // the priming read starts under the old key…
    await harness.oldCreditsStarted; // …and is provably parked mid-read
    await tick(); // its ungated queries all land before the write does
    const { status, payload } = await postCredential(harness, '{"value":"new-key"}');

    // the POST answer is an explicit fresh read under the new key, not the
    // in-flight one: 9 is the new key's figure, 1 the old key's
    assert.equal(status, 200);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.todaySpend.usd, 9, 'the reply carries figures read under the new key');
    assert.equal(payload.credential.configured, true);

    // the old-key read completes only now, after the write: it must not reach
    // the cache, or the next polls would show the pre-write figures
    harness.releaseOldCredits();
    await tick();
    const poll = await getSummary(harness);
    assert.equal(poll.payload.todaySpend.usd, 9, 'the cache holds the post-write payload');
    const fetchesAfterPoll = harness.fetches.length;
    assert.equal((await getSummary(harness)).payload.todaySpend.usd, 9);
    assert.equal(harness.fetches.length, fetchesAfterPoll, 'the poll was answered from the cache');
    // no request after the write ever carried the old key
    const firstFresh = harness.fetches.findIndex(entry => entry.auth.includes('new-key'));
    assert.ok(firstFresh >= 0);
    assert.equal(harness.fetches.slice(firstFresh).every(entry => !entry.auth.includes('old-key')), true);
  } finally {
    harness.restore();
  }
});

test('POST /credential answers a JSON 502 when the read after the write cannot even start', async () => {
  const harness = routeHarness({
    credentials: {
      resolve: async () => { throw new Error('credentials store offline'); },
      describe: async () => ({ configured: true, writable: true }),
      set: async () => undefined,
      unset: async () => undefined,
    },
  });
  try {
    apply(harness.ctx, harness.config); // the priming read fails the same way, contained
    const { status, payload } = await postCredential(harness, '{"value":"new-key"}');

    // the GET route's JSON 502, not a bare 400 from the host
    assert.equal(status, 502);
    assert.equal(payload.status, 'error');
    assert.match(payload.error, /credentials store offline/);
  } finally {
    harness.restore();
  }
});

test('apply refuses warnConsumedFraction at or above criticalConsumedFraction', () => {
  // the refusal happens before any registration, so a bare context is enough
  const config = {
    credentialRef: 'REF', apiBase: 'https://api.test/v1', refreshSeconds: 60, historyDays: 30,
    cbrUrl: 'https://cbr.test/rates', rateRefreshSeconds: 3600, timeoutMs: 15_000,
    warnConsumedFraction: 0.9, criticalConsumedFraction: 0.5, burnWindowDays: 7,
  };
  assert.throws(
    () => apply({}, config),
    /warnConsumedFraction \(0\.9\) must be below criticalConsumedFraction \(0\.5\)/,
  );
});
