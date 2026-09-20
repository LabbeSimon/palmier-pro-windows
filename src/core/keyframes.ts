/**
 * Keyframe animation.
 *
 * A keyframe track is a sorted list of (frame, value) pairs with an easing on
 * each segment. Frames are relative to the clip's own start, so moving a clip
 * carries its animation with it — the alternative, absolute frames, silently
 * desynchronises the moment anyone drags a clip.
 *
 * Not every parameter can be animated: FFmpeg only evaluates expressions per
 * frame in filters that accept `eval=frame`. `animatableTargets` is the honest
 * list, and the domain refuses anything outside it rather than accepting a
 * keyframe that would render as a constant.
 */

export type Easing = 'linear' | 'smooth' | 'hold'

export const EASINGS: Easing[] = ['linear', 'smooth', 'hold']

export interface Keyframe {
  /** Frames from the clip's own start. */
  frame: number
  value: number
  /** How the value travels from this keyframe to the next. */
  easing: Easing
}

/** Keyframe tracks on a clip, keyed by target path. */
export type KeyframeMap = Record<string, Keyframe[]>

/**
 * Targets that actually animate at render time.
 *
 * `transform.*` and `opacity` drive overlay and scale expressions, which accept
 * `eval=frame`. Effect parameters are addressed as `effect:<effectId>:<param>`
 * and are only allowed when the definition marks the parameter animatable.
 */
export const STATIC_TARGETS = [
  'opacity',
  'volume',
  'transform.centerX',
  'transform.centerY',
  'transform.scaleX',
  'transform.scaleY',
  'transform.rotation',
] as const

export type StaticTarget = (typeof STATIC_TARGETS)[number]

export interface TargetSpec {
  label: string
  min: number
  max: number
  step: number
  unit?: string
}

/**
 * Bounds and labels for the built-in targets, in one place: the domain, the MCP
 * tools and the keyframe editor all read this rather than each carrying its own
 * copy of the numbers.
 */
export const STATIC_TARGET_SPECS: Record<StaticTarget, TargetSpec> = {
  opacity: { label: 'Opacity', min: 0, max: 1, step: 0.01 },
  volume: { label: 'Volume', min: 0, max: 4, step: 0.01 },
  'transform.centerX': { label: 'Position X', min: -2, max: 3, step: 0.005 },
  'transform.centerY': { label: 'Position Y', min: -2, max: 3, step: 0.005 },
  'transform.scaleX': { label: 'Scale X', min: 0.01, max: 10, step: 0.01 },
  'transform.scaleY': { label: 'Scale Y', min: 0.01, max: 10, step: 0.01 },
  'transform.rotation': { label: 'Rotation', min: -3600, max: 3600, step: 1, unit: '°' },
}

export function isEffectTarget(target: string): boolean {
  return target.startsWith('effect:')
}

/** Splits `effect:<effectId>:<param>` into its parts, or null when malformed. */
export function parseEffectTarget(target: string): { effectId: string; param: string } | null {
  const parts = target.split(':')
  if (parts.length !== 3 || parts[0] !== 'effect' || !parts[1] || !parts[2]) return null
  return { effectId: parts[1], param: parts[2] }
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

/**
 * Value at `frame`, where `frame` is relative to the clip start.
 *
 * Before the first keyframe the first value holds; after the last, the last
 * value holds. That matches every editor and avoids surprising extrapolation.
 */
export function sampleKeyframes(keyframes: Keyframe[] | undefined, frame: number, fallback: number): number {
  if (!keyframes || keyframes.length === 0) return fallback
  const sorted = keyframes
  if (sorted.length === 1) return sorted[0]!.value
  if (frame <= sorted[0]!.frame) return sorted[0]!.value
  if (frame >= sorted[sorted.length - 1]!.frame) return sorted[sorted.length - 1]!.value

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!
    const b = sorted[i + 1]!
    if (frame < a.frame || frame > b.frame) continue
    if (a.easing === 'hold') return a.value
    const span = b.frame - a.frame
    if (span <= 0) return b.value
    const t = (frame - a.frame) / span
    const eased = a.easing === 'smooth' ? smoothstep(t) : t
    return a.value + (b.value - a.value) * eased
  }
  return fallback
}

/** Keyframes sorted by frame, with duplicates on the same frame collapsed. */
export function normalizeKeyframes(keyframes: Keyframe[]): Keyframe[] {
  const byFrame = new Map<number, Keyframe>()
  for (const keyframe of keyframes) byFrame.set(keyframe.frame, keyframe)
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame)
}

export function isAnimated(keyframes: Keyframe[] | undefined): boolean {
  return Boolean(keyframes && keyframes.length >= 2)
}

/**
 * FFmpeg expression for a keyframe track, in graph time.
 *
 * Built as nested `if` clauses because that is the only conditional the
 * expression evaluator has. `t` is graph seconds; `clipStart` shifts the
 * clip-relative keyframe frames onto it.
 */
export function keyframeExpression(
  keyframes: Keyframe[],
  fps: number,
  clipStartSeconds: number,
  fallback: number,
): string {
  const sorted = normalizeKeyframes(keyframes)
  if (sorted.length === 0) return String(fallback)
  if (sorted.length === 1) return String(sorted[0]!.value)

  const at = (keyframe: Keyframe) => (clipStartSeconds + keyframe.frame / fps).toFixed(6)
  const n = (value: number) => value.toFixed(6)

  // Walk backwards so each segment wraps the rest as its else branch.
  let expression = n(sorted[sorted.length - 1]!.value)
  for (let i = sorted.length - 2; i >= 0; i--) {
    const a = sorted[i]!
    const b = sorted[i + 1]!
    const t0 = at(a)
    const span = Number(at(b)) - Number(t0)

    let segment: string
    if (a.easing === 'hold' || span <= 0) {
      segment = n(a.value)
    } else {
      const progress = `((t-${t0})/${n(span)})`
      const eased =
        a.easing === 'smooth'
          ? `(${progress}*${progress}*(3-2*${progress}))`
          : progress
      segment = `(${n(a.value)}+(${n(b.value - a.value)})*${eased})`
    }
    expression = `if(lt(t,${at(b)}),${segment},${expression})`
  }
  // Before the first keyframe the first value holds.
  return `if(lt(t,${at(sorted[0]!)}),${n(sorted[0]!.value)},${expression})`
}
