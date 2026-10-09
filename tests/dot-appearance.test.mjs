/**
 * The chip dot's colour and motion, checked as a cascade rather than as text.
 *
 * The earlier checks asserted that strings like `data-state="limit-warn"` or
 * `@keyframes ors-pulse` appear in the source. That pins the wording, not the
 * outcome: it passes when the keyframes are never referenced, when a later rule
 * overrides the state colour, or when the pulse escapes its
 * `prefers-reduced-motion` guard. This file applies the plugin's own stylesheet
 * — specificity and document order included — and asserts what a browser would
 * compute.
 *
 * The token values are fixtures read out of the running DSH GUI on 2026-10-09,
 * so the colours are the real ones. A real browser was used to confirm them:
 * docs/mockups/dot-states-browser-check.png is that render, and it agrees with
 * every assertion below.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

/** The component's CSS, lifted from the template literal it lives in. */
function pluginCss() {
  const start = source.indexOf('const CSS = `');
  assert.notEqual(start, -1, 'client.js must keep the CSS template literal');
  const from = start + 'const CSS = `'.length;
  const to = source.indexOf('`;', from);
  assert.ok(to > from, 'the CSS literal must be closed');
  return source.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * A minimal rule parser: `selector { decls }`, recursing into `@media` and
 * skipping other at-rules such as `@keyframes`. Order is document order, which
 * is what breaks ties between equal-specificity rules.
 */
function parseRules(css, media = null, out = []) {
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const head = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') depth -= 1;
      j += 1;
    }
    const body = css.slice(open + 1, j - 1);
    if (head.startsWith('@media')) {
      parseRules(body, head.slice('@media'.length).trim(), out);
    } else if (!head.startsWith('@')) {
      const decls = {};
      for (const piece of body.split(';')) {
        const m = piece.match(/^\s*([a-z-]+)\s*:\s*(.+)$/s);
        if (m !== null) decls[m[1]] = m[2].trim();
      }
      for (const selector of head.split(',').map(s => s.trim())) {
        out.push({ selector, decls, media, order: out.length });
      }
    }
    i = j;
  }
  return out;
}

/** `.ors-chip-dot` matches any state; the attribute form matches one. */
function matchesState(selector, state) {
  if (selector === '.ors-chip-dot') return true;
  const m = selector.match(/^\.ors-chip-dot\[data-state="([^"]+)"\]$/);
  return m !== null && m[1] === state;
}

function specificity(selector) {
  return (selector.match(/\./g) ?? []).length * 10 + (selector.match(/\[/g) ?? []).length;
}

/** True when the rule's media query holds for the motion preference. */
function mediaApplies(query, reducedMotion) {
  if (query === null) return true;
  if (query.includes('prefers-reduced-motion: no-preference')) return !reducedMotion;
  if (query.includes('prefers-reduced-motion: reduce')) return reducedMotion;
  return true;
}

/** The declaration a browser would apply: highest specificity, then latest. */
function winningDeclaration(rules, state, property, reducedMotion) {
  let best = null;
  for (const rule of rules) {
    if (!matchesState(rule.selector, state)) continue;
    if (!(property in rule.decls)) continue;
    if (!mediaApplies(rule.media, reducedMotion)) continue;
    const spec = specificity(rule.selector);
    if (best === null || spec > best.spec || (spec === best.spec && rule.order > best.order)) {
      best = { spec, order: rule.order, value: rule.decls[property] };
    }
  }
  return best === null ? undefined : best.value;
}

/** `var(--name, fallback)` against the theme's token map. */
function resolveColour(value, tokens) {
  if (value === undefined) return undefined;
  const m = String(value).trim().match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)$/);
  if (m === null) return value;
  const [, name, fallback] = m;
  if (name in tokens) return tokens[name];
  return fallback === undefined ? undefined : fallback.trim();
}

/**
 * Token values read from the running GUI (body scope), light and dark. The
 * plugin references these rather than hex literals, which is what lets one
 * stylesheet follow the theme; pinning them keeps that promise testable.
 */
const THEMES = {
  light: {
    '--dsw-alias-state-business-primary': '#4176e6',
    '--dsw-alias-state-warn-primary': '#f59e0b',
    '--dsw-alias-state-error-primary': '#ec1313',
    '--dsw-alias-label-tertiary': '#81858c',
  },
  dark: {
    '--dsw-alias-state-business-primary': '#7aaaff',
    '--dsw-alias-state-warn-primary': '#f59e0b',
    '--dsw-alias-state-error-primary': '#f25a5a',
    '--dsw-alias-label-tertiary': '#adb2b8',
  },
};

const rules = parseRules(pluginCss());

test('the three levels render three distinct colours in both themes', () => {
  // Colour is the whole point of the dot, and it must separate ok from warn
  // from critical. Checked per theme, because the dark values differ and a rule
  // that hardcodes a light hex would pass in one theme and fail in the other.
  for (const [theme, tokens] of Object.entries(THEMES)) {
    const resolved = ['ok', 'limit-warn', 'limit-critical'].map(state =>
      resolveColour(winningDeclaration(rules, state, 'background', false), tokens));
    for (const value of resolved) assert.notEqual(value, undefined, `${theme}: every level needs a colour`);
    assert.equal(new Set(resolved).size, 3,
      `${theme}: ok/warn/critical must not collide — got ${JSON.stringify(resolved)}`);
    assert.equal(resolved[0], tokens['--dsw-alias-state-business-primary'], `${theme}: ok is the business blue`);
    assert.equal(resolved[1], tokens['--dsw-alias-state-warn-primary'], `${theme}: warn is the amber token`);
    assert.equal(resolved[2], tokens['--dsw-alias-state-error-primary'], `${theme}: critical is the error token`);
  }
});

test('the limit levels reuse the palette of the health levels they stand beside', () => {
  // `limit-warn` must land on the same amber as `stale`, and `limit-critical`
  // on the same red as `error`, so the two families read as one scale rather
  // than as two colour systems. The declarations must name the token, not a
  // literal — a hardcoded hex would survive a theme change as a wrong colour.
  const pairs = [
    ['limit-warn', 'stale', '--dsw-alias-state-warn-primary'],
    ['limit-critical', 'error', '--dsw-alias-state-error-primary'],
    ['limit-critical', 'no-credential', '--dsw-alias-state-error-primary'],
  ];
  for (const [limit, health, token] of pairs) {
    for (const prop of ['background']) {
      const limitValue = winningDeclaration(rules, limit, prop, false);
      const healthValue = winningDeclaration(rules, health, prop, false);
      assert.equal(limitValue, healthValue, `${limit} and ${health} must share the ${prop}`);
      assert.ok(String(limitValue).includes(token),
        `${limit} must reference ${token}, not a literal — got ${limitValue}`);
    }
  }
});

test('the pulse is finite and holds its resting colour', () => {
  // A beacon would be worse than silence: an endless pulse trains the reader to
  // ignore it, and `forwards` is what stops a re-render restarting it. Both
  // assertions are about the shorthand a browser parses, not about the string.
  const expected = { 'limit-warn': '2', 'limit-critical': '3' };
  for (const [state, iterations] of Object.entries(expected)) {
    const animation = winningDeclaration(rules, state, 'animation', false);
    assert.ok(animation, `${state} must animate under normal motion`);
    const parts = animation.split(/\s+/);
    assert.equal(parts[0], 'ors-pulse', `${state} must run the pulse`);
    assert.ok(parts.includes(iterations), `${state} must run ${iterations} times, got ${animation}`);
    assert.ok(parts.includes('forwards'), `${state} must hold its resting colour: ${animation}`);
    assert.ok(!parts.includes('infinite'), `${state} must not pulse forever: ${animation}`);
    assert.match(animation, /\d+(\.\d+)?s/, `${state} needs a duration: ${animation}`);
  }
});

test('the pulse is off when the reader asks for reduced motion', () => {
  // This is the assertion the grep-style check could not make: it proved the
  // `@media` query was written down, not that the animation stops matching
  // without it. Here the media rules are excluded and the base rule must win.
  for (const state of ['limit-warn', 'limit-critical']) {
    const animation = winningDeclaration(rules, state, 'animation', true);
    assert.equal(animation, 'none', `${state} must not animate under prefers-reduced-motion`);
    // And the colour survives, so the level is still readable without motion.
    const background = resolveColour(winningDeclaration(rules, state, 'background', true), THEMES.light);
    assert.ok(background, `${state} must keep its colour when motion is off`);
  }
});

test('only the two limit levels pulse', () => {
  // The health levels are static: a stale or error dot that blinked would
  // compete with the limit warning and blur the one signal this feature adds.
  for (const state of ['ok', 'loading', 'stale', 'error', 'no-credential']) {
    const animation = winningDeclaration(rules, state, 'animation', false);
    if (animation === undefined || animation === 'none') continue;
    assert.fail(`${state} must not animate, got ${animation}`);
  }
  // And the keyframes the pulse names must actually exist.
  const keyframes = new Set([...pluginCss().matchAll(/@keyframes\s+([\w-]+)/g)].map(m => m[1]));
  assert.ok(keyframes.has('ors-pulse'), 'the pulse keyframes must be defined');
});
