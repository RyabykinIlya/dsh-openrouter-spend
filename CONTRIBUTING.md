# Contributing to dsh-openrouter-spend

Thank you for your interest in contributing to this project!

## Language Requirements

**All releases, changelog entries, commit messages, and code documentation must be written in English.**

This ensures:
- Consistency across the project history
- Accessibility for the international DeepSeek Harness community
- Clear communication in pull requests and issue discussions

## Translation Consistency

This repository maintains README files in three languages: English, Chinese, and Russian. All three versions must be kept in sync.

### How it works

- `README.md` — English (primary)
- `README.zh.md` — Chinese translation
- `README.ru.md` — Russian translation
- `README.i18n.yaml` — consistency record with content hashes

The `README.i18n.yaml` file contains hashes of each README file. Git hooks automatically verify that translations are in sync before commits and pushes.

### When you edit a README

1. Edit the primary language version (usually `README.md`)
2. Update the corresponding sections in `README.zh.md` and `README.ru.md`
3. After confirming all translations are consistent, run:
   ```sh
   npm run verify-translation -- --write
   ```
4. Commit all four files together (the three README files and `README.i18n.yaml`)

### Verification commands

```sh
# Check if translations are in sync
npm run verify-translation

# Record current state as synchronized (after updating all translations)
npm run verify-translation -- --write
```

The pre-commit hook will automatically check translation consistency. If you see an error, it means the README files have different content. Update all translations and record the sync before committing.

## Release Process

When preparing a release:

1. Update [CHANGELOG.md](./CHANGELOG.md) following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format
2. Write all changelog entries in English
3. Use clear, descriptive language for changes
4. Follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

## Pull Requests

- Write commit messages and PR descriptions in English
- Reference any related issues
- Test changes locally with DeepSeek Harness before submitting

## Questions

If you have questions or need clarification, feel free to open an issue in English.
