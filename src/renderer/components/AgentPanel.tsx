import { useEffect, useRef, useState } from 'react'

import type { AgentEvent } from '../../main/agent/session.js'
import type { JournalEntry } from '../../main/project/store.js'
import { IconUndo } from './Icons.js'

interface Props {
  journal: JournalEntry[]
  onRevert: (entryId: string) => void
  onError: (message: string) => void
}

interface Settings {
  model: string
  hasKey: boolean
  models: readonly { id: string; label: string }[]
}

type Entry =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; result?: { ok: boolean; summary: string } }
  | { kind: 'error'; id: string; text: string }

/**
 * The conversation panel.
 *
 * The agent edits through the same tools as everything else, so there is no
 * preview-then-apply step: what it does is already on the timeline, and the
 * journal below is how you take any of it back.
 */
export function AgentPanel(props: Props) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.palmier.agent.settings().then((result) => {
      if (result.ok) {
        setSettings(result.value)
        if (!result.value.hasKey) setShowSettings(true)
      }
    })
  }, [])

  useEffect(
    () =>
      window.palmier.agent.onEvent((event: AgentEvent) => {
        setEntries((current) => reduce(current, event))
        if (event.type === 'done' || event.type === 'error') setBusy(false)
      }),
    [],
  )

  // Follow the tail while the answer streams in.
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [entries])

  async function send(): Promise<void> {
    const text = prompt.trim()
    if (!text || busy) return
    setEntries((current) => [...current, { kind: 'user', id: crypto.randomUUID(), text }])
    setPrompt('')
    setBusy(true)
    const result = await window.palmier.agent.send(text)
    if (!result.ok) {
      setBusy(false)
      setEntries((current) => [...current, { kind: 'error', id: crypto.randomUUID(), text: result.message }])
    }
  }

  async function saveKey(): Promise<void> {
    const result = await window.palmier.agent.configure({ apiKey: keyDraft.trim() })
    if (!result.ok) return props.onError(result.message)
    setSettings(result.value)
    setKeyDraft('')
    if (result.value.hasKey) setShowSettings(false)
  }

  return (
    <div className="agent-panel">
      <div className="agent-head">
        <select
          value={settings?.model ?? ''}
          disabled={!settings}
          title="Model used for the next message"
          onChange={async (event) => {
            const result = await window.palmier.agent.configure({ model: event.target.value })
            if (result.ok) setSettings(result.value)
            else props.onError(result.message)
          }}
        >
          {(settings?.models ?? []).map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
        <button
          className={`agent-chip${showSettings ? ' open' : ''}${settings?.hasKey ? '' : ' missing'}`}
          title={settings?.hasKey ? 'Change or remove the stored API key' : 'The agent needs an API key'}
          onClick={() => setShowSettings((open) => !open)}
        >
          {settings?.hasKey ? 'Key set' : 'No key'}
        </button>
        <button
          className="agent-chip"
          disabled={entries.length === 0 || busy}
          title="Forget the conversation. Edits already made stay on the timeline."
          onClick={() => {
            void window.palmier.agent.clear()
            setEntries([])
          }}
        >
          Clear
        </button>
      </div>

      {showSettings ? (
        <div className="agent-settings">
          <p className="hint">
            The agent calls the Anthropic API with your own key. It is encrypted with the Windows
            keystore and never leaves this machine except to that API.
          </p>
          <div className="agent-key">
            <input
              type="password"
              placeholder="sk-ant-…"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void saveKey()}
            />
            <button onClick={() => void saveKey()} disabled={keyDraft.trim() === ''}>
              Save
            </button>
          </div>
          {settings?.hasKey ? (
            <button
              className="link"
              onClick={async () => {
                const result = await window.palmier.agent.configure({ apiKey: '' })
                if (result.ok) setSettings(result.value)
              }}
            >
              Remove the stored key
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="agent-log" ref={scroller}>
        {entries.length === 0 ? (
          <p className="hint">
            Ask for an edit — “cut the first clip at two seconds”, “fade every clip in over 12
            frames”, “put a title over the opening shot”. It works on the timeline you are looking
            at, and everything it does is in the journal below.
          </p>
        ) : (
          entries.map((entry) => <LogEntry key={entry.id} entry={entry} />)
        )}
        {busy ? <p className="agent-busy">Working…</p> : null}
      </div>

      <div className="agent-input">
        <textarea
          rows={3}
          value={prompt}
          placeholder={settings?.hasKey ? 'Describe the edit…' : 'Add an API key first'}
          disabled={!settings?.hasKey}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
        />
        {busy ? (
          <button onClick={() => void window.palmier.agent.cancel()}>Stop</button>
        ) : (
          <button onClick={() => void send()} disabled={!settings?.hasKey || prompt.trim() === ''}>
            Send
          </button>
        )}
      </div>

      <Journal entries={props.journal} onRevert={props.onRevert} />
    </div>
  )
}

function LogEntry({ entry }: { entry: Entry }) {
  const [open, setOpen] = useState(false)

  switch (entry.kind) {
    case 'user':
      return <div className="agent-msg user">{entry.text}</div>
    case 'assistant':
      return <div className="agent-msg assistant">{entry.text}</div>
    case 'error':
      return <div className="agent-msg error">{entry.text}</div>
    case 'tool':
      return (
        <div className={`agent-tool${entry.result && !entry.result.ok ? ' failed' : ''}`}>
          <button className="agent-tool-head" onClick={() => setOpen((v) => !v)}>
            <span className="agent-tool-name">{entry.name}</span>
            <span className="agent-tool-summary">
              {entry.result ? entry.result.summary : 'running…'}
            </span>
          </button>
          {open ? <pre className="agent-tool-args">{JSON.stringify(entry.input, null, 2)}</pre> : null}
        </div>
      )
  }
}

function Journal(props: { entries: JournalEntry[]; onRevert: (entryId: string) => void }) {
  const newestFirst = [...props.entries].reverse()

  return (
    <div className="agent-journal">
      <h4>Action journal · {props.entries.length}</h4>
      {newestFirst.length === 0 ? (
        <p className="hint">Nothing has changed the project yet.</p>
      ) : (
        <ul>
          {newestFirst.map((entry, index) => (
            <li key={entry.id} className={`journal-row ${entry.source}`}>
              <span className="journal-source" title={`Made by the ${entry.source}`}>
                {entry.source}
              </span>
              <span className="journal-summary" title={entry.summary}>
                {entry.summary}
              </span>
              <button
                className="icon-btn"
                title={
                  index === 0
                    ? 'Undo this action'
                    : `Undo just this action, re-running the ${index} later one(s) on top`
                }
                onClick={() => props.onRevert(entry.id)}
              >
                <IconUndo />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Folds the event stream into the visible log.
 *
 * Text deltas append to the assistant entry that is currently open, so a
 * streaming answer grows in place rather than arriving as a hundred bubbles.
 */
function reduce(entries: Entry[], event: AgentEvent): Entry[] {
  switch (event.type) {
    case 'text': {
      const last = entries[entries.length - 1]
      if (last?.kind === 'assistant') {
        return [...entries.slice(0, -1), { ...last, text: last.text + event.delta }]
      }
      return [...entries, { kind: 'assistant', id: crypto.randomUUID(), text: event.delta }]
    }
    case 'tool':
      return [...entries, { kind: 'tool', id: event.id, name: event.name, input: event.input }]
    case 'result':
      return entries.map((entry) =>
        entry.kind === 'tool' && entry.id === event.id
          ? { ...entry, result: { ok: event.ok, summary: event.summary } }
          : entry,
      )
    case 'error':
      return [...entries, { kind: 'error', id: crypto.randomUUID(), text: event.message }]
    default:
      return entries
  }
}
