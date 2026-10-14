/**
 * Repository guards: systematic tripwires for the bug classes the 0.4.1
 * review-and-fix cycle found. Each test is named for the class it prevents,
 * so a failure says what kind of mistake was just made. These are cheap and
 * static on purpose — they run in `npm test` and in the pre-push hook.
 *
 * Bug classes covered (findings IDs from docs/review/0.4.1-review-findings.md):
 *   M1   consumer reads a field the producer never returns (silent wrong fallback)
 *   m8   host and client disagree on the failure-code vocabulary
 *   M7   install-time lifecycle scripts leak to registry consumers
 *   M8   documentation links to files that are missing or untracked
 *   M9   READMEs pin stale release refs while describing newer features
 *   m26  assets ship only via npm's implicit include, not the `files` list
 *   m24  CHANGELOG lacks an entry for the current package version
 *   N5   profile patch configures knobs the schema does not define
 *   i18n locale metadata files drift apart across languages
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { describeFailure } from '../index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const clientSource = read('client.js');
const indexSource = read('index.js');
const pkg = JSON.parse(read('package.json'));

// ---------------------------------------------------------------- seams
// client.js is a plain script body registered through window.__ModuleLoader__;
// the factory exposes the pure helpers and `apply` registers the dictionaries
// with the locale service. Capturing `locale.register` is the sanctioned way
// to read the shipped dictionaries (the same seam the feature tests use).
function loadClient() {
  let captured;
  runInNewContext(clientSource, {
    window: { __ModuleLoader__: { load: registration => { captured = registration; } } },
  });
  return captured.factory(specifier => {
    if (specifier === 'react') {
      return {
        createElement: () => null,
        useCallback: fn => fn,
        useEffect: () => undefined,
        useMemo: fn => fn(),
        useRef: initial => ({ current: initial }),
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => undefined],
      };
    }
    throw new Error(`Unexpected browser dependency: ${specifier}`);
  });
}

function shippedDictionaries(api) {
  const registered = [];
  api.apply({
    effect: fn => { fn(); return () => {}; },
    locale: { register: (ns, dict) => { registered.push(dict); return () => {}; }, bind: () => key => key },
    slots: { inject: () => {}, register: () => () => {} },
  });
  const dicts = registered.find(entry => entry && entry.en) ?? {};
  return dicts; // { en: {...}, zh: {...}, ru: {...} }
}

const api = loadClient();
const dicts = shippedDictionaries(api);
const { limitState, failureLabelKey } = api;

// ------------------------------------------------- M1 / m8: half contracts
test('M1: every `state.X` the client reads is produced by some limitState branch', () => {
  // The M1 bug was the Toast reading `state.limitReset` that limitState never
  // returned, so a daily-cap toast silently fell through to "lifetime". The
  // branches return different shapes (early-out, lifetime, periodic), so the
  // contract is the UNION: a read must exist on at least one branch, and the
  // next test pins each branch's exact shape so a field cannot vanish quietly.
  const shapes = [
    limitState({ limit: 0 }), // invalid cap: the early-out shape
    limitState({ limit: 100, limitRemaining: 80, limitReset: null, burn: [], nowMs: Date.UTC(2026, 9, 9, 12) }),
    limitState({
      limit: 100, limitRemaining: 80, limitReset: null,
      burn: [4, 3, 2, 1, 0].map(d => ({ ts: `2026-10-0${9 - d}T12:00:00Z`, usd: 2 })),
      nowMs: Date.UTC(2026, 9, 9, 12),
    }),
    limitState({ limit: 12, limitRemaining: 1.8, limitReset: 'daily', burn: [], nowMs: Date.UTC(2026, 9, 9, 12), thresholds: { warn: 0.4, critical: 0.8 } }),
  ];
  const union = new Set(shapes.flatMap(shape => Object.keys(shape)));
  const reads = [...clientSource.matchAll(/\bstate\??\.(\w+)/g)].map(match => match[1]);
  const missing = [...new Set(reads)].filter(key => !union.has(key)).sort();
  assert.deepEqual(missing, [],
    'a consumer reads state.<field> that no limitState branch returns — '
    + 'this is the M1 bug class (silent undefined falls into a wrong default)');
});

test('M1: each limitState branch returns exactly its documented shape', () => {
  // The raise (ADR-0008) adds three fields to the shared shape:
  // `limitUsdRounded`/`percentRounded` — the whole-dollar and whole-percent
  // faces the raise button and the meter print — and `raiseToUsd`, the
  // offered new cap. They are shared (not branch-specific) because every
  // branch that shows a cap can be raised, whatever its reset schedule.
  const shared = [
    'level', 'limitReset', 'limitUsd', 'limitUsdRounded', 'remainingUsd', 'percent',
    'percentRounded', 'lifetime', 'resetAtMs', 'untilResetMs', 'resetText', 'runwayMs',
    'runwayText', 'requests', 'raiseToUsd',
  ];
  assert.deepEqual(Object.keys(limitState({ limit: 0 })).sort(), ['level'],
    'the early-out shape carries only the level');
  assert.deepEqual(
    Object.keys(limitState({ limit: 100, limitRemaining: 80, limitReset: null, burn: [], nowMs: Date.UTC(2026, 9, 9, 12) })).sort(),
    [...shared].sort(),
    'a lifetime cap without enough closed days is the shared shape, no runwayDays');
  assert.deepEqual(
    Object.keys(limitState({
      limit: 100, limitRemaining: 80, limitReset: null,
      burn: [4, 3, 2, 1, 0].map(d => ({ ts: `2026-10-0${9 - d}T12:00:00Z`, usd: 2 })),
      nowMs: Date.UTC(2026, 9, 9, 12),
    })).sort(),
    [...shared, 'perDayUsd', 'runwayDays'].sort(),
    'the lifetime branch adds perDayUsd and runwayDays');
  assert.deepEqual(
    Object.keys(limitState({ limit: 12, limitRemaining: 1.8, limitReset: 'daily', burn: [], nowMs: Date.UTC(2026, 9, 9, 12), thresholds: { warn: 0.4, critical: 0.8 } })).sort(),
    // `periodBurnUsd` is the periodic branch's own pace figure: what the
    // period burned so far, which `suggestedRaise` sizes the offer from.
    [...shared, 'consumed', 'imminent', 'periodBurnUsd'].sort(),
    'the periodic branch adds consumed, imminent and the period burn');
});

test('m8: every failure code either half can emit has a sentence in all three languages', () => {
  // The host classifies failures (describeFailure) and the client names them
  // (failureLabelKey); the halves drifted once — the client had no `request`
  // case, so a classified 4xx rendered "the reason is unknown". Drive the
  // classifier across its branches and require a non-empty, translated label.
  const classified = [
    Object.assign(new Error('socket'), { name: 'TimeoutError' }),
    Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
    new Error('keys answered 401: nope'),
    new Error('keys answered 429: slow down'),
    new Error('keys answered 503: boom'),
    new Error('keys answered 400: bad'),
    new Error('analytics/query returned no data rows'),
    new Error('something else entirely'),
  ].map(error => describeFailure(error).code);
  classified.push('host'); // the client's own 502 classification
  for (const code of new Set(classified)) {
    const key = failureLabelKey(code);
    assert.notEqual(key, undefined, `${code} must map to a label key`);
    for (const lang of ['en', 'zh', 'ru']) {
      const sentence = dicts[lang]?.[key];
      assert.ok(typeof sentence === 'string' && sentence.length > 0,
        `${code} -> ${key} must exist and be non-empty in ${lang}`);
    }
  }
  // 'unknown' deliberately maps to the catch-all sentence.
  assert.equal(failureLabelKey('unknown'), 'errorUnknown');
});

// ------------------------------------------------- M7: consumer lifecycle
test('M7: the package ships no install-time lifecycle scripts', () => {
  // `postinstall: lefthook install || true` ran for every registry consumer,
  // printed `command not found`, and was exactly what pnpm 10 blocks. Dev
  // tooling must live in `prepare` (clone-only) or in CONTRIBUTING.md.
  const forbidden = ['preinstall', 'install', 'postinstall'];
  const offending = forbidden.filter(name => name in (pkg.scripts ?? {}));
  assert.deepEqual(offending, [],
    'install-time scripts run for every consumer of the published package; '
    + 'use `prepare` for contributor tooling or document it in CONTRIBUTING.md');
});

// ------------------------------------------- M8: links resolve and ship
const DOC_FILES = [
  ...readdirSync(root).filter(name => /^README[^/]*\.md$/.test(name)),
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  ...readdirSync(join(root, 'docs', 'adr')).map(name => `docs/adr/${name}`),
  'docs/design/limit-notice.md',
  'docs/design/limit-notice-implementation.md',
  'scripts/README.md',
];

function gitTracked(relPath) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', relPath], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('M8: every local path the docs reference exists and is tracked', () => {
  // The CHANGELOG once linked an ADR that was still untracked (the link would
  // 404 at publish) and a test cited a screenshot that was never committed.
  // docs/review/** is excluded on purpose: it is the findings record and cites
  // missing artifacts as evidence.
  const failures = [];
  for (const rel of DOC_FILES) {
    const text = readFileSync(join(root, rel), 'utf8');
    const refs = [
      ...[...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]),
      ...[...text.matchAll(/https:\/\/github\.com\/RyabykinIlya\/dsh-openrouter-spend\/(?:blob|tree|raw)\/[^/]+\/([^\s)#]+)/g)].map(m => m[1]),
    ];
    for (const raw of refs) {
      if (/^(https?:|mailto:|#)/.test(raw)) continue;
      const target = raw.split('#')[0].split('?')[0];
      if (target === '') continue;
      // Markdown links resolve relative to the file; raw GitHub URLs relative
      // to the repository root. Accept either.
      const candidates = [join(root, target), join(root, dirname(rel), target)];
      const found = candidates.find(candidate => existsSync(candidate));
      if (found === undefined) {
        failures.push(`${rel} -> ${target} (missing)`);
        continue;
      }
      const repoRel = found.slice(root.length + 1);
      if (!gitTracked(repoRel)) failures.push(`${rel} -> ${target} (exists but untracked: commit it before the link ships)`);
    }
  }
  assert.deepEqual(failures, [], 'documentation must not link to missing or untracked files');
});

// ----------------------------------------------- M9 / m24: release coherence
test('M9 and m24: READMEs pin the current version and the CHANGELOG covers it', () => {
  const version = pkg.version;
  assert.match(version, /^\d+\.\d+\.\d+$/, 'package.json version must stay semver');
  // The READMEs once pinned `#v0.3.2` while documenting 0.4.x features: a
  // reader following the install command got the old behaviour. The rule is
  // that every pinned ref names the version being prepared — bump the refs in
  // the same change that bumps package.json.
  const failures = [];
  for (const name of readdirSync(root).filter(file => /^README[^/]*\.md$/.test(file))) {
    const text = read(name);
    for (const match of text.matchAll(/dsh-openrouter-spend#v(\d+\.\d+\.\d+)/g)) {
      if (match[1] !== version) failures.push(`${name} pins #v${match[1]}, package.json is ${version}`);
    }
    for (const match of text.matchAll(/raw\.githubusercontent\.com\/RyabykinIlya\/dsh-openrouter-spend\/(v\d+\.\d+\.\d+|main)\//g)) {
      if (match[1] !== 'main' && match[1] !== `v${version}`) {
        failures.push(`${name} screenshot pinned to ${match[1]}, package.json is ${version}`);
      }
    }
  }
  assert.deepEqual(failures, []);
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.includes(`## [${version}]`),
    `CHANGELOG.md needs an entry for ${version} — an unreleased version without one is the m24 gap`);
});

// ------------------------------------------------------- m26: tarball shape
test('m26: every root README and locale file is in the package `files` list', () => {
  // README.ru.md / README.zh.md / README.i18n.yaml shipped only through npm's
  // implicit README* auto-include; renaming one would silently drop it. The
  // `files` list may name entries with globs (locale/*.json), so a plain
  // includes() would false-positive — match entries as simple globs.
  const matchesEntry = (name, entry) => {
    const pattern = `^${entry.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`;
    return new RegExp(pattern).test(name);
  };
  const mustShip = [
    ...readdirSync(root).filter(name => /^README[^/]*\.?(md|ya?ml)$/.test(name)),
    ...readdirSync(join(root, 'locale')).map(name => `locale/${name}`),
  ];
  const missing = mustShip.filter(name => !pkg.files.some(entry => matchesEntry(name, entry)));
  assert.deepEqual(missing, [],
    'add these to package.json `files` so they cannot vanish on a rename');
});

// ----------------------------------------------------------- M8: ADR index
test('M8: the ADR index lists exactly the ADR files that exist', () => {
  // The index is a table of `| NNNN | title | status | date |` rows; match by
  // number, which is what ties a row to its NNNN-kebab-case-title.md file.
  const adrs = readdirSync(join(root, 'docs', 'adr')).filter(name => /^\d{4}-.*\.md$/.test(name)).sort();
  const index = read('docs', 'adr', 'README.md');
  const indexedNumbers = new Set([...index.matchAll(/^\|\s*(\d{4})\s*\|/gm)].map(match => match[1]));
  const fileNumbers = new Set(adrs.map(name => name.slice(0, 4)));
  const missingFromIndex = [...fileNumbers].filter(number => !indexedNumbers.has(number)).sort();
  const listedButGone = [...indexedNumbers].filter(number => !fileNumbers.has(number)).sort();
  assert.deepEqual(missingFromIndex, [], 'an ADR file that is not indexed will be forgotten');
  assert.deepEqual(listedButGone, [], 'the index lists an ADR that does not exist');
});

// ------------------------------------------------------------ i18n metadata
test('i18n: locale/*.json carry identical key sets', () => {
  const parsed = Object.fromEntries(
    readdirSync(join(root, 'locale'))
      .filter(name => name.endsWith('.json'))
      .map(name => [name.replace('.json', ''), JSON.parse(read('locale', name))]),
  );
  const baseline = new Set(Object.keys(parsed.en ?? {}));
  assert.ok(baseline.size > 0, 'locale/en.json must exist and have keys');
  for (const [lang, body] of Object.entries(parsed)) {
    const keys = new Set(Object.keys(body));
    assert.deepEqual([...keys].sort(), [...baseline].sort(),
      `locale/${lang}.json must keep the same key set as locale/en.json`);
    for (const [key, value] of Object.entries(body)) {
      const flat = JSON.stringify(value);
      assert.ok(flat.length > 2, `locale/${lang}.json ${key} must not be empty`);
    }
  }
});

// ------------------------------------------------- N5: patch vs schema
test('N5: cordis.patch.yml configures only schema fields', () => {
  // The patch once pinned three knobs at exactly their schema defaults — a
  // silent override that would freeze stale values if a default ever moved.
  const schemaFields = new Set([...indexSource.matchAll(/^  (\w+): Schema\./gm)].map(match => match[1]));
  const patch = read('cordis.patch.yml');
  const lines = patch.split('\n');
  const patchKeys = [];
  let inConfig = false;
  let configIndent = 0;
  for (const line of lines) {
    const configMatch = line.match(/^(\s*)config:\s*$/);
    if (configMatch) { inConfig = true; configIndent = configMatch[1].length; continue; }
    if (!inConfig) continue;
    const entry = line.match(/^(\s*)(\w+):/);
    if (entry && entry[1].length > configIndent) patchKeys.push(entry[2]);
    else if (line.trim() !== '' && entry === null && line.match(/^\S/)) inConfig = false;
  }
  const unknown = patchKeys.filter(key => !schemaFields.has(key));
  assert.deepEqual(unknown, [],
    'a patch key the schema does not define is ignored or mis-typed at activation');
  assert.ok(patch.endsWith('\n'), 'cordis.patch.yml must end with a newline');
});
