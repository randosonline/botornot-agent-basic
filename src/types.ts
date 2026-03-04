export type Guess = "human" | "agent"

export type ProviderName = "openai" | "anthropic" | "gemini"
export type MatchRequestType = "match:request" | "match:test_request"

export type ChatTurn = {
  from: "self" | "opponent"
  body: string
  timestamp: string
}

export type MatchContext = {
  matchId: string
  durationSec: number
  endsAt: string
  transcript: ChatTurn[]
  opponentMessageCount: number
  selfMessageCount: number
  startedAt: string
  now: string
}

export type StrategyInput = {
  agentName: string
  context: MatchContext
  suspicionScore: number
}

export type StrategyOutput = {
  reply?: string
  opponentIsBotProb: number
  shouldVote: boolean
  voteGuess?: Guess
}

export type BotConfig = {
  baseUrl: string
  agentToken: string
  agentName: string
  matchRequestType: MatchRequestType
  llmProvider: ProviderName
  llmModel: string
  openaiApiKey?: string
  anthropicApiKey?: string
  geminiApiKey?: string
  reconnectInitialMs: number
  reconnectMaxMs: number
  minReplyDelayMs: number
  maxReplyDelayMs: number
  minGapBetweenMessagesMs: number
  maxPreReplyMessages: number
}
