import { useRef } from 'react'

interface Band {
  label: string
  keys: [string, string, string]
}

const BANDS: Band[] = [
  { label: 'Shadows', keys: ['shadowsR', 'shadowsG', 'shadowsB'] },
  { label: 'Midtones', keys: ['midsR', 'midsG', 'midsB'] },
  { label: 'Highlights', keys: ['highsR', 'highsG', 'highsB'] },
]

/**
 * Where each primary sits on the wheel, in radians, red at the top.
 *
 * The same three directions are used to write a puck position into R/G/B and to
 * read it back, so the puck never jumps to a different place than the one it
 * was dropped at.
 */
const AXES: [string, number][] = [
  ['r', -Math.PI / 2],
  ['g', -Math.PI / 2 + (2 * Math.PI) / 3],
  ['b', -Math.PI / 2 + (4 * Math.PI) / 3],
]

interface Props {
  params: Record<string, number>
  onChange: (params: Record<string, number>) => void
}

/** Three-way colour corrector, one wheel per tonal band. */
export function ColorWheels(props: Props) {
  return (
    <div className="color-wheels">
      {BANDS.map((band) => (
        <Wheel
          key={band.label}
          band={band}
          rgb={[
            props.params[band.keys[0]] ?? 0,
            props.params[band.keys[1]] ?? 0,
            props.params[band.keys[2]] ?? 0,
          ]}
          onChange={(rgb) =>
            props.onChange({
              [band.keys[0]]: rgb[0],
              [band.keys[1]]: rgb[1],
              [band.keys[2]]: rgb[2],
            })
          }
        />
      ))}
    </div>
  )
}

/** Puck position (unit disc) for a colour shift. */
function toPuck(rgb: [number, number, number]): { x: number; y: number } {
  let x = 0
  let y = 0
  AXES.forEach(([, angle], index) => {
    x += rgb[index]! * Math.cos(angle)
    y += rgb[index]! * Math.sin(angle)
  })
  // The three axes sum to zero, so the projection is 2/3 of the round trip.
  return { x: (x * 2) / 3, y: (y * 2) / 3 }
}

/**
 * Colour shift for a puck position.
 *
 * The mean is subtracted so the triple carries hue and chroma only: a wheel
 * that also lifted brightness would fight the exposure controls above it, and
 * the puck could not be read back from the values.
 */
function toRgb(x: number, y: number): [number, number, number] {
  const raw = AXES.map(([, angle]) => x * Math.cos(angle) + y * Math.sin(angle))
  const mean = (raw[0]! + raw[1]! + raw[2]!) / 3
  return raw.map((value) => round(value - mean)) as [number, number, number]
}

const round = (value: number) => Math.round(Math.min(Math.max(value, -1), 1) * 1000) / 1000

/** Two decimals without the leading zero, so three values fit on one line. */
const format = (value: number) =>
  (value < 0 ? '-' : '') + Math.abs(value).toFixed(2).replace(/^0/, '')

function Wheel(props: {
  band: Band
  rgb: [number, number, number]
  onChange: (rgb: [number, number, number]) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const puck = toPuck(props.rgb)
  const neutral = props.rgb.every((value) => Math.abs(value) < 1e-3)

  function drag(event: React.PointerEvent): void {
    event.preventDefault()
    const apply = (clientX: number, clientY: number) => {
      const box = ref.current?.getBoundingClientRect()
      if (!box) return
      const radius = box.width / 2
      let x = (clientX - box.left - radius) / radius
      let y = (clientY - box.top - radius) / radius
      // Outside the disc the shift is clamped to full chroma at that hue,
      // rather than refusing the drag once the pointer leaves the circle.
      const distance = Math.hypot(x, y)
      if (distance > 1) {
        x /= distance
        y /= distance
      }
      props.onChange(toRgb(x, y))
    }

    apply(event.clientX, event.clientY)
    const move = (e: PointerEvent) => apply(e.clientX, e.clientY)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="wheel">
      <div
        ref={ref}
        className="wheel-disc"
        role="slider"
        tabIndex={0}
        aria-label={`${props.band.label} colour shift`}
        aria-valuetext={
          neutral
            ? 'neutral'
            : `R ${props.rgb[0].toFixed(2)}, G ${props.rgb[1].toFixed(2)}, B ${props.rgb[2].toFixed(2)}`
        }
        onPointerDown={drag}
        onDoubleClick={() => props.onChange([0, 0, 0])}
      >
        <span
          className="wheel-puck"
          style={{ left: `${(puck.x / 2 + 0.5) * 100}%`, top: `${(puck.y / 2 + 0.5) * 100}%` }}
        />
      </div>
      <span className="wheel-label">{props.band.label}</span>
      <span className="wheel-value">
        {neutral ? 'neutral' : props.rgb.map((value) => format(value)).join(' ')}
      </span>
    </div>
  )
}
