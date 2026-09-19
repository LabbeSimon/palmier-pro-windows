/**
 * Transition rendering.
 *
 * A transition is drawn by pulling the incoming clip backwards over its
 * predecessor using its own head handle: the clip starts `durationFrames`
 * earlier, seeks `durationFrames` earlier into the source, and reveals itself
 * over that overlap. The outgoing clip is never modified, so undoing a
 * transition cannot leave the timeline shifted.
 *
 * Every kind here resolves to alpha or geometry on the incoming clip, which is
 * what the compositor already knows how to overlay.
 */

import type { TransitionKind } from './model.js'

export interface TransitionRender {
  /** Filters appended to the incoming clip's chain, in order. */
  filters: string[]
  /** Overrides the overlay x expression when the kind slides rather than fades. */
  overlayX?: (restX: number, width: number) => string
  overlayY?: (restY: number, height: number) => string
  /** True when the outgoing clip must fade out underneath instead of cutting. */
  fadeOutPrevious: boolean
}

const f = (value: number) => value.toFixed(6)

/**
 * @param start  Graph-time seconds at which the overlap begins.
 * @param dur    Overlap length in seconds.
 * @param width  Incoming clip's drawn width in pixels.
 * @param height Incoming clip's drawn height in pixels.
 */
export function transitionRender(
  kind: TransitionKind,
  start: number,
  dur: number,
  width: number,
  height: number,
): TransitionRender {
  // Progress 0→1 across the overlap, clamped so the expression is safe outside it.
  // `t` for filters that take frame time; `T` for geq, whose evaluator only knows
  // the uppercase form — a lowercase t there is an undefined constant.
  const p = `min(1,max(0,(t-${f(start)})/${f(dur)}))`
  const pGeq = `min(1,max(0,(T-${f(start)})/${f(dur)}))`

  switch (kind) {
    case 'dissolve':
      return {
        filters: [`fade=t=in:st=${f(start)}:d=${f(dur)}:alpha=1`],
        fadeOutPrevious: true,
      }

    // The compositor's base is black, so letting both sides fade against it in
    // sequence produces a true dip rather than a cross-dissolve.
    case 'fade-black':
      return {
        filters: [`fade=t=in:st=${f(start + dur / 2)}:d=${f(dur / 2)}:alpha=1`],
        fadeOutPrevious: true,
      }

    case 'fade-white':
      return {
        filters: [
          `fade=t=in:st=${f(start + dur / 2)}:d=${f(dur / 2)}:alpha=1`,
          // A white flash that peaks at the midpoint and decays with the incoming clip.
          `colorlevels=rimin=${`-${f(0.6)}`}:gimin=-0.6:bimin=-0.6:enable='between(t,${f(start)},${f(start + dur)})'`,
        ],
        fadeOutPrevious: true,
      }

    case 'wipe-left':
      // Reveal grows from the left edge: keep the leftmost p fraction.
      return {
        filters: [wipeAlpha(`X/${width} - ${pGeq}`, start, dur)],
        fadeOutPrevious: false,
      }
    case 'wipe-right':
      return {
        filters: [wipeAlpha(`(${width}-X)/${width} - ${pGeq}`, start, dur)],
        fadeOutPrevious: false,
      }
    case 'wipe-up':
      return {
        filters: [wipeAlpha(`Y/${height} - ${pGeq}`, start, dur)],
        fadeOutPrevious: false,
      }
    case 'wipe-down':
      return {
        filters: [wipeAlpha(`(${height}-Y)/${height} - ${pGeq}`, start, dur)],
        fadeOutPrevious: false,
      }

    case 'slide-left':
      return {
        filters: [],
        overlayX: (restX, w) => `${restX}+(1-${p})*${w}`,
        fadeOutPrevious: false,
      }
    case 'slide-right':
      return {
        filters: [],
        overlayX: (restX, w) => `${restX}-(1-${p})*${w}`,
        fadeOutPrevious: false,
      }

    case 'circle-open':
      return {
        filters: [circleAlpha(pGeq, width, height, false, start, dur)],
        fadeOutPrevious: false,
      }
    case 'circle-close':
      return {
        filters: [circleAlpha(pGeq, width, height, true, start, dur)],
        fadeOutPrevious: false,
      }
  }
}

/**
 * Hard-edged reveal on the alpha plane. `test` is negative where the incoming
 * clip should already be visible.
 *
 * geq evaluates per pixel per frame and is roughly five times slower than the
 * fade-based kinds; that cost is why wipes are not the default transition.
 */
function wipeAlpha(test: string, start: number, dur: number): string {
  // Outside the overlap the clip is fully opaque; geq only drives the window.
  return (
    `geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':` +
    `a='if(lt(T,${f(start)}),0,if(gt(T,${f(start + dur)}),alpha(X,Y),` +
    `if(lt(${test},0),alpha(X,Y),0)))'`
  )
}

/** Circular reveal centred on the frame. */
function circleAlpha(
  p: string,
  width: number,
  height: number,
  closing: boolean,
  start: number,
  dur: number,
): string {
  const cx = width / 2
  const cy = height / 2
  const maxR = Math.sqrt(cx * cx + cy * cy)
  const radius = closing ? `(1-${p})*${f(maxR)}` : `${p}*${f(maxR)}`
  const inside = `lt(hypot(X-${f(cx)},Y-${f(cy)}),${radius})`
  const test = closing ? `if(${inside},0,alpha(X,Y))` : `if(${inside},alpha(X,Y),0)`
  return (
    `geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':` +
    `a='if(lt(T,${f(start)}),0,if(gt(T,${f(start + dur)}),alpha(X,Y),${test}))'`
  )
}

export const TRANSITION_LABELS: Record<TransitionKind, string> = {
  dissolve: 'Dissolve',
  'fade-black': 'Fade through black',
  'fade-white': 'Fade through white',
  'wipe-left': 'Wipe left',
  'wipe-right': 'Wipe right',
  'wipe-up': 'Wipe up',
  'wipe-down': 'Wipe down',
  'slide-left': 'Slide left',
  'slide-right': 'Slide right',
  'circle-open': 'Circle open',
  'circle-close': 'Circle close',
}
