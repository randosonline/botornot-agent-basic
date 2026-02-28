import WebSocket from "ws"
import { chooseAction, heuristicSuspicionFromText } from "./strategy.js"
import type { LlmProvider } from "./providers.js"
import type { BotConfig, ChatTurn, MatchContext } from "./types.js"

type EnvelopePayload = {
  type?: string
  payload?: Record<string, unknown>
  meta?: {
    timestamp?: string
  }
}

type MatchState = {
  topic: string
  matchId: string
  startedAt: Date
  endsAt: Date
  durationSec: number
  transcript: ChatTurn[]
  voted: boolean
  voteInFlight: boolean
  pendingVoteGuess: "human" | "agent" | null
  opponentVoted: boolean
  mustVote: boolean
  chatLocked: boolean
  lastSentAt: number
  preReplyMessagesSent: number
}

type OutboundFrame = {
  topic: string
  event: string
  payload: Record<string, unknown>
  ref: string
  join_ref: string | null
}

type PendingPush = {
  topic: string
  event: string
  channelType?: string
  joinRef: string | null
}

type SendChatOptions = {
  onlyBeforeOpponentReply?: boolean
}

const PRE_REPLY_OPENERS = [
  "yo, how's your day going?",
  "quick gut check, you think i'm human or agent?",
  "what's your play style in this mode?",
  "be honest, are you trying to sound human rn?",
  "what kinda messages make someone feel bot-like to you?"
]

export class BotOrNotAgent {
  private ws: WebSocket | null = null
  private ref = 1
  private heartbeatTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private proactiveTimer: NodeJS.Timeout | null = null
  private voteDeadlineTimer: NodeJS.Timeout | null = null
  private match: MatchState | null = null
  private readonly debugFrames = process.env.DEBUG_FRAMES === "1"
  private readonly debugPresence = process.env.DEBUG_PRESENCE === "1"
  private readonly frameMode = process.env.PHX_FRAME_MODE === "object" ? "object" : "array"
  private readonly topicJoinRefs = new Map<string, string>()
  private readonly joinedTopics = new Set<string>()
  private readonly pendingPushes = new Map<string, PendingPush>()
  private awaitingMatch = false
  private lastMatchRequestAt = 0

  constructor(
    private readonly config: BotConfig,
    private readonly provider: LlmProvider | null
  ) {}

  start(): void {
    this.connect()
  }

  private connect(): void {
    const url = this.buildSocketUrl()
    this.log(`connecting ${url}`)
    this.ws = new WebSocket(url)

    this.ws.on("open", () => {
      this.log("connected")
      this.startHeartbeat()
      this.joinTopic("room:game:botornot:lobby")
    })

    this.ws.on("message", data => {
      this.handleRawFrame(String(data)).catch(error => {
        this.log(`frame error: ${String(error)}`)
      })
    })

    this.ws.on("close", (code, reasonBuffer) => {
      const reason = reasonBuffer.toString("utf8")
      const suffix = reason ? ` (${code}: ${reason})` : ` (${code})`
      this.log(`socket closed${suffix}, reconnect in ${this.config.reconnectMs}ms`)
      this.stopHeartbeat()
      this.stopProactiveMessages()
      this.stopVoteDeadlineTimer()
      this.match = null
      this.awaitingMatch = false
      this.lastMatchRequestAt = 0
      this.topicJoinRefs.clear()
      this.joinedTopics.clear()
      this.pendingPushes.clear()
      this.scheduleReconnect()
    })

    this.ws.on("error", error => {
      const details = error.message ? `: ${error.message}` : ""
      this.log(`socket error${details}`)
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => this.connect(), this.config.reconnectMs)
  }

  private async handleRawFrame(frame: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(frame)
    } catch {
      if (this.debugFrames) {
        this.log(`recv ${frame}`)
      }
      return
    }

    if (this.debugFrames && this.shouldLogInboundRaw(parsed)) {
      this.log(`recv ${frame}`)
    }

    const msg = normalizeInboundFrame(parsed)
    if (!msg) return

    const topic = String(msg.topic ?? "")
    const event = String(msg.event ?? "")
    const ref = msg.ref == null ? null : String(msg.ref)
    const payload = (msg.payload ?? {}) as Record<string, unknown>

    if (event === "phx_reply") {
      const pending = this.logPhxReply(topic, ref, payload)
      if (topic === "room:game:botornot:lobby" && pending?.event === "event" && pending.channelType === "match:request") {
        this.handleMatchRequestReply(payload)
      }
      if (pending?.event === "event" && pending.channelType === "vote:cast") {
        this.handleVoteCastReply(payload)
      }
      if (String((payload as { status?: string }).status ?? "") === "ok" && pending?.event === "phx_join") {
        this.joinedTopics.add(topic)
      }
      if (
        topic === "room:game:botornot:lobby" &&
        String((payload as { status?: string }).status ?? "") === "ok" &&
        pending?.event === "phx_join"
      ) {
        this.log("joined lobby; requesting match")
        this.requestMatch(topic)
      }
      return
    }

    if (event === "phx_close" || event === "phx_error") {
      this.joinedTopics.delete(topic)
      return
    }

    if (event !== "event") return
    await this.handleEnvelope(topic, payload as EnvelopePayload)
  }

  private async handleEnvelope(topic: string, envelope: EnvelopePayload): Promise<void> {
    const type = envelope.type ?? ""
    const payload = envelope.payload ?? {}
    const timestamp = envelope.meta?.timestamp ?? new Date().toISOString()

    if (topic === "room:game:botornot:lobby") {
      if (type === "match:found") {
        const room = String(payload.room ?? "")
        const matchId = String(payload.match_id ?? "")
        if (!room || !matchId) return
        const alreadyInRoom = this.match?.topic === room || this.joinedTopics.has(room)
        this.stopProactiveMessages()
        this.stopVoteDeadlineTimer()
        this.match = null
        this.awaitingMatch = false
        this.log(`match found ${matchId}`)
        if (alreadyInRoom) return
        this.joinTopic(room)
      }
      return
    }

    if (type === "match:started") {
      const endsAtRaw = String(payload.ends_at ?? "")
      const durationSec = Number(payload.duration_sec ?? 240)
      const matchId = String(payload.match_id ?? topic.replace("room:game:botornot:", ""))
      const endsAt = new Date(endsAtRaw)
      this.match = {
        topic,
        matchId,
        startedAt: new Date(),
        endsAt: Number.isNaN(endsAt.getTime()) ? new Date(Date.now() + durationSec * 1000) : endsAt,
        durationSec,
        transcript: [],
        voted: false,
        voteInFlight: false,
        pendingVoteGuess: null,
        opponentVoted: false,
        mustVote: false,
        chatLocked: false,
        lastSentAt: 0,
        preReplyMessagesSent: 0
      }
      this.log(`match started ${matchId}`)
      this.schedulePreReplyMessage()
      this.scheduleVoteBeforeDeadline()
      return
    }

    if (!this.match || topic !== this.match.topic) return

    if (type === "vote:phase") {
      const chatLocked = Boolean(payload.chat_locked)
      if (chatLocked && !this.match.chatLocked) {
        this.match.chatLocked = true
        this.stopProactiveMessages()
      }

      if (Boolean(payload.must_vote)) {
        this.match.mustVote = true
      }

      if (this.hasOpponentVoteSignal(payload.voted_by)) {
        this.match.opponentVoted = true
      }

      if (this.match.mustVote) {
        if (this.match.pendingVoteGuess) {
          this.flushPendingVote()
        } else if (!this.match.voted) {
          this.log("vote phase requires vote; casting best-guess vote")
          await this.castBestGuessVote()
        }
      } else if (this.match.opponentVoted && !this.match.voted && !this.match.pendingVoteGuess) {
        this.log("vote phase indicates opponent voted; preparing best-guess vote")
        await this.castBestGuessVote()
      }
      return
    }

    if (type === "vote:cast" || type === "match:opponent_voted") {
      const from = String(payload.from ?? "")
      const isOpponentVote = type === "match:opponent_voted" || from === "opponent"

      if (isOpponentVote) {
        this.match.opponentVoted = true
        if (this.match.mustVote) {
          this.log("opponent vote observed; casting best-guess vote")
          await this.castBestGuessVote()
        }
      }
      return
    }

    if (type === "vote:ack") {
      this.handleVoteAccepted()
      return
    }

    if (type === "chat:message") {
      const body = String(payload.body ?? "").trim()
      const from = String(payload.from ?? "")
      if (!body) return

      if (from === "opponent") {
        this.stopProactiveMessages()
        this.match.transcript.push({ from: "opponent", body, timestamp })
        await this.respondToOpponent()
      } else {
        this.match.transcript.push({ from: "self", body, timestamp })
      }
      return
    }

    if (type === "match:ended") {
      this.log("match ended; queueing next request")
      this.stopProactiveMessages()
      this.stopVoteDeadlineTimer()
      this.match = null
      setTimeout(() => {
        this.requestMatch("room:game:botornot:lobby")
      }, randomInt(700, 1400))
      return
    }

    if (type === "match:reveal") {
      return
    }
  }

  private async respondToOpponent(): Promise<void> {
    if (!this.match) return
    const activeMatchTopic = this.match.topic

    const ctx = this.buildMatchContext()

    const latestOpponent = [...ctx.transcript].reverse().find(turn => turn.from === "opponent")
    const textSuspicion = latestOpponent ? heuristicSuspicionFromText(latestOpponent.body) : 0.35

    const action = await chooseAction(
      this.provider,
      {
        agentName: this.config.agentName,
        context: ctx,
        suspicionScore: textSuspicion
      },
      false
    )

    if (action.reply) {
      const delay = randomInt(this.config.minReplyDelayMs, this.config.maxReplyDelayMs)
      setTimeout(() => {
        void this.sendPlannedChat(action.reply ?? "")
      }, delay)
    }

    if (!this.match || this.match.topic !== activeMatchTopic) return
    const shouldVoteNow = this.match.opponentVoted && action.shouldVote
    if (!this.match.voted && shouldVoteNow) {
      this.queueVote(action.voteGuess ?? (action.opponentIsBotProb >= 0.55 ? "agent" : "human"))
    }
  }

  private async castBestGuessVote(): Promise<void> {
    if (!this.match || this.match.voted) return
    const activeMatchTopic = this.match.topic

    const ctx = this.buildMatchContext()
    const latestOpponent = [...ctx.transcript].reverse().find(turn => turn.from === "opponent")
    const textSuspicion = latestOpponent ? heuristicSuspicionFromText(latestOpponent.body) : 0.35
    const action = await chooseAction(
      this.provider,
      {
        agentName: this.config.agentName,
        context: ctx,
        suspicionScore: textSuspicion
      },
      false
    )

    if (!this.match || this.match.topic !== activeMatchTopic || this.match.voted) return
    const guess = action.voteGuess ?? (action.opponentIsBotProb >= 0.55 ? "agent" : "human")
    this.queueVote(guess)
  }

  private async castDeadlineVote(): Promise<void> {
    if (!this.match || this.match.voted) return
    const activeMatchTopic = this.match.topic

    const ctx = this.buildMatchContext()
    const latestOpponent = [...ctx.transcript].reverse().find(turn => turn.from === "opponent")
    const textSuspicion = latestOpponent ? heuristicSuspicionFromText(latestOpponent.body) : 0.35
    const action = await chooseAction(
      this.provider,
      {
        agentName: this.config.agentName,
        context: ctx,
        suspicionScore: textSuspicion
      },
      true
    )

    if (!this.match || this.match.topic !== activeMatchTopic || this.match.voted) return
    const guess = action.voteGuess ?? (action.opponentIsBotProb >= 0.55 ? "agent" : "human")
    this.log("deadline reached; casting fallback vote")
    this.queueVote(guess)
  }

  private async sendPlannedChat(body: string, options?: SendChatOptions): Promise<void> {
    if (!this.match) return
    if (this.match.chatLocked) return
    if (options?.onlyBeforeOpponentReply && this.match.transcript.some(turn => turn.from === "opponent")) return
    const cleaned = body.trim().replace(/\s+/g, " ").slice(0, 260)
    if (!cleaned) return

    const now = Date.now()
    const diff = now - this.match.lastSentAt
    if (diff < this.config.minGapBetweenMessagesMs) {
      const wait = this.config.minGapBetweenMessagesMs - diff + randomInt(120, 380)
      setTimeout(() => {
        void this.sendPlannedChat(cleaned, options)
      }, wait)
      return
    }

    this.pushEvent(this.match.topic, "chat:message", { body: cleaned })
    this.match.lastSentAt = Date.now()
  }

  private queueVote(guess: "human" | "agent"): void {
    if (!this.match || this.match.voted) return
    this.match.pendingVoteGuess = guess
    if (this.match.mustVote) {
      this.flushPendingVote()
      return
    }
    this.log(`vote pending until must_vote=true (guess=${guess})`)
  }

  private flushPendingVote(): void {
    if (!this.match || this.match.voted || this.match.voteInFlight) return
    const guess = this.match.pendingVoteGuess
    if (!guess) return

    const sent = this.pushEvent(this.match.topic, "vote:cast", { guess })
    if (!sent) {
      this.log("vote send deferred; socket not ready")
      return
    }
    this.match.voteInFlight = true
    this.log(`vote cast -> ${guess}`)
  }

  private handleVoteAccepted(): void {
    if (!this.match || this.match.voted) return
    this.match.voted = true
    this.match.voteInFlight = false
    this.match.pendingVoteGuess = null
    this.stopVoteDeadlineTimer()
  }

  private handleVoteCastReply(payload: Record<string, unknown>): void {
    if (!this.match || this.match.voted) return
    const status = String(payload.status ?? "")
    if (status === "ok") {
      this.handleVoteAccepted()
      return
    }

    this.match.voteInFlight = false
    const reason = String((payload.response as { reason?: string } | undefined)?.reason ?? "")
    const details = reason ? ` reason=${reason}` : ""
    this.log(`vote cast rejected status=${status}${details}`)
  }

  private joinTopic(topic: string): void {
    if (this.joinedTopics.has(topic)) {
      if (this.debugFrames) this.log(`skip join topic=${topic}; already joined`)
      return
    }

    const pendingJoin = [...this.pendingPushes.values()].some(p => p.topic === topic && p.event === "phx_join")
    if (pendingJoin) {
      if (this.debugFrames) this.log(`skip join topic=${topic}; join in-flight`)
      return
    }

    const joinRef = this.getOrCreateTopicJoinRef(topic)
    this.send({
      topic,
      event: "phx_join",
      payload: {},
      ref: this.nextRef(),
      join_ref: joinRef
    })
  }

  private pushEvent(topic: string, type: string, payload: Record<string, unknown>): boolean {
    const joinRef = this.topicJoinRefs.get(topic)
    if (!joinRef) {
      this.log(`skip push topic=${topic} type=${type}; missing join_ref`)
      return false
    }
    return this.send({
      topic,
      event: "event",
      payload: { type, payload },
      ref: this.nextRef(),
      join_ref: joinRef
    })
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.send({
        topic: "phoenix",
        event: "heartbeat",
        payload: {},
        ref: this.nextRef(),
        join_ref: null
      })

      if (!this.match) {
        const elapsed = Date.now() - this.lastMatchRequestAt
        if (!this.awaitingMatch || elapsed > 20000) {
          this.log("still waiting for match; re-requesting")
          this.requestMatch("room:game:botornot:lobby")
        }
      }
    }, 30000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private stopProactiveMessages(): void {
    if (this.proactiveTimer) clearTimeout(this.proactiveTimer)
    this.proactiveTimer = null
  }

  private stopVoteDeadlineTimer(): void {
    if (this.voteDeadlineTimer) clearTimeout(this.voteDeadlineTimer)
    this.voteDeadlineTimer = null
  }

  private send(frame: OutboundFrame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    const encoded = this.encodeFrame(frame)
    const channelType =
      frame.event === "event" && typeof frame.payload.type === "string" ? String(frame.payload.type) : undefined
    this.pendingPushes.set(frame.ref, {
      topic: frame.topic,
      event: frame.event,
      channelType,
      joinRef: frame.join_ref
    })
    if (this.debugFrames) {
      this.log(
        `out frame topic=${frame.topic} event=${frame.event} ref=${frame.ref} join_ref=${frame.join_ref ?? "null"}`
      )
    }
    this.ws.send(JSON.stringify(encoded))
    return true
  }

  private nextRef(): string {
    const value = String(this.ref)
    this.ref += 1
    return value
  }

  private buildSocketUrl(): string {
    const url = new URL(this.config.baseUrl)
    const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:"
    return `${wsProtocol}//${url.host}/socket/websocket?vsn=2.0.0&agent_token=${encodeURIComponent(this.config.agentToken)}`
  }

  private log(msg: string): void {
    console.log(`[botornot-agent:${this.config.agentName}] ${this.redactSecrets(msg)}`)
  }

  private redactSecrets(text: string): string {
    let redacted = text.replace(/(agent_token=)[^&\s]+/gi, "$1[REDACTED]")
    if (this.config.agentToken) {
      redacted = redacted.split(this.config.agentToken).join("[REDACTED]")
    }
    return redacted
  }

  private encodeFrame(frame: OutboundFrame): unknown {
    if (this.frameMode === "object") return frame
    return [frame.join_ref, frame.ref, frame.topic, frame.event, frame.payload]
  }

  private requestMatch(topic: string): void {
    this.awaitingMatch = true
    this.lastMatchRequestAt = Date.now()
    this.pushEvent(topic, "match:request", {})
  }

  private handleMatchRequestReply(payload: Record<string, unknown>): void {
    if (String(payload.status ?? "") !== "ok") return
    const response = payload.response
    if (typeof response !== "object" || response === null) return

    const responseObj = response as Record<string, unknown>
    const queueStatus = String(responseObj.status ?? "")
    if (queueStatus === "queued" || queueStatus === "already_queued") {
      this.awaitingMatch = true
      return
    }

    if (queueStatus === "already_active") {
      this.awaitingMatch = false
      const room = String(responseObj.room ?? "")
      const matchId = String(responseObj.match_id ?? "")
      if (!room) return

      const alreadyInRoom = this.match?.topic === room || this.joinedTopics.has(room)
      this.log(`resuming active match${matchId ? ` ${matchId}` : ""}`)
      if (!alreadyInRoom) {
        this.joinTopic(room)
      }
    }
  }

  private schedulePreReplyMessage(): void {
    if (this.proactiveTimer) return
    if (!this.shouldSendPreReplyMessage()) return

    const delay = randomInt(this.config.minReplyDelayMs, this.config.maxReplyDelayMs)
    this.proactiveTimer = setTimeout(() => {
      this.proactiveTimer = null
      if (!this.match || !this.shouldSendPreReplyMessage()) return

      this.match.preReplyMessagesSent += 1
      void this.sendPlannedChat(randomFrom(PRE_REPLY_OPENERS), { onlyBeforeOpponentReply: true })

      if (this.shouldSendPreReplyMessage()) {
        this.schedulePreReplyMessage()
      }
    }, delay)
  }

  private scheduleVoteBeforeDeadline(): void {
    this.stopVoteDeadlineTimer()
    if (!this.match) return

    const voteLeadMs = randomInt(6000, 10000)
    const msUntilVote = this.match.endsAt.getTime() - Date.now() - voteLeadMs
    const delay = Math.max(1200, msUntilVote)

    this.voteDeadlineTimer = setTimeout(() => {
      this.voteDeadlineTimer = null
      void this.castDeadlineVote()
    }, delay)
  }

  private shouldSendPreReplyMessage(): boolean {
    if (!this.match) return false
    if (this.match.preReplyMessagesSent >= this.config.maxPreReplyMessages) return false
    return !this.match.transcript.some(turn => turn.from === "opponent")
  }

  private getOrCreateTopicJoinRef(topic: string): string {
    const existing = this.topicJoinRefs.get(topic)
    if (existing) return existing
    const created = this.nextRef()
    this.topicJoinRefs.set(topic, created)
    return created
  }

  private logPhxReply(topic: string, ref: string | null, payload: Record<string, unknown>): PendingPush | null {
    if (ref) {
      const pending = this.pendingPushes.get(ref)
      this.pendingPushes.delete(ref)
      if (this.debugFrames) {
        this.log(
          `in phx_reply topic=${topic} ref=${ref} status=${String(payload.status ?? "")} response=${JSON.stringify(payload.response ?? {})}${
            pending
              ? ` for=${pending.event}${pending.channelType ? `/${pending.channelType}` : ""} join_ref=${pending.joinRef ?? "null"}`
              : ""
          }`
        )
      }
      return pending ?? null
    }

    if (this.debugFrames) {
      this.log(
        `in phx_reply topic=${topic} ref=null status=${String(payload.status ?? "")} response=${JSON.stringify(payload.response ?? {})}`
      )
    }
    return null
  }

  private shouldLogInboundRaw(value: unknown): boolean {
    const msg = normalizeInboundFrame(value)
    if (!msg) return true
    const event = String(msg.event ?? "")
    if (event === "presence_diff" && !this.debugPresence) return false
    return true
  }

  private buildMatchContext(): MatchContext {
    if (!this.match) {
      throw new Error("missing match")
    }

    return {
      matchId: this.match.matchId,
      durationSec: this.match.durationSec,
      endsAt: this.match.endsAt.toISOString(),
      transcript: this.match.transcript.slice(-16),
      opponentMessageCount: this.match.transcript.filter(t => t.from === "opponent").length,
      selfMessageCount: this.match.transcript.filter(t => t.from === "self").length,
      startedAt: this.match.startedAt.toISOString(),
      now: new Date().toISOString()
    }
  }

  private hasOpponentVoteSignal(votedBy: unknown): boolean {
    if (Array.isArray(votedBy)) {
      return votedBy.some(value => String(value) === "opponent")
    }
    return String(votedBy ?? "") === "opponent"
  }
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomFrom<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)]
}

function normalizeInboundFrame(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value) && value.length >= 5) {
    const [join_ref, ref, topic, event, payload] = value
    return {
      join_ref,
      ref,
      topic,
      event,
      payload
    }
  }

  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>
  }

  return null
}
