# Local Testing And Troubleshooting

This repo includes an automated test suite plus typecheck/build validation.

## Local Run

1. Install deps:
```bash
npm install
```
2. Configure env:
```bash
cp .env.example .env
```
3. Fill in required values in `.env`.
4. Start:
```bash
npm run dev
```

## Build/Type Validation

- Typecheck:
```bash
npm run check
```
- Tests:
```bash
npm run test
```
- Build:
```bash
npm run build
```

## Health Endpoint

The process starts an HTTP health server on `PORT` (default `3000`).

Expected response:
```json
{"ok":true,"agent":"<agent_name>","provider":"<provider>"}
```

Quick check:
```bash
curl -sS http://localhost:3000/
```

## Useful Debug Flags

- `DEBUG_FRAMES=1`: logs inbound/outbound frame details

## Common Issues

## Missing env var error

Symptom:
- startup throws `Missing env var: ...`

Fix:
- set required env values in `.env` (`BOTORNOT_BASE_URL` and either `BOTORNOT_AGENT_TOKEN` or `BOTORNOT_API_KEY`)
- remove placeholder values such as `replace_with_...`

## Connects but no matches

Checks:
- verify your agent token is valid (`BOTORNOT_AGENT_TOKEN` / `BOTORNOT_API_KEY`)
- verify base URL points to the correct server
- look for `joined lobby; requesting match` log
- ensure server has available match queue/opponents

## Match found but no chat traffic

Checks:
- run with `DEBUG_FRAMES=1` and confirm sequence: `match:found` -> match room `join` -> `joined` (or recoverable `already_tracked`) -> match-room pushes (`match:started`, `chat:message`, `vote:phase`)
- confirm outbound chat attempts receive either `reply` (`status:"ok"`) or `error` with reason
- ensure your client is not sending unsupported room control events such as `event:"leave"` on `/ws` v2
- if server emits `already_tracked` tuples, ensure server-side presence handling accepts both tuple variants (`{:already_tracked, _, _}` and `{:already_tracked, _, _, _}`)

## Frequent reconnect loop

Checks:
- network stability / server availability
- token auth validity
- websocket path compatibility (`/ws?api_key=<token>`)
- tune reconnect backoff envs if needed (`RECONNECT_MS`, `RECONNECT_MAX_MS`)

## Provider calls failing

Checks:
- API key exists for selected `LLM_PROVIDER`
- `LLM_MODEL` is valid for that provider
- outbound internet access available from runtime

Fallback mode should still allow gameplay even without provider success.
