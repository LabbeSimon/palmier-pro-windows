import type { Timeline } from '../../core/model.js'
import { framesToTimecode } from '../../core/timecode.js'

interface Props {
  timeline: Timeline
  frame: number
  image: string | null
  busy: boolean
  error: string | null
  empty: boolean
}

export function Preview(props: Props) {
  return (
    <div className="panel">
      <div className="panel-title">
        <span>Preview</span>
        <span>
          {props.timeline.width}×{props.timeline.height} · {props.timeline.fps} fps
        </span>
      </div>
      <div className="preview">
        {props.empty ? (
          <p className="placeholder">
            The timeline is empty.
            <br />
            Drag media from the left onto a track, or ask an agent over MCP.
          </p>
        ) : props.error ? (
          <p className="placeholder" style={{ color: 'var(--danger)' }}>
            Preview failed
            <br />
            {props.error}
          </p>
        ) : props.image ? (
          <img src={props.image} alt={`Frame ${props.frame}`} />
        ) : (
          <p className="placeholder">Rendering the first frame…</p>
        )}
        <span className={`badge${props.busy ? ' busy' : ''}`}>
          {framesToTimecode(props.frame, props.timeline.fps)}
          {props.busy ? ' · rendering' : ''}
        </span>
      </div>
    </div>
  )
}
