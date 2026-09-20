import { useRef, useState } from 'react'

import { IDENTITY_CURVE, normalizeCurve, type CurvePoint } from '../../core/effects.js'

interface Props {
  channel: string
  label: string
  points: CurvePoint[] | undefined
  onChange: (points: CurvePoint[]) => void
}

/** Pixel radius within which a click counts as grabbing an existing point. */
const GRAB = 0.06

/**
 * A tone curve you drag.
 *
 * Input runs left to right, output bottom to top, so the identity is the
 * diagonal — the arrangement every grading tool uses, and the reason an
 * S-shape reads instantly as "more contrast".
 */
export function CurveEditor(props: Props) {
  const boxRef = useRef<SVGSVGElement>(null)
  const points = props.points && props.points.length >= 2 ? props.points : IDENTITY_CURVE
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  /** Pointer position in curve space, clamped to the unit square. */
  const at = (event: { clientX: number; clientY: number }): CurvePoint => {
    const box = boxRef.current?.getBoundingClientRect()
    if (!box) return { x: 0, y: 0 }
    const clamp = (value: number) => Math.min(Math.max(value, 0), 1)
    return {
      x: clamp((event.clientX - box.left) / box.width),
      y: clamp(1 - (event.clientY - box.top) / box.height),
    }
  }

  function commit(next: CurvePoint[]): void {
    props.onChange(normalizeCurve(next))
  }

  function onPointerDown(event: React.PointerEvent<SVGSVGElement>): void {
    const target = at(event)
    const nearest = points.reduce(
      (best, point, index) => {
        const distance = Math.hypot(point.x - target.x, point.y - target.y)
        return distance < best.distance ? { index, distance } : best
      },
      { index: -1, distance: Infinity },
    )

    if (nearest.distance <= GRAB) {
      startDrag(nearest.index, points)
      return
    }
    // A click on empty space adds a point there, which is how you shape a curve.
    const next = normalizeCurve([...points, target])
    commit(next)
    startDrag(
      next.findIndex((point) => Math.abs(point.x - target.x) < 1e-3),
      next,
    )
  }

  function startDrag(index: number, from: CurvePoint[]): void {
    if (index < 0) return
    setDragIndex(index)
    const first = index === 0
    const last = index === from.length - 1

    const move = (event: PointerEvent) => {
      const target = at(event)
      const next = from.map((point, i) =>
        i === index
          ? // The endpoints hold their input position: a curve must define a
            // value for pure black and pure white, or FFmpeg extrapolates.
            { x: first ? 0 : last ? 1 : target.x, y: target.y }
          : point,
      )
      commit(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragIndex(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function removePoint(index: number): void {
    if (index === 0 || index === points.length - 1) return
    commit(points.filter((_point, i) => i !== index))
  }

  const path = points.map((point) => `${(point.x * 100).toFixed(2)},${((1 - point.y) * 100).toFixed(2)}`)

  return (
    <div className={`curve-editor ${props.channel}`}>
      <div className="curve-head">
        <span>{props.label}</span>
        <button
          className="link"
          disabled={points === IDENTITY_CURVE}
          title="Back to a straight line"
          onClick={() => commit(IDENTITY_CURVE)}
        >
          Reset
        </button>
      </div>
      <svg
        ref={boxRef}
        className="curve-canvas"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${props.label} tone curve`}
        onPointerDown={onPointerDown}
      >
        <line x1="0" y1="100" x2="100" y2="0" className="curve-identity" vectorEffect="non-scaling-stroke" />
        <polyline points={path.join(' ')} className="curve-line" vectorEffect="non-scaling-stroke" />
        {points.map((point, index) => (
          <circle
            key={`${point.x}-${index}`}
            cx={point.x * 100}
            cy={(1 - point.y) * 100}
            r="2.4"
            className={`curve-point${dragIndex === index ? ' on' : ''}`}
            vectorEffect="non-scaling-stroke"
            onDoubleClick={(event) => {
              event.stopPropagation()
              removePoint(index)
            }}
          />
        ))}
      </svg>
      <p className="curve-hint">Click to add · drag to bend · double-click a point to remove it</p>
    </div>
  )
}
