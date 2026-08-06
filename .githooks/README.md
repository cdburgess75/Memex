# Git hooks

Versioned hooks, so every clone gets the same guardrails. Git does not use this
directory automatically — point it here once per clone:

```bash
git config core.hooksPath .githooks
```

`cd server && npm install` does this for you (the `prepare` script), so in practice
you only run the command by hand if you never install dependencies.

## pre-commit

Refuses to commit credentials. **This repository is public**, so a secret that
reaches a commit is world-readable as soon as it is pushed, and removing it
afterwards means a history rewrite that breaks every clone and still leaves
GitHub's cached views and any forks intact.

It inspects only what is staged, and blocks on:

- **Credential filenames** — `.env` and any `.env.*` variant (except `.env.example`),
  `.pem`, `.p12`, `.pfx`, `id_rsa` and friends, `.netrc`, `.htpasswd`,
  `service-account*.json`, `credentials.json`.
- **Credential content in added lines** — Anthropic, OpenAI, AWS, GitHub, Slack and
  Google key formats; private key material; and `PASSWORD=` / `SECRET=` / `TOKEN=` /
  `API_KEY=` assignments carrying a literal value.

Placeholders are deliberately allowed (`sk-ant-...`, `changeme`, `${VAR}`, and a
`-----BEGIN PRIVATE KEY-----` header with no base64 body — `index.html` has one as
UI placeholder text). A hook that cries wolf gets bypassed, which is worse than no
hook at all.

To commit anyway, when you are certain it is a false positive:

```bash
git commit --no-verify
```

## Why this exists

A `.env.localhost-backup` — a hand-made copy of `.env`, not matched by the old
`.gitignore` rule — was once staged for commit carrying the live
`POSTGRES_PASSWORD`, `KEYCLOAK_ADMIN_PASSWORD`, `STORAGE_ENCRYPTION_KEY` and
`COLLABORA_ADMIN_PASSWORD`. It was caught by eye, one `git push` from publication.
`.gitignore` now matches `.env*`, but that only helps for names someone thought of
in advance. This hook checks content too.
