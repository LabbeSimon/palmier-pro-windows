/**
 * The in-app agent.
 *
 * It runs the same tools the MCP server exposes, against the same store, so an
 * edit it makes is indistinguishable from one made in the panel — same undo
 * stack, same journal, same refusals. The only difference is attribution.
 */

import { EventEmitter } from 'node:events'

import { activeTimeline, timelineDisplayFrames } from '../../core/model.js'
import { framesToTimecode } from '../../core/timecode.js'
import { OpError } from '../../core/ops.js'
import { TOOLS, TOOLS_BY_NAME, type ToolContext } from '../mcp/tools.js'
import type { ProjectStore } from '../project/store.js'
import { AgentError, complete, type ContentBlock, type Message } from './client.js'

/** Guard against a loop that keeps calling tools and never answers. */
const MAX_TURNS = 24

export interface AgentSettings {
  apiKey: string
  model: string
}

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'result'; id: string; ok: boolean; summary: string }
  | { type: 'turn-end' }
  | { type: 'done'; usage: { input: number; output: number } }
  | { type: 'error'; message: string }

const SYSTEM = `You are the editing assistant built into Palmier Win, a Windows video editor.

You edit the timeline the user is looking at, through tools. The user sees every change the
instant you make it, and can undo any of your actions individually from the journal.

How to work:
- Read before you write. get_timeline or inspect_timeline gives you real clip ids; positional
  guesses break as soon as anything moves.
- Frames are the unit of truth. The timeline's fps is in get_timeline.
- Make the edit, then say in one or two sentences what you did. Do not narrate each tool call —
  the user already sees them.
- When a tool refuses, it tells you exactly why and usually with the number you needed. Use that
  instead of retrying the same call.
- If a request is ambiguous in a way that changes the edit, ask rather than guess. If it is
  ambiguous in a way that does not, pick the obvious reading and say which you picked.
- You cannot see the picture. Never claim something looks good; describe what you changed.`

export class AgentSession extends EventEmitter {
  private messages: Message[] = []
  private controller: AbortController | null = null
  private running = false

  constructor(
    private readonly store: ProjectStore,
    private readonly ctx: ToolContext,
  ) {
    super()
  }

  get busy(): boolean {
    return this.running
  }

  get transcript(): Message[] {
    return this.messages
  }

  clear(): void {
    this.messages = []
  }

  cancel(): void {
    this.controller?.abort()
  }

  /** One user turn: runs tools until the model answers, or the cap is hit. */
  async send(prompt: string, settings: AgentSettings): Promise<void> {
    if (this.running) throw new OpError('refused', 'The agent is already working on the previous message.')
    if (!settings.apiKey) {
      throw new OpError('refused', 'No API key yet. Add one in the agent panel before sending.')
    }

    this.running = true
    this.controller = new AbortController()
    this.messages.push({ role: 'user', content: `${prompt}\n\n${this.situation()}` })

    const schemas = TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }))

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const completion = await complete(
          {
            apiKey: settings.apiKey,
            model: settings.model,
            system: SYSTEM,
            messages: this.messages,
            tools: schemas,
            signal: this.controller.signal,
          },
          {
            onText: (delta) => this.emit('event', { type: 'text', delta } satisfies AgentEvent),
            onToolStart: () => {},
          },
        )

        this.messages.push({ role: 'assistant', content: completion.content })
        const calls = completion.content.filter((block) => block.type === 'tool_use')
        if (calls.length === 0 || completion.stopReason !== 'tool_use') {
          this.emit('event', { type: 'done', usage: completion.usage } satisfies AgentEvent)
          return
        }

        const results: ContentBlock[] = []
        for (const call of calls) {
          if (call.type !== 'tool_use') continue
          this.emit('event', {
            type: 'tool',
            id: call.id,
            name: call.name,
            input: call.input,
          } satisfies AgentEvent)
          results.push(await this.runTool(call.id, call.name, call.input))
        }
        this.messages.push({ role: 'user', content: results })
        this.emit('event', { type: 'turn-end' } satisfies AgentEvent)
      }

      this.emit('event', {
        type: 'error',
        message: `Stopped after ${MAX_TURNS} tool rounds without a final answer. The edits made so far are in the journal.`,
      } satisfies AgentEvent)
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        this.emit('event', { type: 'error', message: 'Cancelled.' } satisfies AgentEvent)
        return
      }
      const message =
        error instanceof AgentError || error instanceof OpError
          ? error.message
          : `Could not reach the API: ${(error as Error).message}`
      this.emit('event', { type: 'error', message } satisfies AgentEvent)
    } finally {
      this.running = false
      this.controller = null
    }
  }

  private async runTool(id: string, name: string, input: Record<string, unknown>): Promise<ContentBlock> {
    const tool = TOOLS_BY_NAME.get(name)
    if (!tool) {
      const message = `unknown tool "${name}"`
      this.emit('event', { type: 'result', id, ok: false, summary: message } satisfies AgentEvent)
      return { type: 'tool_result', tool_use_id: id, content: message, is_error: true }
    }

    try {
      const result = await this.store.runAttributed({ source: 'agent', name, args: input }, () =>
        tool.handler(input, this.ctx),
      )
      const payload = JSON.stringify(result, null, 2)
      this.emit('event', {
        type: 'result',
        id,
        ok: true,
        summary: summarise(result),
      } satisfies AgentEvent)
      return { type: 'tool_result', tool_use_id: id, content: payload }
    } catch (error) {
      // A refusal is information the model can act on, so it goes back as a
      // result rather than aborting the turn.
      const message = error instanceof OpError ? `${error.code}: ${error.message}` : (error as Error).message
      this.emit('event', { type: 'result', id, ok: false, summary: message } satisfies AgentEvent)
      return { type: 'tool_result', tool_use_id: id, content: message, is_error: true }
    }
  }

  /** A short note on the project, so the first tool call is an informed one. */
  private situation(): string {
    const project = this.store.project
    const timeline = activeTimeline(project)
    return (
      `[Current state: project "${project.name}", timeline "${timeline.name}" ` +
      `${timeline.width}x${timeline.height} @ ${timeline.fps}fps, ` +
      `${framesToTimecode(timelineDisplayFrames(timeline), timeline.fps)} long, ` +
      `${timeline.tracks.length} tracks, ${timeline.tracks.reduce((n, t) => n + t.clips.length, 0)} clips, ` +
      `${project.assets.length} media assets.]`
    )
  }
}

function summarise(result: unknown): string {
  if (result && typeof result === 'object' && 'summary' in result) {
    return String((result as { summary: unknown }).summary)
  }
  const text = JSON.stringify(result)
  return text.length > 160 ? `${text.slice(0, 157)}…` : text
}
