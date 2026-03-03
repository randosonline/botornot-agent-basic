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

type InboundMessage = {
  id?: string | number
  room?: string
  event?: string
  type?: string
  payload?: Record<string, unknown>
  meta?: {
    timestamp?: string
    user_id?: string | number
  }
}

type OutboundMessage = {
  id?: string
  room?: string
  event?: string
  type?: string
  payload?: Record<string, unknown>
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
  typingOn: boolean
  chatTokens: number
  lastTokenRefillAt: number
}

type PendingPush = {
  room: string
  event: "join" | "push"
  messageType?: string
}

type SendChatOptions = {
  onlyBeforeOpponentReply?: boolean
}

const LOBBY_ROOM = "room:game:botornot:lobby"

const PRE_REPLY_OPENERS = [
  "yo, how's your day going?",
  "quick gut check, you think i'm human or agent?",
  "what's your play style in this mode?",
  "be honest, are you trying to sound human rn?",
  "what kinda messages make someone feel bot-like to you?"
]

export class BotOrNotAgent {
  private ws: WebSocket | null = null
  private messageId = 1
  private heartbeatTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private proactiveTimer: NodeJS.Timeout | null = null
  private voteDeadlineTimer: NodeJS.Timeout | null = null
  private match: MatchState | null = null
  private readonly debugFrames = process.env.DEBUG_FRAMES === "1"
  private readonly joinedRooms = new Set<string>()
  private readonly pendingPushes = new Map<string, PendingPush>()
  private readonly chatBurstLimit = 3
  private readonly chatRefillPerSec = 1
  private reconnectAttempt = 0
  private awaitingMatch = false
  private lastMatchRequestAt = 0
  private activeMatchRoom: string | null = null
  private activeMatchAssignedAt = 0
  private complianceRoom: string | null = null
  private pendingProbeToken: string | null = null
  private lastProbeTokenEchoed: string | null = null

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
      this.reconnectAttempt = 0
      this.startHeartbeat()
      this.joinRoom(LOBBY_ROOM)
    })

    this.ws.on("message", data => {
      this.handleRawFrame(String(data)).catch(error => {
        this.log(`frame error: ${String(error)}`)
      })
    })

    this.ws.on("close", (code, reasonBuffer) => {
      const reason = reasonBuffer.toString("utf8")
      const suffix = reason ? ` (${code}: ${reason})` : ` (${code})`
      const reconnectInMs = this.nextReconnectDelayMs()
      this.log(`socket closed${suffix}, reconnect in ${reconnectInMs}ms`)
      this.stopHeartbeat()
      this.stopProactiveMessages()
      this.stopVoteDeadlineTimer()
      this.stopTyping()
      this.match = null
      this.awaitingMatch = false
      this.lastMatchRequestAt = 0
      this.clearActiveMatchRoom()
      this.clearComplianceState()
      this.joinedRooms.clear()
      this.pendingPushes.clear()
      this.scheduleReconnect(reconnectInMs)
    })

    this.ws.on("error", error => {
      const details = error.message ? `: ${error.message}` : ""
      this.log(`socket error${details}`)
    })
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs)
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

    const msg = normalizeInboundMessage(parsed)
    if (!msg) return

    if (this.debugFrames && this.shouldLogInboundRaw(msg)) {
      this.log(`recv ${JSON.stringify(msg)}`)
    }

    if (msg.event === "pong") return

    const room = String(msg.room ?? "")
    const id = msg.id == null ? null : String(msg.id)
    const payload = msg.payload ?? {}

    if (msg.event === "joined") {
      this.handleJoinAck(room, id)
      return
    }

    if (msg.event === "reply" || msg.event === "error") {
      this.handleReplyOrError(room, id, msg.event, payload)
      return
    }

    if (msg.type) {
      await this.handleEnvelope(room, {
        type: msg.type,
        payload,
        meta: msg.meta
      })
    }
  }

  private handleJoinAck(room: string, id: string | null): void {
    if (!room) return

    if (id) {
      const pending = this.pendingPushes.get(id)
      this.pendingPushes.delete(id)
      if (this.debugFrames) {
        const pendingLabel = pending ? ` pending=${pending.event}` : ""
        this.log(`in joined room=${room} id=${id}${pendingLabel}`)
      }
    }

    this.joinedRooms.add(room)

    if (room === LOBBY_ROOM) {
      this.log("joined lobby; requesting match")
      this.requestMatch(room)
    }

    if (room === this.complianceRoom && this.pendingProbeToken) {
      this.flushPendingProbeEcho()
    }
  }

  private handleReplyOrError(
    room: string,
    id: string | null,
    event: "reply" | "error",
    payload: Record<string, unknown>
  ): void {
    const pending = id ? this.pendingPushes.get(id) ?? null : null
    if (id) this.pendingPushes.delete(id)

    if (this.debugFrames) {
      this.log(
        `in ${event} room=${room || "<none>"} id=${id ?? "null"} payload=${JSON.stringify(payload)}${
          pending ? ` for=${pending.event}${pending.messageType ? `/${pending.messageType}` : ""}` : ""
        }`
      )
    }

    if (!pending) return

    if (pending.event === "join" && event === "error") {
      const reason = this.formatReason(payload.reason)
      if (this.isAlreadyTrackedReason(reason)) {
        const trackedRoom = this.extractAlreadyTrackedRoom(reason)
        if (trackedRoom === pending.room) {
          this.log(`join already tracked room=${pending.room}; treating as joined`)
          this.handleJoinAck(pending.room, id)
          return
        }
        if (trackedRoom === LOBBY_ROOM && pending.room !== LOBBY_ROOM) {
          this.log(`join blocked by lobby tracking; retrying match join`)
          setTimeout(() => this.joinRoom(pending.room), randomInt(300, 900))
          return
        }
        this.log(`join already tracked room=${pending.room} reason=${reason}`)
        return
      }
      this.log(`join rejected room=${pending.room} reason=${reason}`)
      return
    }

    if (pending.event !== "push") return

    if (pending.messageType === "match:request") {
      this.handleMatchRequestReply(payload, event)
      return
    }

    if (pending.messageType === "vote:cast") {
      this.handleVoteCastReply(payload, event)
      return
    }

    if (event === "error") {
      const reason = String(payload.reason ?? "unknown")
      this.log(`event rejected type=${pending.messageType ?? "unknown"} reason=${reason}`)
    }
  }

  private async handleEnvelope(topic: string, envelope: EnvelopePayload): Promise<void> {
    const type = envelope.type ?? ""
    const payload = envelope.payload ?? {}
    const timestamp = envelope.meta?.timestamp ?? new Date().toISOString()

    if (topic === LOBBY_ROOM) {
      if (type === "room:sync") {
        const room = String(payload.room ?? "")
        if (!room) return
        this.trackComplianceRoom(room)
        this.joinRoom(room)
        return
      }

      if (type === "match:found") {
        const room = String(payload.room ?? "")
        const matchId = String(payload.match_id ?? "")
        if (!room || !matchId) return
        this.markActiveMatchRoom(room)
        const alreadyInRoom = this.match?.topic === room || this.joinedRooms.has(room)
        this.stopProactiveMessages()
        this.stopVoteDeadlineTimer()
        this.stopTyping()
        this.match = null
        this.awaitingMatch = false
        this.log(`match found ${matchId}`)
        if (alreadyInRoom) return
        this.joinRoom(room)
      }
      return
    }

    if (this.isComplianceRoom(topic)) {
      this.handleComplianceEnvelope(topic, type, payload)
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
        preReplyMessagesSent: 0,
        typingOn: false,
        chatTokens: this.chatBurstLimit,
        lastTokenRefillAt: Date.now()
      }
      this.markActiveMatchRoom(topic)
      this.log(`match started ${matchId}`)
      this.schedulePreReplyMessage()
      this.scheduleVoteBeforeDeadline()
      return
    }

    if (type === "match:ended") {
      this.log("match ended; queueing next request")
      this.stopProactiveMessages()
      this.stopVoteDeadlineTimer()
      this.stopTyping()
      this.clearActiveMatchRoom()
      this.match = null
      this.awaitingMatch = false
      this.joinRoom(LOBBY_ROOM)
      return
    }

    if (!this.match && this.isMatchRoom(topic) && this.shouldBootstrapMatchFromEvent(type)) {
      this.bootstrapMatchFromEvent(topic, payload)
    }

    if (!this.match || topic !== this.match.topic) return

    if (type === "vote:phase") {
      const chatLocked = Boolean(payload.chat_locked)
      if (chatLocked && !this.match.chatLocked) {
        this.match.chatLocked = true
        this.stopProactiveMessages()
        this.stopTyping()
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
      this.maybeStartTyping(delay)
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
    if (this.match.chatLocked) {
      this.stopTyping()
      return
    }
    if (options?.onlyBeforeOpponentReply && this.match.transcript.some(turn => turn.from === "opponent")) {
      this.stopTyping()
      return
    }
    const cleaned = body.trim().replace(/\s+/g, " ").slice(0, 260)
    if (!cleaned) {
      this.stopTyping()
      return
    }

    const now = Date.now()
    this.refillChatTokens(now)
    if (this.match.chatTokens < 1) {
      const wait = Math.max(350, Math.ceil(1000 / this.chatRefillPerSec) + randomInt(40, 180))
      setTimeout(() => {
        void this.sendPlannedChat(cleaned, options)
      }, wait)
      return
    }

    const diff = now - this.match.lastSentAt
    if (diff < this.config.minGapBetweenMessagesMs) {
      const wait = this.config.minGapBetweenMessagesMs - diff + randomInt(120, 380)
      setTimeout(() => {
        void this.sendPlannedChat(cleaned, options)
      }, wait)
      return
    }

    const sent = this.pushEvent(this.match.topic, "chat:message", { body: cleaned })
    if (!sent) {
      this.stopTyping()
      return
    }
    this.match.chatTokens = Math.max(0, this.match.chatTokens - 1)
    this.match.lastSentAt = Date.now()
    this.stopTyping()
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

  private handleVoteCastReply(payload: Record<string, unknown>, eventKind: "reply" | "error"): void {
    if (!this.match || this.match.voted) return

    if (eventKind === "reply") {
      const status = String(payload.status ?? "")
      if (status === "ok") {
        this.handleVoteAccepted()
        return
      }

      this.match.voteInFlight = false
      const reason = String(payload.reason ?? "")
      const details = reason ? ` reason=${reason}` : ""
      this.log(`vote cast rejected status=${status || "unknown"}${details}`)
      return
    }

    this.match.voteInFlight = false
    const reason = String(payload.reason ?? "")
    const details = reason ? ` reason=${reason}` : ""
    this.log(`vote cast error${details}`)
  }

  private joinRoom(room: string): void {
    if (this.joinedRooms.has(room)) {
      if (this.debugFrames) this.log(`skip join room=${room}; already joined`)
      return
    }

    const pendingJoin = [...this.pendingPushes.values()].some(p => p.room === room && p.event === "join")
    if (pendingJoin) {
      if (this.debugFrames) this.log(`skip join room=${room}; join in-flight`)
      return
    }

    const id = this.nextMessageId()
    this.send(
      {
        id,
        room,
        event: "join",
        payload: {}
      },
      {
        room,
        event: "join"
      }
    )
  }

  private pushEvent(room: string, type: string, payload: Record<string, unknown>): boolean {
    if (!this.joinedRooms.has(room)) {
      this.log(`skip push room=${room} type=${type}; room not joined`)
      return false
    }

    const id = this.nextMessageId()
    return this.send(
      {
        id,
        room,
        type,
        payload
      },
      {
        room,
        event: "push",
        messageType: type
      }
    )
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.send({ event: "ping" })

      if (!this.match) {
        this.expireStaleActiveMatchAssignment()
        const elapsed = Date.now() - this.lastMatchRequestAt
        if ((!this.awaitingMatch || elapsed > 20000) && !this.hasActiveMatchAssignment()) {
          this.log("still waiting for match; re-requesting")
          this.requestMatch(LOBBY_ROOM)
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

  private send(message: OutboundMessage, pending?: PendingPush): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false

    if (message.id && pending) {
      this.pendingPushes.set(message.id, pending)
    }

    if (this.debugFrames) {
      this.log(`out ${JSON.stringify(message)}`)
    }

    this.ws.send(JSON.stringify(message))
    return true
  }

  private nextMessageId(): string {
    const value = String(this.messageId)
    this.messageId += 1
    return value
  }

  private buildSocketUrl(): string {
    const base = new URL(this.config.baseUrl)
    const wsProtocol = base.protocol === "https:" ? "wss:" : "ws:"
    const url = new URL("/ws", `${wsProtocol}//${base.host}`)
    url.searchParams.set("api_key", this.config.agentToken)
    return url.toString()
  }

  private log(msg: string): void {
    console.log(`[botornot-agent:${this.config.agentName}] ${this.redactSecrets(msg)}`)
  }

  private redactSecrets(text: string): string {
    let redacted = text.replace(/(api_key=)[^&\s]+/gi, "$1[REDACTED]")
    if (this.config.agentToken) {
      redacted = redacted.split(this.config.agentToken).join("[REDACTED]")
    }
    return redacted
  }

  private requestMatch(room: string): void {
    const sent = this.pushEvent(room, "match:request", {})
    if (!sent) return
    this.awaitingMatch = true
    this.lastMatchRequestAt = Date.now()
  }

  private handleMatchRequestReply(payload: Record<string, unknown>, eventKind: "reply" | "error"): void {
    if (eventKind === "error") {
      const reason = String(payload.reason ?? "unknown")
      this.log(`match request rejected reason=${reason}`)
      return
    }

    const queueStatus = String(payload.status ?? "")
    if (queueStatus === "queued" || queueStatus === "already_queued") {
      this.awaitingMatch = true
      return
    }

    if (queueStatus === "probe_required") {
      this.awaitingMatch = false
      const room = String(payload.room ?? "")
      if (!room) {
        this.log("match request requires probe, but no compliance room provided")
        return
      }
      this.log(`match request requires probe in room=${room}`)
      this.trackComplianceRoom(room)
      this.joinRoom(room)
      return
    }

    if (queueStatus === "already_active") {
      this.awaitingMatch = false
      const room = String(payload.room ?? "")
      const matchId = String(payload.match_id ?? "")
      if (!room) return
      this.markActiveMatchRoom(room)

      const alreadyInRoom = this.match?.topic === room || this.joinedRooms.has(room)
      this.log(`resuming active match${matchId ? ` ${matchId}` : ""}`)
      if (!alreadyInRoom) {
        this.joinRoom(room)
      }
      return
    }

    if (queueStatus) {
      this.log(`match request reply status=${queueStatus}`)
    }
  }

  private hasActiveMatchAssignment(): boolean {
    if (this.match) return true
    if (this.activeMatchRoom) return true
    return false
  }

  private isComplianceRoom(topic: string): boolean {
    return Boolean(this.complianceRoom) && topic === this.complianceRoom
  }

  private handleComplianceEnvelope(topic: string, type: string, payload: Record<string, unknown>): void {
    if (type !== "chat:message") return
    const probeToken = String(payload.probe_token ?? "").trim()
    if (!probeToken) return
    this.queueProbeEcho(topic, probeToken)
  }

  private queueProbeEcho(room: string, probeToken: string): void {
    if (!probeToken) return
    this.trackComplianceRoom(room)

    if (this.pendingProbeToken === probeToken) return
    if (this.lastProbeTokenEchoed === probeToken) {
      if (this.debugFrames) {
        this.log(`ignoring duplicate probe token for room=${room}`)
      }
      return
    }

    this.pendingProbeToken = probeToken
    this.flushPendingProbeEcho()
  }

  private flushPendingProbeEcho(): void {
    if (!this.complianceRoom || !this.pendingProbeToken) return
    if (!this.joinedRooms.has(this.complianceRoom)) {
      this.joinRoom(this.complianceRoom)
      return
    }

    const token = this.pendingProbeToken
    const sent = this.pushEvent(this.complianceRoom, "chat:message", { body: token })
    if (!sent) return

    this.pendingProbeToken = null
    this.lastProbeTokenEchoed = token
    this.log("compliance probe echoed; retrying match request")
    this.requestMatch(LOBBY_ROOM)
  }

  private trackComplianceRoom(room: string): void {
    if (!room) return
    if (this.complianceRoom !== room) {
      this.complianceRoom = room
      this.pendingProbeToken = null
      this.lastProbeTokenEchoed = null
      return
    }
    this.complianceRoom = room
  }

  private clearComplianceState(): void {
    this.complianceRoom = null
    this.pendingProbeToken = null
    this.lastProbeTokenEchoed = null
  }

  private schedulePreReplyMessage(): void {
    if (this.proactiveTimer) return
    if (!this.shouldSendPreReplyMessage()) return

    const delay = randomInt(this.config.minReplyDelayMs, this.config.maxReplyDelayMs)
    this.maybeStartTyping(delay)
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
    this.voteDeadlineTimer.unref?.()
  }

  private shouldSendPreReplyMessage(): boolean {
    if (!this.match) return false
    if (this.match.preReplyMessagesSent >= this.config.maxPreReplyMessages) return false
    return !this.match.transcript.some(turn => turn.from === "opponent")
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

  private shouldLogInboundRaw(message: InboundMessage): boolean {
    return message.event !== "pong"
  }

  private markActiveMatchRoom(room: string): void {
    this.activeMatchRoom = room
    this.activeMatchAssignedAt = Date.now()
  }

  private clearActiveMatchRoom(): void {
    this.activeMatchRoom = null
    this.activeMatchAssignedAt = 0
  }

  private expireStaleActiveMatchAssignment(): void {
    if (!this.activeMatchRoom || this.activeMatchAssignedAt <= 0) return
    const staleMs = 45_000
    if (Date.now() - this.activeMatchAssignedAt < staleMs) return
    const staleRoom = this.activeMatchRoom
    this.log(`active match assignment stale (${staleRoom}); clearing and requeueing`)
    this.joinedRooms.delete(staleRoom)
    this.clearActiveMatchRoom()
    this.awaitingMatch = false
    this.joinRoom(LOBBY_ROOM)
  }

  private isMatchRoom(topic: string): boolean {
    return topic.startsWith("room:game:botornot:") && topic !== LOBBY_ROOM
  }

  private shouldBootstrapMatchFromEvent(type: string): boolean {
    return type === "chat:message" || type === "vote:phase" || type === "vote:cast" || type === "match:opponent_voted"
  }

  private bootstrapMatchFromEvent(topic: string, payload: Record<string, unknown>): void {
    const durationSec = Number(payload.duration_sec ?? 240)
    const endsAt = new Date(String(payload.ends_at ?? ""))
    const matchId = topic.replace("room:game:botornot:", "")
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
      preReplyMessagesSent: 0,
      typingOn: false,
      chatTokens: this.chatBurstLimit,
      lastTokenRefillAt: Date.now()
    }
    this.markActiveMatchRoom(topic)
    this.log(`match bootstrap ${matchId} (received match-room event before match:started)`)
    this.scheduleVoteBeforeDeadline()
  }

  private isAlreadyTrackedReason(reason: string): boolean {
    return reason.includes("already_tracked")
  }

  private extractAlreadyTrackedRoom(reason: string): string | null {
    const matches = reason.match(/"room:game:botornot:[^"]+"/g)
    if (!matches || matches.length === 0) return null
    return matches[0].slice(1, -1)
  }

  private formatReason(reason: unknown): string {
    if (typeof reason === "string") return reason
    if (reason == null) return "unknown"
    try {
      return JSON.stringify(reason)
    } catch {
      return String(reason)
    }
  }

  private nextReconnectDelayMs(): number {
    const multiplier = 2 ** this.reconnectAttempt
    this.reconnectAttempt += 1
    return Math.min(this.config.reconnectMaxMs, this.config.reconnectInitialMs * multiplier)
  }

  private refillChatTokens(now: number): void {
    if (!this.match) return
    const elapsedMs = now - this.match.lastTokenRefillAt
    if (elapsedMs <= 0) return

    const refillAmount = (elapsedMs / 1000) * this.chatRefillPerSec
    this.match.chatTokens = Math.min(this.chatBurstLimit, this.match.chatTokens + refillAmount)
    this.match.lastTokenRefillAt = now
  }

  private maybeStartTyping(delayMs: number): void {
    if (!this.match) return
    if (this.match.chatLocked || this.match.typingOn) return
    if (delayMs < 300) return
    if (Math.random() > 0.75) return

    const sent = this.pushEvent(this.match.topic, "chat:typing", { typing: true })
    if (sent) {
      this.match.typingOn = true
    }
  }

  private stopTyping(): void {
    if (!this.match || !this.match.typingOn) return
    this.pushEvent(this.match.topic, "chat:typing", { typing: false })
    this.match.typingOn = false
  }
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomFrom<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)]
}

function normalizeInboundMessage(value: unknown): InboundMessage | null {
  if (typeof value !== "object" || value === null) return null
  return value as InboundMessage
}
