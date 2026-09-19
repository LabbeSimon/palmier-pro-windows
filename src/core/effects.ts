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
   */
  filter: (params: Record<string, number>) => string | null
}

/** An effect instance on a clip. */
export interface Effect {
  id: string
  definitionId: string
  enabled: boolean
  params: Record<string, number>
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
    params: [{ key: 'amount', label: 'Brightness', min: -1, max: 1, step: 0.01, default: 0 }],
    filter: (p) => (near(p.amount ?? 0, 0) ? null : `eq=brightness=${fixed(p.amount ?? 0)}`),
  },
  {
    id: 'contrast',
    name: 'Contrast',
    category: 'Color',
    kind: 'video',
    description: 'Expands or compresses the tonal range around mid grey.',
    params: [{ key: 'amount', label: 'Contrast', min: 0, max: 3, step: 0.01, default: 1 }],
    filter: (p) => (near(p.amount ?? 1, 1) ? null : `eq=contrast=${fixed(p.amount ?? 1)}`),
  },
  {
    id: 'saturation',
    name: 'Saturation',
    category: 'Color',
    kind: 'video',
    description: 'Intensity of colour. Zero is monochrome.',
    params: [{ key: 'amount', label: 'Saturation', min: 0, max: 3, step: 0.01, default: 1 }],
    filter: (p) => (near(p.amount ?? 1, 1) ? null : `eq=saturation=${fixed(p.amount ?? 1)}`),
  },
  {
    id: 'gamma',
    name: 'Gamma',
    category: 'Color',
    kind: 'video',
    description: 'Shifts midtones without moving black or white.',
    params: [{ key: 'amount', label: 'Gamma', min: 0.1, max: 3, step: 0.01, default: 1 }],
    filter: (p) => (near(p.amount ?? 1, 1) ? null : `eq=gamma=${fixed(p.amount ?? 1)}`),
  },
  {
    id: 'hue',
    name: 'Hue shift',
    category: 'Color',
    kind: 'video',
    description: 'Rotates every colour around the wheel.',
    params: [{ key: 'degrees', label: 'Hue', min: -180, max: 180, step: 1, default: 0, unit: '°' }],
    filter: (p) => (near(p.degrees ?? 0, 0) ? null : `hue=h=${fixed(p.degrees ?? 0, 2)}`),
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

  // --- Stylize ------------------------------------------------------------
  {
    id: 'vignette',
    name: 'Vignette',
    category: 'Stylize',
    kind: 'video',
    description: 'Darkens the corners to pull the eye inward.',
    params: [{ key: 'angle', label: 'Strength', min: 0.1, max: 1.5, step: 0.05, default: 0.7 }],
    filter: (p) => `vignette=angle=${fixed(p.angle ?? 0.7, 3)}`,
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
    params: [{ key: 'db', label: 'Gain', min: -40, max: 20, step: 0.5, default: 0, unit: 'dB' }],
    filter: (p) => (near(p.db ?? 0, 0) ? null : `volume=${fixed(p.db ?? 0, 2)}dB`),
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
 */
export function effectChain(effects: Effect[] | undefined, kind: EffectKind): string[] {
  if (!effects?.length) return []
  const out: string[] = []
  for (const effect of effects) {
    if (!effect.enabled) continue
    const definition = EFFECTS_BY_ID.get(effect.definitionId)
    if (!definition || definition.kind !== kind) continue
    const fragment = definition.filter(effect.params)
    if (fragment) out.push(fragment)
  }
  return out
}
