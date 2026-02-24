import type { ProviderName } from "./types.js"

export interface LlmProvider {
  generateJson(system: string, user: string): Promise<string>
}

type ProviderConfig = {
  provider: ProviderName
  model: string
  openaiApiKey?: string
  anthropicApiKey?: string
  geminiApiKey?: string
}

export function createProvider(config: ProviderConfig): LlmProvider | null {
  switch (config.provider) {
    case "openai":
      return config.openaiApiKey ? new OpenAIProvider(config.model, config.openaiApiKey) : null
    case "anthropic":
      return config.anthropicApiKey ? new AnthropicProvider(config.model, config.anthropicApiKey) : null
    case "gemini":
      return config.geminiApiKey ? new GeminiProvider(config.model, config.geminiApiKey) : null
    default:
      return null
  }
}

class OpenAIProvider implements LlmProvider {
  constructor(private readonly model: string, private readonly apiKey: string) {}

  async generateJson(system: string, user: string): Promise<string> {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.85,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    })

    if (!response.ok) {
      throw new Error(`openai error ${response.status}: ${await response.text()}`)
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    return data.choices?.[0]?.message?.content ?? "{}"
  }
}

class AnthropicProvider implements LlmProvider {
  constructor(private readonly model: string, private readonly apiKey: string) {}

  async generateJson(system: string, user: string): Promise<string> {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 400,
        temperature: 0.8,
        system,
        messages: [
          {
            role: "user",
            content: user
          }
        ]
      })
    })

    if (!response.ok) {
      throw new Error(`anthropic error ${response.status}: ${await response.text()}`)
    }

    const data = await response.json() as { content?: Array<{ type?: string; text?: string }> }
    const textPart = data.content?.find(item => item.type === "text")
    return textPart?.text ?? "{}"
  }
}

class GeminiProvider implements LlmProvider {
  constructor(private readonly model: string, private readonly apiKey: string) {}

  async generateJson(system: string, user: string): Promise<string> {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        generationConfig: {
          temperature: 0.8,
          responseMimeType: "application/json"
        },
        contents: [
          {
            role: "user",
            parts: [{ text: `${system}\n\n${user}` }]
          }
        ]
      })
    })

    if (!response.ok) {
      throw new Error(`gemini error ${response.status}: ${await response.text()}`)
    }

    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}"
  }
}
