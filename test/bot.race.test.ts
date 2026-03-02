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
    chatLocked: false,
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

test("queued vote is sent on must_vote and confirmed on vote:ack", async () => {
  const config: BotConfig = {
    baseUrl: "https://randosonline.com",
    agentToken: "test-token",
    agentName: "vote-test-bot",
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    reconnectMs: 50,
    minReplyDelayMs: 0,
    maxReplyDelayMs: 0,
    minGapBetweenMessagesMs: 0,
    maxPreReplyMessages: 0
  }

  const agent = new BotOrNotAgent(config, null)
  const now = new Date()
  const activeMatch = {
    topic: "room:game:botornot:test-match",
    matchId: "test-match",
    startedAt: now,
    endsAt: new Date(now.getTime() + 60_000),
    durationSec: 60,
    transcript: [] as Array<{ from: "self" | "opponent"; body: string; timestamp: string }>,
    voted: false,
    voteInFlight: false,
    pendingVoteGuess: null as "human" | "agent" | null,
    opponentVoted: false,
    mustVote: false,
    chatLocked: false,
    lastSentAt: 0,
    preReplyMessagesSent: 0
  }

  const sentVotes: Array<{ guess: string }> = []
  ;(agent as unknown as { pushEvent: (topic: string, type: string, payload: { guess: string }) => boolean }).pushEvent = (
    _topic: string,
    type: string,
    payload: { guess: string }
  ) => {
    if (type === "vote:cast") sentVotes.push(payload)
    return true
  }

  ;(agent as unknown as { match: typeof activeMatch | null }).match = activeMatch
  ;(agent as unknown as { queueVote: (guess: "human" | "agent") => void }).queueVote("human")
  assert.equal(activeMatch.pendingVoteGuess, "human")
  assert.equal(activeMatch.voteInFlight, false)
  assert.equal(sentVotes.length, 0)

  await (agent as unknown as {
    handleEnvelope: (topic: string, payload: { type: string; payload: { must_vote: boolean } }) => Promise<void>
  }).handleEnvelope(activeMatch.topic, { type: "vote:phase", payload: { must_vote: true } })

  assert.equal(activeMatch.mustVote, true)
  assert.equal(activeMatch.voteInFlight, true)
  assert.equal(sentVotes.length, 1)
  assert.equal(sentVotes[0]?.guess, "human")

  await (agent as unknown as {
    handleEnvelope: (topic: string, payload: { type: string; payload: Record<string, unknown> }) => Promise<void>
  }).handleEnvelope(activeMatch.topic, { type: "vote:ack", payload: {} })

  assert.equal(activeMatch.voted, true)
  assert.equal(activeMatch.voteInFlight, false)
  assert.equal(activeMatch.pendingVoteGuess, null)
})

test("bootstraps match on chat event when match:started is missing", async () => {
  const config: BotConfig = {
    baseUrl: "https://randosonline.com",
    agentToken: "test-token",
    agentName: "bootstrap-test-bot",
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    reconnectMs: 50,
    minReplyDelayMs: 0,
    maxReplyDelayMs: 0,
    minGapBetweenMessagesMs: 0,
    maxPreReplyMessages: 0
  }

  const agent = new BotOrNotAgent(config, null)
  const topic = "room:game:botornot:test-bootstrap"
  const sentChats: Array<{ body: string }> = []

  ;(agent as unknown as { joinedRooms: Set<string> }).joinedRooms.add(topic)
  ;(agent as unknown as { pushEvent: (room: string, type: string, payload: { body: string }) => boolean }).pushEvent = (
    _room: string,
    type: string,
    payload: { body: string }
  ) => {
    if (type === "chat:message") sentChats.push(payload)
    return true
  }

  await (agent as unknown as {
    handleEnvelope: (
      topic: string,
      payload: { type: string; payload: { from: string; body: string }; meta: { timestamp: string } }
    ) => Promise<void>
  }).handleEnvelope(topic, {
    type: "chat:message",
    payload: { from: "opponent", body: "hello?" },
    meta: { timestamp: new Date().toISOString() }
  })

  await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(sentChats.length >= 1)
})
