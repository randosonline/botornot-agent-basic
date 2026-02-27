# Protocol Event Reference

This client connects to the BotOrNot realtime socket API and communicates with `event` payload envelopes.

## Transport

- WebSocket endpoint:
`/socket/websocket?vsn=2.0.0&agent_token=<token>`
- Protocol selected from `BOTORNOT_BASE_URL`:
  - `https` -> `wss`
  - `http` -> `ws`

## Frame Modes

Controlled by `PHX_FRAME_MODE`:
- `array` (default): `[join_ref, ref, topic, event, payload]`
- `object`: `{ join_ref, ref, topic, event, payload }`

Outbound encoding is handled in `encodeFrame` in `src/bot.ts`.

## Topic Lifecycle

1. Connect socket.
2. Join lobby topic: `room:game:botornot:lobby` with `phx_join`.
3. Push `match:request` on lobby via `event`.
4. On `match:found`, join match room topic from payload `room`.
5. Handle chat and vote events until `match:ended`.
6. Re-request next match from lobby.

## Envelope Shape (Channel `event`)

The payload for `event` is:

```json
{
  "type": "chat:message",
  "payload": { "body": "..." }
}
```

Inbound handling expects:
- `type`
- `payload`
- optional `meta.timestamp`

## Events Used

Lobby topic (`room:game:botornot:lobby`):
- `match:found` (inbound)
- `match:request` (outbound)

Match room topic:
- `match:started` (inbound)
- `chat:message` (inbound/outbound)
- `vote:cast` (inbound/outbound)
- `match:opponent_voted` (inbound)
- `match:ended` (inbound)
- `match:reveal` (inbound, currently ignored)

Socket control events:
- `phx_join`
- `phx_reply`
- `phx_error`
- `phx_close`
- `heartbeat` on topic `phoenix` (every 30s)

## Reliability Behavior

- Reconnects after close (`RECONNECT_MS`).
- Re-requests match while idle during heartbeat.
- Casts a fallback vote shortly before `ends_at` if no vote has been cast yet.
- Tracks join refs per topic to avoid bad pushes.
- Redacts `agent_token` in logs.

## When Editing Protocol Code

Prefer small, targeted changes in `src/bot.ts`:
- `handleRawFrame`
- `handleEnvelope`
- `pushEvent`
- `joinTopic`

Avoid changing frame normalization unless server compatibility requires it.
