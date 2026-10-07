# Translation Verification System

This directory contains scripts for maintaining translation consistency across README files.

## Overview

The repository maintains README files in three languages:
- `README.md` (English)
- `README.zh.md` (Chinese) 
- `README.ru.md` (Russian)

The `README.i18n.yaml` file tracks content hashes to ensure all translations stay synchronized.

## Scripts

### verify-translation-sync.mjs

Verifies that all README translations are in sync by comparing content hashes.

**Usage:**

```bash
# Check if translations are in sync
npm run verify-translation

# Record current state as synchronized (after updating all translations)
npm run verify-translation -- --write
```

## Git Hooks

Lefthook automatically runs translation verification:
- **pre-commit**: Checks if any README*.md files were modified
- **pre-push**: Verifies all translations before pushing

## Workflow

1. Edit any README file (e.g., fix a typo in `README.md`)
2. Update the same content in the other language files (`README.zh.md`, `README.ru.md`)
3. Run `npm run verify-translation -- --write` to record the new state
4. Commit all changes together

The git hook will prevent commits if translations are out of sync.

## Implementation Details

The system uses SHA256 hashes to detect content changes. This is a simplified version inspired by DeepSeek Harness's translation pairing system, adapted for smaller projects.

Unlike the full DSH system which tracks per-section hashes and structural matching, this implementation:
- Uses simple whole-file hashing for ease of use
- Requires manual translation updates (no automated translation)
- Relies on review to ensure translation quality
- Works without external dependencies (uses Node.js built-ins only)
