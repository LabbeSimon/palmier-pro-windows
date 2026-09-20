import { useEffect, useRef, useState } from 'react'

import type { Clip, MediaAsset, Timeline } from '../../core/model.js'
import type { Easing } from '../../core/keyframes.js'
import { KeyframeEditor } from './KeyframeEditor.js'
import { framesToTimecode } from '../../core/timecode.js'
import { ProjectMonitor } from './ProjectMonitor.js'
import { Transport } from './Transport.js'
import type { PlayerState } from '../usePlayer.js'

interface Props {
  timeline: Timeline
  frame: number
  totalFrames: number
  image: string | null
  busy: boolean
  error: string | null
  empty: boolean
  /** Asset shown in the clip monitor; null when nothing is picked in the bin. */
  clipAsset: MediaAsset | null
  /** The single selected clip, or null when the selection is not exactly one. */
  keyframeClip: Clip | null
  player: PlayerState
  onSeek: (frame: number) => void
  onSplit: () => void
  onSetPlaying: (playing: boolean) => void
  /** Play, building the proxy first if there is none. */
  onPlay: () => void
  onRenderPreview: () => void
  onCancelRender: () => void
  onPlaybackError: (message: string) => void
  onSetKeyframe: (target: string, frame: number, value: number, easing: Easing) => void
  onMoveKeyframe: (target: string, fromFrame: number, toFrame: number) => void
  onRemoveKeyframe: (target: string, frame?: number) => void
}

type Monitor = 'project' | 'clip'

/**
 * Two monitors, as an editor expects: the clip monitor shows the raw source
 * from the bin, the project monitor shows the composited edit. Keeping them in
 * one pane with tabs rather than side by side preserves picture size on a
 * laptop, which is the machine this runs on.
 */
export function Monitors(props: Props) {
  const [monitor, setMonitor] = useState<Monitor>('project')
  const [clipSeconds, setClipSeconds] = useState(0)

  // Picking a different asset should start that clip from its head.
  useEffect(() => setClipSeconds(0), [props.clipAsset?.id])

  const clipFrame = useClipFrame(props.clipAsset, clipSeconds, monitor === 'clip')
  const showClip = monitor === 'clip'

  return (
    <div className="panel">
      <div className="tabs monitors" role="tablist">
        <button
          role="tab"
          aria-selected={monitor === 'clip'}
          className={monitor === 'clip' ? 'on' : ''}
          onClick={() => setMonitor('clip')}
        >
          Clip monitor
        </button>
        <button
          role="tab"
          aria-selected={monitor === 'project'}
          className={monitor === 'project' ? 'on' : ''}
          onClick={() => setMonitor('project')}
        >
          Project monitor
        </button>
      </div>

      {showClip ? (
        <div className="preview">
          {props.clipAsset ? (
            clipFrame.image ? (
              <img src={props.clipAsset ? clipFrame.image : undefined} alt={props.clipAsset.name} />
            ) : (
              <p className="placeholder">{clipFrame.error ?? 'Loading the source…'}</p>
            )
          ) : (
            <p className="placeholder">
              Nothing picked.
              <br />
              Select a file in the project bin to inspect it here.
            </p>
          )}
          {clipFrame.busy ? <span className="badge busy">Rendering</span> : null}
          {props.clipAsset ? <span className="badge tc">{clipSeconds.toFixed(2)} s</span> : null}
        </div>
      ) : (
        <ProjectMonitor
          timeline={props.timeline}
          frame={props.frame}
          totalFrames={props.totalFrames}
          player={props.player}
          stillImage={props.image}
          stillBusy={props.busy}
          stillError={props.error}
          empty={props.empty}
          onSeek={props.onSeek}
          onSetPlaying={props.onSetPlaying}
          onPlay={props.onPlay}
          onRenderPreview={props.onRenderPreview}
          onCancelRender={props.onCancelRender}
          onPlaybackError={props.onPlaybackError}
        />
      )}

      {showClip ? (
        <div className="transport">
          <span className="timecode">{clipSeconds.toFixed(2)}</span>
          <span className="total">/ {(props.clipAsset?.durationSeconds ?? 0).toFixed(2)} s</span>
          <input
            className="scrub"
            type="range"
            min={0}
            max={Math.max(0.01, props.clipAsset?.durationSeconds ?? 0)}
            step={0.04}
            value={clipSeconds}
            disabled={!props.clipAsset || (props.clipAsset.durationSeconds ?? 0) <= 0}
            aria-label="Scrub the source clip"
            onChange={(event) => setClipSeconds(Number(event.target.value))}
          />
          <span className="format">
            {props.clipAsset ? `${props.clipAsset.width}×${props.clipAsset.height}` : '—'}
          </span>
        </div>
      ) : (
        <Transport
          timeline={props.timeline}
          frame={props.frame}
          totalFrames={props.totalFrames}
          playing={props.player.playing}
          canPlay={props.player.fresh}
          onSeek={props.onSeek}
          onSplit={props.onSplit}
          onTogglePlay={props.onPlay}
        />
      )}

      {showClip ? null : (
        <KeyframeEditor
          clip={props.keyframeClip}
          timeline={props.timeline}
          frame={props.frame}
          onSeek={props.onSeek}
          onSetKeyframe={props.onSetKeyframe}
          onMoveKeyframe={props.onMoveKeyframe}
          onRemoveKeyframe={props.onRemoveKeyframe}
        />
      )}
    </div>
  )
}

/** Debounced source-frame fetch; a stale response never overwrites a newer one. */
function useClipFrame(asset: MediaAsset | null, seconds: number, enabled: boolean) {
  const [image, setImage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    if (!enabled || !asset) return
    if (asset.type === 'audio' || asset.type === 'subtitle') {
      setImage(null)
      setError('This media has no picture.')
      return
    }
    const id = ++generation.current
    const timer = setTimeout(async () => {
      setBusy(true)
      const result = await window.palmier.render.assetFrame(asset.id, seconds)
      if (id !== generation.current) return
      setBusy(false)
      if (result.ok) {
        setImage(result.value)
        setError(null)
      } else {
        setError(result.message)
      }
    }, 140)
    return () => clearTimeout(timer)
  }, [asset, seconds, enabled])

  return { image, busy, error }
}
