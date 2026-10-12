---
name: release-publish
description: Release dsh-openrouter-spend — bump version, README/CHANGELOG, tests, tag, push to GitHub and publish to npm from the .env token. Use when preparing or shipping a release of this plugin.
---

# Release & publish

The repo's `AGENTS.md` "Release checklist" is the contract; this skill is the
runnable version of it, including the publish steps that live nowhere in the
repo yet (they cost an hour of debugging on 2026-10-12 — hence this file).

## Where the pieces live

- Version: `package.json` `version`.
- Version refs: the `dsh plugin --profile web add github:…#vX.Y.Z` line in
  **all three** READMEs (`README.md`, `README.ru.md`, `README.zh.md`) — a
  repo-guard test fails the release if they lag behind `package.json`.
- User-visible changes: a `## [X.Y.Z] - YYYY-MM-DD` section in `CHANGELOG.md`.
  Move the `[Unreleased]` entries into it; keep an empty `[Unreleased]`
  heading on top.
- Decisions: a new `docs/adr/NNNN-*.md` plus a row in `docs/adr/README.md`,
  when the release ships a decision.
- npm token: `PNPM_KEY` in `.env` (never tracked, never quoted in logs or
  files — the token rides only in the `Authorization` header).

## Pre-flight (all must be green before tagging)

```sh
git status --short                # must be empty
npm test                           # full suite, 0 fail
node scripts/verify-translation-sync.mjs
npm --cache /tmp/npmcache-review pack --dry-run   # tarball = package.json files
```

npm's default cache is broken on this machine — always pass
`--cache /tmp/npmcache-review` to any npm command that needs the network.

The lefthook pre-commit hook re-checks the translation sync; if a commit is
rejected with "Translation files out of sync", run
`node scripts/verify-translation-sync.mjs --write` and commit again.

## Publish

1. Tag and push (the tag is what GitHub installs read):
   ```sh
   git tag vX.Y.Z
   git push origin main --tags
   ```

2. Publish with the `.env` token. **Never** `npm login`, never write the
   token into a file npm persists (`~/.npmrc`) — pass it as a one-shot config
   on the command line, read from `.env` at run time:
   ```sh
   cd /tmp
   PNPM_TOKEN=$(grep PNPM_KEY /Users/user/dev/dsh-openrouter-spend/.env \
     | cut -d= -f2 | tr -d ' \r\n')
   npm --cache /tmp/npmcache-review publish --access public \
     --//registry.npmjs.org/:_authToken="$PNPM_TOKEN" \
     /Users/user/dev/dsh-openrouter-spend
   ```
   Run it from outside the repo dir so the repo's own `.env`/`.npmrc` cannot
   leak into the environment npm sees.

3. Sanity-check the token first if anything smells wrong:
   ```sh
   curl -s -H "Authorization: Bearer $PNPM_TOKEN" https://registry.npmjs.org/-/whoami
   ```
   `{"username":…}` = valid; `{}` with HTTP 401 = expired or wrong-scope token
   → ask the user to rotate `PNPM_KEY` in `.env` and retry. A publish that
   answers `404 'dsh-openrouter-spend@…' is not in this registry` is the same
   auth problem, not a missing package.

4. Verify propagation — the registry takes a minute or two, poll until 200:
   ```sh
   curl -s -o /dev/null -w "%{http_code}\n" \
     https://registry.npmjs.org/dsh-openrouter-spend/X.Y.Z
   ```
   `npm view` may lie on this machine (`EPERM` on the broken cache) — the
   curl check is the honest one.

## Known traps (each has cost real time)

- `404 Not Found - PUT …/dsh-openrouter-spend` on publish = auth, not "the
  package does not exist". Check the token with whoami before re-trying.
- `limit: Too big: expected number to be <=10000` from
  `analytics/query` = the request body's row ceiling; nothing to do with
  npm, but it is the other "limit" in this repo and easy to confuse.
- Forgetting the `#vX.Y.Z` bump in any one of the three READMEs fails the
  repo-guard test only at commit time — do the READMEs and the changelog in
  the same edit as `package.json`, not after.
- The `.env` token line carries a trailing space; `tr -d ' \r\n'` it.

## Done means

Tag pushed (`git ls-remote --tags origin` shows it), npm registry answers
200 for the exact version, and the release notes say what a user sees — not
what the diff did.