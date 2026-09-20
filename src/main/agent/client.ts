/**
 * Minimal Anthropic Messages client.
 *
 * Streaming, because a tool-using turn can take ten seconds and a panel that
 * shows nothing until it finishes reads as broken. Only the event types this
 * app acts on are decoded; the rest are ignored rather than rejected, so a new
 * server-side event never breaks a running edit.
 */

export interface ToolSchema {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export interface Message {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

export interface StreamEvents {
  onText: (delta: string) => void
  onToolStart: (id: string, name: string) => void
}

export interface Completion {
  content: ContentBlock[]
  stopReason: string | null
  usage: { input: number; output: number }
}

export class AgentError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'AgentError'
  }
}

const ENDPOINT = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'

export async function complete(
  options: {
    apiKey: string
    model: string
    system: string
    messages: Message[]
    tools: ToolSchema[]
    maxTokens?: number
    signal?: AbortSignal
  },
  events: StreamEvents,
): Promise<Completion> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': options.apiKey,
      'anthropic-version': API_VERSION,
    },
    signal: options.signal,
    body: JSON.stringify({
      model: options.model,
      max_tokens: options.maxTokens ?? 8192,
      system: options.system,
      messages: options.messages,
      tools: options.tools,
      stream: true,
    }),
  })

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '')
    throw new AgentError(explain(response.status, detail), response.status)
  }

  const blocks: ContentBlock[] = []
  /** Tool arguments arrive as JSON in pieces and are only valid once complete. */
  const partialJson = new Map<number, string>()
  let stopReason: string | null = null
  const usage = { input: 0, output: 0 }

  for await (const event of sseEvents(response.body)) {
    switch (event.type) {
      case 'message_start':
        usage.input = event.message?.usage?.input_tokens ?? 0
        break

      case 'content_block_start': {
        const block = event.content_block
        if (block.type === 'text') {
          blocks[event.index] = { type: 'text', text: '' }
        } else if (block.type === 'tool_use') {
          blocks[event.index] = { type: 'tool_use', id: block.id, name: block.name, input: {} }
          partialJson.set(event.index, '')
          events.onToolStart(block.id, block.name)
        }
        break
      }

      case 'content_block_delta': {
        const block = blocks[event.index]
        if (event.delta.type === 'text_delta' && block?.type === 'text') {
          block.text += event.delta.text
          events.onText(event.delta.text)
        } else if (event.delta.type === 'input_json_delta') {
          partialJson.set(event.index, (partialJson.get(event.index) ?? '') + event.delta.partial_json)
        }
        break
      }

      case 'content_block_stop': {
        const block = blocks[event.index]
        const json = partialJson.get(event.index)
        if (block?.type === 'tool_use' && json !== undefined) {
          block.input = json.trim() === '' ? {} : (JSON.parse(json) as Record<string, unknown>)
        }
        break
      }

      case 'message_delta':
        stopReason = event.delta?.stop_reason ?? stopReason
        usage.output = event.usage?.output_tokens ?? usage.output
        break

      case 'error':
        throw new AgentError(event.error?.message ?? 'The API reported an error mid-stream')
    }
  }

  return { content: blocks.filter(Boolean), stopReason, usage }
}

/** Turns an HTTP failure into something a user can act on. */
function explain(status: number, detail: string): string {
  const message = (() => {
    try {
      return (JSON.parse(detail) as { error?: { message?: string } }).error?.message
    } catch {
      return undefined
    }
  })()

  switch (status) {
    case 401:
    case 403:
      return 'The API key was rejected. Check it in the agent panel settings.'
    case 400:
      return message ?? 'The API refused the request as malformed.'
    case 429:
      return `Rate limited by the API. ${message ?? 'Wait a moment and try again.'}`
    case 529:
      return 'The API is overloaded right now. Try again in a moment.'
    default:
      return message ?? `The API returned HTTP ${status}.`
  }
}

/** Server-sent events, reassembled from a byte stream that splits anywhere. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('')
      if (data && data !== '[DONE]') {
        try {
          yield JSON.parse(data)
        } catch {
          // A frame we cannot parse is not worth killing the turn over.
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}
