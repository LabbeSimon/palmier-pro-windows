/**
 * The in-app agent, without touching the network.
 *
 * `complete` is exercised against a hand-built SSE stream because the decoding
 * of a streamed tool call — arguments arriving as JSON fragments — is the part
 * most likely to break silently and hardest to notice at runtime.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentError, complete, type ContentBlock } from '../src/main/agent/client.js'

function stream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

function sse(events: unknown[]): string[] {
  return events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`)
}

function stubFetch(body: ReadableStream<Uint8Array>, ok = true, status = 200, text = ''): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, status, body, text: async () => text }) as unknown as Response),
  )
}

const CALL = {
  apiKey: 'sk-test',
  model: 'claude-sonnet-5',
  system: 'be useful',
  messages: [{ role: 'user' as const, content: 'hello' }],
  tools: [],
}

const SILENT = { onText: () => {}, onToolStart: () => {} }

afterEach(() => vi.unstubAllGlobals())

describe('complete', () => {
  it('assembles streamed text and reports usage', async () => {
    stubFetch(
      stream(
        sse([
          { type: 'message_start', message: { usage: { input_tokens: 42 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Cut ' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'made.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
        ]),
      ),
    )

    const seen: string[] = []
    const result = await complete(CALL, { onText: (d) => seen.push(d), onToolStart: () => {} })

    expect(seen).toEqual(['Cut ', 'made.'])
    expect(result.content).toEqual([{ type: 'text', text: 'Cut made.' }])
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage).toEqual({ input: 42, output: 7 })
  })

  it('reassembles tool arguments split across deltas', async () => {
    stubFetch(
      stream(
        sse([
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'split_clips' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"fra' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'me": 6' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '0}' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        ]),
      ),
    )

    const started: string[] = []
    const result = await complete(CALL, { onText: () => {}, onToolStart: (_id, name) => started.push(name) })

    expect(started).toEqual(['split_clips'])
    expect(result.content).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'split_clips', input: { frame: 60 } },
    ] satisfies ContentBlock[])
    expect(result.stopReason).toBe('tool_use')
  })

  it('treats a tool call with no arguments as an empty object, not a parse error', async () => {
    stubFetch(
      stream(
        sse([
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_2', name: 'get_media' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        ]),
      ),
    )
    const result = await complete(CALL, SILENT)
    expect(result.content[0]).toMatchObject({ name: 'get_media', input: {} })
  })

  it('survives a frame split mid-JSON by the transport', async () => {
    const frames = sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    ]).join('')
    // Chop the byte stream at an arbitrary point inside the first frame.
    stubFetch(stream([frames.slice(0, 37), frames.slice(37)]))

    const result = await complete(CALL, SILENT)
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('ignores a frame it cannot parse rather than killing the turn', async () => {
    stubFetch(
      stream([
        'data: {not json\n\n',
        ...sse([
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'still here' } },
        ]),
      ]),
    )
    const result = await complete(CALL, SILENT)
    expect(result.content).toEqual([{ type: 'text', text: 'still here' }])
  })

  it('turns a rejected key into advice rather than an HTTP code', async () => {
    stubFetch(stream([]), false, 401, '{"error":{"message":"invalid x-api-key"}}')
    await expect(complete(CALL, SILENT)).rejects.toThrow(/API key was rejected/)
  })

  it('passes the API message through on a 400', async () => {
    stubFetch(stream([]), false, 400, '{"error":{"message":"max_tokens too large"}}')
    await expect(complete(CALL, SILENT)).rejects.toThrow(/max_tokens too large/)
  })

  it('raises an error event from inside the stream', async () => {
    stubFetch(stream(sse([{ type: 'error', error: { message: 'overloaded' } }])))
    await expect(complete(CALL, SILENT)).rejects.toBeInstanceOf(AgentError)
  })
})
