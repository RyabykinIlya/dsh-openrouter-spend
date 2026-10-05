# Security Policy

Do not open a public issue for vulnerabilities. Use [GitHub Security Advisories](https://github.com/RyabykinIlya/dsh-openrouter-spend/security/advisories/new) for this repository.

Notes on credentials:

- The OpenRouter management key is stored through the Harness credentials service and is never echoed to the browser or logged by this plugin.
- The spend summary is served behind the Harness connection trust check; anyone who passes that check can read your spend figures.