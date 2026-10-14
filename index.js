/**
 * Host half of the OpenRouter spend bundle.
 *
 * Reads what the OpenRouter account actually charged with a management key and
 * serves it to the browser half as one cached summary. Every figure comes from
 * OpenRouter's own analytics (`total_usage`), so it is billed money rather than
 * a token estimate priced from a local table. The one figure that is not
 * OpenRouter's is the RUB rate, read from the CBR daily sheet so the browser
 * can show the same money in rubles. Per-key spend limits come from the
 * management keys endpoint and the hourly burn behind the "limit is running
 * out" warning from analytics bucketed by hour; both ride the same summary.
 */

import Schema from 'schemastery'

/** Loader row id; matches the `insert` in cordis.patch.yml. */
export const name = 'openrouter-spend'

/**
 * `credentials` resolves the management key, `webServer` carries the route.
 * `sessionQuery` supplies session lineage: a delegated subagent runs as its own
 * session, so its spend lands on its own analytics row and must be folded into
 * the parent's figure (ADR-0003). Declaring it here is deliberate — the row is
 * a DSH bundle row, and Cordis starts it only once the service exists.
 */
export const inject = ['credentials', 'webServer', 'connection', 'sessionQuery']

/** One read-only summary route, fenced by the connection trust check. */
const SUMMARY_PATH = '/openrouter-spend/summary'

/** Route that stores or clears the management key. */
const CREDENTIAL_PATH = '/openrouter-spend/credential'

/**
 * Route that raises one key's spend limit. The body names the key by NAME —
 * the identifier the popover already shows — because the hash never travels
 * to the browser (this repo and its payloads are public), so this half is the
 * one that resolves the name to the hash and carries it upstream.
 */
const KEY_LIMIT_PATH = '/openrouter-spend/key-limit'

/**
 * A raise past this multiple of the current limit is refused. The route is a
 * button next to a number the reader recognises, so an extra zero in the
 * custom field is the one typo the wire cannot tell from intent; the multiple
 * turns it into a refusal that names itself rather than a spent balance.
 */
const RAISE_MAX_FACTOR = 10

/** A credential body is one string; a larger one is hostile, not a real setting. */
const MAX_BODY_BYTES = 64 * 1024

/** A runaway guard: the window holds one row per day, key, and model. */
const MAX_REPLY_BYTES = 4 * 1024 * 1024

/** Rows beyond this are refused rather than truncated: a partial split misreports cost. */
const MAX_ANALYTICS_ROWS = 500

/**
 * The hourly burn window has a different row shape from the daily split above:
 * one row per hour and key — `burnWindowDays × 24 × keys` — rather than one per
 * day, key and model. Reusing `MAX_ANALYTICS_ROWS` there refused the window at
 * three keys burning across the default seven days (504 rows), which is ordinary
 * traffic rather than a runaway. The reply-size guard still bounds the response.
 */
const MAX_BURN_ROWS = 5000

/** The session split is one row per session and key, not per session and day; the server caps at 1000. */
const MAX_SESSION_ROWS = 1000

/**
 * Ceiling on the `/keys` pagination walk. OpenRouter does not document a page
 * size for `offset`, so the walk is bounded by accumulated rows rather than
 * pages; an account with more keys than this is a runaway, and the read is
 * refused rather than looped.
 */
const MAX_KEY_ROWS = 1000

/**
 * How far one row's spend climbs towards its ancestors. Real delegation nests a
 * handful deep — the measured corpus held depths of 1 and 2 — so a longer chain
 * is a corrupt lineage, and the walk stops rather than trusting it.
 */
const MAX_LINEAGE_DEPTH = 64

/**
 * Ceiling on the rolled-up split. `MAX_SESSION_ROWS` bounds the rows read; the
 * rollup can add a row per ancestor, so a corrupt corpus could otherwise fan a
 * thousand leaves into an unbounded payload. Past this the fold is refused —
 * the caller keeps the unrolled rows and says why.
 */
const MAX_ROLLUP_ROWS = 5000

/** The CBR sheet is a dozen kilobytes; a larger reply is not a rate sheet. */
const MAX_RATE_BYTES = 256 * 1024

/**
 * The errno values undici hides behind a bare `fetch failed`. They are the
 * difference between "this machine cannot reach OpenRouter" and "OpenRouter
 * refused us", which are two different sentences in the popover.
 */
const NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EPROTO', 'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

/**
 * The retry ladder after a failed refresh. The first attempt is quick because
 * the ordinary cause is a socket that is not up yet — a harness started before
 * its VPN or proxy — and a full `refreshSeconds` of waiting would hold the chip
 * amber for a minute over a transient fault. The ladder then settles back on
 * the ordinary cadence rather than backing off past it: the figures are what
 * the user is waiting for, so patience has a ceiling.
 */
const RETRY_FIRST_SECONDS = 15
const RETRY_SECOND_SECONDS = 30

/**
 * Ceiling on a server-supplied retry hint: a `Retry-After` past an hour is
 * more likely a misparsed clock or a hostile header than a real cooldown, and
 * falling back to the contained-retry ladder is safer than obeying it — the
 * worst case is one more 429, which the failure containment already absorbs.
 */
const MAX_RETRY_HINT_SECONDS = 3600

/**
 * A forced refresh — the popover's Retry — is honoured at most this often.
 * Concurrent callers already collapse into the one in-flight read; this floor
 * bounds a scripted caller that waits for each answer before asking again, so
 * the button cannot become a way to hammer OpenRouter.
 */
const FORCE_FLOOR_MS = 2000

/**
 * The row's `config` schema: validated by the Loader before `apply`, so a
 * wrong value fails the row at activation instead of misreporting spend later.
 * Every field is overridable from the patch row so a deployment can retarget
 * the API, the credential, or the cadence without an edit to this file.
 */
export const Config = Schema.object({
  credentialRef: Schema.string().pattern(/^\S+$/).default('OPENROUTER_MGMT_API_KEY')
    .description('Credentials reference holding the OpenRouter management API key.'),
  apiBase: Schema.string().pattern(/^https:\/\//).default('https://openrouter.ai/api/v1')
    .description('OpenRouter REST API root; https only.'),
  refreshSeconds: Schema.number().step(1).min(10).max(3600).default(60)
    .description('Seconds between OpenRouter refreshes; one poll serves every open tab.'),
  historyDays: Schema.number().step(1).min(2).max(366).default(30)
    .description('Days of history the summary window covers, today included.'),
  cbrUrl: Schema.string().pattern(/^https:\/\//).default('https://www.cbr.ru/scripts/XML_daily.asp')
    .description('CBR daily-rates sheet read for the RUB rate; https only.'),
  rateRefreshSeconds: Schema.number().step(1).min(60).max(86_400).default(3600)
    .description('Seconds between cbr.ru rate reads; the rate moves at most once a day.'),
  timeoutMs: Schema.number().step(1).min(1000).max(120_000).default(15_000)
    .description('Per-request deadline against the OpenRouter API and cbr.ru, in milliseconds.'),
  warnConsumedFraction: Schema.number().step(0.01).min(0.05).max(0.95).default(0.4)
    .description('Share of a key limit consumed that turns the chip into a warning.'),
  criticalConsumedFraction: Schema.number().step(0.01).min(0.1).max(1).default(0.8)
    .description('Share of a key limit consumed that turns the chip critical.'),
  burnWindowDays: Schema.number().step(1).min(1).max(30).default(7)
    .description('Days of hourly burn the summary carries, today included. '
      + 'The window holds one row per hour and key; past 5000 rows the read is '
      + 'refused rather than truncated, so a long window and many simultaneously '
      + 'active keys do not mix — narrow this value when the refusal names it.'),
})

/**
 * Classify a failed refresh so the browser can say what went wrong in its own
 * words instead of repeating the wire's. The raw message still travels as
 * `error`; this only picks which sentence fits, because "fetch failed" and
 * "answered 401" are the same string to a reader and different problems to fix.
 * @returns `{ code, detail }` with `code` one of `network`, `timeout`, `auth`,
 * `rate-limit`, `server`, `request`, `data`, or `unknown`.
 */
export function describeFailure(error) {
  const detail = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''
  // `AbortSignal.timeout` rejects with a TimeoutError; an abort of our own keeps AbortError.
  if (name === 'TimeoutError' || name === 'AbortError') return { code: 'timeout', detail }
  const cause = error instanceof Error ? error.cause : undefined
  const causeCode = cause !== null && typeof cause === 'object' && typeof cause.code === 'string'
    ? cause.code
    : ''
  if (NETWORK_CODES.has(causeCode)) return { code: 'network', detail }
  // Our own status throws read `analytics/query answered 401: ...`.
  const answered = /answered (\d{3})/.exec(detail)
  if (answered !== null) {
    const status = Number(answered[1])
    if (status === 401 || status === 403) return { code: 'auth', detail }
    if (status === 429) return { code: 'rate-limit', detail }
    if (status >= 500) return { code: 'server', detail }
    return { code: 'request', detail }
  }
  // A cause-less undici rejection is still a socket that never opened.
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket hang up|other side closed/i.test(detail)) {
    return { code: 'network', detail }
  }
  // A reply that arrived but did not carry the shape we read.
  if (/no data rows|no rows|no total_credits|no data array|exceeds|ceiling|truncated/i.test(detail)) {
    return { code: 'data', detail }
  }
  return { code: 'unknown', detail }
}

/**
 * Seconds until the next attempt after `failures` consecutive failed refreshes.
 * The ladder is quick once and then settles on the ordinary cadence; it never
 * exceeds `refreshSeconds`, so a deliberately short interval is not stretched
 * by the retry schedule. A server that said when it will accept us again
 * (`hintSeconds`, parsed off a 429's headers) overrides the ladder upwards:
 * an earlier retry is just another 429, so the hint may legitimately stretch
 * past `refreshSeconds`, bounded only by `MAX_RETRY_HINT_SECONDS`.
 */
export function retryDelaySeconds(failures, refreshSeconds, hintSeconds = 0) {
  const step = failures <= 1 ? RETRY_FIRST_SECONDS
    : failures === 2 ? RETRY_SECOND_SECONDS
    : refreshSeconds
  const ladder = Math.min(step, refreshSeconds)
  const hint = Number.isFinite(hintSeconds)
    ? Math.min(MAX_RETRY_HINT_SECONDS, Math.ceil(Math.max(0, hintSeconds)))
    : 0
  return Math.max(ladder, hint)
}

/**
 * The retry delay the server itself asked for, read off a 429 reply's
 * headers: `Retry-After` (delay-seconds or an HTTP-date) and
 * `X-RateLimit-Reset` (a unix epoch — seconds, though some deployments send
 * milliseconds). Both are read when both are present and the later one wins.
 * Pure, so the parsing is pinnable without a live rate limit.
 * @param headers - a `Headers`-like object with a `get(name)` method.
 * @param nowMs - the clock the date- and epoch-shaped hints are measured
 * against.
 * @returns whole seconds until the server will accept us again, `0` when no
 * header carried a usable hint or the hint is already in the past.
 */
export function retryHintSeconds(headers, nowMs = Date.now()) {
  const delays = []
  const retryAfter = headers?.get('retry-after')
  if (retryAfter != null) {
    if (/^\d+(?:\.\d+)?$/.test(retryAfter)) delays.push(Number(retryAfter))
    else {
      const at = Date.parse(retryAfter)
      if (Number.isFinite(at)) delays.push((at - nowMs) / 1000)
    }
  }
  const reset = headers?.get('x-ratelimit-reset')
  if (reset != null && /^\d+$/.test(reset)) {
    // A unix epoch, in seconds — though values past ~1e12 can only be
    // milliseconds, so both spellings are normalised before the subtraction.
    const epoch = Number(reset)
    const epochMs = epoch > 1e12 ? epoch : epoch * 1000
    delays.push((epochMs - nowMs) / 1000)
  }
  const hint = Math.max(0, ...delays)
  return Math.min(MAX_RETRY_HINT_SECONDS, Math.ceil(hint))
}

/**
 * Whether a request is answered from the cache instead of reading again. A
 * plain poll is answered while the entry is fresh; a forced one only inside
 * `floorMs` of the last attempt, which is what keeps a held-down Retry from
 * becoming a stream of upstream queries.
 * @returns true when the cached payload must be served.
 */
export function serveFromCache({ cached, now, force, lastAttemptMs, floorMs }) {
  if (cached === undefined) return false
  if (!force) return now < cached.expiresAt
  return now - lastAttemptMs < floorMs
}

/**
 * The next cache entry after one completed read: how many failures it leaves
 * behind, when it stops standing in for a read, and the payload with that
 * schedule stamped on it. Pure, so the ladder, the announced `nextRefreshAt`,
 * and the "a good read resets the ladder" rule are testable without a server.
 *
 * `nextRefreshAt` is the field the browser polls on: a fixed interval would
 * make the shorter retry after a failure a promise the poll ignores.
 */
export function scheduleRefresh(payload, failures, config, now) {
  // `error` is defensive: `summary()` only answers ok/stale/no-credential and
  // the routes send `error` straight to the wire, uncached — but should a
  // future caller schedule one anyway, it must climb the ladder rather than
  // stand as a good read.
  const failed = payload.status === 'stale' || payload.status === 'error'
  const nextFailures = failed ? failures + 1 : 0
  // A 429 that said when it will accept us again carries its hint on the
  // stale payload; the scheduler takes max(ladder, hint) when stamping the
  // next attempt.
  const hint = failed ? Math.max(0, Number(payload.retryAfterSeconds) || 0) : 0
  const ttlMs = (failed ? retryDelaySeconds(nextFailures, config.refreshSeconds, hint) : config.refreshSeconds) * 1000
  return {
    failures: nextFailures,
    expiresAt: now + ttlMs,
    payload: {
      ...payload,
      lastAttemptAt: new Date(now).toISOString(),
      nextRefreshAt: new Date(now + ttlMs).toISOString(),
    },
  }
}

/**
 * Read one analytics row. `request_count` arrives as a decimal string and the
 * dimensions are strings, so this is the wire boundary the narrowing belongs at.
 * @returns the row, or `undefined` when it does not carry a usable day and cost.
 */
function readRow(row) {
  if (row === null || typeof row !== 'object') return undefined
  const day = row.date__day
  const key = row.api_key_id
  const model = row.model
  const usd = Number(row.total_usage)
  const requests = Number(row.request_count)
  if (typeof day !== 'string' || typeof key !== 'string' || typeof model !== 'string') return undefined
  if (!Number.isFinite(usd) || !Number.isFinite(requests)) return undefined
  return { day, key, model, usd, requests }
}

/**
 * The error every refused upstream reply throws: the status plus a short
 * slice of the body, so a 403 "Only management keys can perform this
 * operation" reaches the reader as a sentence rather than a bare number. A
 * reply that said when it will accept us again also carries its retry hint,
 * for the scheduler to honour (m2).
 */
async function upstreamError(what, response) {
  const detail = (await response.text()).slice(0, 200)
  const error = new Error(`${what} answered ${response.status}: ${detail}`)
  const hint = retryHintSeconds(response.headers)
  if (hint > 0) error.retryAfterSeconds = hint
  return error
}

/** Fetch the window split by API key and model; one query answers both views. */
async function queryAnalytics(config, credential, start, end, signal) {
  const url = `${config.apiBase.replace(/\/+$/, '')}/analytics/query`
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      metrics: ['total_usage', 'request_count'],
      dimensions: ['api_key_id', 'model'],
      granularity: 'day',
      time_range: { start, end },
      limit: MAX_ANALYTICS_ROWS,
    }),
    signal,
  })
  if (!response.ok) throw await upstreamError('analytics/query', response)
  const length = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > MAX_REPLY_BYTES) {
    throw new Error(`analytics/query reply exceeds ${MAX_REPLY_BYTES} bytes`)
  }
  const body = await response.json()
  const rows = body?.data?.data
  if (!Array.isArray(rows)) throw new Error('analytics/query returned no data rows')
  if (rows.length >= MAX_ANALYTICS_ROWS) {
    throw new Error(`analytics/query hit its ${MAX_ANALYTICS_ROWS}-row ceiling; narrow config.historyDays`)
  }
  return rows.flatMap(row => {
    const read = readRow(row)
    return read === undefined ? [] : [read]
  })
}

/**
 * Read one session split row. Same wire narrowing as `readRow`; the `none`
 * bucket collects requests sent without a session id and belongs to no chat.
 *
 * The API key rides along because the chip's `session/day` pair has to name one
 * key on both sides (ADR-0006): a session's spend is only comparable to a key's
 * day when we know which key the session spent on. A row without a usable key
 * is dropped rather than kept with an unknown one — the pair cannot be scoped
 * from it, and a row that cannot be attributed would either span keys or have
 * to be guessed at, which is what this read exists to avoid.
 * @returns the row, or `undefined` when it carries no usable session, key or cost.
 */
function readSessionRow(row) {
  if (row === null || typeof row !== 'object') return undefined
  const id = row.session_id
  const key = row.api_key_id
  const usd = Number(row.total_usage)
  const requests = Number(row.request_count)
  if (typeof id !== 'string' || id.length === 0 || id === 'none') return undefined
  if (typeof key !== 'string' || key.length === 0) return undefined
  if (!Number.isFinite(usd) || !Number.isFinite(requests)) return undefined
  return { id, key, usd, requests }
}

/**
 * Fetch the spend split by session and API key over a time range, without
 * granularity: one row per session and key for the whole range, so the row
 * count is bounded by sessions × the keys each one used rather than
 * sessions multiplied by days. The key dimension is what lets the browser
 * scope the chip's two figures to a single key (ADR-0006); measured against a
 * live account, the same 271 sessions came back as 275 rows, because a session
 * bills to one key unless the tracked key was switched mid-session.
 */
async function querySessions(config, credential, start, end, signal) {
  const url = `${config.apiBase.replace(/\/+$/, '')}/analytics/query`
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      metrics: ['total_usage', 'request_count'],
      dimensions: ['api_key_id', 'session_id'],
      time_range: { start, end },
      limit: MAX_SESSION_ROWS,
    }),
    signal,
  })
  if (!response.ok) throw await upstreamError('analytics/query (sessions)', response)
  const length = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > MAX_REPLY_BYTES) {
    throw new Error(`analytics/query (sessions) reply exceeds ${MAX_REPLY_BYTES} bytes`)
  }
  const body = await response.json()
  const rows = body?.data?.data
  if (!Array.isArray(rows)) throw new Error('analytics/query (sessions) returned no rows')
  // A truncated split sums to less than the summary says; refuse instead.
  if (body?.data?.metadata?.truncated === true || rows.length >= MAX_SESSION_ROWS) {
    throw new Error(`analytics/query (sessions) hit its ${MAX_SESSION_ROWS}-row ceiling; narrow config.historyDays`)
  }
  return rows.flatMap(row => {
    const read = readSessionRow(row)
    return read === undefined ? [] : [read]
  })
}

/**
 * One key's share of a session's spend, accumulated across the rows that share
 * the session's id. A session bills to one key unless the tracked key was
 * switched mid-session, so this is usually a single entry — but the pair the
 * chip renders divides two figures, and both have to name the same key, so the
 * split is kept rather than collapsed to a guessed-at winner.
 * @returns `key → { usd, requests }`, insertion-ordered.
 */
function newKeyTotals() {
  return new Map()
}

/**
 * Add one row's figures to a session entry, keyed by the API key that billed
 * them. A row with no usable key is skipped rather than filed under
 * `undefined`: an unattributable share is not attributed to anyone, and an
 * `undefined` entry would reach the payload as a key the browser cannot match
 * against `byKey`.
 */
function addKeyTotal(totals, key, usd, requests) {
  if (typeof key !== 'string' || key.length === 0) return
  const entry = totals.get(key) ?? { usd: 0, requests: 0 }
  entry.usd += usd
  entry.requests += requests
  totals.set(key, entry)
}

/**
 * Read a row's per-key totals whatever shape they arrive in: `mergeSessions`
 * builds a `Map`, and a payload or a test may hand back the array form. An
 * absent field reads as "no per-key information", which publishes an empty
 * split — the browser then declines the pair rather than dividing by a key it
 * cannot name.
 */
function keyTotalsOf(row) {
  const source = row?.todayKeys
  const totals = newKeyTotals()
  if (source instanceof Map) {
    for (const [key, entry] of source) addKeyTotal(totals, key, entry?.usd ?? 0, entry?.requests ?? 0)
    return totals
  }
  if (Array.isArray(source)) {
    for (const entry of source) {
      // `id` is checked inside `addKeyTotal`, so the array form cannot smuggle
      // in a bucket the Map form would have refused.
      addKeyTotal(totals, entry?.id, entry?.usd ?? 0, entry?.requests ?? 0)
    }
  }
  return totals
}

/** The wire shape of a session row's per-key split: descending by spend, so the largest share leads. */
function keyTotalsPayload(totals) {
  return [...totals.entries()]
    .map(([id, entry]) => ({ id, usd: entry.usd, requests: entry.requests }))
    .sort((left, right) => right.usd - left.usd)
}

/**
 * Merge the window's session rows with today's: window totals carry the
 * popover list, today's figures carry the chip's session half. Both are kept
 * per API key, because the chip's pair is only meaningful when its two figures
 * name one key (ADR-0006).
 * @returns the per-session split, most recent spend first.
 */
export function mergeSessions(windowRows, todayRows) {
  const merged = new Map()
  const create = () => ({ id: '', usd: 0, requests: 0, todayUsd: 0, todayRequests: 0, todayKeys: newKeyTotals() })
  for (const row of windowRows) {
    const entry = merged.get(row.id) ?? create()
    entry.id = row.id
    entry.usd += row.usd
    entry.requests += row.requests
    merged.set(row.id, entry)
  }
  // A session that only today's read mentions still has to carry a window
  // figure, or the popover would show it with a zero: the window query covers
  // today too, so an id here and not there means the window read was thinner,
  // and today's own figures are the honest window total. Mirrored by id, not
  // per row, so a row already in the window is never counted twice.
  const mirrored = new Set()
  for (const row of todayRows) {
    const entry = merged.get(row.id) ?? create()
    entry.id = row.id
    entry.todayUsd += row.usd
    entry.todayRequests += row.requests
    if (!merged.has(row.id)) mirrored.add(row.id)
    if (mirrored.has(row.id)) {
      entry.usd += row.usd
      entry.requests += row.requests
    }
    // `todayKeys` is built here and nowhere else, so it is always a Map at this
    // point; `keyTotalsOf` reads it as whatever shape a caller hands the rollup.
    addKeyTotal(entry.todayKeys, row.key, row.usd, row.requests)
    merged.set(row.id, entry)
  }
  return [...merged.values()]
    // The wire shape, not the Map the loop accumulated into: one payload shape
    // for merged and rolled-up rows alike, so no caller has to know which path
    // produced the rows it is reading.
    .map(entry => ({ ...entry, todayKeys: keyTotalsPayload(entry.todayKeys) }))
    .sort((left, right) => (right.todayUsd - left.todayUsd) || (right.usd - left.usd))
}

/**
 * Narrow session headers to the delegation edges the rollup folds along.
 *
 * `parentSession` alone is not enough: a forked session also records a parent,
 * but it is a branch of the same work rather than work the parent delegated,
 * and its spend already reached OpenRouter under its own id. Only a child the
 * harness marked `origin: 'subagent'` is a delegated subagent — the field every
 * in-process delegation sets and neither fork path does (ADR-0003).
 * @param records - logical session records as `ctx.sessionQuery` returns them.
 * @returns `parent id → child ids`, delegation only.
 */
export function delegationEdges(records) {
  const childrenByParent = new Map()
  for (const record of records ?? []) {
    const header = record?.header
    if (header?.origin !== 'subagent') continue
    const id = header.id
    if (typeof id !== 'string' || id.length === 0) continue
    const parent = header.parentSession
    if (typeof parent !== 'string' || parent.length === 0) continue
    const children = childrenByParent.get(parent)
    if (children === undefined) childrenByParent.set(parent, [id])
    else children.push(id)
  }
  return childrenByParent
}

/**
 * Read session lineage from the harness: one listing of logical session
 * headers, narrowed to the delegation edges the rollup needs. A delegated
 * subagent runs as its own session, so this is the only place the parent link
 * exists (ADR-0003).
 *
 * The listing walks the whole logical corpus, and that is a documented
 * acceptance rather than an oversight: `ctx.sessionQuery` offers no corpus
 * version to key a cache on, the edges change the moment a subagent is
 * delegated (a cached map would fold a fresh subagent's spend one refresh
 * late), and the listing is the session-query service's own lightweight
 * path — headers and availability flags only, no log replay. It runs once
 * per refresh, not once per query; revisit only if refresh latency says so.
 * @returns `parent id → child ids` for delegated children.
 */
async function queryLineage(ctx, signal) {
  return delegationEdges(await ctx.sessionQuery.listSessions(signal))
}

/**
 * Fold each session's delegated subtrees into its own figures, recursively —
 * a grandchild's spend belongs to the whole chain above it, and delegation
 * nests. A session whose own traffic never reached OpenRouter still gets a row
 * when something it delegated spent, or the figure would be unreachable from
 * exactly the chats that delegated the work.
 *
 * The response keeps the shape the browser half already reads: `usd`,
 * `requests`, `todayUsd`, `todayRequests`, now meaning "this session plus the
 * work it delegated" rather than the session's own requests alone — plus
 * `todayKeys`, the same subtree figures split by the API key that billed them,
 * which is what lets the chip name one key on both halves of its pair (ADR-0006).
 * @param rows - the merged per-session split, before the rollup.
 * @param lineage - `childrenByParent`, delegation edges only (see `delegationEdges`).
 * @returns the rolled-up split, most recent spend first.
 */
export function rollupSessions(rows, lineage) {
  const parentOf = new Map()
  for (const [parent, children] of lineage.childrenByParent) {
    for (const child of children) if (!parentOf.has(child)) parentOf.set(child, parent)
  }
  const subtree = new Map()
  const bump = (id, row) => {
    const entry = subtree.get(id) ?? { usd: 0, requests: 0, todayUsd: 0, todayRequests: 0, todayKeys: newKeyTotals() }
    entry.usd += row.usd
    entry.requests += row.requests
    entry.todayUsd += row.todayUsd
    entry.todayRequests += row.todayRequests
    // The key split folds with the money it splits: a child billed on another
    // key than its parent makes the subtree span two keys, and the browser
    // needs to see that rather than a pair that names only one of them.
    for (const [key, share] of keyTotalsOf(row)) addKeyTotal(entry.todayKeys, key, share.usd, share.requests)
    subtree.set(id, entry)
  }
  for (const row of rows) {
    // A row's spend counts for the session itself and for every ancestor. The
    // seen-set guards against a cycle and the depth cap against a chain long
    // enough to stall the refresh: lineage is read from disk, and a corrupt
    // header must neither hang the poll nor inflate the figure without bound.
    const seen = new Set([row.id])
    bump(row.id, row)
    let parent = parentOf.get(row.id)
    while (typeof parent === 'string' && !seen.has(parent) && seen.size <= MAX_LINEAGE_DEPTH) {
      seen.add(parent)
      bump(parent, row)
      parent = parentOf.get(parent)
    }
  }
  // Every row id was bumped into `subtree` above, so its keys already cover the
  // input ids; the ancestors it gained are the only additions.
  if (subtree.size > MAX_ROLLUP_ROWS) {
    throw new Error(`session rollup grew to ${subtree.size} rows, past the ${MAX_ROLLUP_ROWS}-row ceiling; lineage looks corrupt`)
  }
  return [...subtree.keys()]
    .map(id => {
      const { usd, requests, todayUsd, todayRequests, todayKeys } = subtree.get(id)
      return { id, usd, requests, todayUsd, todayRequests, todayKeys: keyTotalsPayload(todayKeys) }
    })
    .sort((left, right) => (right.todayUsd - left.todayUsd) || (right.usd - left.usd))
}

/**
 * Roll the split up with lineage, containing a failed lineage read: own-session
 * figures plus a reported reason beat no figures at all, so a chat understates
 * rather than losing the chip (ADR-0003). Takes the reader as a callback so the
 * containment is exercisable without a live harness.
 * @param merged - the merged per-session split, before the rollup.
 * @param readLineage - reads `parent id → child ids`; may reject.
 * @param onError - reports a failed read, typically to the host log.
 * @returns the summary fragment the payload carries.
 */
/**
 * The wire shape of merged (unrolled) session rows. `mergeSessions` keeps its
 * per-key split in a `Map`, and a `Map` serialises to `{}` — so a payload that
 * skipped this step would publish the split as an empty object and the chip
 * would silently lose the key it needs. Used on every path that returns rows
 * without going through `rollupSessions`.
 */
function sessionRowsPayload(rows) {
  return rows.map(row => ({
    id: row.id,
    usd: row.usd,
    requests: row.requests,
    todayUsd: row.todayUsd,
    todayRequests: row.todayRequests,
    todayKeys: keyTotalsPayload(keyTotalsOf(row)),
  }))
}

export async function rollupWithLineage(merged, readLineage, onError) {
  try {
    const childrenByParent = await readLineage()
    return { bySession: rollupSessions(merged, { childrenByParent }) }
  } catch (error) {
    // A reporter that throws must not undo the containment it reports for:
    // the figures are already known good, so the failure to log them is
    // swallowed rather than allowed to take the split down.
    try {
      onError(error)
    } catch { /* reporting is best-effort */ }
    return {
      bySession: sessionRowsPayload(merged),
      lineageError: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Read the prepaid credits balance, which is the account's remaining budget. */
async function queryCredits(config, credential, signal) {
  const url = `${config.apiBase.replace(/\/+$/, '')}/credits`
  const response = await fetch(url, { headers: { authorization: `Bearer ${credential}` }, signal })
  if (!response.ok) throw await upstreamError('credits', response)
  const length = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > MAX_REPLY_BYTES) {
    throw new Error(`credits reply exceeds ${MAX_REPLY_BYTES} bytes`)
  }
  const body = await response.json()
  const data = body?.data
  if (typeof data?.total_credits !== 'number' || typeof data?.total_usage !== 'number') {
    throw new Error('credits returned no total_credits/total_usage')
  }
  return { totalCredits: data.total_credits, totalUsage: data.total_usage }
}

/**
 * Narrow the `/keys` reply to the limits the browser renders. Only a key that
 * actually carries a limit is published — a key without one is not a "limit is
 * running out" candidate — and only the four limit fields travel: the record
 * itself (hash, label, creator, timestamps, usage counters) stays in the host,
 * since this repo and its payload are public.
 *
 * Two keys cannot share a published name: the analytics split identifies a
 * key by name alone, so which of two same-named keys a spend row belongs to
 * is undecidable, and last-wins would misjoin figures to an arbitrary one of
 * them (ADR-0002 names duplication as the join's known risk). A duplicated
 * name drops every entry carrying it and surfaces `limitsNote` instead, so
 * the browser can hang its "limit unknown" path on the reason rather than
 * show a joined figure that looks authoritative. A name shared by a limited
 * and an unlimited key is not a duplicate: only one of them is ever
 * published, so the name stays unambiguous.
 * @param keysBody - the parsed `GET {apiBase}/keys` body.
 * @returns `{ limits, limitsNote }`: `limits` maps `key name →
 * { limit, limitRemaining, limitReset, disabled }`, one entry per key whose
 * limit is a finite number above zero and whose name is unique among those;
 * `limitsNote` is `undefined` unless a duplicated name was dropped.
 * @throws when `keysBody.data` is not an array: a reply of an unknown shape
 * must read as "could not read", never as "no limits exist".
 */
export function readKeyLimits(keysBody) {
  const data = keysBody?.data
  if (!Array.isArray(data)) throw new Error('keys returned no data array')
  // `Object.create(null)`: key names are user-chosen labels, and a key
  // literally named `__proto__` must land as a plain own entry — the burn
  // map's `Object.fromEntries` already defines such names as own properties,
  // so the two maps agree on the corner.
  const limits = Object.create(null)
  const seenNames = new Set()
  const duplicated = new Set()
  for (const row of data) {
    if (row === null || typeof row !== 'object') continue
    const name = row.name
    if (typeof name !== 'string' || name.length === 0) continue
    const limit = row.limit
    if (!Number.isFinite(limit) || limit <= 0) continue
    if (seenNames.has(name)) {
      // The second (and any later) limited key of this name: drop the entry
      // the first one wrote and remember the name for the note. A later copy
      // cannot resurrect it — the name stays in `seenNames`.
      duplicated.add(name)
      delete limits[name]
      continue
    }
    seenNames.add(name)
    const remaining = row.limit_remaining
    limits[name] = {
      limit,
      limitRemaining: Number.isFinite(remaining) ? remaining : limit,
      limitReset: typeof row.limit_reset === 'string' ? row.limit_reset : null,
      disabled: row.disabled === true,
    }
  }
  const limitsNote = duplicated.size === 0 ? undefined
    : `keys named ${[...duplicated].sort().map(name => `"${name}"`).join(', ')} carry limits but share a name; `
      + 'spend joins keys by name, so all of them were dropped — rename all but one in OpenRouter to see its limit'
  return { limits, limitsNote }
}

/**
 * Fetch the account's API key records, raw.
 *
 * The request states its scope rather than riding the endpoint's defaults,
 * which exclude exactly the keys a limit warning is about. `include_disabled`
 * is set because a disabled key still owns its cap and must not read as
 * "limit unknown" while it still shows spend — the user disabled spending,
 * not the limit. Expired keys stay excluded on purpose: an expired key cannot
 * spend, so its cap can never run out, and its frozen remaining/reset figures
 * would read as live data. `offset` paginates with an undocumented page size,
 * so the walk requests the next page until one comes back empty; a page that
 * adds no unseen key means the reply ignores `offset` and already carried
 * everything, and the row ceiling turns a pathological walk into a refusal
 * rather than a loop. Only the default workspace's keys are listed —
 * iterating workspaces would need a workspace listing plus one read per
 * workspace on every refresh — so a key outside it surfaces as "limit
 * unknown", the honest answer rather than a missing one.
 *
 * The rows are returned raw, hash included: the limits read narrows them
 * before they reach the payload, and the raise needs the hash to name the
 * key upstream — the two readers share this one walk.
 */
async function queryKeyRows(config, credential, signal) {
  const base = `${config.apiBase.replace(/\/+$/, '')}/keys`
  const rows = []
  const seenHashes = new Set()
  let offset = 0
  while (true) {
    const response = await fetch(`${base}?include_disabled=true&offset=${offset}`, {
      headers: { authorization: `Bearer ${credential}` },
      signal,
    })
    if (!response.ok) throw await upstreamError('keys', response)
    const length = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(length) && length > MAX_REPLY_BYTES) {
      throw new Error(`keys reply exceeds ${MAX_REPLY_BYTES} bytes`)
    }
    const body = await response.json()
    const page = body?.data
    if (!Array.isArray(page)) throw new Error('keys returned no data array')
    if (page.length === 0) break
    let fresh = 0
    for (const row of page) {
      // `hash` is the key's unique id; a repeat means the reply re-sent a row
      // this walk already has, which is how an `offset`-ignoring reply is
      // recognised as complete rather than paginated.
      const hash = row?.hash
      if (typeof hash === 'string' && hash.length > 0) {
        if (seenHashes.has(hash)) continue
        seenHashes.add(hash)
      }
      rows.push(row)
      fresh += 1
    }
    if (fresh === 0) break
    offset += page.length
    if (rows.length >= MAX_KEY_ROWS) {
      throw new Error(`keys listing grew to ${rows.length} rows, past the ${MAX_KEY_ROWS}-row ceiling; the pagination walk refused rather than loop`)
    }
  }
  return rows
}

/**
 * Fetch the keys and narrow them to the per-key limits. The narrowing contract
 * is `readKeyLimits`'s own (see above); this is the walk plus that one call.
 */
async function queryKeys(config, credential, signal) {
  return readKeyLimits({ data: await queryKeyRows(config, credential, signal) })
}

/**
 * Raise one key's spend limit through the management key.
 *
 * The name is resolved to a hash through the same `/keys` walk the limits read
 * uses, so the browser never has to carry the hash and the two halves cannot
 * disagree about which key a name means — with one deliberate difference:
 * ambiguity here is judged over EVERY key carrying the name, not only the
 * limited ones `readKeyLimits` publishes, because the raise names a record,
 * not a published entry, and OpenRouter identifies records by hash alone.
 *
 * Only a raise is accepted, and only within `RAISE_MAX_FACTOR` of the current
 * limit: a button that lowers a cap would misread as a raise, and a raise two
 * orders of magnitude up is a typo wearing intent.
 *
 * The refusals carry a `kind` the route maps to a status: `not-found` (404),
 * `ambiguous` / `no-limit` / `invalid` (400), and anything from the PATCH
 * itself, which stays a plain `upstreamError` (502).
 * @returns `{ name, limit }` — the raise the account now carries.
 */
export async function raiseKeyLimit(config, credential, name, limit, signal) {
  const rows = await queryKeyRows(config, credential, signal)
  const matches = rows.filter(row => row !== null && typeof row === 'object'
    && row.name === name && typeof row.hash === 'string' && row.hash.length > 0)
  const refuse = (kind, message) => {
    const error = new Error(message)
    error.kind = kind
    return error
  }
  if (matches.length === 0) {
    throw refuse('not-found', `no key named "${name}" on the account`)
  }
  if (matches.length > 1) {
    throw refuse('ambiguous', `keys named "${name}" share a name, and OpenRouter identifies a key by hash, so the raise cannot name one key — rename all but one in OpenRouter`)
  }
  const current = Number(matches[0].limit)
  if (!Number.isFinite(current) || current <= 0) {
    throw refuse('no-limit', `key "${name}" carries no finite limit, so there is no cap to raise — set a limit on it in OpenRouter first`)
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw refuse('invalid', `the new limit must be a finite number above zero, not ${limit}`)
  }
  if (limit <= current) {
    throw refuse('invalid', `only a raise is accepted: the new limit (${limit}) is at or below the current (${current})`)
  }
  if (limit > current * RAISE_MAX_FACTOR) {
    throw refuse('invalid', `the new limit (${limit}) is past ${RAISE_MAX_FACTOR}x the current (${current}); a raise that large is refused as a likely typo`)
  }
  const response = await fetch(`${config.apiBase.replace(/\/+$/, '')}/keys/${encodeURIComponent(matches[0].hash)}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify({ limit }),
    signal,
  })
  if (!response.ok) throw await upstreamError('keys/{hash}', response)
  return { name, limit }
}

/**
 * Read one hourly burn row. Same wire narrowing as `readRow`: the key and the
 * hour bucket are strings, and `total_usage` arrives as a decimal string.
 * @returns the row, or `undefined` when it carries no usable key or hour.
 */
function readBurnRow(row) {
  if (row === null || typeof row !== 'object') return undefined
  const key = row.api_key_id
  const ts = row.date__hour
  const usd = Number(row.total_usage)
  if (typeof key !== 'string' || typeof ts !== 'string') return undefined
  if (!Number.isFinite(usd)) return undefined
  return { key, ts, usd }
}

/**
 * Bucket hourly analytics rows per key: one list of `{ ts, usd }` points per
 * key, ascending by hour. Hours nobody spent in stay absent rather than
 * zero-filled — the browser pads the gaps it cares about.
 * @param rows - hourly rows as `queryHourlyBurn` reads them.
 * @returns `key name → [{ ts, usd }]`; rows without a usable key, hour or
 * cost are skipped silently.
 */
export function groupHourlyBurn(rows) {
  const burn = new Map()
  for (const row of rows ?? []) {
    const read = readBurnRow(row)
    if (read === undefined) continue
    const buckets = burn.get(read.key) ?? new Map()
    const bucket = buckets.get(read.ts) ?? { ts: read.ts, usd: 0 }
    bucket.usd += read.usd
    buckets.set(read.ts, bucket)
    burn.set(read.key, buckets)
  }
  return Object.fromEntries([...burn.entries()].map(([key, buckets]) => [
    key,
    [...buckets.values()].sort((left, right) => (left.ts < right.ts ? -1 : left.ts > right.ts ? 1 : 0)),
  ]))
}

/**
 * Fetch the burn window bucketed by hour and key. The analytics `filter`
 * parameter is silently ignored by this API, so every narrowing happens in the
 * request itself and in the host, never in a filter this server would drop.
 */
async function queryHourlyBurn(config, credential, start, end, signal) {
  const url = `${config.apiBase.replace(/\/+$/, '')}/analytics/query`
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      metrics: ['total_usage'],
      dimensions: ['api_key_id'],
      granularity: 'hour',
      time_range: { start, end },
      limit: MAX_BURN_ROWS,
    }),
    signal,
  })
  if (!response.ok) throw await upstreamError('analytics/query (hourly burn)', response)
  const length = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > MAX_REPLY_BYTES) {
    throw new Error(`analytics/query (hourly burn) reply exceeds ${MAX_REPLY_BYTES} bytes`)
  }
  const body = await response.json()
  const rows = body?.data?.data
  if (!Array.isArray(rows)) throw new Error('analytics/query (hourly burn) returned no data rows')
  // A truncated burn sums to less than the keys actually burnt; refuse instead.
  if (body?.data?.metadata?.truncated === true || rows.length >= MAX_BURN_ROWS) {
    throw new Error(`analytics/query (hourly burn) hit its ${MAX_BURN_ROWS}-row ceiling; narrow config.burnWindowDays`)
  }
  return groupHourlyBurn(rows)
}

/**
 * Read one numeric tag (`<Value>`, `<Nominal>`) out of a `<Valute>` block.
 * The sheet is windows-1251, but every tag read here is ASCII, so decoding the
 * reply as UTF-8 cannot corrupt a rate; the garbled names are never touched.
 */
function readRateTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}>\\s*([\\d\\s,\\.]+)\\s*</${tag}>`))
  return match === null ? undefined : match[1].replace(/\s/g, '').replace(',', '.')
}

/**
 * Pull the USD rate out of a CBR daily-rates sheet.
 * @returns rubles for one US dollar.
 */
function parseUsdRub(sheet) {
  const blocks = sheet.match(/<Valute[\s\S]*?<\/Valute>/g) ?? []
  const usd = blocks.find(block => /<CharCode>\s*USD\s*<\/CharCode>/.test(block))
  if (usd === undefined) throw new Error('cbr daily sheet carries no USD row')
  // `Value` is the price of `Nominal` dollars; the rate is their quotient.
  const value = Number(readRateTag(usd, 'Value'))
  const nominal = Number(readRateTag(usd, 'Nominal') ?? '1')
  const perUsd = value / nominal
  if (!Number.isFinite(perUsd) || perUsd <= 0) throw new Error('cbr daily sheet carries no usable USD rate')
  return perUsd
}

/** Fetch today's USD rate from the CBR daily sheet; one number out of the XML. */
async function queryUsdRub(config, signal) {
  const response = await fetch(config.cbrUrl, {
    headers: { accept: 'application/xml, text/xml' },
    signal,
  })
  if (!response.ok) throw new Error(`cbr daily sheet answered ${response.status}`)
  const sheet = await response.text()
  if (sheet.length > MAX_RATE_BYTES) throw new Error(`cbr daily sheet exceeds ${MAX_RATE_BYTES} bytes`)
  return parseUsdRub(sheet)
}

/** UTC calendar day of a timestamp, the bucket OpenRouter answers `date__day` with. */
function utcDay(now) {
  return now.toISOString().slice(0, 10)
}

/** UTC midnight opening the day that is `offset` days before `now`'s day. */
function startOfUtcDay(now, offset) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset))
  return `${day.toISOString().slice(0, 10)}T00:00:00Z`
}

/** Add one row's figures into an accumulator, creating it when the first row lands. */
function add(target, id, row) {
  const entry = target.get(id) ?? { usd: 0, requests: 0 }
  entry.usd += row.usd
  entry.requests += row.requests
  target.set(id, entry)
}

/** Zero-filled daily totals across the window, so a chart has no missing bars. */
function dailySeries(rows, historyDays, now) {
  const totals = new Map()
  for (const row of rows) add(totals, row.day, row)
  const series = []
  for (let offset = historyDays - 1; offset >= 0; offset -= 1) {
    const date = utcDay(new Date(now.getTime() - offset * 86_400_000))
    const entry = totals.get(date) ?? { usd: 0, requests: 0 }
    series.push({ date, usd: entry.usd, requests: entry.requests })
  }
  return series
}

/** Sum the trailing `days` entries of a daily series, today included. */
function trailing(series, days) {
  return series.slice(-days).reduce((sum, entry) => ({
    usd: sum.usd + entry.usd,
    requests: sum.requests + entry.requests,
  }), { usd: 0, requests: 0 })
}

/**
 * Per-key totals over the window plus today's per-key model split, so selecting
 * a key in the UI answers both "how much" and "on what" without a second poll.
 */
function byKey(rows, today, series) {
  const totals = new Map()
  const todayModels = new Map()
  const perDay = new Map()
  for (const row of rows) {
    add(totals, row.key, row)
    const days = perDay.get(row.key) ?? new Map()
    add(days, row.day, row)
    perDay.set(row.key, days)
    if (row.day !== today) continue
    const models = todayModels.get(row.key) ?? new Map()
    add(models, row.model, row)
    todayModels.set(row.key, models)
  }
  const trailingFor = (key, days) => {
    const window = series.slice(-days).map(entry => entry.date)
    let usd = 0
    let requests = 0
    for (const day of window) {
      const entry = perDay.get(key)?.get(day)
      if (entry === undefined) continue
      usd += entry.usd
      requests += entry.requests
    }
    return { usd, requests }
  }
  return [...totals.entries()]
    .map(([id, entry]) => {
      const models = [...(todayModels.get(id) ?? new Map()).entries()]
        .map(([model, modelEntry]) => ({ id: model, usd: modelEntry.usd, requests: modelEntry.requests }))
        .sort((left, right) => right.usd - left.usd)
      return {
        id,
        usd: entry.usd,
        requests: entry.requests,
        todayModels: models,
        todayUsd: models.reduce((sum, model) => sum + model.usd, 0),
        todayRequests: models.reduce((sum, model) => sum + model.requests, 0),
        last7: trailingFor(id, 7),
        last30: trailingFor(id, 30),
      }
    })
    .sort((left, right) => right.usd - left.usd)
}

/** Today's spend split by model, in descending cost. */
function byModel(rows, today) {
  const totals = new Map()
  for (const row of rows) {
    if (row.day === today) add(totals, row.model, row)
  }
  return [...totals.entries()]
    .map(([id, entry]) => ({ id, usd: entry.usd, requests: entry.requests }))
    .sort((left, right) => right.usd - left.usd)
}

/**
 * Build the one summary the browser half renders: today's spend, trailing
 * windows, the daily series, per-model, per-key and per-session splits, and
 * the balance. `rateInfo` answers the RUB rate (or the reason it is missing)
 * on the same refresh, so RUB display costs no extra round trip. The session
 * split is auxiliary: its failure lands in `sessionsError` and never takes
 * the rest of the summary down with it. A lineage read that fails is contained
 * the same way — the rows keep their own figures and `lineageError` says why —
 * so the chip understates rather than disappearing (ADR-0003). The per-key
 * limits and the hourly burn are auxiliary the same way: each lands in its own
 * `limitsError` / `burnError` and neither failure can take the summary down.
 */
async function collect(ctx, config, credential, rateInfo) {
  const now = new Date()
  const end = new Date(now.getTime() + 60_000).toISOString()
  const start = startOfUtcDay(now, config.historyDays - 1)
  const burnStart = startOfUtcDay(now, config.burnWindowDays - 1)
  // One deadline per upstream request, not one for the whole refresh: the
  // schema documents a per-request timeout, and a shared signal lets a slow
  // auxiliary read abort the primary analytics query mid-flight and flip the
  // whole summary stale over a query the chip does not even show. The queries
  // run concurrently, so the refresh as a whole still answers in about one
  // deadline rather than the sum of seven.
  const deadline = () => AbortSignal.timeout(config.timeoutMs)
  const sessions = querySessions(config, credential, start, end, deadline())
    .then(async windowRows => {
      const todayStart = startOfUtcDay(now, 0)
      const todayRows = await querySessions(config, credential, todayStart, end, deadline())
      const merged = mergeSessions(windowRows, todayRows)
      return rollupWithLineage(
        merged,
        () => queryLineage(ctx, deadline()),
        error => ctx.logger.warn('openrouter-spend: session lineage unavailable', error),
      )
    })
    .catch(error => ({
      sessionsError: error instanceof Error ? error.message : String(error),
    }))
  const limits = queryKeys(config, credential, deadline())
    // `limitsNote` rides only when duplicated key names were dropped, so its
    // absence keeps meaning "every limited key is published".
    .then(({ limits, limitsNote }) => (limitsNote === undefined ? { limits } : { limits, limitsNote }))
    .catch(error => ({
      limitsError: error instanceof Error ? error.message : String(error),
    }))
  const burn = queryHourlyBurn(config, credential, burnStart, end, deadline())
    .then(burnMap => ({ burnHourly: burnMap }))
    .catch(error => ({
      burnError: error instanceof Error ? error.message : String(error),
    }))
  const [rows, credits, rate, sessionSplit, limitsSplit, burnSplit] = await Promise.all([
    queryAnalytics(config, credential, start, end, deadline()),
    queryCredits(config, credential, deadline()),
    rateInfo(),
    sessions,
    limits,
    burn,
  ])
  const today = utcDay(now)
  const series = dailySeries(rows, config.historyDays, now)
  return {
    status: 'ok',
    today,
    refreshedAt: now.toISOString(),
    refreshSeconds: config.refreshSeconds,
    historyDays: config.historyDays,
    todaySpend: series[series.length - 1] ?? { date: today, usd: 0, requests: 0 },
    last7: trailing(series, 7),
    last30: trailing(series, 30),
    byDay: series,
    byModel: byModel(rows, today),
    byKey: byKey(rows, today, series),
    // `rate` is always present: rubles per dollar, or null when cbr.ru failed
    // — then `rateError` carries the reason for the panel to show. The session
    // split is `bySession`, or `sessionsError` when the split could not be read.
    // The limits are `limits`, or `limitsError` when the keys could not be
    // read — an empty `limits` with no error means "no key carries a limit",
    // so the two answers must never be confused. `limitsNote` appears only
    // when duplicated key names were dropped from `limits`. The burn is
    // `burnHourly`, or `burnError` when the hourly window could not be read.
    ...rate,
    ...sessionSplit,
    ...limitsSplit,
    ...burnSplit,
    // The thresholds are host config but take effect in the browser, so they
    // ride along rather than being duplicated there. A browser that never sees
    // them falls back to the ADR-0001 defaults.
    limitThresholds: { warn: config.warnConsumedFraction, critical: config.criticalConsumedFraction },
    credits,
  }
}

/** JSON reply carrying live facts; never cached by the browser. */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Collect a bounded request body as UTF-8; null past the ceiling (stream drained). */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      // Drain the rest so the refusal is a readable response, not a socket cut.
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Validate the key-limit body at the wire: an object with a non-empty `name`
 * and a finite `limit`. A `Number()` read rather than `typeof === 'number'`,
 * because a JSON `10` and an OpenRouter string `"10"` are both a limit the
 * account can carry; what is refused is what no figure can be.
 * @returns `{ name, limit }`, or `undefined` when the body is not a raise.
 */
export function parseKeyLimitBody(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    // A non-JSON body is exactly the refusal case.
    return undefined
  }
  if (body === null || typeof body !== 'object') return undefined
  if (typeof body.name !== 'string' || body.name.length === 0) return undefined
  const limit = Number(body.limit)
  if (!Number.isFinite(limit)) return undefined
  return { name: body.name, limit }
}

/** Validate the credential body at the wire: an object with `value` or `clear`. */
function parseCredentialBody(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    // A non-JSON body is exactly the refusal case.
    return undefined
  }
  if (body === null || typeof body !== 'object') return undefined
  if (body.clear === true) return { clear: true }
  return typeof body.value === 'string' && body.value.length > 0 ? { value: body.value } : undefined
}

/** The payload the browser shows before any query has answered. */
function emptyPayload(config) {
  return {
    status: 'loading',
    today: utcDay(new Date()),
    refreshSeconds: config.refreshSeconds,
    historyDays: config.historyDays,
    todaySpend: { usd: 0, requests: 0 },
    last7: { usd: 0, requests: 0 },
    last30: { usd: 0, requests: 0 },
    byDay: [],
    byModel: [],
    byKey: [],
    bySession: [],
    limits: {},
    burnHourly: {},
    limitThresholds: { warn: config.warnConsumedFraction, critical: config.criticalConsumedFraction },
    rate: null,
  }
}

/**
 * Register the summary route. The reply is cached for `refreshSeconds` and one
 * refresh serves every concurrent caller, so several open tabs cost one poll.
 */
export function apply(ctx, config) {
  // The schema cannot cross-validate two fields against each other, so the
  // warn/critical ordering is refused here, at activation, with the reason —
  // the same "fail the row rather than misreport later" rule the field
  // schemas follow. warn >= critical makes the warning tier unreachable and
  // the chip would jump straight to critical.
  if (config.warnConsumedFraction >= config.criticalConsumedFraction) {
    throw new Error(
      `warnConsumedFraction (${config.warnConsumedFraction}) must be below `
      + `criticalConsumedFraction (${config.criticalConsumedFraction}): at or above it the warning tier is unreachable`,
    )
  }
  let cached = undefined
  let inFlight = undefined
  // Bumped on every credential write: a read that started before the bump is
  // stale on arrival, whatever it managed to fetch. `inFlightGeneration` is
  // the generation the current in-flight read started under.
  let generation = 0
  let inFlightGeneration = -1
  let rateCached = undefined
  let rateInFlight = undefined
  // The retry ladder's state: how many refreshes have failed in a row, and when
  // the last attempt started. A good read resets both.
  let failures = 0
  let lastAttemptMs = 0

  /**
   * The RUB rate, on its own clock: the CBR sheet moves at most once a day, so
   * a good rate is kept for `rateRefreshSeconds`. A failure is kept for one
   * refresh window only — a down cbr.ru is retried gently but recovers fast.
   * Never throws: it answers `{ rate }`, or `{ rate: null, rateError }` for
   * the payload to carry to the panel.
   */
  const rateInfo = async () => {
    const fresh = rateCached !== undefined && Date.now() - rateCached.fetchedAt < rateCached.ttlMs
    if (fresh) return rateCached.value
    if (rateInFlight !== undefined) return rateInFlight
    rateInFlight = (async () => {
      const now = Date.now()
      try {
        const perUsd = await queryUsdRub(config, AbortSignal.timeout(config.timeoutMs))
        rateCached = {
          fetchedAt: now,
          ttlMs: config.rateRefreshSeconds * 1000,
          value: { rate: { perUsd, fetchedAt: new Date(now).toISOString() } },
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        ctx.logger.warn('openrouter-spend: cbr rate unavailable', reason)
        rateCached = {
          fetchedAt: now,
          ttlMs: config.refreshSeconds * 1000,
          value: { rate: null, rateError: reason },
        }
      } finally {
        rateInFlight = undefined
      }
      return rateCached.value
    })()
    return rateInFlight
  }

  const summary = async () => {
    const resolved = await ctx.credentials.resolve(config.credentialRef)
    const info = await ctx.credentials.describe(config.credentialRef)
    const credential = {
      ref: config.credentialRef,
      configured: info.configured,
      writable: info.writable,
      ...(info.source === undefined ? {} : { source: info.source }),
    }
    if (resolved === undefined) {
      return { ...emptyPayload(config), status: 'no-credential', credential }
    }
    try {
      return { ...(await collect(ctx, config, resolved.value, rateInfo)), credential }
    } catch (error) {
      // A stale reply beats an empty panel: keep the last good figures and say why.
      const reason = error instanceof Error ? error.message : String(error)
      ctx.logger.warn('openrouter-spend: refresh failed', reason)
      // A 429 that said when it will accept us again carries its hint on the
      // payload; `scheduleRefresh` takes max(ladder, hint) when stamping the
      // next attempt (m2).
      const hint = error instanceof Error && Number.isFinite(error.retryAfterSeconds)
        ? Math.max(0, error.retryAfterSeconds)
        : 0
      return {
        ...(cached?.payload ?? emptyPayload(config)),
        status: 'stale',
        error: reason,
        errorCode: describeFailure(error).code,
        retryAfterSeconds: hint,
        credential,
      }
    }
  }

  /**
   * The current summary, from cache while it is still good. `force` skips the
   * freshness check — the popover's Retry asks for figures now — but still joins
   * an in-flight read and honours `FORCE_FLOOR_MS`, so it is an override of the
   * cache and not of the coalescing.
   *
   * Every completed read announces its own schedule: `refreshSeconds` ahead
   * after a good one, and the retry ladder after a failure. The browser follows
   * that field rather than a fixed interval, which is what makes the shorter
   * retry real and visible instead of a promise the poll ignores.
   */
  const current = (force = false) => {
    const at = Date.now()
    // A read still running under a superseded credential is not joinable: it
    // will answer with the old key's figures, and joining it is exactly how a
    // credential write used to serve — and cache — the pre-write payload
    // (M4). It is treated as absent: the cache can still answer, a new read
    // can start alongside it, and the old read's own caller keeps its answer,
    // but it never reaches the cache or the ladder.
    const joinable = inFlight !== undefined && inFlightGeneration === generation
    if (!joinable
      && serveFromCache({ cached, now: at, force, lastAttemptMs, floorMs: FORCE_FLOOR_MS })) {
      return Promise.resolve(cached.payload)
    }
    if (joinable) return inFlight
    const readGeneration = generation
    const read = (async () => {
      lastAttemptMs = Date.now()
      try {
        const entry = scheduleRefresh(await summary(), failures, config, Date.now())
        if (generation !== readGeneration) return entry.payload
        failures = entry.failures
        cached = { expiresAt: entry.expiresAt, payload: entry.payload }
        return cached.payload
      } catch (error) {
        // A read that never produced a payload still counts towards the ladder,
        // so a route that keeps throwing does not retry at full speed forever —
        // unless the credential was replaced meanwhile, when the failure says
        // nothing about the key the next read will use.
        if (generation === readGeneration) failures += 1
        throw error
      } finally {
        // Only the slot's current occupant clears it: a superseded read
        // finishing late must not unset a newer read's registration.
        if (inFlight === read) inFlight = undefined
      }
    })()
    inFlight = read
    inFlightGeneration = readGeneration
    return read
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SUMMARY_PATH,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      try {
        // `?force=1` is the popover's Retry — and the confirming read after a
        // raise (ADR-0008): the raise route retires the cache, so both are
        // answered from upstream rather than a pre-raise entry.
        const url = new URL(req.url ?? '/', 'http://localhost')
        sendJson(res, 200, await current(url.searchParams.get('force') === '1'))
      } catch (error) {
        ctx.logger.warn('openrouter-spend: summary failed', error)
        sendJson(res, 502, { status: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `openrouter-spend: GET ${SUMMARY_PATH}`)

  // Storing the key: the credentials service owns the write, and its refusal
  // (a shadowing read-only source) is passed through so Settings can show it.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CREDENTIAL_PATH,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const body = readBoundedBody(req).then(parseCredentialBody)
      const parsed = await body
      if (parsed === undefined) {
        sendJson(res, 400, { status: 'error', error: 'expected {"value": "..."} or {"clear": true}' })
        return
      }
      try {
        if (parsed.clear === true) await ctx.credentials.unset(config.credentialRef)
        else await ctx.credentials.set(config.credentialRef, parsed.value)
      } catch (error) {
        sendJson(res, 409, { status: 'error', error: error instanceof Error ? error.message : String(error) })
        return
      }
      cached = undefined
      // A stored key is a new reason to read: the ladder starts over rather
      // than making the first poll after the write wait out an earlier
      // failure. The generation bump also retires any read still in flight —
      // it started under the old key, and both joining it and letting it
      // complete into the cache would answer this reply and the next polls
      // with the pre-write figures (M4).
      generation += 1
      failures = 0
      lastAttemptMs = 0
      try {
        sendJson(res, 200, await current())
      } catch (error) {
        // Mirrors the GET route: a read that cannot even start answers the
        // wire's JSON 502, not a bare 400 from the host (m6).
        ctx.logger.warn('openrouter-spend: summary failed', error)
        sendJson(res, 502, { status: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `openrouter-spend: POST ${CREDENTIAL_PATH}`)

  /**
   * The raise route: `{ name, limit }` → the account's answer, or a refusal.
   *
   * The same fencing as the two routes above — the connection trust check, then
   * a 405 for anything but POST. The refusal kinds are a poor man's status map:
   * `not-found` is a 404 (a key the account does not carry), `ambiguous`,
   * `no-limit` and `invalid` are 400s (the browser asked for something that is
   * not a raise), and anything the PATCH itself said is a 502 — the words are
   * upstream's, and this half must not invent its own for a reply it never
   * saw.
   *
   * A completed raise does not just answer `current()`: it bumps `raisedAtMs`
   * and retires the cache, because the browser's first poll after this reply
   * will carry `?attempted=<the epoch this read ran at>`, and that poll must
   * read upstream rather than be handed the reply this route already retired.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: KEY_LIMIT_PATH,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      let parsed
      try {
        parsed = parseKeyLimitBody(await readBoundedBody(req))
      } catch {
        sendJson(res, 400, { status: 'error', error: 'expected {"name": "...", "limit": ...}' })
        return
      }
      if (parsed === undefined) {
        sendJson(res, 400, { status: 'error', error: 'expected {"name": "...", "limit": ...}' })
        return
      }
      const resolved = await ctx.credentials.resolve(config.credentialRef)
      if (resolved === undefined) {
        sendJson(res, 409, { status: 'error', error: 'no management key is configured' })
        return
      }
      try {
        const raised = await raiseKeyLimit(
          config, resolved.value, parsed.name, parsed.limit,
          AbortSignal.timeout(config.timeoutMs),
        )
        // The reply that follows this raise must read upstream: a cached
        // pre-raise `limits` would show the old cap beside the raise's own
        // confirmation, and the confirmation is the one number the reader just
        // acted on.
        cached = undefined
        generation += 1
        failures = 0
        lastAttemptMs = 0
        ctx.logger.info?.('openrouter-spend: raised a key limit', raised)
        sendJson(res, 200, { status: 'ok', ...raised })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        ctx.logger.warn('openrouter-spend: raising a key limit failed', reason)
        const status = error?.kind === 'not-found' ? 404
          : error?.kind !== undefined ? 400
          : 502
        sendJson(res, status, { status: 'error', error: reason })
      }
    },
  }), `openrouter-spend: POST ${KEY_LIMIT_PATH}`)

  // Prime the cache so the first browser poll is a reply rather than a stall.
  ctx.effect(() => {
    void current().catch(error => ctx.logger.warn('openrouter-spend: priming failed', error))
    return () => undefined
  })
}