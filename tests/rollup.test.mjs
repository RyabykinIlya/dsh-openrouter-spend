/**
 * Unit tests for the session-lineage rollup in the host half.
 *
 * `mergeSessions`, `delegationEdges`, `rollupSessions` and `rollupWithLineage`
 * are the pieces of the figure the browser shows that run without a live
 * harness, so they are the only ones pinned here. `delegationEdges` is the pure
 * filter over session headers that decides which links count as delegation, and
 * the lineage index past it is built by hand rather than read from disk, and
 * `rollupWithLineage` takes its reader as a callback, so a failed read is
 * reachable too.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { delegationEdges, mergeSessions, rollupSessions, rollupWithLineage } from '../index.js'

/** One window/today row as OpenRouter reports it, before the merge. */
const source = (id, usd, requests) => ({ id, usd, requests })

/** One merged row, the shape `rollupSessions` reads and returns. */
const row = (id, usd, requests, todayUsd, todayRequests) => ({ id, usd, requests, todayUsd, todayRequests })

/** The lineage index `queryLineage` hands to the rollup: parent id → child ids. */
const lineage = pairs => ({
  childrenByParent: new Map(pairs.map(([parent, children]) => [parent, children])),
})

/** Folding sums money, so 0.2 + 0.5 lands a bit off; compare to a micro-dollar. */
const money = rows => rows.map(({ id, usd, requests, todayUsd, todayRequests }) => ({
  id,
  usd: Math.round(usd * 1e6) / 1e6,
  requests,
  todayUsd: Math.round(todayUsd * 1e6) / 1e6,
  todayRequests,
}))

const ids = rows => rows.map(entry => entry.id)

/** One session record as `ctx.sessionQuery.listSessions` returns it. */
const record = header => ({ header })

/** A delegated child's header: `origin: 'subagent'` is what marks delegation. */
const subagent = (id, parentSession) => ({ id, parentSession, origin: 'subagent' })

/** A forked child's header: a parent link and the seed flag, and no `origin`. */
const fork = (id, parentSession) => ({ id, parentSession, isSeeded: true })

test('rollupSessions: a child folds into its parent and keeps its own row', () => {
  const rolled = rollupSessions(
    [row('parent', 1, 10, 0.2, 2), row('child', 3, 30, 0.5, 5)],
    lineage([['parent', ['child']]]),
  )

  assert.deepEqual(money(rolled), [
    row('parent', 4, 40, 0.7, 7),
    row('child', 3, 30, 0.5, 5),
  ])
})

test('rollupSessions: a grandchild folds into both its parent and its grandparent', () => {
  const rolled = rollupSessions(
    [
      row('grandparent', 1, 10, 0.1, 1),
      row('parent', 2, 20, 0.2, 2),
      row('child', 4, 40, 0.4, 4),
    ],
    lineage([['grandparent', ['parent']], ['parent', ['child']]]),
  )

  // the recursion: 4 reaches the grandparent through the parent, so it counts twice over
  assert.deepEqual(money(rolled), [
    row('grandparent', 7, 70, 0.7, 7),
    row('parent', 6, 60, 0.6, 6),
    row('child', 4, 40, 0.4, 4),
  ])
})

test('rollupSessions: a child whose parent is absent from the lineage stands alone', () => {
  const rolled = rollupSessions(
    [
      row('orphan', 3, 30, 0.4, 4),
      row('other-parent', 1, 10, 0.1, 1),
      row('other-child', 2, 20, 0.2, 2),
    ],
    // `orphan`'s parent is not a key here, so nothing links it anywhere
    lineage([['other-parent', ['other-child']]]),
  )

  assert.deepEqual(ids(rolled), ['orphan', 'other-parent', 'other-child'])
  assert.equal(rolled.find(entry => entry.id === 'orphan').usd, 3)
  assert.equal(rolled.find(entry => entry.id === 'other-parent').usd, 3)
  assert.equal(rolled.find(entry => entry.id === 'other-child').usd, 2)
})

test('rollupSessions: a session with descendants but no row of its own carries the subtree total', () => {
  // a relay parent: it delegated, so no traffic ever landed under its own id
  const rolled = rollupSessions([row('child', 4, 40, 1, 10)], lineage([['relay-parent', ['child']]]))

  assert.deepEqual(money(rolled), [
    row('child', 4, 40, 1, 10),
    row('relay-parent', 4, 40, 1, 10),
  ])
})

test('rollupSessions: a cycle in childrenByParent terminates without double-counting', {
  timeout: 2000,
}, () => {
  // a corrupt header pair: neither is an ancestor, each names the other
  const rolled = rollupSessions(
    [row('a', 1, 10, 0, 0), row('b', 3, 30, 0, 0)],
    lineage([['a', ['b']], ['b', ['a']]]),
  )

  // each walk stops where it started, so neither figure inflates past the pair
  assert.deepEqual(money(rolled), [
    row('a', 4, 40, 0, 0),
    row('b', 4, 40, 0, 0),
  ])
})

test('rollupSessions: a session listed as its own parent terminates', { timeout: 2000 }, () => {
  const rolled = rollupSessions([row('self', 2, 20, 0.2, 2)], lineage([['self', ['self']]]))

  assert.deepEqual(money(rolled), [row('self', 2, 20, 0.2, 2)])
})

test('rollupSessions: rows untouched by the lineage pass through unchanged', () => {
  const rolled = rollupSessions(
    [row('lone-a', 1.5, 15, 0.15, 3), row('lone-b', 2.5, 25, 0.25, 5)],
    lineage([]),
  )

  assert.deepEqual(money(rolled), [
    row('lone-b', 2.5, 25, 0.25, 5),
    row('lone-a', 1.5, 15, 0.15, 3),
  ])
})

test('rollupSessions: output is ordered by today spend, then by window spend', () => {
  const rolled = rollupSessions(
    [row('a', 9, 90, 1, 10), row('b', 1, 10, 5, 50), row('c', 3, 30, 5, 50)],
    lineage([]),
  )

  // c beats b on the window tie-break, a drops to the bottom on today
  assert.deepEqual(ids(rolled), ['c', 'b', 'a'])
})

test('mergeSessions: today-only rows appear and a shared row takes today figures', () => {
  const windowRows = [source('w1', 5, 50), source('w2', 2, 20)]
  const todayRows = [source('w1', 1, 10), source('t3', 3, 30)]

  assert.deepEqual(mergeSessions(windowRows, todayRows), [
    row('t3', 3, 30, 3, 30),
    row('w1', 5, 50, 1, 10),
    row('w2', 2, 20, 0, 0),
  ])
  // the caller's rows are left alone
  assert.deepEqual(windowRows, [source('w1', 5, 50), source('w2', 2, 20)])
})

test('rollupSessions: ids match exactly, so a prefixed id never absorbs a bare one', () => {
  const rolled = rollupSessions(
    [
      row('session-4d1e9a11', 2, 20, 0.2, 2),
      row('4d1e9a11', 7, 70, 0.7, 7),
      row('child-x', 3, 30, 0.3, 3),
    ],
    lineage([['parent-y', ['child-x']]]),
  )

  // the linked pair folds, the prefix-differing pair does not: nothing normalises an id
  assert.deepEqual(ids(rolled), ['4d1e9a11', 'child-x', 'parent-y', 'session-4d1e9a11'])
  assert.deepEqual(money(rolled), [
    row('4d1e9a11', 7, 70, 0.7, 7),
    row('child-x', 3, 30, 0.3, 3),
    row('parent-y', 3, 30, 0.3, 3),
    row('session-4d1e9a11', 2, 20, 0.2, 2),
  ])
})

test('rollupWithLineage: a good read rolls the split up and reports no lineage error', async () => {
  const merged = [row('parent', 1, 10, 0.2, 2), row('child', 3, 30, 0.5, 5)]
  const errors = []
  const result = await rollupWithLineage(
    merged,
    async () => new Map([['parent', ['child']]]),
    error => errors.push(error),
  )

  assert.deepEqual(Object.keys(result), ['bySession'])
  assert.equal(result.lineageError, undefined)
  assert.deepEqual(money(result.bySession), [
    row('parent', 4, 40, 0.7, 7),
    row('child', 3, 30, 0.5, 5),
  ])
  assert.deepEqual(errors, [])
})

test('rollupWithLineage: a rejected read keeps the own-session figures and reports why', async () => {
  const merged = [row('parent', 1, 10, 0.2, 2), row('child', 3, 30, 0.5, 5)]
  const before = structuredClone(merged)
  const failure = new Error('session listing answered 503')
  const errors = []
  const result = await rollupWithLineage(
    merged,
    async () => { throw failure },
    error => errors.push(error),
  )

  // no fold happened: the figures are the session's own, untouched
  assert.deepEqual(result.bySession, before)
  assert.equal(result.lineageError, 'session listing answered 503')
  // the host log gets the very error, not a copy of its message
  assert.equal(errors.length, 1)
  assert.equal(errors[0], failure)
})

test('rollupWithLineage: a read that throws a non-Error still reports a readable reason', async () => {
  const merged = [row('lone', 2, 20, 0.2, 2)]
  const errors = []
  const result = await rollupWithLineage(
    merged,
    () => { throw 'harness offline' },
    error => errors.push(error),
  )

  assert.deepEqual(result.bySession, merged)
  assert.equal(result.lineageError, 'harness offline')
  assert.equal(errors[0], 'harness offline')
})

test('rollupWithLineage: the failure path leaves the merged rows unmutated', async () => {
  const merged = [row('parent', 1, 10, 0.2, 2), row('child', 3, 30, 0.5, 5)]
  const before = structuredClone(merged)
  await rollupWithLineage(
    merged,
    async () => { throw new Error('lineage read failed') },
    () => undefined,
  )

  assert.deepEqual(merged, before)
  // the parent never absorbed the child on the way out
  assert.equal(merged.find(entry => entry.id === 'parent').usd, 1)
  assert.equal(merged.find(entry => entry.id === 'child').usd, 3)
})

test('delegationEdges: a subagent header yields an edge from its parent', () => {
  const edges = delegationEdges([record(subagent('child', 'parent'))])

  assert.deepEqual(edges, new Map([['parent', ['child']]]))
})

test('delegationEdges: a fork-shaped header yields no edge', () => {
  // the decision this pins: a fork records a parent but is not delegation, so
  // folding its spend into the parent would double-count work the user did once
  const edges = delegationEdges([record(fork('branch', 'parent'))])

  assert.equal(edges.has('parent'), false)
  assert.equal(edges.size, 0)
})

test('delegationEdges: only the subagent under a shared parent is linked', () => {
  const edges = delegationEdges([
    record(subagent('delegated', 'parent')),
    record(fork('forked', 'parent')),
  ])

  assert.deepEqual(edges, new Map([['parent', ['delegated']]]))
})

test('delegationEdges: several children of one parent keep the input order', () => {
  const edges = delegationEdges([
    record(subagent('third', 'parent')),
    record(subagent('first', 'parent')),
    record(subagent('second', 'parent')),
  ])

  assert.deepEqual(edges.get('parent'), ['third', 'first', 'second'])
})

test('delegationEdges: malformed records are skipped without throwing', () => {
  const edges = delegationEdges([
    record(subagent('kept', 'parent')),
    {}, // no header at all
    { header: null },
    { header: 'not-an-object' },
    record(subagent('', 'parent')), // blank id
    record({ parentSession: 'parent', origin: 'subagent' }), // absent id
    record({ id: 42, parentSession: 'parent', origin: 'subagent' }), // non-string id
    record(subagent('blank-parent', '')), // blank parentSession
    record({ id: 'no-parent', origin: 'subagent' }), // absent parentSession
    'not-a-record',
    null,
    42,
  ])

  assert.deepEqual(edges, new Map([['parent', ['kept']]]))
})

test('delegationEdges: a delegated grandchild yields a second, nested edge', () => {
  const edges = delegationEdges([
    record(subagent('child', 'root')),
    record(subagent('grandchild', 'child')),
  ])

  // two edges, so the rollup has a chain to walk rather than a single hop
  assert.deepEqual(edges, new Map([['root', ['child']], ['child', ['grandchild']]]))
})

test('delegationEdges: no records and no argument both give an empty map', () => {
  assert.deepEqual(delegationEdges([]), new Map())
  assert.deepEqual(delegationEdges(undefined), new Map())
})

test('delegationEdges into rollupSessions: a fork stays on its own row, a subagent folds', () => {
  // the fixture corpus, end to end: the filter decides what the rollup can fold
  const corpus = [
    record(subagent('subagent', 'chat')),
    record(fork('forked', 'chat')),
    record(subagent('grandchild', 'subagent')),
  ]
  const merged = [
    row('chat', 1, 10, 0.1, 1),
    row('subagent', 0.5, 5, 0.05, 1),
    row('forked', 2, 20, 0.2, 2),
    row('grandchild', 0.25, 3, 0.02, 1),
  ]

  const bySession = rollupSessions(merged, { childrenByParent: delegationEdges(corpus) })

  // chat carries its own spend plus the whole delegated subtree: 1 + 0.5 + 0.25
  assert.deepEqual(money(bySession), [
    row('forked', 2, 20, 0.2, 2),
    row('chat', 1.75, 18, 0.17, 3),
    row('subagent', 0.75, 8, 0.07, 2),
    row('grandchild', 0.25, 3, 0.02, 1),
  ])
  // the fork's spend never reached the parent: 1.75, not 3.75
  assert.equal(bySession.find(entry => entry.id === 'chat').usd, 1.75)
})
