import { useEffect, useRef, useState } from 'react'

import { clipEndFrame, type Clip, type MediaAsset, type Timeline } from '../../core/model.js'

interface Props {
  clip: Clip
  timeline: Timeline
  assets: MediaAsset[]
  /** Timeline playhead. */
  frame: number
  onSwitch: (angleIndex: number, frame: number) => void
}

/**
 * The angle grid.
 *
 * Every camera is shown at the moment the playhead is on, which is the only
 * way to choose one: a thumbnail of the head of the file says nothing about
 * what that camera was doing on this line. Clicking cuts from the playhead, so
 * the part before keeps the angle it already had.
 */
export function MulticamPanel(props: Props) {
  const multicam = props.clip.multicam!
  const inside = props.frame >= props.clip.startFrame && props.frame < clipEndFrame(props.clip)

  return (
    <div className="field-group">
      <h4>Angles · {multicam.angles.length}</h4>
      {!inside ? (
        <p className="hint">Move the playhead over this clip to cut between cameras.</p>
      ) : (
        <p className="hint">
          Click an angle, or press its number, to cut here. Sound stays on “{multicam.angles[0]!.name}”.
        </p>
      )}
      <div className="angle-grid">
        {multicam.angles.map((angle, index) => (
          <Angle
            key={angle.assetId}
            index={index}
            name={angle.name}
            asset={props.assets.find((asset) => asset.id === angle.assetId) ?? null}
            seconds={sourceSeconds(props.clip, angle.offsetFrames, props.frame, props.timeline.fps)}
            active={multicam.activeIndex === index}
            disabled={!inside}
            onPick={() => props.onSwitch(index, props.frame)}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Where the playhead falls inside a given angle's own file.
 *
 * The clip reads its current angle from `trimStartFrame`; subtracting that
 * angle's offset gives the moment in sync time, and adding the target angle's
 * offset puts it back into that camera's frames.
 */
function sourceSeconds(clip: Clip, offsetFrames: number, frame: number, fps: number): number {
  const current = clip.multicam!.angles[clip.multicam!.activeIndex]!
  const elapsed = Math.max(0, frame - clip.startFrame) * clip.speed
  const syncRelative = clip.trimStartFrame - current.offsetFrames + elapsed
  return Math.max(0, (syncRelative + offsetFrames) / fps)
}

function Angle(props: {
  index: number
  name: string
  asset: MediaAsset | null
  seconds: number
  active: boolean
  disabled: boolean
  onPick: () => void
}) {
  const [image, setImage] = useState<string | null>(null)
  const generation = useRef(0)

  // Debounced, and a stale answer never overwrites a newer one: scrubbing
  // through a four-angle set would otherwise queue a dozen FFmpeg calls.
  useEffect(() => {
    if (!props.asset) return
    const id = ++generation.current
    const timer = setTimeout(async () => {
      const result = await window.palmier.render.assetFrame(props.asset!.id, props.seconds)
      if (id !== generation.current) return
      if (result.ok) setImage(result.value)
    }, 200)
    return () => clearTimeout(timer)
  }, [props.asset?.id, Math.round(props.seconds * 4)])

  return (
    <button
      className={`angle${props.active ? ' on' : ''}`}
      disabled={props.disabled}
      title={`${props.name} — press ${props.index + 1}`}
      onClick={props.onPick}
    >
      <span className="angle-frame">
        {image ? <img src={image} alt="" /> : <span className="angle-loading">…</span>}
        <span className="angle-index">{props.index + 1}</span>
      </span>
      <span className="angle-name">{props.name}</span>
    </button>
  )
}
