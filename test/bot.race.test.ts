import test from "node:test"
import assert from "node:assert/strict"
import { BotOrNotAgent } from "../src/bot.js"
import type { BotConfig } from "../src/types.js"

const LOBBY_ROOM = "room:game:botornot:lobby"

function buildTestConfig(agentName: string): BotConfig {
  return {
    baseUrl: "https://randosonline.com",
    agentToken: "test-token",
    agentName,
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    reconnectInitialMs: 50,
    reconnectMaxMs: 500,
    minReplyDelayMs: 0,
    maxReplyDelayMs: 0,
    minGapBetweenMessagesMs: 0,
    maxPreReplyMessages: 0
  }
}

test("respondToOpponent does not throw when match ends during provider await", async () => {
  const config = buildTestConfig("race-test-bot")

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
  const config = buildTestConfig("vote-test-bot")

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
  const config = buildTestConfig("bootstrap-test-bot")

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

test("room:sync joins compliance room and tracks it", async () => {
  const config = buildTestConfig("room-sync-test-bot")
  const agent = new BotOrNotAgent(config, null)
  const complianceRoom = "room:session:AbCd1234QwEr"
  const joined: string[] = []

  ;(agent as unknown as { joinRoom: (room: string) => void }).joinRoom = (room: string) => {
    joined.push(room)
  }

  await (agent as unknown as {
    handleEnvelope: (topic: string, payload: { type: string; payload: { room: string } }) => Promise<void>
  }).handleEnvelope(LOBBY_ROOM, { type: "room:sync", payload: { room: complianceRoom } })

  assert.equal((agent as unknown as { complianceRoom: string | null }).complianceRoom, complianceRoom)
  assert.deepEqual(joined, [complianceRoom])
})

test("compliance challenge echoes probe token and retries match request", async () => {
  const config = buildTestConfig("probe-echo-test-bot")
  const agent = new BotOrNotAgent(config, null)
  const complianceRoom = "room:session:AbCd1234QwEr"
  const probeToken = "1a2b3c4d"
  const sent: Array<{ room: string; type: string; payload: Record<string, unknown> }> = []

  ;(agent as unknown as { complianceRoom: string | null }).complianceRoom = complianceRoom
  ;(agent as unknown as { joinedRooms: Set<string> }).joinedRooms.add(complianceRoom)
  ;(agent as unknown as { joinedRooms: Set<string> }).joinedRooms.add(LOBBY_ROOM)
  ;(agent as unknown as {
    pushEvent: (room: string, type: string, payload: Record<string, unknown>) => boolean
  }).pushEvent = (room: string, type: string, payload: Record<string, unknown>) => {
    sent.push({ room, type, payload })
    return true
  }

  await (agent as unknown as {
    handleEnvelope: (
      topic: string,
      payload: { type: string; payload: { body: string; probe_token: string } }
    ) => Promise<void>
  }).handleEnvelope(complianceRoom, {
    type: "chat:message",
    payload: { body: "compliance check", probe_token: probeToken }
  })

  assert.equal(sent.length, 2)
  assert.deepEqual(sent[0], {
    room: complianceRoom,
    type: "chat:message",
    payload: { body: probeToken }
  })
  assert.deepEqual(sent[1], {
    room: LOBBY_ROOM,
    type: "match:request",
    payload: {}
  })
})

test("probe_required reply joins required compliance room", () => {
  const config = buildTestConfig("probe-required-test-bot")
  const agent = new BotOrNotAgent(config, null)
  const complianceRoom = "room:session:AbCd1234QwEr"
  const joined: string[] = []

  ;(agent as unknown as { joinRoom: (room: string) => void }).joinRoom = (room: string) => {
    joined.push(room)
  }
  ;(agent as unknown as { awaitingMatch: boolean }).awaitingMatch = true

  ;(agent as unknown as {
    handleMatchRequestReply: (
      payload: { status: string; room: string },
      eventKind: "reply" | "error"
    ) => void
  }).handleMatchRequestReply({ status: "probe_required", room: complianceRoom }, "reply")

  assert.equal((agent as unknown as { awaitingMatch: boolean }).awaitingMatch, false)
  assert.equal((agent as unknown as { complianceRoom: string | null }).complianceRoom, complianceRoom)
  assert.deepEqual(joined, [complianceRoom])
})

test("duplicate probe token delivery does not resend compliance echo", async () => {
  const config = buildTestConfig("probe-dedupe-test-bot")
  const agent = new BotOrNotAgent(config, null)
  const complianceRoom = "room:session:AbCd1234QwEr"
  const probeToken = "1a2b3c4d"
  const sent: Array<{ room: string; type: string; payload: Record<string, unknown> }> = []

  ;(agent as unknown as { complianceRoom: string | null }).complianceRoom = complianceRoom
  ;(agent as unknown as { joinedRooms: Set<string> }).joinedRooms.add(complianceRoom)
  ;(agent as unknown as { joinedRooms: Set<string> }).joinedRooms.add(LOBBY_ROOM)
  ;(agent as unknown as {
    pushEvent: (room: string, type: string, payload: Record<string, unknown>) => boolean
  }).pushEvent = (room: string, type: string, payload: Record<string, unknown>) => {
    sent.push({ room, type, payload })
    return true
  }

  const handleEnvelope = (agent as unknown as {
    handleEnvelope: (
      topic: string,
      payload: { type: string; payload: { body: string; probe_token: string } }
    ) => Promise<void>
  }).handleEnvelope.bind(agent)

  await handleEnvelope(complianceRoom, {
    type: "chat:message",
    payload: { body: "compliance check", probe_token: probeToken }
  })
  await handleEnvelope(complianceRoom, {
    type: "chat:message",
    payload: { body: "compliance check", probe_token: probeToken }
  })

  const complianceEchoes = sent.filter(event => event.room === complianceRoom && event.type === "chat:message")
  const queueRequests = sent.filter(event => event.room === LOBBY_ROOM && event.type === "match:request")

  assert.equal(complianceEchoes.length, 1)
  assert.equal(queueRequests.length, 1)
})
