# Implementation plan: limit warning

Work plan for the feature specified in [ADR-0001](../adr/0001-warn-early-on-cap-consumption.md),
[ADR-0002](../adr/0002-read-per-key-limits-from-the-management-keys-endpoint.md),
[ADR-0004](../adr/0004-gate-the-limit-warning-behind-a-default-off-setting.md) and
[the design doc](limit-notice.md). That set is the specification; this document only says who
builds what, in which order, and how each piece is verified.

Written to be handed out task by task. Each task names the files it owns.

---

## 1. Verified API facts

Measured against a live account on 2026-10-07. Treat as evidence with a date, not as contract.

| Fact | Value |
|---|---|
| `analytics/query` `api_key_id` dimension | Carries the key **name**, a short human label — not the 64-char `hash`. Verified: every analytics name was present in `/keys`, none orphaned |
| Join key | `api_key_id` ↔ `/keys[].name`, exact string |
| `limit_remaining` | Equals `limit − usage_<period>`, where `<period>` is `limit_reset` (`null` → lifetime `usage`). Verified on every limited key |
| `/keys` per-key fields | `hash`, `name`, `label`, `disabled`, `limit`, `limit_remaining`, `limit_reset`, `usage`, `usage_daily`, `usage_weekly`, `usage_monthly`, `created_at`, `updated_at`, `last_used_at` |
| `limit_reset` values seen | `null`, `"daily"`, `"weekly"` |
| Reset boundary | **UTC midnight** (03:00 MSK). Derived: `usage_daily` matched the analytics sum over the UTC calendar day to ~1e-5, while a rolling window would not. No timezone field is exposed |
| Hourly granularity | Supported: `granularity: "hour"`, `date__hour` as `"2026-10-07 19:00:00"` |
| Row budget for hourly | 7 days, `dims: ["api_key_id"]`, all keys → **203 rows**. A 500-row ceiling is comfortable |
| **`filter` parameter** | **Silently ignored.** A filtered query returned byte-identical totals to an unfiltered one. Do not rely on server-side filtering; narrow in the host |
| Non-management key | `/keys` answers 403. Must degrade to `limitsError`, never break the summary |

## 2. Non-goals

* No automatic mitigation: no switching keys, no raising limits, no disabling.
* No per-model limits — OpenRouter's caps are per key.
* No `monthly` time-based trigger (ADR-0001: unmeasured, deliberately no code path).
* No history of limit changes; only the latest poll's value.
* No host-side toggle: the setting is browser-local (ADR-0004).

## 3. Interface contract

Freeze this before parallel work starts; both halves depend on it and neither should guess.

```
summary payload additions
{
  limits: {
    [keyName: string]: {
      limit: number,           // > 0
      limitRemaining: number,
      limitReset: 'daily' | 'weekly' | 'monthly' | null,
      disabled: boolean
    }
  },
  limitsError?: string,        // present only when /keys failed
  burnHourly: {                // 7 trailing days, hour buckets, per key
    [keyName: string]: { ts: string, usd: number }[]
  }
}
```

Rules:

* `limits` carries **only keys with `limit != null`**, and only these four fields. No `hash`,
  no `label`, no `creator_user_id`, no `usage*` breakdowns in the payload.
* `limitsError` is a string reason; its presence with an empty `limits` means "could not read",
  not "no limits exist". The client must distinguish those two.
* `burnHourly` is keyed by name like `limits`, valued by that key's hour buckets, ascending by
  `ts`, zero-filled is *not* required — absent hours read as zero.
* Everything is additive: existing consumers of `todaySpend`, `byKey`, `byDay`, `credits`,
  `bySession` are unchanged.

> **Resolved — ADR-0002, Amendment 2026-10-07.** The record originally required the host to
> "narrow to the tracked key", which is unimplementable: `ors.keyId` is a browser-local
> preference while the payload is a single host-side cache shared by every tab. The requirement
> is replaced in that record by the **shape** constraint stated above — the four limit fields
> per key, nothing else. The decision itself is unchanged, so implement the contract above as
> written and do not narrow by key.

---

## 4. Tasks

Three tasks. **A** and **B** touch different files and can run in parallel once §3 is frozen.
**C** depends on both.

### Task A — host half: read and expose limits

**Owns:** `index.js`, `cordis.patch.yml`, `package.json`

1. `Config` (schemastery): add
   * `warnConsumedFraction` — number, step 0.01, min 0.05, max 0.95, default `0.4`
   * `criticalConsumedFraction` — number, step 0.01, min 0.1, max 1, default `0.8`
   * `burnWindowDays` — number, step 1, min 1, max 30, default `7`
   Mirror in `cordis.patch.yml`.
2. New `queryKeys(config, credential, signal)` → `GET {apiBase}/keys`, same shape discipline as
   `queryCredits` (`index.js`, the `/credits` reader): non-OK throws with the status, 403 included.
3. New `readKeyLimits(keysBody)` → narrow to the `limits` map of §3. Skip entries with
   `limit == null`. Do **not** pass through other fields.
4. New `queryHourlyBurn(config, credential, signal, now)` → `POST /analytics/query` with
   `metrics: ['total_usage']`, `dimensions: ['api_key_id']`, `granularity: 'hour'`,
   window = `burnWindowDays`, `limit: MAX_ANALYTICS_ROWS`. Group rows by `api_key_id` into
   ascending buckets. Reuse the existing row-count guard style from `queryAnalytics`.
5. Wire into `collect` with the same isolation the session split already uses
   (the `.catch` that yields `sessionsError`): each of the two new reads is a `.catch` that yields
   `{ limitsError: reason }` / `{ burnError: reason }` rather than failing the summary.
6. Add `limits` and `burnHourly` to `emptyPayload` as `{}` so the client never
   sees `undefined`.
7. Confirm the cached-summary path is untouched: one poll still serves all tabs
   (the `current()` cache with `inFlight` de-duplication).

**Verify:** start the plugin, hit `/openrouter-spend/summary`, check that `limits` holds only
limited keys with exactly four fields; that a wrong credential yields `limitsError` with the
rest of the payload intact; and that the real spend figures are byte-identical to before the
change (diff the payload with the feature reads stubbed out).

### Task B — browser half: state, block, toggle

**Owns:** `client.js` (all of it — one file, one writer)

1. **Preference.** `PREF_LIMIT_NOTICE = 'ors.limitNotice'`, default `'0'`. Read through
   `readPref`, written through `writePref` so the existing `PREFS_CHANGED` broadcast works.
   Add a `<select>` or checkbox to `Settings` beside the existing fields, mirroring the
   `refreshEvery` field's pattern.
2. **`limitState(input)`** — a pure function, no React, near the other helpers
   (`fmtInt`, `keyTint`, `readPref`):

   ```
   input: { limit, limitRemaining, limitReset, burnHourly, todayUsed, nowMs }
   → { level: 'none'|'warn'|'critical', percent?, remainingUsd?, runwayText?, resetText? }
   ```

   * `limitReset === null` → runway in days = `limitRemaining ÷ median(daily spend, closed days)`.
     warn ≤ 3, critical ≤ 1. Fewer than 3 closed days → `none`.
   * `limitReset` set → `consumed = used_<period> ÷ limit`. warn ≥ `warnConsumedFraction`,
     critical ≥ `criticalConsumedFraction`.
   * **Reset veto:** if the reset lands before the projected exhaustion, demote `critical` → `warn`.
   * **Hysteresis** (design doc): leave `warn` at 38%, leave `critical` at 78%; lifetime: leave
     warn at 4 days, leave critical at 1.5 days. Needs the previous level as input — thread it
     from a ref so the function stays pure.
   * `runwayText` = `limitRemaining ÷ max(burnHourly)` over the 7-day window, rendered as a
     rounded duration. Zero burn → omit the text, do not divide.
   * `resetText` = the UTC-midnight boundary rendered in the browser's local zone (`03:00` for
     MSK). Never the literal "midnight".
3. **Gating.** When the preference is off, `limitState` is never called and the block is never
   rendered; the dot renders exactly as today. Keep the gate in one place so there is a single
   thing to flip.
4. **Dot states.** Extend the chip-dot CSS rules with `limit-warn` / `limit-critical` and
   the finite pulse (design doc). Add `animation-fill-mode: forwards` and an explicit
   `animation: none` for the resting state — a re-render every `refreshSeconds` otherwise
   restarts the animation, and the pulse would repeat forever.
5. **Popover block.** Between the balance line and the range switcher. Label + tinted key
   name (the existing `keyTint`), percent consumed,
   5px meter showing **consumed**, and the branch sentence per the design doc. Match the
   existing visual language: no new colors beyond the two states.
6. **Unmatched case.** When `limitsError` is set, or the selected key has no entry in `limits`
   while its spend is non-zero, render the greyed block with `limitUnknownMatch` / `limitUnavailable`
   — not nothing (design doc, "When the key cannot be matched").
7. **Locale.** Add every key from the design doc's table to all three blocks (`en` `zh` `ru`) in
   `ctx.locale.register` (the `en` / `zh` / `ru` blocks). `locale/*.json` holds only listing metadata and
   is **not** touched.
8. Keep `findSession` untouched — the subagent-descendant gap is ADR-0003's
   subject, a separate change.

**Verify:** run `node --check client.js`; load the app, enable the toggle, and confirm the three
levels by temporarily overriding the payload via a local fixture (no test harness exists, so
this is a manual check); confirm the dot is byte-identical to today with the toggle off;
confirm the pulse runs at most 3 iterations and then rests.

### Task C — the toast (optional, ship after A and B)

**Owns:** `client.js` toast entry, `package.json` `dsh.client.inject`

1. Add `@deepseek-ai/dsh-client-ui-layout` to `dsh.client.inject`. It ships inside the harness
   web bundle (`packages/client/ui-layout`, and `packages/bundle/web-app` depends on it) — no
   npm dependency is added, and no install step is needed.
2. Register a fresh id in `shell.overlay`. **Not** `shell.quota-notice` — that chain routes
   Chat's own quota-failure codes and offers no plugin push.
3. Fire only on an unseen escalation (`none→warn`, `none→critical`, `warn→critical`), never on
   de-escalation or on every poll. Copy per the design doc; clicking opens the popover.
4. One live notice at most; a newer escalation replaces it.

**Verify:** with the toggle off, the entry is inert; with it on, the toast appears once per
escalation while polling continues every `refreshSeconds`.

---

## 5. What cannot be verified here, and how that is handled

* **A test harness now exists** — added by parallel work on ADR-0003: `npm test` runs
  `node --test tests/*.test.mjs`, currently 10 passing cases over the pure host-side rollup.
  `limitState` is a pure function by design (§4 Task B), so the ADR-0001 Confirmation cases
  **should be written as real tests** in `tests/`, not left as manual checks. Treat the harness
  as the contract: pure logic gets a test, only rendering gets a manual look.
* **`client.js` is a plain script body, not an ES module.** The harness compiles it with
  `new Function(...)` and **fails outright if it contains `import` or `export`**
  (`packages/experimental/webworker-runtime/src/module-system/module-loader.ts`, `compile`).
  So client-side pure logic cannot be exported for tests the way `index.js` exports
  `mergeSessions`. The sanctioned workaround, taken from the harness's own tests
  (`packages/client/ui-sidebar-documentpreview/tests/document-preview-license-bundle.client.spec.ts`):
  return the pure functions from the factory next to `inject` / `apply`, and drive
  `registration.factory(resolve)` from a test through `node:vm`'s `runInNewContext` with a
  stubbed `window.__ModuleLoader__`. Task B and Task C both follow this.
* **Concurrent edits to `index.js` have landed.** The ADR-0003 work was committed while this
  plan was being written; `index.js` now exports `mergeSessions`, `delegationEdges`,
  `rollupSessions`, `rollupWithLineage`, and takes `sessionQuery` in its `inject`. That work is
  done and must not be touched or reverted. **No line numbers are cited in this plan on
  purpose**; locate everything by symbol name.
* **The 40% default rests on one exhausting day.** ADR-0001 records this as the weakest point.
  Do not treat the number as settled while implementing.
* **Monthly caps are unmeasured.** No code path is written for them (ADR-0001).
* **`filter` is unusable.** Any narrowing happens in the host, over the full row set.
* **Live API calls are not testable here.** `queryKeys` and `queryHourlyBurn` need a real
  management key. Keep them thin, and keep the parsing (`readKeyLimits`, the hourly grouping)
  in separate pure functions, so what can be tested is separated from what cannot.

## 6. Sequencing

```
freeze §3 contract
      │
      ├─ Task A (index.js)  ─┐
      │                      ├─→ Task C (toast)
      └─ Task B (client.js) ─┘
```

A and B in parallel, both after §3. C only after both, and only if the toast is wanted at all —
Tiers 1 and 2 of the design (dot + popover block) are the feature; the toast is addition.

## 7. Definition of done

* Toggle off (the default on a fresh install): the chip, dot, and popover are byte-identical to
  the current release.
* Toggle on: the block appears for a limited key, the dot takes `limit-warn` / `limit-critical`
  at the documented thresholds, and the pulse is finite.
* A failed `/keys` degrades to `limitsError` with spend figures intact; a 403 from a
  non-management key is indistinguishable from that case by design.
* No real key names, account figures, or UUIDs in committed docs or fixtures — ADR-0000's rule.
* `CHANGELOG.md` carries the change under a new version; `package.json` version bumped.
