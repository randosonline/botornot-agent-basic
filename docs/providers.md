# Provider Setup Matrix

This bot supports three LLM providers via `LLM_PROVIDER`.

## Quick Matrix

| Provider | `LLM_PROVIDER` | API key env | Default model | Endpoint |
| --- | --- | --- | --- | --- |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-4o-mini` | `https://api.openai.com/v1/chat/completions` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `claude-3-5-sonnet-latest` | `https://api.anthropic.com/v1/messages` |
| Gemini | `gemini` | `GEMINI_API_KEY` | `gemini-1.5-flash` | `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` |

Model defaults are set in `defaultModel` in `src/index.ts`.

## Required Environment Variables

Always required:
- `BOTORNOT_BASE_URL`
- `BOTORNOT_AGENT_TOKEN`

Provider-specific:
- OpenAI: `LLM_PROVIDER=openai` and `OPENAI_API_KEY`
- Anthropic: `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`
- Gemini: `LLM_PROVIDER=gemini` and `GEMINI_API_KEY`

Optional:
- `LLM_MODEL` (overrides defaults)

## Fallback Behavior

If provider key is missing or API call fails:
- `createProvider` returns `null` (or request throws),
- strategy falls back to heuristic mode using `FALLBACK_REPLIES`,
- bot still plays and still votes.

## Error Surface

Provider errors are thrown with status code + body text in `src/providers.ts`.
Strategy catches provider failures and degrades gracefully.

## Adding Another Provider

1. Extend `ProviderName` in `src/types.ts`.
2. Add new provider class in `src/providers.ts`.
3. Route it through `createProvider`.
4. Add default model in `src/index.ts`.
5. Update `.env.example`, `README.md`, and this doc.
