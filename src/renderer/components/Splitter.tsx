import { useCallback, useEffect, useRef } from 'react'

interface Props {
  orientation: 'vertical' | 'horizontal'
  /** Current size of the panel this splitter resizes, in pixels. */
  size: number
  min: number
  max: number
  /** True when dragging right/down should shrink the tracked panel. */
  inverted?: boolean
  onResize: (size: number) => void
  label: string
}

/**
 * Drag handle between two docks, as KDE splitters behave: the pointer is
 * captured for the whole gesture so the drag survives crossing other panels,
 * and arrow keys move it for keyboard users.
 *
 * `vertical` means a vertical bar resizing width; `horizontal` a horizontal bar
 * resizing height — the same wording Qt uses.
 */
export function Splitter(props: Props) {
  const { orientation, size, min, max, inverted, onResize } = props
  const dragging = useRef<{ origin: number; start: number } | null>(null)

  const clamp = useCallback((value: number) => Math.min(max, Math.max(min, value)), [min, max])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragging.current = {
      origin: orientation === 'vertical' ? event.clientX : event.clientY,
      start: size,
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = dragging.current
    if (!state) return
    const current = orientation === 'vertical' ? event.clientX : event.clientY
    const delta = current - state.origin
    onResize(clamp(state.start + (inverted ? -delta : delta)))
  }

  const stop = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  // The body cursor has to follow the gesture, or it flickers over children.
  useEffect(() => {
    const cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize'
    const onUp = () => {
      document.body.style.cursor = ''
    }
    if (dragging.current) document.body.style.cursor = cursor
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
    }
  }, [orientation])

  return (
    <div
      className={`splitter ${orientation}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={props.label}
      aria-valuenow={size}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={() => onResize(clamp((min + max) / 2))}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 10
        const grow = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
        const shrink = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
        if (event.key !== grow && event.key !== shrink) return
        event.preventDefault()
        const direction = event.key === grow ? 1 : -1
        onResize(clamp(size + direction * step * (inverted ? -1 : 1)))
      }}
    />
  )
}
