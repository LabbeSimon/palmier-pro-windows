/**
 * The tool loop, with the model replaced by a script of canned completions.
 *
 * What matters here is that the agent's edits go through the same store as the
 * UI's — same undo stack, same journal — and that a refusal comes back to the
 * model as a result it can act on rather than ending the turn.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Completion } from '../src/main/agent/client.js'

const script: Completion[] = []

vi.mock('../src/main/agent/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/main/agent/client.js')>()
  return {
    ...original,
    complete: vi.fn(async (_options: unknown, events: { onText: (d: string) => void }) => {
      const next = script.shift()
      if (!next) throw new Error('the script ran out of completions')
      for (const block of next.content) {
        if (block.type === 'text') events.onText(block.text)
      }
      return next
    }),
  }
})

const { AgentSession } = await import('../src/main/agent/session.js')
const ops = await import('../src/core/ops.js')
const { ProjectStore } = await import('../src/main/project/store.js')

const SETTINGS = { apiKey: 'sk-test', model: 'claude-sonnet-5' }

const text = (value: string): Completion => ({
  content: [{ type: 'text', text: value }],
  stopReason: 'end_turn',
  usage: { input: 1, output: 1 },
})

const call = (id: string, name: string, input: Record<string, unknown>): Completion => ({
  content: [{ type: 'tool_use', id, name, input }],
  stopReason: 'tool_use',
  usage: { input: 1, output: 1 },
})

let store: InstanceType<typeof ProjectStore>
let session: InstanceType<typeof AgentSession>
let events: any[]

beforeEach(() => {
  script.length = 0
  store = new ProjectStore(ops.emptyProject('A'))
  session = new AgentSession(store, { store, defaultExportDir: '/tmp' })
  events = []
  session.on('event', (event: unknown) => events.push(event))
})

describe('AgentSession', () => {
  it('answers without touching the project when no tool is needed', async () => {
    script.push(text('Nothing to do.'))
    await session.send('say hello', SETTINGS)

    expect(events.map((e) => e.type)).toEqual(['text', 'done'])
    expect(store.journal).toHaveLength(0)
  })

  it('runs a tool, then answers, and the edit lands in the journal as the agent', async () => {
    script.push(call('t1', 'add_markers', { markers: [{ start_frame: 12, name: 'beat' }] }))
    script.push(text('Marker placed.'))

    await session.send('put a marker at frame 12', SETTINGS)

    expect(store.project.timelines[0]!.markers).toHaveLength(1)
    expect(store.journal).toHaveLength(1)
    expect(store.journal[0]!.source).toBe('agent')
    expect(store.journal[0]!.replayable).toBe(true)
    expect(events.map((e) => e.type)).toEqual(['tool', 'result', 'turn-end', 'text', 'done'])
  })

  it('is undoable from the same stack the UI uses', async () => {
    script.push(call('t1', 'add_markers', { markers: [{ start_frame: 5, name: 'a' }] }))
    script.push(text('Done.'))
    await session.send('marker', SETTINGS)

    store.undo()
    expect(store.project.timelines[0]!.markers).toHaveLength(0)
  })

  it('hands a refusal back to the model instead of ending the turn', async () => {
    script.push(call('t1', 'split_clips', { frame: -4 }))
    script.push(text('That frame does not exist, so I left it alone.'))

    await session.send('split at minus four', SETTINGS)

    const result = events.find((e) => e.type === 'result')
    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(/frame/i)
    expect(events.at(-1).type).toBe('done')
  })

  it('reports an unknown tool by name rather than crashing', async () => {
    script.push(call('t1', 'colour_grade_everything', {}))
    script.push(text('No such tool.'))

    await session.send('grade it', SETTINGS)
    expect(events.find((e) => e.type === 'result').summary).toMatch(/unknown tool/)
  })

  it('refuses to start without a key', async () => {
    await expect(session.send('do something', { apiKey: '', model: 'x' })).rejects.toThrow(/No API key/)
  })

  it('stops after the turn cap instead of looping forever', async () => {
    for (let i = 0; i < 40; i++) script.push(call(`t${i}`, 'get_media', {}))
    await session.send('loop', SETTINGS)

    const last = events.at(-1)
    expect(last.type).toBe('error')
    expect(last.message).toMatch(/Stopped after 24 tool rounds/)
  })

  it('keeps the conversation so a follow-up has context, and clears on demand', async () => {
    script.push(text('First.'))
    await session.send('one', SETTINGS)
    expect(session.transcript.length).toBe(2)

    session.clear()
    expect(session.transcript).toHaveLength(0)
  })
})
