---
name: release-publish
description: Release dsh-openrouter-spend — bump version, README/CHANGELOG, tests, tag, GitHub Release, npm publish from the .env token. Use when preparing or shipping a release of this plugin.
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

2. Create the **GitHub Release** on that tag — a tag alone is not a release,
   and the Releases page is where users look (the repo had tags without
   releases until 2026-10-12, and `gh release list` still showed the previous
   version as "Latest"). `gh` is authenticated on this machine as
   `RyabykinIlya` (keyring), so no token handling is needed here:
   ```sh
   cd /Users/user/dev/dsh-openrouter-spend
   cat > /tmp/release-X.Y.Z.md <<'EOF'
   ## Что нового

   - <what a user sees>

   ## Что исправлено

   - <what a user sees>

   ## Установка

   `dsh plugin --profile web add dsh-openrouter-spend@X.Y.Z`
   EOF
   gh release create vX.Y.Z \
     --title "X.Y.Z: <short user-facing headline>" \
     --notes-file /tmp/release-X.Y.Z.md --latest
   ```
   The install line sits in single backticks, not a fenced block: this whole
   recipe is itself inside a ```sh fence, and a nested triple fence would end
   the skill's block early and scramble everything after it.
   House style, taken from the shipped releases: **Russian**, sections
   `## Что нового` / `## Что исправлено` / `## Установка`, bullets written as
   what a user sees (not what the diff did), and a link to the ADR when the
   release ships a decision. The notes restate the CHANGELOG section — do not
   paste the whole changelog, one release's worth only.

3. Publish to npm with the `.env` token. **Never** `npm login`, never write the
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

4. Sanity-check the token first if anything smells wrong:
   ```sh
   curl -s -H "Authorization: Bearer $PNPM_TOKEN" https://registry.npmjs.org/-/whoami
   ```
   `{"username":…}` = valid; `{}` with HTTP 401 = expired or wrong-scope token
   → ask the user to rotate `PNPM_KEY` in `.env` and retry. A publish that
   answers `404 'dsh-openrouter-spend@…' is not in this registry` is the same
   auth problem, not a missing package.

5. Verify propagation — the registry takes a minute or two, poll until 200:
   ```sh
   curl -s -o /dev/null -w "%{http_code}\n" \
     https://registry.npmjs.org/dsh-openrouter-spend/X.Y.Z
   ```
   `npm view` may lie on this machine (`EPERM` on the broken cache) — the
   curl check is the honest one.

## Known traps (each has cost real time)

- **A pushed tag is not a GitHub Release.** `git push --tags` leaves the
  Releases page empty and keeps the previous version marked "Latest"; nothing
  fails, so nothing reminds you. `gh release list` is the check, and the
  `gh release create` step above is what fixes it.
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

Four things, all checkable:

```sh
# the tag is pushed
git ls-remote --tags origin | grep vX.Y.Z
# it is the latest GitHub RELEASE, not just a tag
gh release list --limit 1
# npm answers 200 for the exact version
curl -s -o /dev/null -w "%{http_code}\n" \
  https://registry.npmjs.org/dsh-openrouter-spend/X.Y.Z
```

and the release notes say what a user sees — not what the diff did.