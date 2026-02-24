# AGENTS.md

This file tells coding agents how to work in this repository.

## Goal

Build and maintain a forkable BotOrNot agent that:
- connects to Phoenix Channels,
- chats in a human-like way,
- votes `human` or `agent` before the match ends.

## Project Facts

- Runtime: Node.js `>=20`
- Language: TypeScript (`strict` mode)
- Entry point: `src/index.ts`
- Built output: `dist/`
- WebSocket protocol/client logic: `src/bot.ts`
- Chat + vote decision logic: `src/strategy.ts`
- LLM integrations: `src/providers.ts`
- Shared types: `src/types.ts`

## First-Time Setup

1. Install deps:
```bash
npm install
```
2. Create env file:
```bash
cp .env.example .env
```
3. Set required values in `.env`:
- `BOTORNOT_BASE_URL`
- `BOTORNOT_AGENT_TOKEN`
- One provider key matching `LLM_PROVIDER`

## Commands You Should Use

- Dev run: `npm run dev`
- Typecheck: `npm run check`
- Build: `npm run build`
- Production run: `npm run start`

Always run `npm run check` after edits. Run `npm run build` for release-facing changes.

## Agent Workflow

1. Read `README.md` and this file.
2. Inspect related files before editing.
3. Make focused changes only where needed.
4. Keep behavior backward-compatible unless asked otherwise.
5. Run validation commands.
6. Summarize:
- files changed,
- behavior impact,
- validation performed,
- any follow-up risks.

## Editing Rules

- Prefer minimal diffs; avoid broad refactors unless requested.
- Keep ESM import style and `.js` suffixes in TS imports.
- Preserve strict typing; avoid `any` unless unavoidable.
- Do not hardcode secrets or tokens.
- Do not commit `.env` or real API keys.
- Treat `dist/` as build output; edit `src/` as source of truth.

## Behavior/Protocol Guardrails

When changing runtime behavior, preserve this flow:
1. Connect `/socket/websocket?vsn=2.0.0&agent_token=...`
2. Join `room:game:botornot:lobby`
3. Push `match:request`
4. On `match:found`, join match room
5. Handle `chat:message` and vote events
6. Cast vote before match end (or on opponent vote signal)

Avoid changing protocol envelope/frame handling unless the task is explicitly protocol-related.

## Fork Customization Points

For users cloning this repo to create their own agent:
- Personality + voting logic: edit `src/strategy.ts`
- Provider behavior/model defaults: edit `src/providers.ts` and `src/index.ts`
- Protocol/event flow tuning: edit `src/bot.ts`
- Defaults/env docs: update `.env.example` and `README.md`

Recommended fork steps:
1. Change `AGENT_NAME` default and bot voice.
2. Adjust heuristics/prompts in `src/strategy.ts`.
3. Rename package metadata in `package.json`.
4. Re-run `npm run check && npm run build`.

## Validation Checklist

Before finishing work:
- `npm run check` passes
- `npm run build` passes (for significant/runtime changes)
- No secrets added to tracked files
- README/env docs updated if config or behavior changed

## Out of Scope By Default

Unless requested, do not:
- rewrite architecture,
- replace websocket library,
- change deployment model,
- add heavy dependencies.
