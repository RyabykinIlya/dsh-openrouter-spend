/**
 * Host half of the OpenRouter spend bundle.
 *
 * Reads what the OpenRouter account actually charged with a management key and
 * serves it to the browser half as one cached summary. Every figure comes from
 * OpenRouter's own analytics (`total_usage`), so it is billed money rather than
 * a token estimate priced from a local table. The one figure that is not
 * OpenRouter's is the RUB rate, read from the CBR daily sheet so the browser
 * can show the same money in rubles.
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

/** A credential body is one string; a larger one is hostile, not a real setting. */
const MAX_BODY_BYTES = 64 * 1024

/** A runaway guard: the window holds one row per day, key, and model. */
const MAX_REPLY_BYTES = 4 * 1024 * 1024

/** Rows beyond this are refused rather than truncated: a partial split misreports cost. */
const MAX_ANALYTICS_ROWS = 500

/** The session split is one row per session, not per session and day; the server caps at 1000. */
const MAX_SESSION_ROWS = 1000

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
})

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
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200)
    throw new Error(`analytics/query answered ${response.status}: ${detail}`)
  }
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
 * @returns the row, or `undefined` when it carries no usable session or cost.
 */
function readSessionRow(row) {
  if (row === null || typeof row !== 'object') return undefined
  const id = row.session_id
  const usd = Number(row.total_usage)
  const requests = Number(row.request_count)
  if (typeof id !== 'string' || id.length === 0 || id === 'none') return undefined
  if (!Number.isFinite(usd) || !Number.isFinite(requests)) return undefined
  return { id, usd, requests }
}

/**
 * Fetch the spend split by session over a time range, without granularity: one
 * row per session for the whole range, so the row count is bounded by the
 * number of sessions rather than sessions multiplied by days.
 */
async function querySessions(config, credential, start, end, signal) {
  const url = `${config.apiBase.replace(/\/+$/, '')}/analytics/query`
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      metrics: ['total_usage', 'request_count'],
      dimensions: ['session_id'],
      time_range: { start, end },
      limit: MAX_SESSION_ROWS,
    }),
    signal,
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200)
    throw new Error(`analytics/query (sessions) answered ${response.status}: ${detail}`)
  }
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
 * Merge the window's session rows with today's: window totals carry the
 * popover list, today's figures carry the chip's session half.
 * @returns the per-session split, most recent spend first.
 */
export function mergeSessions(windowRows, todayRows) {
  const merged = new Map()
  for (const row of windowRows) merged.set(row.id, { ...row, todayUsd: 0, todayRequests: 0 })
  for (const row of todayRows) {
    const entry = merged.get(row.id)
    if (entry === undefined) merged.set(row.id, { ...row, todayUsd: row.usd, todayRequests: row.requests })
    else { entry.todayUsd = row.usd; entry.todayRequests = row.requests }
  }
  return [...merged.values()]
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
 * work it delegated" rather than the session's own requests alone.
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
    const entry = subtree.get(id) ?? { usd: 0, requests: 0, todayUsd: 0, todayRequests: 0 }
    entry.usd += row.usd
    entry.requests += row.requests
    entry.todayUsd += row.todayUsd
    entry.todayRequests += row.todayRequests
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
      const { usd, requests, todayUsd, todayRequests } = subtree.get(id)
      return { id, usd, requests, todayUsd, todayRequests }
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
      bySession: merged,
      lineageError: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Read the prepaid credits balance, which is the account's remaining budget. */
async function queryCredits(config, credential, signal) {
  const url = `${config.apiBase.replace(/\/+$/, '')}/credits`
  const response = await fetch(url, { headers: { authorization: `Bearer ${credential}` }, signal })
  if (!response.ok) throw new Error(`credits answered ${response.status}`)
  const body = await response.json()
  const data = body?.data
  if (typeof data?.total_credits !== 'number' || typeof data?.total_usage !== 'number') {
    throw new Error('credits returned no total_credits/total_usage')
  }
  return { totalCredits: data.total_credits, totalUsage: data.total_usage }
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
 * so the chip understates rather than disappearing (ADR-0003).
 */
async function collect(ctx, config, credential, signal, rateInfo) {
  const now = new Date()
  const end = new Date(now.getTime() + 60_000).toISOString()
  const start = startOfUtcDay(now, config.historyDays - 1)
  const sessions = querySessions(config, credential, start, end, signal)
    .then(async windowRows => {
      const todayStart = startOfUtcDay(now, 0)
      const todayRows = await querySessions(config, credential, todayStart, end, signal)
      const merged = mergeSessions(windowRows, todayRows)
      return rollupWithLineage(
        merged,
        () => queryLineage(ctx, signal),
        error => ctx.logger.warn('openrouter-spend: session lineage unavailable', error),
      )
    })
    .catch(error => ({
      sessionsError: error instanceof Error ? error.message : String(error),
    }))
  const [rows, credits, rate, sessionSplit] = await Promise.all([
    queryAnalytics(config, credential, start, end, signal),
    queryCredits(config, credential, signal),
    rateInfo(),
    sessions,
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
    ...rate,
    ...sessionSplit,
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
    rate: null,
  }
}

/**
 * Register the summary route. The reply is cached for `refreshSeconds` and one
 * refresh serves every concurrent caller, so several open tabs cost one poll.
 */
export function apply(ctx, config) {
  let cached = undefined
  let inFlight = undefined
  let rateCached = undefined
  let rateInFlight = undefined

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
    const signal = AbortSignal.timeout(config.timeoutMs)
    try {
      return { ...(await collect(ctx, config, resolved.value, signal, rateInfo)), credential }
    } catch (error) {
      // A stale reply beats an empty panel: keep the last good figures and say why.
      const reason = error instanceof Error ? error.message : String(error)
      ctx.logger.warn('openrouter-spend: refresh failed', reason)
      return {
        ...(cached ?? emptyPayload(config)),
        status: 'stale',
        error: reason,
        credential,
      }
    }
  }

  const current = () => {
    const fresh = cached !== undefined && Date.now() - cached.fetchedAt < config.refreshSeconds * 1000
    if (fresh) return Promise.resolve(cached.payload)
    if (inFlight !== undefined) return inFlight
    inFlight = (async () => {
      try {
        const payload = await summary()
        cached = { fetchedAt: Date.now(), payload }
        return payload
      } finally {
        inFlight = undefined
      }
    })()
    return inFlight
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
        sendJson(res, 200, await current())
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
      sendJson(res, 200, await current())
    },
  }), `openrouter-spend: POST ${CREDENTIAL_PATH}`)

  // Prime the cache so the first browser poll is a reply rather than a stall.
  ctx.effect(() => {
    void current().catch(error => ctx.logger.warn('openrouter-spend: priming failed', error))
    return () => undefined
  })
}