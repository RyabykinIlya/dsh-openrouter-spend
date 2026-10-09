/**
 * Unit tests for the per-key limit and hourly burn reads in the host half.
 *
 * `readKeyLimits` and `groupHourlyBurn` are the pure narrowers behind the
 * payload's `limits` and `burnHourly` fields, so they are the only ones pinned
 * here: the fetches around them and the isolation in `collect` need a live
 * OpenRouter account. The fixtures are hand-built `/keys` and analytics
 * bodies — every key name and every figure is synthetic, and the key records
 * they are built from carry the fields that must stay in the host so their
 * absence from the payload is provable rather than assumed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { groupHourlyBurn, readKeyLimits } from '../index.js'

/**
 * One `/keys` row as the management API reports it: the limit fields the
 * payload may carry plus the record fields that must never travel.
 */
const keyRow = fields => ({
  name: 'build-bot',
  limit: 25,
  limit_remaining: 12,
  limit_reset: 'monthly',
  disabled: false,
  hash: 'record-stays-in-the-host',
  label: 'example-label',
  creator_user_id: 'user-example',
  created_at: '2026-01-01T00:00:00Z',
  last_used_at: '2026-01-02T00:00:00Z',
  usage: 13,
  usage_daily: 3,
  usage_weekly: 5,
  usage_monthly: 13,
  ...fields,
})

/** One hourly analytics row as `groupHourlyBurn` reads it. */
const burnRow = (key, ts, usd) => ({ api_key_id: key, date__hour: ts, total_usage: usd })

test('readKeyLimits: a key with a null limit and a key with no name are skipped', () => {
  const limits = readKeyLimits({
    data: [
      keyRow({}),
      keyRow({ name: 'batch-key', limit: null, limit_remaining: null }),
      keyRow({ name: undefined, limit: 12 }),
      keyRow({ name: '', limit: 12 }),
      keyRow({ name: 'nightly', limit: 0 }),
    ],
  })

  assert.deepEqual(Object.keys(limits), ['build-bot'])
  assert.deepEqual(limits['build-bot'], {
    limit: 25,
    limitRemaining: 12,
    limitReset: 'monthly',
    disabled: false,
  })
})

test('readKeyLimits: an entry carries exactly the four documented fields', () => {
  const limits = readKeyLimits({ data: [keyRow({ limit_remaining: 12.5, disabled: true })] })

  assert.deepEqual(
    Object.keys(limits['build-bot']).sort(),
    ['disabled', 'limit', 'limitRemaining', 'limitReset'],
  )
  assert.equal(limits['build-bot'].disabled, true)
})

test('readKeyLimits: no hash, label or creator_user_id appears anywhere in the map', () => {
  const json = JSON.stringify(readKeyLimits({
    data: [keyRow({}), keyRow({ name: 'batch-key', limit: 12, limit_remaining: 4 })],
  }))

  assert.equal(json.includes('hash'), false)
  assert.equal(json.includes('label'), false)
  assert.equal(json.includes('creator_user_id'), false)
  // the rest of the record — timestamps and usage counters — stays behind too
  assert.equal(json.includes('created_at'), false)
  assert.equal(json.includes('last_used_at'), false)
  assert.equal(json.includes('usage'), false)
})

test('readKeyLimits: a missing or non-finite limit_remaining falls back to the limit', () => {
  const limits = readKeyLimits({
    data: [
      keyRow({ name: 'build-bot', limit: 25, limit_remaining: undefined }),
      keyRow({ name: 'batch-key', limit: 25, limit_remaining: null }),
      keyRow({ name: 'nightly', limit: 25, limit_remaining: 'lots' }),
      keyRow({ name: 'steady', limit: 25, limit_remaining: 12.5 }),
    ],
  })

  assert.equal(limits['build-bot'].limitRemaining, 25)
  assert.equal(limits['batch-key'].limitRemaining, 25)
  assert.equal(limits['nightly'].limitRemaining, 25)
  // a usable remainder is the row's own figure, not the limit
  assert.equal(limits['steady'].limitRemaining, 12.5)
})

test('readKeyLimits: a body whose data is not an array throws instead of reading as no limits', () => {
  assert.throws(() => readKeyLimits({ data: {} }), /no data array/)
  assert.throws(() => readKeyLimits({ data: 'rows' }), /no data array/)
  assert.throws(() => readKeyLimits({}), /no data array/)
  assert.throws(() => readKeyLimits(undefined), /no data array/)
})

test('readKeyLimits: a zero, negative or non-finite limit is skipped', () => {
  const limits = readKeyLimits({
    data: [
      keyRow({ name: 'build-bot', limit: 0 }),
      keyRow({ name: 'batch-key', limit: -12 }),
      keyRow({ name: 'nightly', limit: Infinity }),
      keyRow({ name: 'no-figure', limit: 'lots' }),
      keyRow({ name: 'capped', limit: 12 }),
    ],
  })

  assert.deepEqual(Object.keys(limits), ['capped'])
  assert.equal(limits['capped'].limit, 12)
})

test('readKeyLimits: limit_reset passes through only as a string and disabled only as a boolean', () => {
  const limits = readKeyLimits({
    data: [
      keyRow({ name: 'build-bot', limit_reset: 'weekly', disabled: true }),
      keyRow({ name: 'batch-key', limit_reset: null, disabled: false }),
      keyRow({ name: 'nightly', limit_reset: 7, disabled: undefined }),
    ],
  })

  assert.equal(limits['build-bot'].limitReset, 'weekly')
  assert.equal(limits['build-bot'].disabled, true)
  // nothing invented: a non-string reset and a non-boolean flag read as unset
  assert.equal(limits['batch-key'].limitReset, null)
  assert.equal(limits['nightly'].limitReset, null)
  assert.equal(limits['nightly'].disabled, false)
})

test('groupHourlyBurn: rows group per key with buckets ascending by ts', () => {
  const burn = groupHourlyBurn([
    burnRow('build-bot', '2026-10-02T03:00:00Z', 3),
    burnRow('build-bot', '2026-10-01T05:00:00Z', 1),
    burnRow('build-bot', '2026-10-01T04:00:00Z', 2),
    burnRow('batch-key', '2026-10-01T05:00:00Z', 4),
  ])

  assert.deepEqual(burn['build-bot'], [
    { ts: '2026-10-01T04:00:00Z', usd: 2 },
    { ts: '2026-10-01T05:00:00Z', usd: 1 },
    { ts: '2026-10-02T03:00:00Z', usd: 3 },
  ])
  assert.deepEqual(burn['batch-key'], [{ ts: '2026-10-01T05:00:00Z', usd: 4 }])
  // only keys that actually burnt are present; absent hours are not zero-filled
  assert.deepEqual(Object.keys(burn), ['build-bot', 'batch-key'])
})

test('groupHourlyBurn: rows sharing an hour sum into one bucket and the totals are unaltered', () => {
  const burn = groupHourlyBurn([
    burnRow('build-bot', '2026-10-01T04:00:00Z', 0.25),
    burnRow('build-bot', '2026-10-01T04:00:00Z', 0.5),
    burnRow('build-bot', '2026-10-01T05:00:00Z', '1.25'),
    burnRow('batch-key', '2026-10-01T04:00:00Z', 2),
  ])

  assert.deepEqual(burn['build-bot'], [
    { ts: '2026-10-01T04:00:00Z', usd: 0.75 },
    { ts: '2026-10-01T05:00:00Z', usd: 1.25 },
  ])
  const total = [...Object.values(burn)].flat().reduce((sum, point) => sum + point.usd, 0)
  assert.equal(total, 4)
})

test('groupHourlyBurn: rows without a key, an hour or a cost are skipped', () => {
  const burn = groupHourlyBurn([
    burnRow('build-bot', '2026-10-01T04:00:00Z', 2),
    { date__hour: '2026-10-01T05:00:00Z', total_usage: 5 }, // no key id
    { api_key_id: null, date__hour: '2026-10-01T05:00:00Z', total_usage: 5 },
    { api_key_id: 'build-bot', total_usage: 5 }, // no hour
    burnRow('build-bot', '2026-10-01T06:00:00Z', 'lots'), // not a number
    burnRow('batch-key', '2026-10-01T07:00:00Z', undefined), // absent figure
    'not-a-row',
    null,
    42,
  ])

  assert.deepEqual(burn, {
    'build-bot': [{ ts: '2026-10-01T04:00:00Z', usd: 2 }],
  })
})

test('groupHourlyBurn: no usable rows give an empty map rather than a throw', () => {
  assert.deepEqual(groupHourlyBurn([]), {})
  assert.deepEqual(groupHourlyBurn(undefined), {})
})
