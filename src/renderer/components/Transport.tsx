import type { Timeline } from '../../core/model.js'
import { framesToTimecode } from '../../core/timecode.js'
import { IconEnd, IconNextFrame, IconPause, IconPlay, IconPrevFrame, IconSplit, IconStart } from './Icons.js'

interface Props {
  timeline: Timeline
  frame: number
  totalFrames: number
  playing: boolean
  /** False until a proxy exists; the play button says why it is disabled. */
  canPlay: boolean
  onSeek: (frame: number) => void
  onSplit: () => void
  onTogglePlay: () => void
}

/**
 * The transport is where you read *where you are*, so the playhead timecode is
 * the largest number on screen and the only warm one; the duration sits beside
 * it as quiet context.
 */
export function Transport(props: Props) {
  const { timeline, frame, totalFrames } = props
  const last = Math.max(0, totalFrames - 1)
  const seek = (target: number) => props.onSeek(Math.max(0, Math.min(last, target)))

  return (
    <div className="transport">
      <span className="timecode" title="Playhead">
        {framesToTimecode(frame, timeline.fps)}
      </span>
      <span className="total" title="Timeline duration">
        / {framesToTimecode(totalFrames, timeline.fps)}
      </span>

      <div className="keys">
        <button className="icon-btn" title="Go to start (Home)" onClick={() => seek(0)}>
          <IconStart />
        </button>
        <button className="icon-btn" title="Previous frame (←)" onClick={() => seek(frame - 1)}>
          <IconPrevFrame />
        </button>
        <button
          className={`icon-btn${props.playing ? ' on' : ''}`}
          title={props.canPlay ? 'Play / pause (Space)' : 'Build the preview first to play'}
          disabled={!props.canPlay}
          onClick={props.onTogglePlay}
        >
          {props.playing ? <IconPause /> : <IconPlay />}
        </button>
        <button className="icon-btn" title="Next frame (→)" onClick={() => seek(frame + 1)}>
          <IconNextFrame />
        </button>
        <button className="icon-btn" title="Go to end (End)" onClick={() => seek(last)}>
          <IconEnd />
        </button>
        <span className="divider" />
        <button className="icon-btn" title="Split at playhead (S)" onClick={props.onSplit}>
          <IconSplit />
        </button>
      </div>

      <span className="spacer" />

      <span className="format">
        <span>{timeline.width}×{timeline.height}</span>
        <span>{timeline.fps} fps</span>
        <span>{totalFrames} f</span>
      </span>
    </div>
  )
}
