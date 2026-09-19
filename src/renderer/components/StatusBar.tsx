import type { RenderProgress, Snapshot } from '../../preload/index.js'
import type { StatusMessage } from '../state.js'

interface Props {
  mcp: Snapshot['mcp']
  status: StatusMessage | null
  progress: RenderProgress | null
  clipCount: number
  assetCount: number
}

export function StatusBar(props: Props) {
  const { mcp, progress } = props
  const percent = progress && progress.totalFrames > 0
    ? Math.min(100, Math.round((progress.frame / progress.totalFrames) * 100))
    : 0

  return (
    <div className="status">
      <span title={mcp.error ?? undefined}>
        <span className={`dot ${mcp.running ? 'on' : 'off'}`} />
        MCP {mcp.running ? <code>{mcp.endpoint}</code> : `offline${mcp.error ? ` — ${mcp.error}` : ''}`}
      </span>

      <span>{props.assetCount} assets · {props.clipCount} clips</span>

      {progress ? (
        <>
          <span>
            Exporting {progress.frame}/{progress.totalFrames} ({percent}%) at {progress.speed}
          </span>
          <div className="progress">
            <div style={{ transform: `scaleX(${percent / 100})` }} />
          </div>
        </>
      ) : null}

      <span className="spacer" />

      {props.status ? (
        <span className={`message ${props.status.tone}`}>{props.status.text}</span>
      ) : null}
    </div>
  )
}
