import { useEffect, useState } from 'react'

import type { RenderProgress, Snapshot } from '../../preload/index.js'
import type { UpdateState } from '../../main/updater.js'
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
  const [updateError, setUpdateError] = useState<string | null>(null)

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

      <UpdateNotice onError={(message) => setUpdateError(message)} />
      {updateError ? <span className="message error">{updateError}</span> : null}

      {props.status ? <span className={`message ${props.status.tone}`}>{props.status.text}</span> : null}
    </div>
  )
}

/**
 * A notice, not a nag.
 *
 * It appears only when there is something newer, and each step — download,
 * then restart — is a separate click, because an editor with an unsaved cut
 * open must never restart itself.
 */
function UpdateNotice(props: { onError: (message: string) => void }) {
  const [update, setUpdate] = useState<UpdateState | null>(null)

  useEffect(() => {
    void window.palmier.update.state().then((result) => result.ok && setUpdate(result.value))
    return window.palmier.update.onChanged(setUpdate)
  }, [])

  if (!update || !update.available) return null

  if (update.downloaded) {
    return (
      <span className="update-notice ready">
        {update.available} is ready
        <button
          className="link-btn"
          onClick={async () => {
            const result = await window.palmier.update.install()
            if (!result.ok) props.onError(result.message)
          }}
        >
          Restart to install
        </button>
      </span>
    )
  }

  if (update.percent > 0) {
    return <span className="update-notice">Downloading {update.available} — {update.percent}%</span>
  }

  return (
    <span className="update-notice">
      {update.available} available
      <button className="link-btn" onClick={() => void window.palmier.update.download()}>
        Download
      </button>
      <span className="unsigned" title="Builds are not code-signed yet, so Windows will warn on install">
        unsigned
      </span>
    </span>
  )
}
