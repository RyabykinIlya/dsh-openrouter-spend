/**
 * Tests for the raise (ADR-0008): the host's `POST /openrouter-spend/key-limit`
 * route, the pure narrowing around it (`parseKeyLimitBody`, `raiseKeyLimit`'s
 * refusal kinds), and the client's pure raise pieces (`suggestedRaise`,
 * `parseRaiseInput`).
 *
 * The seams are the same two the rest of the suite uses: import from
 * `../index.js` for the host half, and the module-loader seam (`runInNewContext`
 * + a stubbed `window.__ModuleLoader__`) for `client.js`. No network — `fetch`
 * is stubbed with the same protocol-shaped mocks `summary-route.test.mjs`
 * uses — and no real clock: `Date.now` is faked where the cache or the
 * raise's cache-retire matters.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, parseKeyLimitBody, raiseKeyLimit } from '../index.js'

// ------------------------------------------------- the client's pure pieces

const source = await import('node:fs').then(fs =>
  fs.promises.readFile(new URL('../client.js', import.meta.url), 'utf8'))
const { runInNewContext } = await import('node:vm')

/** The minimal `react` stub the factory destructures at module scope. */
const reactStub = {
  createElement: () => null,
  useCallback: fn => fn,
  useEffect: () => undefined,
  useMemo: fn => fn(),
  useRef: initial => ({ current: initial }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => undefined],
}

function loadClient() {
  let captured
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: registration => { captured = registration } } },
  })
  const api = captured.factory(specifier => {
    if (specifier === 'react') return reactStub
    throw new Error(`unexpected dependency: ${specifier}`)
  })
  return api
}

const client = loadClient()

/**
 * Load the factory and capture what `apply` registers as the dictionaries —
 * the seam `locale-keys.test.mjs` uses. The raise's copy is shipped product, so
 * its placeholders are a contract: call sites pass `{amount}`, `{limit}` or
 * `{reason}`, and a key that lost one would render the figure literally.
 */
function loadDictionaries() {
  let captured
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: registration => { captured = registration } } },
  })
  const api = captured.factory(specifier => {
    if (specifier === 'react') return reactStub
    throw new Error(`unexpected dependency: ${specifier}`)
  })
  const registered = []
  api.apply({
    effect: fn => { fn(); return () => {}; },
    locale: {
      register: (namespace, dict) => { registered.push(dict); return () => {}; },
      bind: () => key => key,
    },
    slots: { inject: (name, thunk) => { thunk(); }, register: () => () => {} },
  })
  const dict = registered.find(entry => entry.en !== undefined)
  assert.ok(dict, 'apply must register the three dictionaries')
  return { en: dict.en, zh: dict.zh, ru: dict.ru }
}

const dicts = loadDictionaries()

const raisePlaceholders = template =>
  [...String(template).matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()

test('the raise copy keeps the placeholders its call sites pass, in all three languages', () => {
  // Derived from the render sites, not from taste: `raiseTo` is given `{amount}`
  // (the figure that will be SENT), `raiseToRub` `{amount}` plus `{rub}` (the
  // read-only echo, ADR-0009), `raiseCustomPlaceholder` and `raiseCustomRefused`
  // `{limit}` (the current cap, so the field says what "above" means), and
  // `raiseFailed` `{reason}` (the route's refusal). `raiseLabel` and
  // `raiseApply` are rendered without params, so a placeholder in either would
  // ship as literal text.
  const expected = {
    raiseTo: ['amount'],
    raiseToRub: ['amount', 'rub'],
    raiseCustomPlaceholder: ['limit'],
    raiseCustomRefused: ['limit'],
    raiseFailed: ['reason'],
    raiseLabel: [],
    raiseApply: [],
    raiseCustomLabel: [],
  }
  for (const lang of ['en', 'zh', 'ru']) {
    for (const [key, params] of Object.entries(expected)) {
      const value = dicts[lang][key]
      assert.equal(typeof value, 'string', `${lang} must define ${key}`)
      assert.deepEqual(raisePlaceholders(value), params,
        `${lang} ${key} must carry exactly ${JSON.stringify(params)} — got ${JSON.stringify(value)}`)
    }
  }
})

test('raiseOfferLabel leads with the sent figure and echoes the display currency', () => {
  // ADR-0009's rule, driven directly. The figure that reaches the route is USD,
  // so it leads in every shape; the ruble echo is a decoration that exists only
  // while the panel has a rate, because a write must not depend on the rate read.
  const fmtMoney = (value, currency) => {
    const amount = Number(value) || 0
    const magnitude = Math.abs(amount)
    const digits = magnitude === 0 ? 2 : magnitude < 0.01 ? 4 : magnitude < 1 ? 3 : 2
    return currency === 'RUB' ? `${amount.toFixed(digits)} \u20bd` : `$${amount.toFixed(digits)}`
  }
  const moneyFor = (rub, rate) => ({
    rub,
    fmt: value => fmtMoney(value * (rub ? rate : 1), rub ? 'RUB' : 'USD'),
    fmtUsd: value => fmtMoney(value, 'USD'),
  })
  // A `t` shaped like the locale layer's: `{name}` substitution, key on a miss.
  const t = (key, params) => {
    const dict = { raiseTo: 'Raise to {amount}', raiseToRub: 'Raise to {amount} \u00b7 \u2248 {rub}' }
    const template = dict[key] ?? key
    return params ? template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : template
  }

  const withRate = client.raiseOfferLabel(moneyFor(true, 140.98), t, 15)
  assert.equal(withRate, 'Raise to $15.00 \u00b7 \u2248 2114.70 \u20bd',
    `the sent figure leads and the echo follows — got ${JSON.stringify(withRate)}`)
  const noRate = client.raiseOfferLabel(moneyFor(false, undefined), t, 15)
  assert.equal(noRate, 'Raise to $15.00',
    `no rate costs the echo and nothing else — got ${JSON.stringify(noRate)}`)
  // The frame the maintainer hit: the ruble form must never BE the sent figure.
  assert.ok(!/\u20bd/.test(withRate.split('\u00b7')[0]),
    'the ruble figure must stay on the echo side of the separator, never in the sent half')
})

test('the offer is named the same way in the popover and the toast', () => {
  // Both surfaces render `raiseTo` with the same `{amount}`; a second key would
  // let them promise different figures for the same click.
  for (const lang of ['en', 'zh', 'ru']) {
    assert.ok(dicts[lang].raiseTo.includes('{amount}'),
      `${lang}: the shared offer key must keep its figure — got ${JSON.stringify(dicts[lang].raiseTo)}`)
    assert.notEqual(dicts[lang].raiseTo, dicts[lang].raiseApply,
      `${lang}: the offer and the apply button must read differently`)
  }
})

test('the toast calls its hook before any early return, so the hook count is stable', () => {
  // React rejects a component whose hook count changes between renders, and a
  // test cannot see it here: the harness's stub `useState`/`useRef` are plain
  // functions, so a hook placed after an early return renders fine in the
  // suite and throws only in the browser. The rule is therefore pinned by
  // reading the source: inside `Toast`, the `useRaise(...)` call must come
  // before the `if (!state || level === 'none') return null;` guard, which is
  // the only early return in the component.
  const start = source.indexOf('function Toast(props)')
  assert.notEqual(start, -1, 'client.js must keep `Toast`')
  const body = source.slice(start, source.indexOf('\n    function Pill(', start))
  const hookAt = body.indexOf('useRaise(')
  const guardAt = body.indexOf("if (!state || level === 'none') return null;")
  assert.notEqual(hookAt, -1, 'the toast must reach the raise hook')
  assert.notEqual(guardAt, -1, 'the toast must keep its level guard')
  assert.ok(hookAt < guardAt,
    'a hook after an early return changes the hook count between renders — React throws on exactly that')
})

// ------------------------------------------------- suggestedRaise / parseRaiseInput

test('suggestedRaise offers cap + one period burn for a fast period cap, x1.5 otherwise', () => {
  // The user's rule, made mechanical: the offer depends on the amount and the
  // speed. A period cap that is burning fast (a period burn exists and is
  // positive) offers enough to finish THIS period at the pace that raised the
  // alarm; anything else offers half again as much.
  const fast = client.suggestedRaise({ cap: 10, periodBurnUsd: 8.5, lifetime: false })
  assert.equal(fast, 18.5, `10 burned at 8.5 this period offers 18.5, not half again — got ${fast}`)
  const slow = client.suggestedRaise({ cap: 10, periodBurnUsd: 0, lifetime: false })
  assert.equal(slow, 15, 'a still period cap offers half again as much')
  const lifetime = client.suggestedRaise({ cap: 10, periodBurnUsd: undefined, lifetime: true })
  assert.equal(lifetime, 15, 'a lifetime cap offers half again as much — its pace is daily, not periodic')
})

test('suggestedRaise rounds to dimes and never offers below the cap', () => {
  // Money is never sub-dime: an offer in finer grains is a number the account
  // cannot carry. And the offer is at least a dime above the cap, so the
  // button is always a raise, never a no-op wearing one.
  const odd = client.suggestedRaise({ cap: 10.03, periodBurnUsd: 3.331, lifetime: false })
  assert.equal(odd, 13.4, `13.371 rounds to 13.4 — got ${odd}`)
  const tiny = client.suggestedRaise({ cap: 0.01, periodBurnUsd: 0, lifetime: true })
  assert.equal(tiny, 0.1, `the offer never lands at or below the cap — got ${tiny}`)
  assert.equal(client.suggestedRaise({ cap: 0 }), undefined, 'no cap, no offer')
  assert.equal(client.suggestedRaise({ cap: -5 }), undefined, 'a negative cap is not a cap')
})

test('parseRaiseInput accepts a comma as a decimal separator and rounds to dimes', () => {
  // The reader is typing a figure, not programming: the decimal separator is
  // whatever their keyboard laid out. Anything at or below the current cap is
  // refused as `undefined` — the custom field's `Raise` button disables and
  // the field's title says why.
  assert.equal(client.parseRaiseInput('15,5', 10), 15.5, 'a comma reads as a point')
  assert.equal(client.parseRaiseInput('15.44', 10), 15.4, 'rounded down to the dime')
  assert.equal(client.parseRaiseInput('9,99', 10), undefined, 'at the cap is not a raise — 10 itself is not one')
  assert.equal(client.parseRaiseInput(15.55, 10), 15.6, 'a number is accepted too, and rounded')
  assert.equal(client.parseRaiseInput('', 10), undefined, 'empty is not a raise')
  assert.equal(client.parseRaiseInput('abc', 10), undefined, 'not a figure')
  assert.equal(client.parseRaiseInput('-5', 10), undefined, 'negative is not a raise')
})

// ------------------------------------------------- limitState carries the raise figures

test('limitState carries the rounded faces and the offer on every branch that shows a cap', () => {
  const state = client.limitState({
    limit: 12.123, limitRemaining: 7.2, limitReset: 'daily', burn: [],
    nowMs: Date.UTC(2026, 9, 9, 12), thresholds: { warn: 0.4, critical: 0.8 },
  })
  assert.equal(state.limitUsdRounded, 12.12, 'the whole-dollar face the button prints')
  // 4.92 of 12.123 consumed is 40.55% — the whole-percent face rounds it to 41.
  assert.equal(state.percentRounded, 41, 'the whole-percent face the meter prints')
  assert.equal(state.raiseToUsd, 17,
    'the periodic offer is the rounded cap plus the period burn, rounded to dimes — 12.12 + 4.92 = 17.04 → 17')
  assert.ok(state.raiseToUsd > state.limitUsdRounded, 'the offer is a raise of the cap it will be sent with')
  // The lifetime branch offers too: it has no period, so it falls to x1.5.
  const lifetime = client.limitState({
    limit: 10, limitRemaining: 8, limitReset: null,
    burn: [4, 3, 2, 1, 0].map(d => ({ ts: `2026-10-0${9 - d}T12:00:00Z`, usd: 2 })),
    nowMs: Date.UTC(2026, 9, 9, 12),
  })
  assert.equal(lifetime.raiseToUsd, 15, 'the lifetime branch offers half again as much')
  assert.equal(lifetime.periodBurnUsd, undefined, 'a lifetime cap has no period to burn one of')
})

// ------------------------------------------------- parseKeyLimitBody

test('parseKeyLimitBody reads name and limit, and refuses the rest', () => {
  assert.deepEqual(parseKeyLimitBody('{"name":"build-bot","limit":15}'), { name: 'build-bot', limit: 15 })
  // A numeric string is accepted: OpenRouter's own reads accept both spellings.
  assert.deepEqual(parseKeyLimitBody('{"name":"build-bot","limit":"15"}'), { name: 'build-bot', limit: 15 })
  assert.equal(parseKeyLimitBody('{"limit":15}'), undefined, 'no name names no key')
  assert.equal(parseKeyLimitBody('{"name":"","limit":15}'), undefined, 'an empty name is none')
  assert.equal(parseKeyLimitBody('{"name":"build-bot"}'), undefined, 'no limit raises nothing')
  assert.equal(parseKeyLimitBody('{"name":"build-bot","limit":"abc"}'), undefined, 'not a figure')
  assert.equal(parseKeyLimitBody('{}'), undefined, 'an empty object raises nothing')
  assert.equal(parseKeyLimitBody('not json'), undefined, 'not JSON')
  assert.equal(parseKeyLimitBody(''), undefined, 'empty is not a raise')
})

// ------------------------------------------------- raiseKeyLimit refusals

/** The `fetch` mock: `keys` answers `pages`, the PATCH answers `patchStatus`. */
function mockKeys({ pages, patchStatus = 200, patched = [] } = {}) {
  let calls = 0
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    if (init.method === 'PATCH') {
      patched.push({ url: target, body: JSON.parse(init.body), auth: init.headers?.authorization })
      return { ok: patchStatus < 300, status: patchStatus, headers: { get: () => null }, json: async () => ({}), text: async () => 'nope' }
    }
    const page = pages[Math.min(calls, pages.length - 1)] ?? []
    calls += 1
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: page }) }
  }
  return () => { globalThis.fetch = undefined }
}

const config = {
  apiBase: 'https://api.test/v1',
  timeoutMs: 15_000,
}

test('raiseKeyLimit resolves the name to the hash and PATCHes only the limit', async () => {
  const patched = []
  const restore = mockKeys({
    pages: [[{ name: 'build-bot', limit: 10, hash: 'hash-one' }, { name: 'other', limit: 5, hash: 'hash-two' }]],
    patched,
  })
  try {
    const raised = await raiseKeyLimit(config, 'mgmt-key', 'build-bot', 15)
    assert.deepEqual(raised, { name: 'build-bot', limit: 15 })
    assert.equal(patched.length, 1, 'exactly one PATCH')
    assert.ok(patched[0].url.endsWith('/keys/hash-one'), `the PATCH names the key's hash — got ${patched[0].url}`)
    assert.deepEqual(patched[0].body, { limit: 15 }, 'the body carries the limit and nothing else')
    assert.equal(patched[0].auth, 'Bearer mgmt-key', 'the management key rides the Authorization header, never the URL')
  } finally {
    restore()
  }
})

test('raiseKeyLimit refuses a name the account does not carry', async () => {
  const restore = mockKeys({ pages: [[{ name: 'build-bot', limit: 10, hash: 'hash-one' }]] })
  try {
    await assert.rejects(
      () => raiseKeyLimit(config, 'mgmt-key', 'ghost', 15),
      /no key named "ghost" on the account/,
      error => { assert.equal(error.kind, 'not-found'); return true },
    )
  } finally { restore() }
})

test('raiseKeyLimit refuses a name two keys share, naming the fix', async () => {
  const restore = mockKeys({
    pages: [[{ name: 'build-bot', limit: 10, hash: 'hash-one' }, { name: 'build-bot', limit: 20, hash: 'hash-two' }]],
  })
  try {
    // The ambiguity is judged over EVERY key carrying the name, not only the
    // limited ones `readKeyLimits` publishes: the raise names a record, and
    // OpenRouter identifies records by hash alone.
    await assert.rejects(
      () => raiseKeyLimit(config, 'mgmt-key', 'build-bot', 15),
      /share a name, and OpenRouter identifies a key by hash/,
      error => { assert.equal(error.kind, 'ambiguous'); return true },
    )
  } finally { restore() }
})

test('raiseKeyLimit refuses anything that is not a raise of the current limit', async () => {
  const restore = mockKeys({ pages: [[{ name: 'build-bot', limit: 10, hash: 'hash-one' }]] })
  try {
    await assert.rejects(
      () => raiseKeyLimit(config, 'mgmt-key', 'build-bot', 10),
      /only a raise is accepted/,
      error => { assert.equal(error.kind, 'invalid'); return true },
    )
    await assert.rejects(
      () => raiseKeyLimit(config, 'mgmt-key', 'build-bot', 5),
      /only a raise is accepted/,
    )
    // The typo guard: a raise two orders of magnitude up is a typo wearing
    // intent, and the wire cannot tell them apart — so this half refuses.
    await assert.rejects(
      () => raiseKeyLimit(config, 'mgmt-key', 'build-bot', 1000),
      /is past 10x the current/,
    )
  } finally { restore() }
})

test('raiseKeyLimit refuses a key with no finite limit, naming the real fix', async () => {
  const restore = mockKeys({ pages: [[{ name: 'build-bot', limit: null, hash: 'hash-one' }]] })
  try {
    // The honest sentence says what to do: there is no cap to RAISE, so the
    // fix is to SET one in OpenRouter, not to retry here.
    await assert.rejects(
      () => raiseKeyLimit(config, 'mgmt-key', 'build-bot', 15),
      /carries no finite limit/,
      error => { assert.equal(error.kind, 'no-limit'); return true },
    )
  } finally { restore() }
})

test('raiseKeyLimit passes an upstream refusal through verbatim', async () => {
  const restore = mockKeys({
    pages: [[{ name: 'build-bot', limit: 10, hash: 'hash-one' }]],
    patchStatus: 403,
  })
  try {
    // The words are upstream's; this half must not invent its own for a reply
    // it never saw (the same rule the analytics refusals follow).
    await assert.rejects(
      () => raiseKeyLimit(config, 'mgmt-key', 'build-bot', 15),
      /keys\/\{hash\} answered 403/,
      error => { assert.equal(error.kind, undefined); return true },
    )
  } finally { restore() }
})

// ------------------------------------------------- the route

/** A response recorder; the handlers `end()` into it. */
function makeRes() {
  const res = { statusCode: 0, headers: {}, setHeader: (n, v) => { res.headers[n.toLowerCase()] = v }, end(body) { res.body = body ?? '' } }
  return res
}

const reqWith = (method, url, body) => ({
  method,
  url,
  resume() {},
  async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body) },
})

/** The same stubbed Cordis context `summary-route.test.mjs` drives, with the
 * `fetch` mock answering the six upstream endpoints a summary reads. A
 * successful PATCH is reflected in the `/keys` answers that follow it, the
 * way the real account would. */
function routeHarness({ keyRows, patchStatus = 200 } = {}) {
  const handlers = {}
  const fetches = []
  const patches = []
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  // The rows the mock serves; a successful PATCH rewrites the raised row.
  const served = (keyRows ?? []).map(row => ({ ...row }))
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    const entry = { target, method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) }
    fetches.push(entry)
    if (init.method === 'PATCH') {
      patches.push(entry)
      if (patchStatus < 300) {
        const raised = served.find(row => row.hash === target.split('/keys/')[1])
        if (raised !== undefined) raised.limit = entry.body.limit
      }
      return { ok: patchStatus < 300, status: patchStatus, headers: { get: () => null }, json: async () => ({}), text: async () => 'nope' }
    }
    if (target.startsWith('https://cbr.test')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }
    if (target.includes('/credits')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { total_credits: 100, total_usage: 10 } }) }
    if (target.includes('/keys')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: served }) }
    if (target.endsWith('/analytics/query')) {
      const body = JSON.parse(init.body)
      if (body.granularity === 'hour') return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { data: [], metadata: {} } }) }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { data: [], metadata: {} } }) }
    }
    throw new Error(`mock: unexpected ${init.method ?? 'GET'} ${target}`)
  }
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    effect: fn => fn(),
    webServer: { register: definition => { handlers[definition.path] = definition.handler; return () => undefined } },
    connection: { requestRejection: () => undefined },
    credentials: {
      resolve: async () => ({ value: 'mgmt-key' }),
      describe: async () => ({ configured: true, writable: true }),
      set: async () => {},
      unset: async () => {},
    },
    sessionQuery: { listSessions: async () => [] },
  }
  const config = {
    credentialRef: 'OPENROUTER_MGMT_API_KEY', apiBase: 'https://api.test/v1', refreshSeconds: 60,
    historyDays: 30, cbrUrl: 'https://cbr.test/rate', rateRefreshSeconds: 3600, timeoutMs: 15_000,
    warnConsumedFraction: 0.4, criticalConsumedFraction: 0.8, burnWindowDays: 7,
  }
  return {
    handlers, fetches, patches, ctx, config,
    apply: () => apply(ctx, config),
    advance: ms => { now += ms },
    restore: () => { globalThis.fetch = originalFetch; Date.now = originalNow },
  }
}

const flush = async (turns = 8) => {
  for (let i = 0; i < turns; i += 1) await new Promise(resolve => { setTimeout(resolve, 0) })
}

const harnessKeys = [{ name: 'build-bot', limit: 10, limit_remaining: 9, limit_reset: 'daily', disabled: false, hash: 'hash-one' }]

test('POST /key-limit raises the cap, retires the cache, and answers the new limit', async () => {
  const harness = routeHarness({ keyRows: harnessKeys })
  try {
    harness.apply()
    await flush()

    const res = makeRes()
    await harness.handlers['/openrouter-spend/key-limit'](reqWith('POST', '/openrouter-spend/key-limit', '{"name":"build-bot","limit":15}'), res)
    assert.equal(res.statusCode, 200, `a raise is a 200 — got ${res.statusCode}: ${res.body}`)
    const payload = JSON.parse(res.body)
    assert.equal(payload.status, 'ok')
    assert.equal(payload.limit, 15)
    assert.equal(harness.patches.length, 1, 'the raise is exactly one PATCH upstream')
    assert.deepEqual(harness.patches[0].body, { limit: 15 })

    // The raise retires the cache: the summary that follows must carry the new
    // cap, not the cached pre-raise one.
    const summaryRes = makeRes()
    await harness.handlers['/openrouter-spend/summary'](reqWith('GET', '/openrouter-spend/summary'), summaryRes)
    const summary = JSON.parse(summaryRes.body)
    assert.equal(summary.limits['build-bot'].limit, 15, `the summary after a raise carries the raised cap — got ${JSON.stringify(summary.limits)}`)
  } finally {
    harness.restore()
  }
})

test('POST /key-limit maps every refusal kind to its status and passes the words through', async () => {
  const harness = routeHarness({ keyRows: harnessKeys })
  try {
    harness.apply()
    await flush()

    const drive = async (body, wanted) => {
      const res = makeRes()
      await harness.handlers['/openrouter-spend/key-limit'](reqWith('POST', '/openrouter-spend/key-limit', body), res)
      return { status: res.statusCode, payload: JSON.parse(res.body), wanted }
    }
    // A key the account does not carry is a 404: the request named something
    // that does not exist, which is what a 404 is for.
    let reply = await drive('{"name":"ghost","limit":15}')
    assert.equal(reply.status, 404, `an unknown key is a 404 — got ${reply.status}: ${JSON.stringify(reply.payload)}`)
    assert.match(reply.payload.error, /no key named "ghost"/)
    // The rest of the browser's mistakes are 400s.
    reply = await drive('{"name":"build-bot","limit":10}')
    assert.equal(reply.status, 400, 'a non-raise is a 400')
    assert.match(reply.payload.error, /only a raise is accepted/)
    reply = await drive('not json')
    assert.equal(reply.status, 400, 'an unreadable body is a 400')
    reply = await drive('{}')
    assert.equal(reply.status, 400)
    assert.match(reply.payload.error, /expected \{"name": "\.\.\.", "limit": \.\.\.\}/)
  } finally {
    harness.restore()
  }
})

test('POST /key-limit answers 405 and names POST for any other method', async () => {
  const harness = routeHarness({ keyRows: harnessKeys })
  try {
    harness.apply()
    await flush()
    const res = makeRes()
    await harness.handlers['/openrouter-spend/key-limit'](reqWith('GET', '/openrouter-spend/key-limit'), res)
    assert.equal(res.statusCode, 405)
    assert.equal(res.headers.allow, 'POST')
  } finally {
    harness.restore()
  }
})

test('POST /key-limit answers 409 when no management key is configured', async () => {
  const harness = routeHarness({ keyRows: harnessKeys })
  harness.ctx.credentials.resolve = async () => undefined
  try {
    harness.apply()
    await flush()
    const res = makeRes()
    await harness.handlers['/openrouter-spend/key-limit'](reqWith('POST', '/openrouter-spend/key-limit', '{"name":"build-bot","limit":15}'), res)
    assert.equal(res.statusCode, 409, `no key configured is a 409, not a 502 — got ${res.statusCode}`)
  } finally {
    harness.restore()
  }
})

test('an upstream PATCH refusal answers 502 with the wire\u2019s own words', async () => {
  const harness = routeHarness({ keyRows: harnessKeys, patchStatus: 403 })
  try {
    harness.apply()
    await flush()
    const res = makeRes()
    await harness.handlers['/openrouter-spend/key-limit'](reqWith('POST', '/openrouter-spend/key-limit', '{"name":"build-bot","limit":15}'), res)
    assert.equal(res.statusCode, 502, 'a reply this half never saw is a 502, never invented here')
    assert.match(JSON.parse(res.body).error, /keys\/\{hash\} answered 403/)
  } finally {
    harness.restore()
  }
})
