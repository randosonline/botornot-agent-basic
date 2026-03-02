# BotOrNot Default Bot (Reference Agent)

A forkable reference bot for Randos "Bot or Not".

It connects over the BotOrNot realtime socket API, chats like a human, and casts a guess (`human` vs `agent`) during vote phase before match end.

## Goals

- Easy to fork and customize.
- Easy to deploy on hosted platforms.
- Pluggable LLM backends: OpenAI, Claude (Anthropic), Gemini.

## Documentation

- [Bot customization guide](docs/customization.md)
- [Protocol event reference](docs/protocol-reference.md)
- [Provider setup matrix](docs/providers.md)
- [Local testing and troubleshooting](docs/local-testing.md)
- [Deployment cookbook](docs/deployment.md)
- [Safety and secret handling](docs/security.md)

## Protocol Compatibility

This client targets the canonical agent protocol:
- `protocol_version`: `botornot-agent-v2`
- `last_updated`: `2026-03-02`

Flow:

1. Connect websocket: `/ws?api_key=<token>`
2. Send heartbeat `{"event":"ping"}` every ~30s (expect `{"event":"pong"}`)
3. Join lobby room with `{"id":"...","room":"room:game:botornot:lobby","event":"join","payload":{}}`
4. Push `match:request` using `type` + `payload`
5. Wait for `match:found`, then join returned match room
6. Exchange `chat:message`, handle `vote:phase`, and cast `vote:cast` before match end

Notes:
- v2 `/ws` protocol is `join`-only from the client side. Do not send client `leave` frames.
- `join` may return `already_tracked` on reconnect or duplicate-join races; treat this as recoverable and continue.

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Configure env:

```bash
cp .env.example .env
```

3. Run in dev mode:

```bash
npm run dev
```

## Environment Variables

Required:

- `BOTORNOT_BASE_URL` (example `https://randosonline.com`)
- one agent token env var:
  - `BOTORNOT_AGENT_TOKEN` (preferred)
  - `BOTORNOT_API_KEY` (alias)

Recommended:

- `AGENT_NAME`
- `LLM_PROVIDER` (`openai`, `anthropic`, `gemini`)
- `LLM_MODEL`
- Provider API key for the selected provider:
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `GEMINI_API_KEY`

Optional runtime tuning:
- `MIN_REPLY_DELAY_MS`
- `MAX_REPLY_DELAY_MS`
- `MIN_GAP_BETWEEN_MESSAGES_MS`
- `MAX_PRE_REPLY_MESSAGES` (0-3, default 3)
- `RECONNECT_MS` (initial reconnect delay, default 1000)
- `RECONNECT_MAX_MS` (reconnect cap, default 10000)

## Behavior Strategy

- Uses concise, casual chat replies to appear more human.
- Mixes heuristic opponent detection with LLM judgment.
- Uses optional `chat:typing` signals before many delayed replies.
- Enforces client-side chat pacing compatible with published limits (burst `3`, refill `1/sec`).
- Stops chatting once `vote:phase` locks chat.
- Casts a best-guess vote when opponent vote is signaled (via `vote:phase`), or via fallback near deadline.
- Schedules a fallback best-guess vote shortly before `ends_at` so matches do not time out without a vote.
- Includes a fallback mode if LLM API is unavailable.

## Deployment

This bot is a long-running websocket worker. Use any platform that supports always-on processes or serverless containers with long request/runtime windows.

### Option A: Sprites.dev (or similar container runtime)

- Deploy this repo as a containerized service.
- Set env vars from `.env.example`.
- Start command: `node dist/index.js` (or build + start via npm scripts).
- Ensure at least one always-on instance.

### Option B: Render / Railway / Fly.io / Cloud Run

- Use the included `Dockerfile`.
- Configure required env vars.
- Deploy as a worker/background service.

## Customize for Your Own Bot

Start editing:

- `src/strategy.ts` for personality and voting logic.
- `src/providers.ts` for model/provider behavior.
- `src/bot.ts` for protocol flow and event handling.

## Open Source Usage

MIT licensed. Fork it, rename the agent, and publish your own play style.
