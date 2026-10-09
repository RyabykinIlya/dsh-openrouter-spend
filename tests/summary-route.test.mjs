/**
 * Route-level tests for the summary route: what `apply()` registers, what the
 * two handlers answer, and — the part the extracted pure helpers cannot see —
 * what stays standing when one auxiliary read fails.
 *
 * The seam is the real `apply()` driven with a stubbed Cordis context and a
 * scripted OpenRouter/cbr.ru backend, the same one `refresh-state.test.mjs`
 * uses for the credential-write race. Everything below is invisible to the
 * pure-function tests: `collect()`'s per-query `.catch` containment (M6,
 * mutation-verified — deleting the `/keys` catch left the whole suite green
 * while a single failed keys read would have taken the chip down),
 * `queryHourlyBurn` / `queryKeys`' refusal paths (m16), the `?force=1` floor
 * and the retry ladder against the real cache (m18), the corrupt-lineage
 * guards (m19), and the thresholds riding from host config into the payload
 * (m22).
 *
 * The clock is faked through `Date.now` alone, so `setTimeout` stays real and
 * no test waits on a wall clock: the cache expiry and the retry ladder are the
 * only readers of it. `fetch` is always stubbed — no test here touches the
 * network. Every key name, figure and timestamp is synthetic.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'

/** `index.js:38` — past this a reply is refused, not parsed. */
const MAX_REPLY_BYTES = 4 * 1024 * 1024
/** `index.js:50` — one row per hour and key; past it the burn is refused. */
const MAX_BURN_ROWS = 5000
/** `index.js:61` — the `/keys` pagination walk's ceiling. */
const MAX_KEY_ROWS = 1000
/** `index.js:76` — the rolled-up split's ceiling; `index.js:68` its depth cap. */
const MAX_ROLLUP_ROWS = 5000
const MAX_LINEAGE_DEPTH = 64
/** `index.js:118` — a held-down Retry is honoured at most this often. */
const FORCE_FLOOR_MS = 2000

/** The wire's own words for a refusal, long enough to exercise the 200-char slice. */
const LONG_DETAIL = `${'A'.repeat(199)}B${'C'.repeat(100)}`

const DAY = new Date().toISOString().slice(0, 10)

/** One hourly burn row: the shape `groupHourlyBurn` reads. */
const burnRow = (key, hour, usd) => ({
  api_key_id: key,
  date__hour: `${DAY}T${String(hour).padStart(2, '0')}:00:00`,
  total_usage: String(usd),
})

/** The happy-path fixtures. Only `sess-b` is delegated, so the rollup folds it. */
const dayRows = [{ date__day: DAY, api_key_id: 'build-bot', model: 'model-a', total_usage: '1.73', request_count: '8' }]
const sessionRows = [
  { session_id: 'sess-a', total_usage: '0.5', request_count: '4' },
  { session_id: 'sess-b', total_usage: '0.25', request_count: '2' },
]
const burnRows = [burnRow('build-bot', 10, 0.5), burnRow('build-bot', 11, 0.7)]
const keyRows = [
  { name: 'build-bot', limit: 25, limit_remaining: 12, limit_reset: 'daily', disabled: false, hash: 'hash-one' },
]
const lineageRecords = [{ header: { id: 'sess-b', parentSession: 'sess-a', origin: 'subagent' } }]
const CBR_XML = '<ValCurs><Valute><CharCode>USD</CharCode><Nominal>1</Nominal><Value>90,5000</Value></Valute></ValCurs>'

/** A JSON reply. `contentLength` overrides the header the size guard reads. */
function json(status, body, { contentLength } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => (name.toLowerCase() === 'content-length' ? (contentLength ?? null) : null) },
    json: async () => body,
    // the status refusal slices the raw body, so a refusal fixture carries text
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

/** A non-JSON reply, which is what cbr.ru answers with. */
function xml(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => { throw new Error('not json') },
    text: async () => text,
  }
}

/**
 * A delegation chain rooted at `head`: `head → head-p1 → head-p2 → …`. Every
 * step is a `subagent` child, which is the only origin `delegationEdges` links.
 */
function chainRecords(head, depth) {
  const records = [{ header: { id: head, parentSession: `${head}-p1`, origin: 'subagent' } }]
  for (let level = 1; level < depth; level += 1) {
    records.push({ header: { id: `${head}-p${level}`, parentSession: `${head}-p${level + 1}`, origin: 'subagent' } })
  }
  return records
}

/** `count` disjoint chains of `depth` ancestors each, with one spend row per root. */
function fanRecords(count, depth) {
  const records = []
  const rows = []
  for (let index = 0; index < count; index += 1) {
    const head = `s${index}`
    rows.push({ session_id: head, total_usage: '1', request_count: '1' })
    records.push(...chainRecords(head, depth))
  }
  return { records, rows }
}

/**
 * `apply()` against a stub context and a scripted backend, driving the
 * registered handlers the way the web server would.
 *
 * `script` is the knob each test turns: one thunk per upstream endpoint,
 * returning the reply the mock fetch hands back. Replacing a thunk before
 * `apply()` makes the priming read itself fail; replacing it mid-test makes
 * the next scheduled read fail. `Date.now` follows `advance` so the cache
 * expiry, the force floor and the retry ladder are all steerable without a
 * real timer, and `restore()` puts both globals back.
 */
function routeHarness(options = {}) {
  const handlers = {}
  const fetches = []
  const logs = []
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now

  const store = { value: options.noCredential === true ? undefined : (options.credential ?? 'mgmt-key') }
  const thresholds = options.thresholds ?? { warn: 0.4, critical: 0.8 }

  const script = {
    day: () => json(200, { data: { data: options.dayRows ?? dayRows, metadata: {} } }),
    sessions: () => json(200, { data: { data: options.sessionRows ?? sessionRows, metadata: {} } }),
    burn: () => json(200, { data: { data: options.burnRows ?? burnRows, metadata: {} } }),
    keys: () => json(200, { data: options.keyRows ?? keyRows }),
    credits: () => json(200, { data: { total_credits: 100, total_usage: 10 } }),
    rate: () => xml(200, CBR_XML),
    lineage: () => options.lineage ?? lineageRecords,
  }

  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    const entry = { target, kind: 'other', auth: init.headers?.authorization ?? '' }
    fetches.push(entry)
    if (target.startsWith('https://cbr.test')) { entry.kind = 'rate'; return script.rate() }
    if (target.includes('/credits')) { entry.kind = 'credits'; return script.credits() }
    if (target.includes('/keys')) { entry.kind = 'keys'; return script.keys() }
    if (target.endsWith('/analytics/query')) {
      const body = JSON.parse(init.body)
      if (body.granularity === 'hour') { entry.kind = 'burn'; return script.burn() }
      if (body.dimensions.includes('model')) { entry.kind = 'day'; return script.day() }
      if (body.dimensions[0] === 'session_id') { entry.kind = 'sessions'; return script.sessions() }
    }
    throw new Error(`mock: unexpected ${init.method ?? 'GET'} ${target}`)
  }

  const ctx = {
    logger: { warn: (...args) => { logs.push(args) } },
    effect: fn => fn(),
    webServer: { register: definition => { handlers[definition.path] = definition.handler; return () => undefined } },
    connection: { requestRejection: () => undefined },
    credentials: {
      resolve: async () => (store.value === undefined ? undefined : { value: store.value }),
      describe: async () => ({ configured: store.value !== undefined, writable: true }),
      set: async (ref, value) => { store.value = value },
      unset: async () => { store.value = undefined },
    },
    sessionQuery: {
      listSessions: async () => {
        const lineage = script.lineage()
        if (lineage instanceof Error) throw lineage
        return lineage
      },
    },
  }
  const config = {
    credentialRef: 'OPENROUTER_MGMT_API_KEY', apiBase: 'https://api.test/v1', refreshSeconds: 60,
    historyDays: 30, cbrUrl: 'https://cbr.test/rate', rateRefreshSeconds: 3600, timeoutMs: 15_000,
    warnConsumedFraction: thresholds.warn, criticalConsumedFraction: thresholds.critical, burnWindowDays: 7,
  }

  return {
    handlers, fetches, logs, script, ctx, config, store,
    apply: () => apply(ctx, config),
    advance: ms => { now += ms },
    restore: () => { globalThis.fetch = originalFetch; Date.now = originalNow },
  }
}

/** A response recorder the handlers can end() into. */
function makeRes() {
  const res = { statusCode: 0, headers: {}, setHeader: (name, value) => { res.headers[name.toLowerCase()] = value }, end(body) { res.body = body ?? '' } }
  return res
}

/** Drive the registered GET /summary handler. */
async function getSummary(harness, url = '/openrouter-spend/summary') {
  const res = makeRes()
  await harness.handlers['/openrouter-spend/summary']({ method: 'GET', url }, res)
  return { status: res.statusCode, headers: res.headers, payload: JSON.parse(res.body) }
}

/** Drive the registered POST /credential handler with a JSON body. */
async function postCredential(harness, body) {
  const res = makeRes()
  const req = {
    method: 'POST',
    url: '/openrouter-spend/credential',
    resume() {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
  }
  await harness.handlers['/openrouter-spend/credential'](req, res)
  return { status: res.statusCode, payload: JSON.parse(res.body) }
}

/** Let the priming read (and any read the handlers started) run to completion. */
const flush = async (turns = 8) => { for (let i = 0; i < turns; i += 1) await new Promise(resolve => { setTimeout(resolve, 0) }) }

/** How many analytics reads actually reached the upstream: one per refresh. */
const dayReads = harness => harness.fetches.filter(entry => entry.kind === 'day').length

// ---------------------------------------------------------------------------
// M6 — auxiliary-failure containment in collect()
// ---------------------------------------------------------------------------

/**
 * The containment the code comments and ADR-0003 promise, and the one mutation
 * testing found unpinned: each auxiliary read has its own `.catch` that turns a
 * failure into a field on an otherwise `ok` payload. Without it the rejection
 * escapes `collect()` into `summary()`'s catch and the whole summary goes
 * `stale` — the chip disappears because an hourly burn query failed.
 */
test('a failed /keys read costs the limits and nothing else: figures stay, limitsError says why', async () => {
  const harness = routeHarness()
  harness.script.keys = () => json(500, 'only management keys can perform this operation')
  try {
    harness.apply()
    await flush()
    harness.advance(61_000) // past the priming entry, so the poll drives a real read
    const { status, payload } = await getSummary(harness)

    assert.equal(status, 200)
    assert.equal(payload.status, 'ok', 'an auxiliary failure must not take the summary down')
    assert.match(payload.limitsError, /keys answered 500: only management keys/)
    // "no limits" and "could not read the limits" are different answers: an
    // empty map with no error means no key carries a limit, so the failed read
    // must leave the field absent rather than empty.
    assert.equal(payload.limits, undefined)
    assert.equal(payload.limitsNote, undefined)
    // the other auxiliaries and the primary query are untouched
    assert.equal(payload.todaySpend.usd, 1.73)
    assert.equal(payload.todaySpend.requests, 8)
    assert.ok(payload.burnHourly['build-bot'], 'the burn read still landed')
    assert.equal(payload.bySession.length, 2)
    assert.equal(payload.rate.perUsd, 90.5)
  } finally {
    harness.restore()
  }
})

test('a failed hourly burn costs the burn and nothing else: figures stay, burnError says why', async () => {
  const harness = routeHarness()
  harness.script.burn = () => json(429, 'slow down')
  try {
    harness.apply()
    await flush()
    harness.advance(61_000)
    const { payload } = await getSummary(harness)

    assert.equal(payload.status, 'ok')
    assert.match(payload.burnError, /analytics\/query \(hourly burn\) answered 429/)
    assert.equal(payload.burnHourly, undefined, 'no map at all beats a map that under-reports')
    assert.equal(payload.todaySpend.usd, 1.73)
    assert.equal(payload.limits['build-bot'].limit, 25, 'the limits read still landed')
    assert.equal(payload.bySession.length, 2)
  } finally {
    harness.restore()
  }
})

test('a failed session split is contained, and a failed lineage read keeps the unrolled rows', async () => {
  // the split itself: both session queries fail, so the failure lands on
  // sessionsError rather than on the summary
  const split = routeHarness()
  split.script.sessions = () => json(500, 'nope')
  try {
    split.apply()
    await flush()
    split.advance(61_000)
    const { payload } = await getSummary(split)
    assert.equal(payload.status, 'ok')
    assert.match(payload.sessionsError, /analytics\/query \(sessions\) answered 500/)
    assert.equal(payload.bySession, undefined)
    assert.equal(payload.todaySpend.usd, 1.73)
  } finally {
    split.restore()
  }

  // the lineage listing: the rows and their own figures survive unrolled, and
  // the host says why — understating the subtree beats losing the chip.
  const lineage = routeHarness()
  lineage.script.lineage = () => new Error('session corpus unreadable')
  try {
    lineage.apply()
    await flush()
    lineage.advance(61_000)
    const { payload } = await getSummary(lineage)
    assert.equal(payload.status, 'ok')
    assert.match(payload.lineageError, /session corpus unreadable/)
    // unrolled: sess-b keeps its own 0.25 instead of folding into sess-a's 0.75
    assert.deepEqual(
      payload.bySession.map(row => [row.id, row.usd]).sort(),
      [['sess-a', 0.5], ['sess-b', 0.25]],
      'the merge still happened; only the fold is missing',
    )
    assert.ok(
      lineage.logs.some(([message]) => /session lineage unavailable/.test(String(message))),
      'the containment also reports the reason to the host log',
    )
  } finally {
    lineage.restore()
  }
})

// ---------------------------------------------------------------------------
// m16 — queryHourlyBurn / queryKeys refusal paths
// ---------------------------------------------------------------------------

/**
 * Every refusal here is a refusal rather than a truncation on purpose: a
 * partial burn sums to less than the keys actually burnt, and the browser
 * derives runway warnings from it. Deleting the truncated-refusal survived
 * mutation testing, so each path gets its own assertion on the message the
 * payload carries — and every message names the config knob to turn.
 */
test('queryHourlyBurn refuses a truncated, oversized, over-ceiling or unreadable window', async () => {
  const cases = [
    {
      name: 'a non-ok status carries the status and the 200-char body slice',
      reply: () => json(500, LONG_DETAIL),
      expected: `analytics/query (hourly burn) answered 500: ${LONG_DETAIL.slice(0, 200)}`,
    },
    {
      name: 'a content-length past the reply ceiling is refused before parsing',
      reply: () => json(200, { data: { data: [] } }, { contentLength: String(MAX_REPLY_BYTES + 1) }),
      expected: `analytics/query (hourly burn) reply exceeds ${MAX_REPLY_BYTES} bytes`,
    },
    {
      name: 'metadata.truncated is refused and names burnWindowDays',
      reply: () => json(200, { data: { data: [burnRow('build-bot', 10, 0.5)], metadata: { truncated: true } } }),
      expected: `analytics/query (hourly burn) hit its ${MAX_BURN_ROWS}-row ceiling; narrow config.burnWindowDays`,
    },
    {
      name: 'a full page of rows is refused on the same ceiling',
      reply: () => json(200, {
        data: { data: Array.from({ length: MAX_BURN_ROWS }, (_, hour) => burnRow('build-bot', hour % 24, 1)), metadata: {} },
      }),
      expected: `analytics/query (hourly burn) hit its ${MAX_BURN_ROWS}-row ceiling; narrow config.burnWindowDays`,
    },
    {
      name: 'a reply with no data rows reads as unreadable, not as an empty burn',
      reply: () => json(200, { data: { metadata: {} } }),
      expected: 'analytics/query (hourly burn) returned no data rows',
    },
  ]

  for (const scenario of cases) {
    const harness = routeHarness()
    harness.script.burn = scenario.reply
    try {
      harness.apply()
      await flush()
      harness.advance(61_000)
      const { payload } = await getSummary(harness)
      assert.equal(payload.status, 'ok', scenario.name)
      assert.equal(payload.burnError, scenario.expected, scenario.name)
      assert.equal(payload.burnHourly, undefined, scenario.name)
    } finally {
      harness.restore()
    }
  }
})

test('queryKeys refuses a reply it cannot read rather than reporting no limits', async () => {
  const cases = [
    {
      name: 'a non-ok status carries the status and the 200-char body slice',
      reply: () => json(403, LONG_DETAIL),
      expected: `keys answered 403: ${LONG_DETAIL.slice(0, 200)}`,
    },
    {
      name: 'a content-length past the reply ceiling is refused before parsing',
      reply: () => json(200, { data: [] }, { contentLength: String(MAX_REPLY_BYTES + 1) }),
      expected: `keys reply exceeds ${MAX_REPLY_BYTES} bytes`,
    },
    {
      name: 'a body whose data is not an array reads as unreadable, not as no limits',
      reply: () => json(200, { data: {} }),
      expected: 'keys returned no data array',
    },
    {
      name: 'a pagination walk past the row ceiling refuses rather than looping',
      reply: () => json(200, {
        data: Array.from({ length: MAX_KEY_ROWS }, (_, index) => ({ name: `key-${index}`, hash: `hash-${index}` })),
      }),
      expected: `keys listing grew to ${MAX_KEY_ROWS} rows, past the ${MAX_KEY_ROWS}-row ceiling; the pagination walk refused rather than loop`,
    },
  ]

  for (const scenario of cases) {
    const harness = routeHarness()
    harness.script.keys = scenario.reply
    try {
      harness.apply()
      await flush()
      harness.advance(61_000)
      const { payload } = await getSummary(harness)
      assert.equal(payload.status, 'ok', scenario.name)
      assert.equal(payload.limitsError, scenario.expected, scenario.name)
      assert.equal(payload.limits, undefined, scenario.name)
    } finally {
      harness.restore()
    }
  }
})

// ---------------------------------------------------------------------------
// m18 — route-level wiring
// ---------------------------------------------------------------------------

test('a second Retry inside FORCE_FLOOR_MS is answered from the cache, not upstream', async () => {
  const harness = routeHarness()
  try {
    harness.apply()
    await flush()
    harness.advance(61_000) // the fresh cache would answer a plain poll; force must not take it

    const beforeFirst = dayReads(harness)
    const first = await getSummary(harness, '/openrouter-spend/summary?force=1')
    assert.equal(first.payload.status, 'ok')
    assert.equal(dayReads(harness), beforeFirst + 1, 'a Retry past the floor reads again')

    // immediately again: inside the 2s floor, so the cached answer stands —
    // this is what keeps a held-down button from becoming a stream of queries
    const afterFirst = dayReads(harness)
    const second = await getSummary(harness, '/openrouter-spend/summary?force=1')
    assert.equal(second.payload.status, 'ok')
    assert.equal(dayReads(harness), afterFirst, 'the second Retry inside the floor costs no upstream read')
    assert.equal(second.payload.refreshedAt, first.payload.refreshedAt, 'and it is the same read, not a new one')

    harness.advance(FORCE_FLOOR_MS + 100)
    await getSummary(harness, '/openrouter-spend/summary?force=1')
    assert.equal(dayReads(harness), afterFirst + 1, 'past the floor it reads again')
  } finally {
    harness.restore()
  }
})

test('a failing read walks the retry ladder, and a good read resets it', async () => {
  const harness = routeHarness()
  try {
    harness.apply()
    await flush() // the priming read is a good one: the ladder starts at zero
    harness.script.day = () => json(500, 'down')

    const rung = async label => {
      harness.advance(61_000)
      const { payload } = await getSummary(harness)
      assert.equal(payload.status, 'stale', label)
      return (new Date(payload.nextRefreshAt)).getTime() - (new Date(payload.lastAttemptAt)).getTime()
    }

    // the first two attempts are quick — the ordinary cause is a socket that is
    // not up yet — and the ladder then settles on the user's cadence
    assert.equal(await rung('first failure'), 15_000)
    assert.equal(await rung('second failure'), 30_000)
    assert.equal(await rung('third failure'), 60_000, 'settles on refreshSeconds')
    assert.equal(await rung('fourth failure'), 60_000, 'and stays there')

    // a good read resets both the count and the schedule…
    harness.script.day = () => json(200, { data: { data: dayRows, metadata: {} } })
    harness.advance(61_000)
    const good = await getSummary(harness)
    assert.equal(good.payload.status, 'ok')
    assert.equal((new Date(good.payload.nextRefreshAt)).getTime() - (new Date(good.payload.lastAttemptAt)).getTime(), 60_000)

    // …so the next failure is the fast first rung again, not the fourth
    harness.script.day = () => json(500, 'down')
    assert.equal(await rung('failure after a good read'), 15_000)
  } finally {
    harness.restore()
  }
})

test('saving a key resets the ladder instead of making the next attempt wait out an earlier failure', async () => {
  const harness = routeHarness()
  try {
    harness.apply()
    await flush()
    harness.script.day = () => json(500, 'down')

    harness.advance(61_000)
    await getSummary(harness) // failure 1 → 15s
    harness.advance(61_000)
    const second = await getSummary(harness) // failure 2 → 30s, the rung the reset must clear
    assert.equal(second.payload.status, 'stale')
    assert.equal((new Date(second.payload.nextRefreshAt)).getTime() - (new Date(second.payload.lastAttemptAt)).getTime(), 30_000)

    // a stored key is a new reason to read: the ladder starts over even though
    // the read the POST performs itself fails
    const { status, payload } = await postCredential(harness, '{"value":"mgmt-key"}')
    assert.equal(status, 200)
    assert.equal(payload.status, 'stale')
    assert.equal(
      (new Date(payload.nextRefreshAt)).getTime() - (new Date(payload.lastAttemptAt)).getTime(),
      15_000,
      'the first rung, not the 30s rung an unrestored counter would have produced',
    )
  } finally {
    harness.restore()
  }
})

test('a route asked with the wrong method answers 405 and names the one it accepts', async () => {
  const harness = routeHarness()
  try {
    harness.apply()
    await flush()

    const summary = makeRes()
    await harness.handlers['/openrouter-spend/summary']({ method: 'POST', url: '/openrouter-spend/summary' }, summary)
    assert.equal(summary.statusCode, 405)
    assert.equal(summary.headers.allow, 'GET')
    assert.equal(summary.body, '')

    // the credential route is write-only: a GET must not read it back
    const credential = makeRes()
    await harness.handlers['/openrouter-spend/credential']({ method: 'GET', url: '/openrouter-spend/credential' }, credential)
    assert.equal(credential.statusCode, 405)
    assert.equal(credential.headers.allow, 'POST')
    assert.equal(credential.body, '')
  } finally {
    harness.restore()
  }
})

test('no-credential answers the empty payload shape, not a zeroed summary', async () => {
  const harness = routeHarness({ noCredential: true })
  try {
    harness.apply()
    await flush()
    const { status, payload } = await getSummary(harness)

    assert.equal(status, 200)
    // the exact key set: a key that appears here is one the browser can rely on
    // sorted as `Array.sort` sorts it: code units, so `last30` before `last7`
    assert.deepEqual(Object.keys(payload).sort(), [
      'burnHourly', 'byDay', 'byKey', 'byModel', 'bySession', 'credential', 'historyDays',
      'last30', 'last7', 'lastAttemptAt', 'limitThresholds', 'limits', 'nextRefreshAt',
      'rate', 'refreshSeconds', 'status', 'today', 'todaySpend',
    ])
    assert.equal(payload.status, 'no-credential')
    assert.equal(payload.today, DAY)
    assert.deepEqual(payload.todaySpend, { usd: 0, requests: 0 })
    assert.deepEqual(payload.last7, { usd: 0, requests: 0 })
    assert.deepEqual(payload.last30, { usd: 0, requests: 0 })
    assert.deepEqual(payload.byDay, [])
    assert.deepEqual(payload.byModel, [])
    assert.deepEqual(payload.byKey, [])
    assert.deepEqual(payload.bySession, [])
    assert.deepEqual(payload.limits, {})
    assert.deepEqual(payload.burnHourly, {})
    assert.equal(payload.rate, null)
    assert.equal(payload.refreshSeconds, 60)
    assert.equal(payload.historyDays, 30)
    // no key configured means no read at all: nothing upstream is called, so
    // the state costs the user nothing
    assert.equal(harness.fetches.length, 0)
    assert.deepEqual(payload.credential, { ref: 'OPENROUTER_MGMT_API_KEY', configured: false, writable: true })
  } finally {
    harness.restore()
  }
})

// ---------------------------------------------------------------------------
// m19 — corrupt-lineage guards
// ---------------------------------------------------------------------------

/**
 * The rollup walks the whole corpus every refresh, so a corrupt lineage must
 * end in a refusal rather than in an unbounded fold or a stalled refresh. Both
 * guards are reachable only with a synthetic corpus, which is why no test had
 * built one: below, `fanRecords` is exactly that corpus.
 */
test('the rollup refuses a corpus that fans past MAX_ROLLUP_ROWS and keeps the unrolled rows', async () => {
  // 100 roots × (itself + 49 ancestors) = exactly 5000: the ceiling is not
  // exceeded, so this must still fold
  const atCeiling = fanRecords(100, MAX_ROLLUP_ROWS / 100 - 1)
  const within = routeHarness({ sessionRows: atCeiling.rows, lineage: atCeiling.records })
  try {
    within.apply()
    await flush()
    within.advance(61_000)
    const { payload } = await getSummary(within)
    assert.equal(payload.status, 'ok')
    assert.equal(payload.lineageError, undefined, 'exactly at the ceiling is still a legal fold')
    assert.equal(payload.bySession.length, MAX_ROLLUP_ROWS)
  } finally {
    within.restore()
  }

  // one more ancestor per root pushes it past the ceiling: refuse, keep the
  // merged rows, and name the ceiling the corpus blew through
  const over = fanRecords(100, MAX_ROLLUP_ROWS / 100)
  const refused = routeHarness({ sessionRows: over.rows, lineage: over.records })
  try {
    refused.apply()
    await flush()
    refused.advance(61_000)
    const { payload } = await getSummary(refused)
    assert.equal(payload.status, 'ok', 'a corrupt corpus must not take the summary down')
    assert.match(payload.lineageError, /past the 5000-row ceiling; lineage looks corrupt/)
    assert.equal(payload.bySession.length, 100, 'the caller keeps the unrolled rows')
    // the primary day query is a different read from the session split: its
    // figures are exactly what the session split's refusal must not disturb
    assert.equal(payload.todaySpend.usd, 1.73)
    assert.equal(payload.todaySpend.requests, 8)
  } finally {
    refused.restore()
  }
})

test('the ancestor walk stops at MAX_LINEAGE_DEPTH instead of trusting a corrupt chain', async () => {
  const depth = 200 // far past the cap, as a corrupt header chain would be
  const harness = routeHarness({
    sessionRows: [{ session_id: 'c0', total_usage: '3', request_count: '30' }],
    lineage: chainRecords('c0', depth),
  })
  try {
    harness.apply()
    await flush()
    harness.advance(61_000)
    const { payload } = await getSummary(harness)

    assert.equal(payload.status, 'ok')
    // the row's spend climbs to the row itself plus exactly 64 ancestors: the
    // walk stops rather than folding an unbounded chain into the figure
    assert.equal(payload.bySession.length, MAX_LINEAGE_DEPTH + 1)
    assert.equal(payload.bySession.every(row => row.usd === 3), true)
    const ids = payload.bySession.map(row => row.id)
    assert.equal(ids[0], 'c0')
    assert.equal(ids.includes(`c0-p${MAX_LINEAGE_DEPTH}`), true, 'the last ancestor inside the cap carries the spend')
    assert.equal(ids.includes(`c0-p${MAX_LINEAGE_DEPTH + 1}`), false, 'the one past it does not')
    assert.equal(payload.bySession.reduce((sum, row) => sum + row.usd, 0), 3 * (MAX_LINEAGE_DEPTH + 1))
  } finally {
    harness.restore()
  }
})

// ---------------------------------------------------------------------------
// m22 — limitThresholds riding into the payload
// ---------------------------------------------------------------------------

test('the configured thresholds ride the payload on both the ok and the empty path', async () => {
  // the thresholds are host config that take effect in the browser, so they
  // travel rather than being duplicated there; a non-default pair proves they
  // are read from config and not from the schema defaults
  const thresholds = { warn: 0.25, critical: 0.75 }

  const live = routeHarness({ thresholds })
  try {
    live.apply()
    await flush()
    const { payload } = await getSummary(live)
    assert.equal(payload.status, 'ok')
    assert.deepEqual(payload.limitThresholds, thresholds)
  } finally {
    live.restore()
  }

  const empty = routeHarness({ thresholds, noCredential: true })
  try {
    empty.apply()
    await flush()
    const { payload } = await getSummary(empty)
    assert.equal(payload.status, 'no-credential')
    assert.deepEqual(payload.limitThresholds, thresholds, 'the empty payload carries them too')
  } finally {
    empty.restore()
  }
})
