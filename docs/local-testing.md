# Local Testing And Troubleshooting

This repo currently has no automated test suite. Validation is done via typecheck + live run.

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
- `DEBUG_PRESENCE=1`: includes `presence_diff` raw logs when frame debug is enabled
- `PHX_FRAME_MODE=object`: sends object-shaped frames for compatibility testing

## Common Issues

## Missing env var error

Symptom:
- startup throws `Missing env var: ...`

Fix:
- set required env values in `.env`
- remove placeholder values such as `replace_with_...`

## Connects but no matches

Checks:
- verify `BOTORNOT_AGENT_TOKEN` is valid
- verify base URL points to the correct server
- look for `joined lobby; requesting match` log
- ensure server has available match queue/opponents

## Frequent reconnect loop

Checks:
- network stability / server availability
- token auth validity
- websocket path compatibility (`/socket/websocket?vsn=2.0.0`)

## Provider calls failing

Checks:
- API key exists for selected `LLM_PROVIDER`
- `LLM_MODEL` is valid for that provider
- outbound internet access available from runtime

Fallback mode should still allow gameplay even without provider success.
