/**
 * Effect registry.
 *
 * One definition per effect: its parameters, their bounds, and how it becomes an
 * FFmpeg filter. The UI, the MCP tools and the render graph all read this table,
 * so adding an effect is a single entry rather than a change in four places.
 *
 * Categories follow the vocabulary editors already know from Kdenlive.
 */

export type EffectKind = 'video' | 'audio'

export type EffectCategory =
  | 'Color'
  | 'Blur and sharpen'
  | 'Distort'
  | 'Stylize'
  | 'Audio'

export interface EffectParamSpec {
  key: string
  label: string
  min: number
  max: number
  step: number
  default: number
  /** Suffix shown next to the value: %, px, dB, °, Hz. */
  unit?: string
  /**
   * True only when the underlying FFmpeg filter evaluates this parameter per
   * frame (`eval=frame`). A keyframe on anything else would render as a
   * constant, so the domain refuses it rather than lying.
   */
  animatable?: boolean
}

/**
 * Turns a parameter key into the text FFmpeg should see: either a formatted
 * constant, or a time expression when that parameter is keyframed. Definitions
 * call it instead of formatting values themselves, so animation needs no second
 * code path.
 */
export type ParamResolver = (key: string, value: number, digits?: number) => string

/** A control point of a tone curve, both axes normalised to 0..1. */
export interface CurvePoint {
  x: number
  y: number
}

/** The identity curve: input passes straight through. */
export const IDENTITY_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
]

export interface CurveChannelSpec {
  key: string
  label: string
}

/** Points sorted by input, clamped to the unit square, duplicates collapsed. */
export function normalizeCurve(points: CurvePoint[]): CurvePoint[] {
  const clamp = (value: number) => Math.min(Math.max(value, 0), 1)
  const byX = new Map<number, number>()
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
    byX.set(Number(clamp(point.x).toFixed(4)), clamp(point.y))
  }
  return [...byX.entries()].sort((a, b) => a[0] - b[0]).map(([x, y]) => ({ x, y }))
}

export function isIdentityCurve(points: CurvePoint[] | undefined): boolean {
  if (!points || points.length === 0) return true
  const normalized = normalizeCurve(points)
  return normalized.every((point) => Math.abs(point.x - point.y) < 1e-4)
}

/** FFmpeg's `curves` point syntax: `0/0 0.5/0.6 1/1`. */
export function curveExpression(points: CurvePoint[]): string {
  const normalized = normalizeCurve(points)
  const withEnds = normalized.length >= 2 ? normalized : IDENTITY_CURVE
  return withEnds.map((point) => `${point.x.toFixed(4)}/${point.y.toFixed(4)}`).join(' ')
}

export interface EffectDefinition {
  id: string
  name: string
  category: EffectCategory
  kind: EffectKind
  description: string
  params: EffectParamSpec[]
  /**
   * Returns the FFmpeg filter fragment, or null when the settings are a no-op —
   * a neutral effect must not cost a filter pass.
   *
   * `resolve` is supplied when the clip has keyframes; a definition that ignores
   * it simply renders a constant.
   */
  filter: (
    params: Record<string, number>,
    resolve?: ParamResolver,
    curves?: Record<string, CurvePoint[]>,
  ) => string | null
  /** Channels this effect exposes as draggable curves, if any. */
  curveChannels?: CurveChannelSpec[]
}

/** Default resolver: no animation, just the formatted number. */
const plain: ParamResolver = (_key, value, digits = 4) => value.toFixed(digits)

/** An effect instance on a clip. */
export interface Effect {
  id: string
  definitionId: string
  enabled: boolean
  params: Record<string, number>
  /** Tone curves by channel, for effects that expose them. */
  curves?: Record<string, CurvePoint[]>
}

const near = (value: number, target: number, epsilon = 1e-6) => Math.abs(value - target) < epsilon
const fixed = (value: number, digits = 4) => value.toFixed(digits)

export const EFFECT_DEFINITIONS: EffectDefinition[] = [
  // --- Color --------------------------------------------------------------
  {
    id: 'brightness',
    name: 'Brightness',
    category: 'Color',
    kind: 'video',
    description: 'Lifts or lowers overall luminance.',
    params: [{ key: 'amount', animatable: true, label: 'Brightness', min: -1, max: 1, step: 0.01, default: 0 }],
    filter: (p, resolve = plain) => `eq=brightness='${resolve('amount', p.amount ?? 0)}':eval=frame`,
  },
  {
    id: 'contrast',
    name: 'Contrast',
    category: 'Color',
    kind: 'video',
    description: 'Expands or compresses the tonal range around mid grey.',
    params: [{ key: 'amount', animatable: true, label: 'Contrast', min: 0, max: 3, step: 0.01, default: 1 }],
    filter: (p, resolve = plain) => `eq=contrast='${resolve('amount', p.amount ?? 1)}':eval=frame`,
  },
  {
    id: 'saturation',
    name: 'Saturation',
    category: 'Color',
    kind: 'video',
    description: 'Intensity of colour. Zero is monochrome.',
    params: [{ key: 'amount', animatable: true, label: 'Saturation', min: 0, max: 3, step: 0.01, default: 1 }],
    filter: (p, resolve = plain) => `eq=saturation='${resolve('amount', p.amount ?? 1)}':eval=frame`,
  },
  {
    id: 'gamma',
    name: 'Gamma',
    category: 'Color',
    kind: 'video',
    description: 'Shifts midtones without moving black or white.',
    params: [{ key: 'amount', animatable: true, label: 'Gamma', min: 0.1, max: 3, step: 0.01, default: 1 }],
    filter: (p, resolve = plain) => `eq=gamma='${resolve('amount', p.amount ?? 1)}':eval=frame`,
  },
  {
    id: 'hue',
    name: 'Hue shift',
    category: 'Color',
    kind: 'video',
    description: 'Rotates every colour around the wheel.',
    params: [{ key: 'degrees', animatable: true, label: 'Hue', min: -180, max: 180, step: 1, default: 0, unit: '°' }],
    filter: (p, resolve = plain) => `hue=h='${resolve('degrees', p.degrees ?? 0, 2)}'`,
  },
  {
    id: 'grayscale',
    name: 'Black and white',
    category: 'Color',
    kind: 'video',
    description: 'Removes colour entirely.',
    params: [],
    filter: () => 'hue=s=0',
  },
  {
    id: 'sepia',
    name: 'Sepia',
    category: 'Color',
    kind: 'video',
    description: 'Warm monochrome tone.',
    params: [],
    filter: () => 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
  },
  {
    id: 'invert',
    name: 'Invert',
    category: 'Color',
    kind: 'video',
    description: 'Negative image.',
    params: [],
    filter: () => 'negate',
  },
  {
    id: 'temperature',
    name: 'White balance',
    category: 'Color',
    kind: 'video',
    description: 'Shifts the image warmer or cooler.',
    params: [{ key: 'warmth', label: 'Warmth', min: -1, max: 1, step: 0.01, default: 0 }],
    filter: (p) => {
      const w = p.warmth ?? 0
      if (near(w, 0)) return null
      // Push red against blue; green stays the reference.
      const r = 1 + w * 0.3
      const b = 1 - w * 0.3
      return `colorchannelmixer=${fixed(r)}:0:0:0:0:1:0:0:0:0:${fixed(b)}`
    },
  },

  // --- Blur and sharpen ---------------------------------------------------
  {
    id: 'blur',
    name: 'Gaussian blur',
    category: 'Blur and sharpen',
    kind: 'video',
    description: 'Soft defocus.',
    params: [{ key: 'radius', label: 'Radius', min: 0, max: 50, step: 0.5, default: 4, unit: 'px' }],
    // gblur reads sigma once at init, so this parameter is deliberately not animatable.
  filter: (p) => (near(p.radius ?? 0, 0) ? null : `gblur=sigma=${fixed(p.radius ?? 0, 2)}`),
  },
  {
    id: 'sharpen',
    name: 'Sharpen',
    category: 'Blur and sharpen',
    kind: 'video',
    description: 'Raises local contrast at edges.',
    params: [{ key: 'amount', label: 'Amount', min: 0, max: 3, step: 0.05, default: 1 }],
    filter: (p) => (near(p.amount ?? 0, 0) ? null : `unsharp=5:5:${fixed(p.amount ?? 1, 2)}:5:5:0`),
  },

  // --- Distort ------------------------------------------------------------
  {
    id: 'flip-horizontal',
    name: 'Flip horizontal',
    category: 'Distort',
    kind: 'video',
    description: 'Mirrors left to right.',
    params: [],
    filter: () => 'hflip',
  },
  {
    id: 'flip-vertical',
    name: 'Flip vertical',
    category: 'Distort',
    kind: 'video',
    description: 'Mirrors top to bottom.',
    params: [],
    filter: () => 'vflip',
  },
  {
    id: 'pixelate',
    name: 'Pixelate',
    category: 'Distort',
    kind: 'video',
    description: 'Coarse mosaic, for obscuring a face or plate.',
    params: [{ key: 'size', label: 'Block size', min: 2, max: 64, step: 1, default: 12, unit: 'px' }],
    filter: (p) => {
      const size = Math.max(2, Math.round(p.size ?? 12))
      return `scale=iw/${size}:ih/${size}:flags=neighbor,scale=iw*${size}:ih*${size}:flags=neighbor`
    },
  },

  {
    id: 'color-wheels',
    name: 'Colour wheels',
    category: 'Color',
    kind: 'video',
    description:
      'Three-way colour corrector: shift shadows, midtones and highlights independently. ' +
      'This is the grading control, where brightness and saturation are corrections.',
    params: [
      { key: 'shadowsR', label: 'Shadows R', min: -1, max: 1, step: 0.01, default: 0 },
      { key: 'shadowsG', label: 'Shadows G', min: -1, max: 1, step: 0.01, default: 0 },
      { key: 'shadowsB', label: 'Shadows B', min: -1, max: 1, step: 0.01, default: 0 },
      { key: 'midsR', label: 'Midtones R', min: -1, max: 1, step: 0.01, default: 0 },
      { key: 'midsG', label: 'Midtones G', min: -1, max: 1, step: 0.01, default: 0 },
      { key: 'midsB', label: 'Midtones B', min: -1, max: 1, step: 0.01, default: 0 },
      { key: 'highsR', label: 'Highlights R', min: -1, max: 1, step: 0.01, default: 0 },
      { key: 'highsG', label: 'Highlights G', min: -1, max: 1, step: 0.01, default: 0 },
      { key: 'highsB', label: 'Highlights B', min: -1, max: 1, step: 0.01, default: 0 },
    ],
    filter: (p) => {
      const parts = [
        `rs=${fixed(p.shadowsR ?? 0)}`, `gs=${fixed(p.shadowsG ?? 0)}`, `bs=${fixed(p.shadowsB ?? 0)}`,
        `rm=${fixed(p.midsR ?? 0)}`, `gm=${fixed(p.midsG ?? 0)}`, `bm=${fixed(p.midsB ?? 0)}`,
        `rh=${fixed(p.highsR ?? 0)}`, `gh=${fixed(p.highsG ?? 0)}`, `bh=${fixed(p.highsB ?? 0)}`,
      ]
      return `colorbalance=${parts.join(':')}`
    },
  },
  {
    id: 'curves',
    name: 'Curves',
    category: 'Color',
    kind: 'video',
    description:
      'Tone curves, master plus one per channel. Drag a point to bend the response: the classic ' +
      'S-curve for contrast, a lifted black point for a film look.',
    params: [],
    curveChannels: [
      { key: 'master', label: 'Master' },
      { key: 'r', label: 'Red' },
      { key: 'g', label: 'Green' },
      { key: 'b', label: 'Blue' },
    ],
    filter: (_params, _resolve, curves) => {
      // An identity channel is omitted rather than written out, so a curve on
      // red alone does not drag the other three through the filter.
      const parts: string[] = []
      for (const [option, key] of [['master', 'master'], ['r', 'r'], ['g', 'g'], ['b', 'b']] as const) {
        const points = curves?.[key]
        if (isIdentityCurve(points)) continue
        parts.push(`${option}='${curveExpression(points!)}'`)
      }
      return parts.length > 0 ? `curves=${parts.join(':')}` : null
    },
  },
  // --- Stylize ------------------------------------------------------------
  {
    id: 'vignette',
    name: 'Vignette',
    category: 'Stylize',
    kind: 'video',
    description: 'Darkens the corners to pull the eye inward.',
    params: [{ key: 'angle', animatable: true, label: 'Strength', min: 0.1, max: 1.5, step: 0.05, default: 0.7 }],
    filter: (p, resolve = plain) => `vignette=angle='${resolve('angle', p.angle ?? 0.7, 3)}':eval=frame`,
  },
  {
    id: 'grain',
    name: 'Film grain',
    category: 'Stylize',
    kind: 'video',
    description: 'Adds luminance noise.',
    params: [{ key: 'strength', label: 'Strength', min: 0, max: 60, step: 1, default: 12 }],
    filter: (p) =>
      near(p.strength ?? 0, 0) ? null : `noise=alls=${Math.round(p.strength ?? 12)}:allf=t+u`,
  },
  {
    id: 'edge-detect',
    name: 'Edge detect',
    category: 'Stylize',
    kind: 'video',
    description: 'Keeps only contours.',
    params: [{ key: 'low', label: 'Threshold', min: 0.01, max: 0.5, step: 0.01, default: 0.1 }],
    filter: (p) => `edgedetect=low=${fixed(p.low ?? 0.1, 3)}:high=${fixed(Math.min(1, (p.low ?? 0.1) * 3), 3)}`,
  },

  // --- Audio --------------------------------------------------------------
  {
    id: 'audio-gain',
    name: 'Gain',
    category: 'Audio',
    kind: 'audio',
    description: 'Level change in decibels.',
    params: [{ key: 'db', animatable: true, label: 'Gain', min: -40, max: 20, step: 0.5, default: 0, unit: 'dB' }],
    filter: (p, resolve = plain) => `volume='${resolve('db', p.db ?? 0, 2)}':eval=frame:precision=float`,
  },
  {
    id: 'highpass',
    name: 'High-pass',
    category: 'Audio',
    kind: 'audio',
    description: 'Removes rumble below the cutoff.',
    params: [{ key: 'hz', label: 'Cutoff', min: 20, max: 2000, step: 10, default: 120, unit: 'Hz' }],
    filter: (p) => `highpass=f=${Math.round(p.hz ?? 120)}`,
  },
  {
    id: 'lowpass',
    name: 'Low-pass',
    category: 'Audio',
    kind: 'audio',
    description: 'Removes hiss above the cutoff.',
    params: [{ key: 'hz', label: 'Cutoff', min: 1000, max: 20000, step: 100, default: 12000, unit: 'Hz' }],
    filter: (p) => `lowpass=f=${Math.round(p.hz ?? 12000)}`,
  },
  {
    id: 'normalize',
    name: 'Loudness normalise',
    category: 'Audio',
    kind: 'audio',
    description: 'Targets a broadcast loudness in LUFS.',
    params: [{ key: 'lufs', label: 'Target', min: -30, max: -8, step: 0.5, default: -16, unit: 'LUFS' }],
    filter: (p) => `loudnorm=I=${fixed(p.lufs ?? -16, 1)}:TP=-1.5:LRA=11`,
  },
  {
    id: 'audio-pitch',
    name: 'Pitch',
    category: 'Audio',
    kind: 'audio',
    description: 'Shifts pitch in semitones without changing length.',
    params: [{ key: 'semitones', label: 'Pitch', min: -12, max: 12, step: 1, default: 0, unit: 'st' }],
    filter: (p) => {
      const semitones = p.semitones ?? 0
      if (near(semitones, 0)) return null
      const ratio = Math.pow(2, semitones / 12)
      // Resample to shift pitch, then restore the original duration.
      return `asetrate=48000*${fixed(ratio, 6)},aresample=48000,atempo=${fixed(1 / ratio, 6)}`
    },
  },
]

export const EFFECTS_BY_ID = new Map(EFFECT_DEFINITIONS.map((d) => [d.id, d]))

export const EFFECT_CATEGORIES: EffectCategory[] = [
  'Color',
  'Blur and sharpen',
  'Distort',
  'Stylize',
  'Audio',
]

export function definitionFor(effect: Effect): EffectDefinition | null {
  return EFFECTS_BY_ID.get(effect.definitionId) ?? null
}

/** Parameters filled in from the definition's defaults. */
export function defaultParams(definition: EffectDefinition): Record<string, number> {
  return Object.fromEntries(definition.params.map((p) => [p.key, p.default]))
}

/**
 * Builds the filter chain for a clip's effects of one kind, in stack order.
 * Disabled and neutral effects contribute nothing.
 *
 * `expressionFor` supplies a time expression when a parameter is keyframed; a
 * neutral effect is only dropped when it is *not* animated, since an animated
 * parameter that happens to start at its neutral value still has to render.
 */
export function effectChain(
  effects: Effect[] | undefined,
  kind: EffectKind,
  expressionFor?: (effectId: string, param: string) => string | null,
): string[] {
  if (!effects?.length) return []
  const out: string[] = []
  for (const effect of effects) {
    if (!effect.enabled) continue
    const definition = EFFECTS_BY_ID.get(effect.definitionId)
    if (!definition || definition.kind !== kind) continue

    const animated = definition.params.some(
      (spec) => spec.animatable && expressionFor?.(effect.id, spec.key),
    )
    const curved = (definition.curveChannels ?? []).some(
      (channel) => !isIdentityCurve(effect.curves?.[channel.key]),
    )
    if (!animated && !curved && isNeutral(definition, effect.params)) continue

    const resolve: ParamResolver = (key, value, digits = 4) =>
      expressionFor?.(effect.id, key) ?? value.toFixed(digits)
    const fragment = definition.filter(effect.params, resolve, effect.curves)
    if (fragment) out.push(fragment)
  }
  return out
}

/** True when the settings leave the picture or sound untouched. */
function isNeutral(definition: EffectDefinition, params: Record<string, number>): boolean {
  const NEUTRAL: Record<string, Record<string, number>> = {
    brightness: { amount: 0 },
    contrast: { amount: 1 },
    saturation: { amount: 1 },
    gamma: { amount: 1 },
    hue: { degrees: 0 },
    'audio-gain': { db: 0 },
    'color-wheels': {
      shadowsR: 0, shadowsG: 0, shadowsB: 0,
      midsR: 0, midsG: 0, midsB: 0,
      highsR: 0, highsG: 0, highsB: 0,
    },
  }
  const neutral = NEUTRAL[definition.id]
  if (!neutral) return false
  return Object.entries(neutral).every(([key, value]) => near(params[key] ?? value, value))
}
