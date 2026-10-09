/**
 * The refresh-failure vocabulary, pinned in all three shipped languages.
 *
 * `client.js` is a plain script body — the harness compiles it with
 * `new Function(...)` and refuses `import`/`export` — so the dictionaries are
 * reached through the module loader's factory: `apply()` registers en/zh/ru with
 * the locale plugin, and the stub's `register` captures them. That is the same
 * seam `limit-state.test.mjs` uses to read the shipped copy.
 *
 * The key list is DERIVED, not hand-copied. `failureLabelKey`'s switch is parsed
 * out of the source, so a new failure code added without a translation fails
 * here instead of shipping as an English sentence in two languages. The
 * derivation is then cross-checked against the live function, so the parse
 * cannot silently disagree with the code it is reading.
 *
 * Scope: the refresh-failure keys only (`error*`, and the five refresh/retry
 * strings). The `limit*` vocabulary has its own completeness checks in
 * `limit-state.test.mjs`, including the design doc's key tables.
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

/** Load the factory and capture whatever `apply` registers as the dictionary. */
function load() {
  let captured;
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: registration => { captured = registration; } } },
  });
  const api = captured.factory(specifier => {
    if (specifier === 'react') return reactStub;
    throw new Error(`Unexpected browser dependency: ${specifier}`);
  });

  const registered = [];
  api.apply({
    effect: fn => { fn(); return () => {}; },
    locale: {
      register: (namespace, dict) => { registered.push(dict); return () => {}; },
      bind: () => key => key,
    },
    slots: {
      inject: (name, thunk) => { thunk(); },
      register: () => () => {},
    },
  });

  const dict = registered.find(entry => entry.en !== undefined);
  assert.ok(dict, 'apply must register the three dictionaries');
  return { api, dicts: { en: dict.en, zh: dict.zh, ru: dict.ru } };
}

const { api, dicts } = load();

const LANGS = ['en', 'zh', 'ru'];

/** The body of `failureLabelKey`, by brace matching from its opening brace. */
function failureLabelBody() {
  const start = source.indexOf('function failureLabelKey');
  assert.notEqual(start, -1, 'client.js must keep `failureLabelKey`');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(open, i + 1); }
  }
  throw new Error('unbalanced braces in failureLabelKey');
}

const body = failureLabelBody();

/** code → dictionary key, straight out of the switch. */
const codeToKey = new Map(
  [...body.matchAll(/case\s+'([^']+)':\s*return\s+'([^']+)'/g)].map(m => [m[1], m[2]]),
);
const fallbackKey = body.match(/default:\s*return\s+'([^']+)'/)?.[1];

/** The five refresh/retry strings beside the codes, at their `t()` call sites. */
const REFRESH_KEYS = ['refreshFailed', 'refreshFailedTitle', 'nextAttemptIn', 'retryNow', 'retrying'];

/** The placeholders a template carries, sorted so the comparison is order-free. */
const placeholders = template => [...String(template).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test('the failure-code list is derived from the switch, and the switch agrees with it', () => {
  // The known vocabulary, plus the `request` case both halves emit (m8). Pinned
  // as a set so a code silently dropped from the switch is also caught: the
  // dictionary requirement below would otherwise shrink with it.
  assert.deepEqual(
    [...codeToKey.keys()].sort(),
    ['auth', 'data', 'host', 'network', 'rate-limit', 'request', 'server', 'timeout'].sort(),
    `the switch must name every code — got ${JSON.stringify([...codeToKey.keys()])}`,
  );
  assert.ok(fallbackKey, 'failureLabelKey must keep a default arm for an unrecognised code');
  // The parse is only trustworthy if the live function returns what it read.
  for (const [code, key] of codeToKey) {
    assert.equal(api.failureLabelKey(code), key, `the switch must return ${key} for "${code}"`);
  }
  assert.equal(api.failureLabelKey('a-code-nobody-classified'), fallbackKey,
    'an unrecognised code must take the default arm the parse found');
});

test('every failure code has a non-empty sentence in en, zh and ru', () => {
  const required = [...new Set([...codeToKey.values(), fallbackKey, ...REFRESH_KEYS])];
  for (const lang of LANGS) {
    const dict = dicts[lang];
    assert.ok(dict, `the ${lang} dictionary must be registered`);
    for (const key of required) {
      const value = dict[key];
      assert.equal(typeof value, 'string', `${lang} must define ${key} (got ${JSON.stringify(value)})`);
      assert.ok(value.trim().length > 0, `${lang} ${key} must not be blank`);
      // A miss returns the key itself, so a key equal to its own name is a miss.
      assert.notEqual(value, key, `${lang} ${key} must be translated, not left as its own key`);
    }
  }
});

test('the error labels carry no placeholder, because they are rendered without params', () => {
  // `t(failureLabelKey(failure.code))` is called with NO params at both call
  // sites (the chip tooltip and the panel sentence), so a placeholder inside an
  // `error*` string could never be substituted — it would ship as literal text.
  for (const lang of LANGS) {
    for (const key of [...new Set([...codeToKey.values(), fallbackKey])]) {
      assert.deepEqual(placeholders(dicts[lang][key]), [],
        `${lang} ${key} must be a plain sentence, got ${JSON.stringify(dicts[lang][key])}`);
    }
  }
});

test('the refresh and retry strings keep exactly the placeholders their call sites pass', () => {
  // Derived from the call sites, not from taste: `refreshFailed` is given
  // `{reason}`; `refreshFailedTitle` `{reason}` and `{time}`; `nextAttemptIn`
  // `{time}`. An extra placeholder would render literally, a missing one would
  // drop the figure the sentence was written to carry.
  const expected = {
    refreshFailed: ['reason'],
    refreshFailedTitle: ['reason', 'time'],
    nextAttemptIn: ['time'],
    retryNow: [],
    retrying: [],
  };
  for (const lang of LANGS) {
    for (const [key, params] of Object.entries(expected)) {
      assert.deepEqual(placeholders(dicts[lang][key]), params,
        `${lang} ${key} must carry exactly ${JSON.stringify(params)} — got ${JSON.stringify(dicts[lang][key])}`);
    }
  }
});

test('the retry labels are distinct, so the button can say which state it is in', () => {
  // m11 derives the label from the state that disables the button; identical
  // strings would make that derivation invisible in every language.
  for (const lang of LANGS) {
    assert.notEqual(dicts[lang].retrying, dicts[lang].retryNow,
      `${lang}: "retrying" must read differently from "retry now" (both ${JSON.stringify(dicts[lang].retrying)})`);
  }
});

test('the failure sentences substitute their figures in every language', () => {
  // Substitution, not just presence: a language can carry `{time}` in a place
  // the formatter's regex still matches, and the rendered sentence is what the
  // reader gets. Rendered through each language's own dictionary.
  const codeLabels = [...codeToKey.values()];
  for (const lang of LANGS) {
    const dict = dicts[lang];
    const t = (key, params) => {
      const template = dict[key] ?? key;
      return params
        ? template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
        : template;
    };

    const reason = t(codeLabels[0]);
    const panel = t('refreshFailed', { reason });
    assert.ok(panel.includes(reason), `${lang}: refreshFailed must carry the reason — got ${panel}`);
    assert.ok(!panel.includes('{'), `${lang}: refreshFailed must leave no placeholder — got ${panel}`);

    const title = t('refreshFailedTitle', { reason, time: '0:15' });
    assert.ok(title.includes(reason), `${lang}: the tooltip must carry the reason — got ${title}`);
    assert.ok(title.includes('0:15'), `${lang}: the tooltip must carry the countdown — got ${title}`);
    assert.ok(!title.includes('{'), `${lang}: refreshFailedTitle must leave no placeholder — got ${title}`);

    const countdown = t('nextAttemptIn', { time: '0:15' });
    assert.ok(countdown.includes('0:15'), `${lang}: nextAttemptIn must carry the time — got ${countdown}`);
    assert.ok(!countdown.includes('{'), `${lang}: nextAttemptIn must leave no placeholder — got ${countdown}`);
  }
});
