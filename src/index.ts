import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { BotOrNotAgent } from "./bot.js"
import { createProvider } from "./providers.js"
import type { BotConfig, ProviderName } from "./types.js"

loadDotEnv()

const config = readConfig()
const provider = createProvider({
  provider: config.llmProvider,
  model: config.llmModel,
  openaiApiKey: config.openaiApiKey,
  anthropicApiKey: config.anthropicApiKey,
  geminiApiKey: config.geminiApiKey
})

const bot = new BotOrNotAgent(config, provider)
bot.start()

const port = Number(process.env.PORT || 3000)
http
  .createServer((_req, res) => {
    res.statusCode = 200
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ ok: true, agent: config.agentName, provider: config.llmProvider }))
  })
  .listen(port, () => {
    console.log(`[botornot-agent:${config.agentName}] health server on :${port}`)
  })

function readConfig(): BotConfig {
  const baseUrl = requiredEnv("BOTORNOT_BASE_URL")
  const agentToken = requiredAgentToken()
  const llmProvider = (process.env.LLM_PROVIDER ?? "openai") as ProviderName

  return {
    baseUrl,
    agentToken,
    agentName: process.env.AGENT_NAME ?? `default_bot_${Math.floor(Math.random() * 1000)}`,
    llmProvider,
    llmModel: process.env.LLM_MODEL ?? defaultModel(llmProvider),
    openaiApiKey: process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
    reconnectInitialMs: Math.max(250, Number(process.env.RECONNECT_MS ?? 1000)),
    reconnectMaxMs: Math.max(1000, Number(process.env.RECONNECT_MAX_MS ?? 10000)),
    minReplyDelayMs: Number(process.env.MIN_REPLY_DELAY_MS ?? 900),
    maxReplyDelayMs: Number(process.env.MAX_REPLY_DELAY_MS ?? 2600),
    minGapBetweenMessagesMs: Number(process.env.MIN_GAP_BETWEEN_MESSAGES_MS ?? 1200),
    maxPreReplyMessages: clampInt(Number(process.env.MAX_PRE_REPLY_MESSAGES ?? 3), 0, 3)
  }
}

function defaultModel(provider: ProviderName): string {
  if (provider === "anthropic") return "claude-3-5-sonnet-latest"
  if (provider === "gemini") return "gemini-1.5-flash"
  return "gpt-4o-mini"
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing env var: ${name}`)
  }
  if (value.includes("replace_with_")) {
    throw new Error(`Env var ${name} still has placeholder value: ${value}`)
  }
  return value
}

function requiredAgentToken(): string {
  const token = process.env.BOTORNOT_AGENT_TOKEN ?? process.env.BOTORNOT_API_KEY
  if (!token) {
    throw new Error("Missing env var: BOTORNOT_AGENT_TOKEN (or BOTORNOT_API_KEY)")
  }
  if (token.includes("replace_with_")) {
    throw new Error(`Agent token still has placeholder value: ${token}`)
  }
  return token
}

function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env")
  if (!fs.existsSync(envPath)) return

  const raw = fs.readFileSync(envPath, "utf8")
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    const eqIndex = trimmed.indexOf("=")
    if (eqIndex <= 0) continue

    const key = trimmed.slice(0, eqIndex).trim()
    if (!key || process.env[key] !== undefined) continue

    let value = trimmed.slice(eqIndex + 1).trim()
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    process.env[key] = value
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  const rounded = Math.floor(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}
