import { useState } from 'react'

import type { RenderProgress, Snapshot } from '../../preload/index.js'
import type { StatusMessage } from '../state.js'

interface Props {
  mcp: Snapshot['mcp']
  status: StatusMessage | null
  progress: RenderProgress | null
  clipCount: number
  assetCount: number
}

/** What an agent host needs pasted into its config to reach this editor. */
function mcpConfig(endpoint: string): string {
  return JSON.stringify(
    { mcpServers: { palmier: { type: 'http', url: endpoint } } },
    null,
    2,
  )
}

export function StatusBar(props: Props) {
  const { mcp, progress } = props
  const [copied, setCopied] = useState<'config' | 'cli' | null>(null)

  const percent =
    progress && progress.totalFrames > 0
      ? Math.min(100, Math.round((progress.frame / progress.totalFrames) * 100))
      : 0

  const copy = async (what: 'config' | 'cli') => {
    if (!mcp.endpoint) return
    const text =
      what === 'config' ? mcpConfig(mcp.endpoint) : `claude mcp add --transport http palmier ${mcp.endpoint}`
    const result = await window.palmier.system.copyToClipboard(text)
    if (!result.ok) return
    setCopied(what)
    window.setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div className="status">
      <span className="mcp-block" title={mcp.error ?? undefined}>
        <span className={`dot ${mcp.running ? 'on' : 'off'}`} />
        MCP
        {mcp.running && mcp.endpoint ? (
          <>
            <code>{mcp.endpoint}</code>
            {/* One click to wire an agent in — reading the URL off the bar and
                retyping it by hand was the friction here. */}
            <button className="link-btn" onClick={() => void copy('cli')} title="Copy the claude mcp add command">
              {copied === 'cli' ? 'Copied' : 'Copy command'}
            </button>
            <button className="link-btn" onClick={() => void copy('config')} title="Copy the mcpServers JSON block">
              {copied === 'config' ? 'Copied' : 'Copy JSON'}
            </button>
          </>
        ) : (
          <span className="offline">offline{mcp.error ? ` — ${mcp.error}` : ''}</span>
        )}
      </span>

      <span className="divider" />

      <span>
        {props.assetCount} assets · {props.clipCount} clips
      </span>

      {progress ? (
        <>
          <span className="divider" />
          <span>
            Exporting {progress.frame}/{progress.totalFrames} ({percent}%) at {progress.speed}
          </span>
          <div className="progress">
            <div style={{ transform: `scaleX(${percent / 100})` }} />
          </div>
        </>
      ) : null}

      <span className="spacer" />

      {props.status ? <span className={`message ${props.status.tone}`}>{props.status.text}</span> : null}
    </div>
  )
}
