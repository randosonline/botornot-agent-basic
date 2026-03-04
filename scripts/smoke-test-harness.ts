import WebSocket from "ws"

type InboundFrame = {
  id?: string | number
  room?: string
  event?: string
  type?: string
  payload?: Record<string, unknown>
}

type PendingRequest = "join" | "match_request" | "probe_echo" | "vote_cast"

const LOBBY_ROOM = "room:game:botornot:lobby"
const TEST_ROOM_PREFIX = "room:game:botornot:test_"
const REQUEST_TYPE = "match:test_request"

const timeoutMs = readPositiveInt(process.env.SMOKE_TIMEOUT_MS, 180_000)
const voteGuess = process.env.SMOKE_VOTE_GUESS === "agent" ? "agent" : "human"

const baseUrl = requiredEnv("BOTORNOT_BASE_URL")
const agentToken = process.env.BOTORNOT_AGENT_TOKEN ?? process.env.BOTORNOT_API_KEY

if (!agentToken) {
  throw new Error("Missing env var: BOTORNOT_AGENT_TOKEN (or BOTORNOT_API_KEY)")
}

const wsUrl = buildSocketUrl(baseUrl, agentToken)

class HarnessSmokeRunner {
  private readonly ws: WebSocket
  private readonly pendingById = new Map<string, PendingRequest>()
  private readonly joinedRooms = new Set<string>()
  private readonly seenEvents = new Set<string>()
  private messageId = 1
  private completed = false
  private heartbeatTimer: NodeJS.Timeout | null = null
  private timeoutTimer: NodeJS.Timeout | null = null
  private complianceRoom: string | null = null
  private pendingProbeToken: string | null = null
  private lastProbeEcho: string | null = null
  private matchRoom: string | null = null
  private voteSent = false
  private sawQueueReply = false
  private sawMatchFound = false
  private sawMatchStarted = false
  private sawVotePhase = false
  private sawVoteAck = false
  private sawMatchReveal = false
  private sawMatchEnded = false

  constructor(url: string) {
    this.ws = new WebSocket(url)
  }

  async run(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const fail = (reason: string): void => {
        if (this.completed) return
        this.completed = true
        this.cleanup()
        reject(new Error(reason))
      }

      const pass = (): void => {
        if (this.completed) return
        this.completed = true
        this.cleanup()
        this.log("PASS: deterministic harness flow completed")
        resolve()
      }

      this.timeoutTimer = setTimeout(() => {
        fail(`timed out after ${timeoutMs}ms waiting for harness flow to finish`)
      }, timeoutMs)
      this.timeoutTimer.unref?.()

      this.ws.on("open", () => {
        this.log(`connected ${redactToken(wsUrl, agentToken)}`)
        this.startHeartbeat()
        this.joinRoom(LOBBY_ROOM)
      })

      this.ws.on("error", error => {
        fail(`socket error: ${error.message}`)
      })

      this.ws.on("close", (code, reasonBuffer) => {
        if (this.completed) return
        const reason = reasonBuffer.toString("utf8")
        fail(`socket closed early (${code}${reason ? `: ${reason}` : ""})`)
      })

      this.ws.on("message", raw => {
        const text = String(raw)
        let frame: InboundFrame

        try {
          frame = JSON.parse(text) as InboundFrame
        } catch {
          return
        }

        try {
          this.handleFrame(frame, pass, fail)
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error))
        }
      })
    })
  }

  private handleFrame(frame: InboundFrame, pass: () => void, fail: (reason: string) => void): void {
    if (frame.event === "pong") return

    const room = String(frame.room ?? "")
    const id = frame.id == null ? null : String(frame.id)
    const payload = frame.payload ?? {}

    if (frame.event === "joined") {
      this.handleJoined(room, id)
      return
    }

    if (frame.event === "reply" || frame.event === "error") {
      this.handleReplyOrError(frame.event, room, id, payload, fail)
      return
    }

    if (!frame.type) return
    this.handlePush(room, frame.type, payload, pass, fail)
  }

  private handleJoined(room: string, id: string | null): void {
    if (!room) return
    if (id) this.pendingById.delete(id)
    this.joinedRooms.add(room)
    this.log(`joined ${room}`)

    if (room === LOBBY_ROOM) {
      this.requestHarnessMatch()
      return
    }

    if (room === this.complianceRoom && this.pendingProbeToken) {
      this.flushProbeEcho()
    }
  }

  private handleReplyOrError(
    event: "reply" | "error",
    room: string,
    id: string | null,
    payload: Record<string, unknown>,
    fail: (reason: string) => void
  ): void {
    const pending = id ? this.pendingById.get(id) ?? null : null
    if (id) this.pendingById.delete(id)

    if (!pending) {
      if (event === "error") {
        const reason = String(payload.reason ?? "unknown")
        fail(`uncorrelated server error in ${room || "<none>"}: ${reason}`)
      }
      return
    }

    if (pending === "join") {
      if (event === "reply") return
      const reason = String(payload.reason ?? "unknown")
      if (reason.includes("already_tracked")) {
        this.log(`join already tracked for ${room}, continuing`)
        this.joinedRooms.add(room)
        return
      }
      fail(`join failed for ${room}: ${reason}`)
      return
    }

    if (pending === "probe_echo") {
      if (event === "error") {
        const reason = String(payload.reason ?? "unknown")
        fail(`probe echo failed: ${reason}`)
      }
      return
    }

    if (pending === "vote_cast") {
      if (event === "error") {
        const reason = String(payload.reason ?? "unknown")
        fail(`vote cast failed: ${reason}`)
        return
      }

      const status = String(payload.status ?? "")
      if (status && status !== "ok") {
        const reason = String(payload.reason ?? "unknown")
        fail(`vote cast rejected status=${status} reason=${reason}`)
      }
      return
    }

    if (pending === "match_request") {
      if (event === "error") {
        const reason = String(payload.reason ?? "unknown")
        fail(`match request failed: ${reason}`)
        return
      }

      const status = String(payload.status ?? "")
      if (!status) {
        fail("match request reply missing status")
        return
      }

      if (status === "queued" || status === "already_queued") {
        this.sawQueueReply = true
        this.log(`queue status=${status}`)
        return
      }

      if (status === "probe_required") {
        const complianceRoom = String(payload.room ?? "")
        if (!complianceRoom) {
          fail("probe_required reply missing compliance room")
          return
        }
        this.log(`probe_required -> ${complianceRoom}`)
        this.trackComplianceRoom(complianceRoom)
        this.joinRoom(complianceRoom)
        return
      }

      if (status === "already_active") {
        this.log("already_active resume from reply")
        this.enterMatchRoomFromPayload(payload, fail)
        return
      }

      fail(`unexpected match request status: ${status}`)
    }
  }

  private handlePush(
    room: string,
    type: string,
    payload: Record<string, unknown>,
    pass: () => void,
    fail: (reason: string) => void
  ): void {
    if (room === LOBBY_ROOM) {
      if (type === "room:sync") {
        const complianceRoom = String(payload.room ?? "")
        if (!complianceRoom) {
          fail("room:sync missing payload.room")
          return
        }
        this.log(`room:sync -> ${complianceRoom}`)
        this.trackComplianceRoom(complianceRoom)
        this.joinRoom(complianceRoom)
        return
      }

      if (type === "match:found") {
        this.sawMatchFound = true
        this.enterMatchRoomFromPayload(payload, fail)
      }
      return
    }

    if (this.complianceRoom && room === this.complianceRoom) {
      if (type !== "chat:message") return
      const probeToken = String(payload.probe_token ?? "").trim()
      if (!probeToken) return
      if (this.lastProbeEcho === probeToken) return
      this.pendingProbeToken = probeToken
      this.flushProbeEcho()
      return
    }

    if (!this.matchRoom || room !== this.matchRoom) return

    this.seenEvents.add(type)

    if (type === "match:started") {
      this.sawMatchStarted = true
      this.log("match started")
      return
    }

    if (type === "vote:phase") {
      this.sawVotePhase = true
      const mustVote = Boolean(payload.must_vote)
      this.log(`vote phase (must_vote=${mustVote ? "true" : "false"})`)
      if (mustVote && !this.voteSent) {
        this.voteSent = true
        this.sendPush(this.matchRoom, "vote:cast", { guess: voteGuess }, "vote_cast")
      }
      return
    }

    if (type === "vote:ack") {
      this.sawVoteAck = true
      this.log("vote acknowledged")
      return
    }

    if (type === "match:reveal") {
      this.sawMatchReveal = true
      this.log("match revealed")
      return
    }

    if (type === "match:ended") {
      this.sawMatchEnded = true
      this.log("match ended")
      if (!this.sawMatchStarted) {
        fail("match ended before match:started was observed")
        return
      }
      if (!this.sawVotePhase) {
        fail("match ended before vote:phase was observed")
        return
      }
      if (!this.sawVoteAck) {
        fail("match ended before vote:ack was observed")
        return
      }
      if (!this.sawMatchReveal) {
        fail("match ended before match:reveal was observed")
        return
      }
      pass()
    }
  }

  private enterMatchRoomFromPayload(payload: Record<string, unknown>, fail: (reason: string) => void): void {
    const room = String(payload.room ?? "")
    if (!room) {
      fail("match payload missing room")
      return
    }
    if (!room.startsWith(TEST_ROOM_PREFIX)) {
      fail(`expected deterministic test room prefix ${TEST_ROOM_PREFIX}, got ${room}`)
      return
    }

    this.matchRoom = room
    this.log(`match room -> ${room}`)
    this.joinRoom(room)
  }

  private flushProbeEcho(): void {
    if (!this.complianceRoom || !this.pendingProbeToken) return
    if (!this.joinedRooms.has(this.complianceRoom)) {
      this.joinRoom(this.complianceRoom)
      return
    }

    const token = this.pendingProbeToken
    this.pendingProbeToken = null
    this.lastProbeEcho = token
    this.log("echoing compliance probe token")
    this.sendPush(this.complianceRoom, "chat:message", { body: token }, "probe_echo")
    this.requestHarnessMatch()
  }

  private requestHarnessMatch(): void {
    this.sendPush(LOBBY_ROOM, REQUEST_TYPE, {}, "match_request")
  }

  private trackComplianceRoom(room: string): void {
    if (this.complianceRoom === room) return
    this.complianceRoom = room
    this.pendingProbeToken = null
    this.lastProbeEcho = null
  }

  private joinRoom(room: string): void {
    if (this.joinedRooms.has(room)) return
    this.send({ room, event: "join", payload: {} }, "join")
  }

  private sendPush(
    room: string,
    type: string,
    payload: Record<string, unknown>,
    pending: PendingRequest
  ): void {
    this.send({ room, type, payload }, pending)
  }

  private send(
    message: { room?: string; event?: string; type?: string; payload?: Record<string, unknown> },
    pending: PendingRequest
  ): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`socket not open while sending ${pending}`)
    }

    const id = String(this.messageId++)
    this.pendingById.set(id, pending)
    this.ws.send(JSON.stringify({ id, ...message }))
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ event: "ping" }))
      }
    }, 30_000)
    this.heartbeatTimer.unref?.()
  }

  private cleanup(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
    this.timeoutTimer = null
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close()
    }
  }

  private log(message: string): void {
    console.log(`[smoke:test-harness] ${message}`)
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing env var: ${name}`)
  }
  return value
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

function buildSocketUrl(baseUrl: string, token: string): string {
  const base = new URL(baseUrl)
  const wsProtocol = base.protocol === "https:" ? "wss:" : "ws:"
  const url = new URL("/ws", `${wsProtocol}//${base.host}`)
  url.searchParams.set("api_key", token)
  return url.toString()
}

function redactToken(url: string, token: string): string {
  return url.replace(token, "[REDACTED]")
}

const runner = new HarnessSmokeRunner(wsUrl)

runner.run().catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[smoke:test-harness] FAIL: ${message}`)
  process.exitCode = 1
})
