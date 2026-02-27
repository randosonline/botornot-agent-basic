import test from "node:test"
import assert from "node:assert/strict"
import { BotOrNotAgent } from "../src/bot.js"
import type { BotConfig } from "../src/types.js"

test("respondToOpponent does not throw when match ends during provider await", async () => {
  const config: BotConfig = {
    baseUrl: "https://randosonline.com",
    agentToken: "test-token",
    agentName: "race-test-bot",
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    reconnectMs: 50,
    minReplyDelayMs: 0,
    maxReplyDelayMs: 0,
    minGapBetweenMessagesMs: 0,
    maxPreReplyMessages: 0
  }

  const provider = {
    async generateJson(): Promise<string> {
      await new Promise(resolve => setTimeout(resolve, 20))
      return "{\"reply\":\"ok\",\"opponent_is_bot_prob\":0.4,\"should_vote\":false,\"vote_guess\":\"human\"}"
    }
  }

  const agent = new BotOrNotAgent(config, provider)
  const now = new Date()
  const activeMatch = {
    topic: "room:game:botornot:test-match",
    matchId: "test-match",
    startedAt: now,
    endsAt: new Date(now.getTime() + 60_000),
    durationSec: 60,
    transcript: [{ from: "opponent" as const, body: "hey", timestamp: now.toISOString() }],
    voted: false,
    opponentVoted: false,
    lastSentAt: 0,
    preReplyMessagesSent: 0
  }

  ;(agent as unknown as { match: typeof activeMatch | null }).match = activeMatch

  setTimeout(() => {
    ;(agent as unknown as { match: typeof activeMatch | null }).match = null
  }, 0)

  await assert.doesNotReject(async () => {
    await (agent as unknown as { respondToOpponent: () => Promise<void> }).respondToOpponent()
  })
})
