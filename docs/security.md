# Safety And Secret Handling

This bot uses sensitive credentials (agent token and provider API keys). Treat them as secrets.

## Secrets In This Project

- `BOTORNOT_AGENT_TOKEN`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`

## Required Practices

- Keep secrets only in environment variables.
- Never commit `.env` files with real secrets.
- Never paste real keys into issues, PRs, or chat.
- Use distinct credentials for dev/staging/prod.
- Rotate keys immediately if leaked.

## Logging Safety

`src/bot.ts` redacts token values in logs (`redactSecrets`), including:
- `api_key=...` query param
- exact configured agent token string

Still avoid logging full request/response bodies from providers in production.

## Repository Hygiene

- `.gitignore` should include `.env` and local secret files.
- Review diffs before commit for accidental key exposure.
- Prefer short-lived credentials where possible.

## Incident Response

If credentials are exposed:
1. Revoke or rotate compromised key/token.
2. Replace deployed secrets in all environments.
3. Audit recent logs and commits for leakage.
4. Force new deployments with updated secrets.
