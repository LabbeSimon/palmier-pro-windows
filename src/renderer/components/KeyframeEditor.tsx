import { useEffect, useMemo, useRef, useState } from 'react'

import { sampleKeyframes, type Easing, type Keyframe } from '../../core/keyframes.js'
import { animatableTargets } from '../../core/ops.js'
import type { Clip, Timeline } from '../../core/model.js'
import { IconTrash } from './Icons.js'

interface Props {
  clip: Clip | null
  timeline: Timeline
  /** Timeline playhead, not clip-relative. */
  frame: number
  onSeek: (frame: number) => void
  onSetKeyframe: (target: string, frame: number, value: number, easing: Easing) => void
  onMoveKeyframe: (target: string, fromFrame: number, toFrame: number) => void
  onRemoveKeyframe: (target: string, frame?: number) => void
}

/** Half the diamond width, in pixels: the breathing room each ruler end needs. */
const INSET = 7

const EASING_LABELS: Record<Easing, string> = {
  linear: 'Linear',
  smooth: 'Smooth',
  hold: 'Hold',
}

/**
 * The keyframe bar under the project monitor, as Kdenlive places it.
 *
 * It only appears for a single selected clip: a curve belongs to one clip, and
 * showing several at once would make "add a keyframe here" ambiguous. Frames on
 * the ruler are clip-relative, which is how they are stored — the playhead is
 * projected into that space rather than the curve being projected out of it.
 */
export function KeyframeEditor(props: Props) {
  const { clip, timeline } = props
  const [openTargets, setOpenTargets] = useState<string[]>([])
  const [selected, setSelected] = useState<{ target: string; frame: number } | null>(null)

  const targets = useMemo(() => (clip ? animatableTargets(clip) : []), [clip])
  const animated = targets.filter((t) => t.keyframes.length > 0)

  // A different clip means a different set of curves; anything remembered about
  // the last one would point at keyframes that no longer exist.
  useEffect(() => {
    setOpenTargets([])
    setSelected(null)
  }, [clip?.id])

  if (!clip) {
    return (
      <div className="keyframe-bar empty">
        <span className="hint">Select one clip to animate its parameters.</span>
      </div>
    )
  }

  const rows = targets.filter((t) => t.keyframes.length > 0 || openTargets.includes(t.target))
  const unopened = targets.filter((t) => !rows.includes(t))
  const clipFrame = props.frame - clip.startFrame
  const inside = clipFrame >= 0 && clipFrame < clip.durationFrames

  return (
    <div className="keyframe-bar">
      <div className="keyframe-head">
        <span className="keyframe-title">Keyframes</span>
        <span className="keyframe-scope">
          {animated.length > 0
            ? `${animated.length} animated · clip frame ${inside ? clipFrame : '—'}`
            : `clip frame ${inside ? clipFrame : '—'}`}
        </span>
        <select
          className="keyframe-add"
          value=""
          onChange={(event) => {
            if (!event.target.value) return
            setOpenTargets((current) => [...current, event.target.value])
          }}
        >
          <option value="">Animate…</option>
          {unopened.map((target) => (
            <option key={target.target} value={target.target}>
              {target.label}
            </option>
          ))}
        </select>
      </div>

      {rows.length === 0 ? (
        <p className="hint">
          Nothing animated. Pick a parameter above, park the playhead, then place a keyframe.
        </p>
      ) : (
        rows.map((target) => (
          <KeyframeRow
            key={target.target}
            label={target.label}
            min={target.min}
            max={target.max}
            step={target.step}
            unit={target.unit}
            fallback={target.fallback}
            keyframes={target.keyframes}
            durationFrames={clip.durationFrames}
            clipFrame={clipFrame}
            inside={inside}
            selectedFrame={selected?.target === target.target ? selected.frame : null}
            onSelect={(frame) => setSelected(frame === null ? null : { target: target.target, frame })}
            onSeek={(frame) => props.onSeek(clip.startFrame + frame)}
            onSet={(frame, value, easing) => props.onSetKeyframe(target.target, frame, value, easing)}
            onMove={(from, to) => props.onMoveKeyframe(target.target, from, to)}
            onRemove={(frame) => props.onRemoveKeyframe(target.target, frame)}
            onClear={() => {
              props.onRemoveKeyframe(target.target)
              setOpenTargets((current) => current.filter((t) => t !== target.target))
            }}
          />
        ))
      )}

      <p className="keyframe-legend">
        Double-click the ruler to place a keyframe · drag a diamond to move it · one keyframe alone
        holds a constant
      </p>
    </div>
  )
}

interface RowProps {
  label: string
  min: number
  max: number
  step: number
  unit?: string
  fallback: number
  keyframes: Keyframe[]
  durationFrames: number
  clipFrame: number
  inside: boolean
  selectedFrame: number | null
  onSelect: (frame: number | null) => void
  onSeek: (frame: number) => void
  onSet: (frame: number, value: number, easing: Easing) => void
  onMove: (fromFrame: number, toFrame: number) => void
  onRemove: (frame: number) => void
  onClear: () => void
}

function KeyframeRow(props: RowProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  /** Frame the dragged diamond is currently over, committed only on release. */
  const [dragging, setDragging] = useState<{ from: number; to: number } | null>(null)

  const last = Math.max(props.durationFrames - 1, 1)
  /**
   * Diamonds are inset by their own half-width, so the ones on the first and
   * last frame sit whole inside the ruler instead of being clipped in half.
   */
  const toOffset = (frame: number) => `calc(${INSET}px + (100% - ${INSET * 2}px) * ${frame / last})`
  const atPlayhead = props.keyframes.find((k) => k.frame === props.clipFrame) ?? null
  const selected = props.keyframes.find((k) => k.frame === props.selectedFrame) ?? null
  const valueNow = sampleKeyframes(props.keyframes, props.clipFrame, props.fallback)

  /** Pointer x within the ruler, snapped to a frame inside the clip. */
  const frameAt = (clientX: number): number => {
    const box = trackRef.current?.getBoundingClientRect()
    if (!box || box.width === 0) return 0
    const usable = Math.max(box.width - INSET * 2, 1)
    const ratio = Math.min(Math.max((clientX - box.left - INSET) / usable, 0), 1)
    return Math.round(ratio * last)
  }

  const previous = [...props.keyframes].reverse().find((k) => k.frame < props.clipFrame) ?? null
  const next = props.keyframes.find((k) => k.frame > props.clipFrame) ?? null

  function toggleAtPlayhead(): void {
    if (!props.inside) return
    if (atPlayhead) {
      props.onRemove(props.clipFrame)
      props.onSelect(null)
    } else {
      props.onSet(props.clipFrame, valueNow, previous?.easing ?? 'linear')
      props.onSelect(props.clipFrame)
    }
  }

  function startDrag(event: React.PointerEvent, keyframe: Keyframe): void {
    event.stopPropagation()
    event.preventDefault()
    props.onSelect(keyframe.frame)
    setDragging({ from: keyframe.frame, to: keyframe.frame })

    const move = (e: PointerEvent) => setDragging({ from: keyframe.frame, to: frameAt(e.clientX) })
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragging(null)
      const to = frameAt(e.clientX)
      // Committed once on release: one undo entry per drag, not one per frame
      // the pointer crossed.
      if (to !== keyframe.frame) {
        props.onMove(keyframe.frame, to)
        props.onSelect(to)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="keyframe-row">
      <div className="keyframe-label" title={props.label}>
        {props.label}
      </div>

      <div
        ref={trackRef}
        className="keyframe-track"
        onClick={(event) => props.onSeek(frameAt(event.clientX))}
        onDoubleClick={(event) => {
          const frame = frameAt(event.clientX)
          props.onSet(frame, sampleKeyframes(props.keyframes, frame, props.fallback), 'linear')
          props.onSelect(frame)
        }}
      >
        {/* The curve itself, so the shape of the animation is readable at a glance. */}
        {props.keyframes.length >= 2 ? <Curve {...props} last={last} /> : null}

        {props.keyframes.map((keyframe) => {
          const frame = dragging?.from === keyframe.frame ? dragging.to : keyframe.frame
          return (
            <button
              key={keyframe.frame}
              className={
                'keyframe-dot' +
                (props.selectedFrame === keyframe.frame ? ' on' : '') +
                (keyframe.easing === 'hold' ? ' hold' : keyframe.easing === 'smooth' ? ' smooth' : '')
              }
              style={{ left: toOffset(frame) }}
              title={`Frame ${frame} · ${keyframe.value} · ${EASING_LABELS[keyframe.easing]}`}
              onPointerDown={(event) => startDrag(event, keyframe)}
              onClick={(event) => {
                event.stopPropagation()
                props.onSelect(keyframe.frame)
              }}
            />
          )
        })}

        {props.inside ? (
          <div className="keyframe-playhead" style={{ left: toOffset(props.clipFrame) }} />
        ) : null}
      </div>

      <div className="keyframe-actions">
        <button
          className="icon-btn"
          disabled={!previous}
          title="Jump to the previous keyframe"
          onClick={() => previous && props.onSeek(previous.frame)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10.6 3.4 6 8l4.6 4.6a.8.8 0 0 1-1.2 1L4.2 8.5a.7.7 0 0 1 0-1l5.2-5.1a.8.8 0 0 1 1.2 1Z" fill="currentColor" />
          </svg>
        </button>
        <button
          className={`icon-btn diamond${atPlayhead ? ' on' : ''}`}
          disabled={!props.inside}
          title={
            !props.inside
              ? 'Move the playhead over this clip first'
              : atPlayhead
                ? 'Remove the keyframe here'
                : 'Place a keyframe here'
          }
          onClick={toggleAtPlayhead}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 2.5 13.5 8 8 13.5 2.5 8Z" fill={atPlayhead ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
        <button
          className="icon-btn"
          disabled={!next}
          title="Jump to the next keyframe"
          onClick={() => next && props.onSeek(next.frame)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5.4 3.4 10 8l-4.6 4.6a.8.8 0 0 0 1.2 1l5.2-5.1a.7.7 0 0 0 0-1L6.6 2.4a.8.8 0 0 0-1.2 1Z" fill="currentColor" />
          </svg>
        </button>

        <input
          type="number"
          className="keyframe-value"
          min={props.min}
          max={props.max}
          step={props.step}
          value={Number((selected?.value ?? valueNow).toFixed(4))}
          disabled={!selected}
          title={selected ? 'Value at the selected keyframe' : 'Select a keyframe to edit its value'}
          onChange={(event) => {
            const value = Number(event.target.value)
            if (selected && Number.isFinite(value)) props.onSet(selected.frame, value, selected.easing)
          }}
        />
        {props.unit ? <span className="unit">{props.unit}</span> : null}

        <select
          className="keyframe-easing"
          value={selected?.easing ?? 'linear'}
          disabled={!selected}
          title="How the value travels to the next keyframe"
          onChange={(event) => {
            if (selected) props.onSet(selected.frame, selected.value, event.target.value as Easing)
          }}
        >
          {(Object.keys(EASING_LABELS) as Easing[]).map((easing) => (
            <option key={easing} value={easing}>
              {EASING_LABELS[easing]}
            </option>
          ))}
        </select>

        <button className="icon-btn" title="Remove this whole curve" onClick={props.onClear}>
          <IconTrash />
        </button>
      </div>
    </div>
  )
}

/**
 * Polyline of the curve.
 *
 * Normalised to the span the curve actually travels, not the full parameter
 * range: scale runs 0.01 to 10, so a 1 → 1.6 move drawn against the whole range
 * would be a flat line pinned to the floor, which says nothing about the shape.
 */
function Curve(props: RowProps & { last: number }) {
  const values = props.keyframes.map((k) => k.value)
  const low = Math.min(...values)
  const high = Math.max(...values)
  const pad = (high - low) * 0.15 || 1
  const floor = low - pad
  const span = high - low + pad * 2

  const steps = Math.min(props.last, 160)
  const points: string[] = []
  for (let i = 0; i <= steps; i++) {
    const frame = (i / steps) * props.last
    const value = sampleKeyframes(props.keyframes, frame, props.fallback)
    const x = INSET + (100 - INSET * 2) * (i / steps)
    const y = 100 - ((value - floor) / span) * 100
    points.push(`${x.toFixed(2)},${Math.min(Math.max(y, 3), 97).toFixed(2)}`)
  }
  return (
    <svg className="keyframe-curve" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
