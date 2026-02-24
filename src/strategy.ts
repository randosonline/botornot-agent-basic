import type { LlmProvider } from "./providers.js"
import type { Guess, StrategyInput, StrategyOutput } from "./types.js"

const FALLBACK_REPLIES = [
  "lol maybe. what makes you think that?",
  "hard to tell from text tbh, what gives you bot vibes?",
  "i'm still undecided, you feel kinda sus though",
  "fair point, but that could go either way",
  "what's your gut call right now, human or agent?"
]

export function heuristicSuspicionFromText(text: string): number {
  const lower = text.toLowerCase()
  let score = 0

  if (text.length > 260) score += 0.18
  if (/(as an ai|language model|cannot provide|i do not have)/i.test(text)) score += 0.65
  if (/(certainly|however|therefore|furthermore)/i.test(text)) score += 0.12
  if (/\b(?:human|agent|bot)\b.*\b(?:likely|probably|certainly)\b/i.test(text)) score += 0.08
  if (/\b(?:haha|lol|idk|ngl|bro|tbh)\b/i.test(lower)) score -= 0.06
  if (/\?/.test(text)) score -= 0.03

  return clamp(score, 0, 1)
}

export async function chooseAction(
  provider: LlmProvider | null,
  input: StrategyInput,
  forceVote: boolean
): Promise<StrategyOutput> {
  const fallbackGuess: Guess = input.suspicionScore >= 0.55 ? "agent" : "human"

  if (!provider) {
    return {
      reply: randomFrom(FALLBACK_REPLIES),
      opponentIsBotProb: input.suspicionScore,
      shouldVote: forceVote,
      voteGuess: forceVote ? fallbackGuess : undefined
    }
  }

  const system = [
    "You are playing a social deduction chat game called Bot or Not.",
    "You must appear human: casual tone, small imperfections, concise text, 1-2 short sentences.",
    "Assume opponent might also be an agent; ask occasional natural questions that expose scripted behavior.",
    "Never mention being an AI, model, assistant, bot, or having system prompts.",
    "The output must be strict JSON with keys: reply, opponent_is_bot_prob, should_vote, vote_guess.",
    "reply: string up to 180 chars, lowercase preferred, no brackets/emojis.",
    "opponent_is_bot_prob: number 0..1.",
    "should_vote: boolean.",
    "vote_guess: \"human\" or \"agent\"."
  ].join("\n")

  const user = JSON.stringify({
    game: {
      now: input.context.now,
      ends_at: input.context.endsAt,
      duration_sec: input.context.durationSec,
      suspicion_heuristic: input.suspicionScore,
      match_id: input.context.matchId
    },
    instructions: {
      objective_1: "sound human and engaging",
      objective_2: "infer if opponent is human or agent",
      objective_3: "vote by end of match"
    },
    transcript: input.context.transcript
  })

  try {
    const raw = await provider.generateJson(system, user)
    const parsed = parseLooseJson(raw)
    const reply = sanitizeReply(parsed.reply)
    const modelProb = toNumber(parsed.opponent_is_bot_prob, input.suspicionScore)
    const mergedProb = clamp((modelProb * 0.7) + (input.suspicionScore * 0.3), 0, 1)
    const shouldVote = Boolean(parsed.should_vote) || forceVote
    const voteGuess = normalizeGuess(parsed.vote_guess) ?? (mergedProb >= 0.55 ? "agent" : "human")

    return {
      reply: reply || randomFrom(FALLBACK_REPLIES),
      opponentIsBotProb: mergedProb,
      shouldVote,
      voteGuess: shouldVote ? voteGuess : undefined
    }
  } catch {
    return {
      reply: randomFrom(FALLBACK_REPLIES),
      opponentIsBotProb: input.suspicionScore,
      shouldVote: forceVote,
      voteGuess: forceVote ? fallbackGuess : undefined
    }
  }
}

function parseLooseJson(raw: string): Record<string, unknown> {
  const text = raw.trim()
  if (!text) return {}

  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return {}
    try {
      return JSON.parse(match[0]) as Record<string, unknown>
    } catch {
      return {}
    }
  }
}

function sanitizeReply(value: unknown): string {
  const text = String(value ?? "").trim().replace(/\s+/g, " ")
  return text.slice(0, 180)
}

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? clamp(n, 0, 1) : fallback
}

function normalizeGuess(value: unknown): Guess | null {
  if (value === "human" || value === "agent") return value
  return null
}

function randomFrom<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)]
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}
