#!/usr/bin/env node
/**
 * Verify that README translations are in sync.
 * Checks that all three files exist (README.md, README.zh.md, README.ru.md)
 * and their content hashes match the recorded values in README.i18n.yaml.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const README_FILES = {
  en: 'README.md',
  zh: 'README.zh.md',
  ru: 'README.ru.md',
  record: 'README.i18n.yaml'
};

const WRITE_MODE = process.argv.includes('--write');

/**
 * Compute a simple hash of the README content.
 * Uses SHA256 for compatibility (Node.js built-in).
 */
function computeHash(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Check if all README files exist.
 */
function checkFilesExist() {
  const missing = [];
  for (const [lang, file] of Object.entries(README_FILES)) {
    if (lang === 'record') continue;
    if (!existsSync(file)) {
      missing.push(file);
    }
  }
  return missing;
}

/**
 * Compute current hashes for all README files.
 */
function computeCurrentHashes() {
  const hashes = {};
  for (const [lang, file] of Object.entries(README_FILES)) {
    if (lang === 'record') continue;
    if (existsSync(file)) {
      const content = readFileSync(file, 'utf8');
      hashes[lang] = computeHash(content);
    }
  }
  return hashes;
}

/**
 * Read recorded hashes from README.i18n.yaml (simple YAML parser).
 */
function readRecordedHashes() {
  if (!existsSync(README_FILES.record)) {
    return null;
  }
  const content = readFileSync(README_FILES.record, 'utf8');
  const hashes = {};
  
  // Simple YAML parser for our specific format
  const lines = content.split('\n');
  for (const line of lines) {
    const match = line.match(/^  (\w+): (\w+)$/);
    if (match) {
      hashes[match[1]] = match[2];
    }
  }
  
  return Object.keys(hashes).length > 0 ? { hashes } : null;
}

/**
 * Write hashes to README.i18n.yaml.
 */
function writeHashes(hashes) {
  const lines = [
    '# Translation consistency record for README files',
    '# Each hash represents the content of the corresponding README file.',
    '# After updating translations, run: npm run verify-translation -- --write',
    '',
    'hashes:',
    `  en: ${hashes.en}`,
    `  zh: ${hashes.zh}`,
    `  ru: ${hashes.ru}`,
    ''
  ];
  
  writeFileSync(README_FILES.record, lines.join('\n'), 'utf8');
  console.log(`✓ Recorded hashes to ${README_FILES.record}`);
}

/**
 * Main verification logic.
 */
function main() {
  // Check if all files exist
  const missing = checkFilesExist();
  if (missing.length > 0) {
    console.error(`✗ Missing translation files: ${missing.join(', ')}`);
    console.error('  All README files must exist: README.md, README.zh.md, README.ru.md');
    process.exit(1);
  }

  // Compute current hashes
  const currentHashes = computeCurrentHashes();

  if (WRITE_MODE) {
    // Write mode: record the current hashes
    writeHashes(currentHashes);
    console.log('✓ Translation consistency record updated');
    console.log('  Current hashes:', currentHashes);
    return;
  }

  // Check mode: verify hashes match
  const recorded = readRecordedHashes();
  if (!recorded || !recorded.hashes) {
    console.error(`✗ No recorded hashes found in ${README_FILES.record}`);
    console.error('  Run: npm run verify-translation -- --write');
    process.exit(1);
  }

  // Compare hashes
  const outOfSync = [];
  for (const [lang, hash] of Object.entries(currentHashes)) {
    if (recorded.hashes[lang] !== hash) {
      outOfSync.push(lang);
    }
  }

  if (outOfSync.length > 0) {
    console.error(`✗ Translation files out of sync: ${outOfSync.map(l => README_FILES[l]).join(', ')}`);
    console.error('  The content has changed since the last recorded sync.');
    console.error('  After updating all translations, run: npm run verify-translation -- --write');
    process.exit(1);
  }

  console.log('✓ All translations are in sync');
  console.log('  Verified:', Object.keys(currentHashes).map(l => README_FILES[l]).join(', '));
}

main();
