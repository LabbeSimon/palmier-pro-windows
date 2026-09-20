import { describe, expect, it } from 'vitest'

import {
  curveExpression,
  effectChain,
  EFFECTS_BY_ID,
  isIdentityCurve,
  normalizeCurve,
  type Effect,
} from '../src/core/effects.js'
import type { MediaAsset } from '../src/core/model.js'
import * as ops from '../src/core/ops.js'

describe('normalizeCurve', () => {
  it('sorts, clamps and collapses duplicate inputs', () => {
    expect(
      normalizeCurve([
        { x: 1, y: 1 },
        { x: -0.5, y: 2 },
        { x: 0.5, y: 0.2 },
        { x: 0.5, y: 0.8 },
      ]),
    ).toEqual([
      { x: 0, y: 1 },
      { x: 0.5, y: 0.8 },
      { x: 1, y: 1 },
    ])
  })
})

describe('isIdentityCurve', () => {
  it('treats absent, empty and diagonal curves alike', () => {
    expect(isIdentityCurve(undefined)).toBe(true)
    expect(isIdentityCurve([])).toBe(true)
    expect(isIdentityCurve([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }])).toBe(true)
    expect(isIdentityCurve([{ x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }])).toBe(false)
  })
})

describe('curveExpression', () => {
  it('writes FFmpeg point syntax', () => {
    expect(curveExpression([{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }])).toBe(
      '0.0000/0.0000 0.5000/0.6000 1.0000/1.0000',
    )
  })

  it('falls back to the identity when given too few points to be a curve', () => {
    expect(curveExpression([{ x: 0.3, y: 0.9 }])).toBe('0.0000/0.0000 1.0000/1.0000')
  })
})

const effect = (definitionId: string, params: Record<string, number> = {}, curves?: Effect['curves']): Effect => ({
  id: 'fx1',
  definitionId,
  enabled: true,
  params: { ...defaultsFor(definitionId), ...params },
  ...(curves ? { curves } : {}),
})

function defaultsFor(definitionId: string): Record<string, number> {
  const definition = EFFECTS_BY_ID.get(definitionId)!
  return Object.fromEntries(definition.params.map((p) => [p.key, p.default]))
}

describe('curves effect', () => {
  it('costs no filter pass when every channel is a straight line', () => {
    expect(effectChain([effect('curves')], 'video')).toEqual([])
    expect(
      effectChain([effect('curves', {}, { master: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })], 'video'),
    ).toEqual([])
  })

  it('writes only the channels that were actually bent', () => {
    const chain = effectChain(
      [effect('curves', {}, { r: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }] })],
      'video',
    )
    expect(chain).toEqual(["curves=r='0.0000/0.1000 1.0000/1.0000'"])
  })

  it('writes master and a channel together', () => {
    const chain = effectChain(
      [
        effect('curves', {}, {
          master: [{ x: 0, y: 0 }, { x: 0.5, y: 0.62 }, { x: 1, y: 1 }],
          b: [{ x: 0, y: 0.05 }, { x: 1, y: 0.95 }],
        }),
      ],
      'video',
    )
    expect(chain[0]).toContain("master='0.0000/0.0000 0.5000/0.6200 1.0000/1.0000'")
    expect(chain[0]).toContain("b='0.0000/0.0500 1.0000/0.9500'")
  })
})

describe('colour wheels effect', () => {
  it('costs no filter pass when every band is neutral', () => {
    expect(effectChain([effect('color-wheels')], 'video')).toEqual([])
  })

  it('maps each band onto the matching colorbalance options', () => {
    const chain = effectChain([effect('color-wheels', { shadowsB: 0.3, highsR: -0.2 })], 'video')
    expect(chain[0]).toMatch(/^colorbalance=/)
    expect(chain[0]).toContain('bs=0.3000')
    expect(chain[0]).toContain('rh=-0.2000')
    expect(chain[0]).toContain('gm=0.0000')
  })
})

// --- Operations -----------------------------------------------------------

function fixture(definitionId: string) {
  const media: MediaAsset = {
    id: crypto.randomUUID(), path: 'C:/m/a.mp4', name: 'a.mp4', type: 'video',
    durationSeconds: 20, width: 1920, height: 1080, fps: 30,
    hasAudio: true, sampleRate: 48000, channels: 2, thumbnailPath: null,
  }
  let state = ops.addAssets(ops.emptyProject('G'), [media]).project
  state = ops.addClips(state, { clips: [{ assetId: media.id, durationFrames: 60 }] }).project
  const clipId = state.timelines[0]!.tracks[0]!.clips[0]!.id
  state = ops.addEffect(state, { clipIds: [clipId], definitionId }).project
  const effectId = state.timelines[0]!.tracks[0]!.clips[0]!.effects[0]!.id
  return { project: state, clipId, effectId }
}

const curveOf = (project: ReturnType<typeof fixture>['project'], channel: string) =>
  project.timelines[0]!.tracks[0]!.clips[0]!.effects[0]!.curves?.[channel]

describe('setEffectCurve', () => {
  it('stores a bent channel, normalised', () => {
    const { project, clipId, effectId } = fixture('curves')
    const { project: next, receipt } = ops.setEffectCurve(project, {
      clipId,
      effectId,
      channel: 'master',
      points: [{ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 0.5, y: 0.7 }],
    })
    expect(receipt.changed).toBe(true)
    expect(curveOf(next, 'master')).toEqual([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.7 },
      { x: 1, y: 1 },
    ])
  })

  it('drops a channel reset to the identity rather than storing a no-op', () => {
    const { project, clipId, effectId } = fixture('curves')
    let state = ops.setEffectCurve(project, {
      clipId, effectId, channel: 'g',
      points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }],
    }).project
    expect(curveOf(state, 'g')).toBeDefined()

    state = ops.setEffectCurve(state, {
      clipId, effectId, channel: 'g',
      points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    }).project
    expect(curveOf(state, 'g')).toBeUndefined()
  })

  it('refuses a channel the effect does not have, and names the ones it does', () => {
    const { project, clipId, effectId } = fixture('curves')
    expect(() =>
      ops.setEffectCurve(project, { clipId, effectId, channel: 'alpha', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }),
    ).toThrow(/no curve channel "alpha" \(has master, r, g, b\)/)
  })

  it('refuses an effect that has no curves at all', () => {
    const { project, clipId, effectId } = fixture('brightness')
    expect(() =>
      ops.setEffectCurve(project, { clipId, effectId, channel: 'master', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }),
    ).toThrow(/has no curves/)
  })

  it('refuses a curve that cannot define a response', () => {
    const { project, clipId, effectId } = fixture('curves')
    expect(() =>
      ops.setEffectCurve(project, { clipId, effectId, channel: 'master', points: [{ x: 0.5, y: 0.5 }] }),
    ).toThrow(/at least two points/)
  })

  it('will not grade a clip on a locked track', () => {
    const { project, clipId, effectId } = fixture('curves')
    const trackId = project.timelines[0]!.tracks[0]!.id
    const locked = ops.setTrackFlags(project, { trackId, locked: true }).project
    expect(() =>
      ops.setEffectCurve(locked, { clipId, effectId, channel: 'master', points: [{ x: 0, y: 0.2 }, { x: 1, y: 1 }] }),
    ).toThrow(/locked/i)
  })

  it('reports an unchanged request honestly', () => {
    const { project, clipId, effectId } = fixture('curves')
    const points = [{ x: 0, y: 0.1 }, { x: 1, y: 1 }]
    const state = ops.setEffectCurve(project, { clipId, effectId, channel: 'r', points }).project
    expect(ops.setEffectCurve(state, { clipId, effectId, channel: 'r', points }).receipt.changed).toBe(false)
  })
})
