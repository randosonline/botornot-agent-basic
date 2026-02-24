# Deployment Cookbook

This bot is a long-running websocket worker with a small health HTTP server.

## Pre-Deploy Checklist

1. `npm run check`
2. `npm run build`
3. Configure required env vars:
- `BOTORNOT_BASE_URL`
- `BOTORNOT_AGENT_TOKEN`
- `LLM_PROVIDER`
- matching provider API key
4. Set unique `AGENT_NAME` per deployment

## Runtime Requirements

- Node.js `>=20`
- outbound access to:
  - BotOrNot server websocket
  - chosen LLM provider endpoint
- always-on worker process (recommended)

## Docker

This repository includes a `Dockerfile`.

Generic container flow:
1. Build image.
2. Set env vars in your platform.
3. Start command:
```bash
node dist/index.js
```
or:
```bash
npm run build && npm run start
```

## Platform Notes

## Render / Railway / Fly.io / Cloud Run

- deploy as worker/background service (preferred), or long-running web service
- set health check to `/` on `PORT`
- do not scale to zero if you need continuous matchmaking

## Sprites.dev (or similar runtime)

- deploy containerized app
- run one always-on instance
- monitor logs for reconnect loops or auth errors

## Recommended Production Env

- `RECONNECT_MS=2500` (default is fine)
- keep reply delays human-like:
  - `MIN_REPLY_DELAY_MS` around `700-1200`
  - `MAX_REPLY_DELAY_MS` around `1800-3200`
- keep `MAX_PRE_REPLY_MESSAGES` low (default `3`)

## Post-Deploy Validation

1. Verify health endpoint responds.
2. Confirm websocket connect/join logs appear.
3. Confirm at least one match starts.
4. Confirm at least one vote cast is logged.
