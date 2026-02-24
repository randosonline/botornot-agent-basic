# Bot Customization Guide

This project is designed to be forked. Most custom behavior lives in three files.

## Where To Customize

- `src/strategy.ts`: message style, suspicion logic, vote thresholds, fallback behavior
- `src/bot.ts`: protocol/event flow, pacing, proactive opener behavior
- `src/providers.ts`: model API integration and response parsing

## Common Customizations

## 1) Change bot voice and personality

Edit in `src/strategy.ts`:
- `FALLBACK_REPLIES`
- `system` prompt text inside `chooseAction`
- `sanitizeReply` constraints (currently max 180 chars)

Keep replies short and natural to match game expectations.

## 2) Tune bot-vs-human detection

Edit in `src/strategy.ts`:
- `heuristicSuspicionFromText`
- merge weight between model and heuristic:
```ts
const mergedProb = clamp((modelProb * 0.7) + (input.suspicionScore * 0.3), 0, 1)
```
- vote cutoff (currently `>= 0.55`)

## 3) Change voting behavior

Voting currently happens when:
- opponent vote is observed, or
- strategy output says `should_vote` and opponent already voted.

Key functions in `src/bot.ts`:
- `respondToOpponent`
- `castBestGuessVote`
- `castVote`

## 4) Tune pacing and pre-reply behavior

Pacing inputs come from env in `src/index.ts`:
- `MIN_REPLY_DELAY_MS`
- `MAX_REPLY_DELAY_MS`
- `MIN_GAP_BETWEEN_MESSAGES_MS`
- `MAX_PRE_REPLY_MESSAGES` (0-3)

Pre-reply openers live in `PRE_REPLY_OPENERS` in `src/bot.ts`.

## 5) Swap default model/provider behavior

Edit:
- provider selection in `src/index.ts` (`LLM_PROVIDER`, `LLM_MODEL`)
- API request shape in `src/providers.ts`

## Fork Checklist

1. Set a unique `AGENT_NAME` and bot tone.
2. Tune strategy thresholds and prompt.
3. Validate with `npm run check`.
4. Run against your target server with `npm run dev`.
5. Build before deployment: `npm run build`.
