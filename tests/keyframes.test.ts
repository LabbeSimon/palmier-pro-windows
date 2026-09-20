import { describe, expect, it } from 'vitest'

import {
  isAnimated,
  keyframeExpression,
  normalizeKeyframes,
  parseEffectTarget,
  sampleKeyframes,
  type Keyframe,
} from '../src/core/keyframes.js'
import type { MediaAsset } from '../src/core/model.js'
import * as ops from '../src/core/ops.js'

const kf = (frame: number, value: number, easing: Keyframe['easing'] = 'linear'): Keyframe => ({
  frame,
  value,
  easing,
})

describe('sampleKeyframes', () => {
  it('holds the first value before the first keyframe and the last after the last', () => {
    const track = [kf(10, 2), kf(20, 8)]
    expect(sampleKeyframes(track, 0, 99)).toBe(2)
    expect(sampleKeyframes(track, 10, 99)).toBe(2)
    expect(sampleKeyframes(track, 20, 99)).toBe(8)
    expect(sampleKeyframes(track, 500, 99)).toBe(8)
  })

  it('interpolates linearly between two keyframes', () => {
    const track = [kf(0, 0), kf(10, 10)]
    expect(sampleKeyframes(track, 5, 0)).toBe(5)
    expect(sampleKeyframes(track, 2, 0)).toBe(2)
  })

  it('eases smoothly, slower at both ends than in the middle', () => {
    const track = [kf(0, 0, 'smooth'), kf(10, 10)]
    const early = sampleKeyframes(track, 1, 0)
    const middle = sampleKeyframes(track, 5, 0)
    const late = sampleKeyframes(track, 9, 0)
    expect(middle).toBeCloseTo(5, 6)
    expect(early).toBeLessThan(1)
    expect(late).toBeGreaterThan(9)
  })

  it('holds the value across a hold segment', () => {
    const track = [kf(0, 3, 'hold'), kf(10, 9)]
    expect(sampleKeyframes(track, 5, 0)).toBe(3)
    expect(sampleKeyframes(track, 9, 0)).toBe(3)
    expect(sampleKeyframes(track, 10, 0)).toBe(9)
  })

  it('falls back when there are no keyframes, and holds with a single one', () => {
    expect(sampleKeyframes(undefined, 5, 42)).toBe(42)
    expect(sampleKeyframes([], 5, 42)).toBe(42)
    expect(sampleKeyframes([kf(7, 1)], 0, 42)).toBe(1)
    expect(sampleKeyframes([kf(7, 1)], 900, 42)).toBe(1)
  })
})

describe('normalizeKeyframes', () => {
  it('sorts by frame and keeps the last value written on a frame', () => {
    const result = normalizeKeyframes([kf(20, 2), kf(0, 0), kf(20, 9)])
    expect(result.map((k) => [k.frame, k.value])).toEqual([
      [0, 0],
      [20, 9],
    ])
  })
})

describe('keyframeExpression', () => {
  /** Evaluates the FFmpeg expression the way FFmpeg would, to check the maths. */
  function evaluate(expression: string, t: number): number {
    const body = expression.replace(/\bif\(/g, 'IF(').replace(/\blt\(/g, 'LT(')
    const IF = (c: unknown, a: number, b: number) => (c ? a : b)
    const LT = (a: number, b: number) => a < b
    // eslint-disable-next-line no-new-func
    return Function('t', 'IF', 'LT', `return ${body}`)(t, IF, LT) as number
  }

  it('matches sampleKeyframes at every point of the curve', () => {
    const track = [kf(0, 0), kf(30, 1, 'smooth'), kf(60, 0.25, 'hold'), kf(90, 2)]
    const expression = keyframeExpression(track, 30, 0, 0)
    for (const frame of [0, 5, 15, 29, 30, 45, 60, 75, 89, 90, 120]) {
      expect(evaluate(expression, frame / 30)).toBeCloseTo(sampleKeyframes(track, frame, 0), 5)
    }
  })

  it('shifts with the clip position in the graph', () => {
    const track = [kf(0, 0), kf(30, 1)]
    const expression = keyframeExpression(track, 30, 2, 0)
    // The clip starts at 2 s, so frame 15 of the clip is t = 2.5 s.
    expect(evaluate(expression, 2.5)).toBeCloseTo(0.5, 5)
    expect(evaluate(expression, 1.0)).toBeCloseTo(0, 5)
  })

  it('collapses to a constant with fewer than two keyframes', () => {
    expect(keyframeExpression([], 30, 0, 7)).toBe('7')
    expect(keyframeExpression([kf(4, 3)], 30, 0, 7)).toBe('3')
  })
})

describe('parseEffectTarget', () => {
  it('splits a well-formed target and rejects the rest', () => {
    expect(parseEffectTarget('effect:abc:amount')).toEqual({ effectId: 'abc', param: 'amount' })
    expect(parseEffectTarget('effect:abc')).toBeNull()
    expect(parseEffectTarget('opacity')).toBeNull()
    expect(parseEffectTarget('effect::amount')).toBeNull()
  })
})

describe('isAnimated', () => {
  it('needs two keyframes to be motion rather than a constant', () => {
    expect(isAnimated(undefined)).toBe(false)
    expect(isAnimated([kf(0, 1)])).toBe(false)
    expect(isAnimated([kf(0, 1), kf(10, 2)])).toBe(true)
  })
})

// --- Operations -----------------------------------------------------------

function fixture() {
  const media: MediaAsset = {
    id: crypto.randomUUID(), path: 'C:/m/a.mp4', name: 'a.mp4', type: 'video',
    durationSeconds: 20, width: 1920, height: 1080, fps: 30,
    hasAudio: true, sampleRate: 48000, channels: 2, thumbnailPath: null,
  }
  let state = ops.addAssets(ops.emptyProject('T'), [media]).project
  state = ops.addClips(state, { clips: [{ assetId: media.id, durationFrames: 90 }] }).project
  return { project: state, clipId: state.timelines[0]!.tracks[0]!.clips[0]!.id }
}

describe('setKeyframe', () => {
  it('stores a curve on a transform target', () => {
    const { project, clipId } = fixture()
    let state = ops.setKeyframe(project, { clipId, target: 'transform.scaleX', frame: 0, value: 1 }).project
    state = ops.setKeyframe(state, { clipId, target: 'transform.scaleX', frame: 60, value: 1.5 }).project
    const track = state.timelines[0]!.tracks[0]!.clips[0]!.keyframes['transform.scaleX']!
    expect(track.map((k) => [k.frame, k.value])).toEqual([
      [0, 1],
      [60, 1.5],
    ])
  })

  it('warns that one keyframe alone is a constant', () => {
    const { project, clipId } = fixture()
    const { receipt } = ops.setKeyframe(project, { clipId, target: 'opacity', frame: 0, value: 0.5 })
    expect(receipt.warnings.join(' ')).toMatch(/single keyframe/i)
  })

  it('refuses a frame past the end of the clip', () => {
    const { project, clipId } = fixture()
    expect(() => ops.setKeyframe(project, { clipId, target: 'opacity', frame: 500, value: 1 })).toThrow(
      /past the end of the clip/,
    )
  })

  it('refuses a value outside the target bounds', () => {
    const { project, clipId } = fixture()
    expect(() => ops.setKeyframe(project, { clipId, target: 'opacity', frame: 0, value: 4 })).toThrow(
      /between 0 and 1/,
    )
  })

  it('refuses an unknown target and names the valid ones', () => {
    const { project, clipId } = fixture()
    expect(() => ops.setKeyframe(project, { clipId, target: 'sharpness', frame: 0, value: 1 })).toThrow(
      /not an animatable target/,
    )
  })

  it('refuses a parameter FFmpeg reads only once, rather than rendering it as a constant', () => {
    const { project, clipId } = fixture()
    const withBlur = ops.addEffect(project, { clipIds: [clipId], definitionId: 'blur' }).project
    const effectId = withBlur.timelines[0]!.tracks[0]!.clips[0]!.effects[0]!.id
    expect(() =>
      ops.setKeyframe(withBlur, { clipId, target: `effect:${effectId}:radius`, frame: 0, value: 10 }),
    ).toThrow(/cannot be animated/)
  })

  it('accepts a parameter that FFmpeg does re-evaluate', () => {
    const { project, clipId } = fixture()
    const graded = ops.addEffect(project, { clipIds: [clipId], definitionId: 'brightness' }).project
    const effectId = graded.timelines[0]!.tracks[0]!.clips[0]!.effects[0]!.id
    const result = ops.setKeyframe(graded, {
      clipId,
      target: `effect:${effectId}:amount`,
      frame: 0,
      value: 0.4,
    })
    expect(result.receipt.changed).toBe(true)
  })

  it('replaces a keyframe already on that frame', () => {
    const { project, clipId } = fixture()
    let state = ops.setKeyframe(project, { clipId, target: 'opacity', frame: 10, value: 0.2 }).project
    state = ops.setKeyframe(state, { clipId, target: 'opacity', frame: 10, value: 0.8 }).project
    const track = state.timelines[0]!.tracks[0]!.clips[0]!.keyframes.opacity!
    expect(track).toHaveLength(1)
    expect(track[0]!.value).toBe(0.8)
  })
})

describe('removeKeyframe', () => {
  it('removes one frame, then the whole curve', () => {
    const { project, clipId } = fixture()
    let state = ops.setKeyframe(project, { clipId, target: 'opacity', frame: 0, value: 0 }).project
    state = ops.setKeyframe(state, { clipId, target: 'opacity', frame: 30, value: 1 }).project

    const one = ops.removeKeyframe(state, { clipId, target: 'opacity', frame: 30 })
    expect(one.project.timelines[0]!.tracks[0]!.clips[0]!.keyframes.opacity).toHaveLength(1)

    const all = ops.removeKeyframe(one.project, { clipId, target: 'opacity' })
    expect(all.project.timelines[0]!.tracks[0]!.clips[0]!.keyframes.opacity).toBeUndefined()
  })

  it('reports honest no-ops', () => {
    const { project, clipId } = fixture()
    expect(ops.removeKeyframe(project, { clipId, target: 'opacity' }).receipt.changed).toBe(false)
    const state = ops.setKeyframe(project, { clipId, target: 'opacity', frame: 0, value: 0 }).project
    expect(ops.removeKeyframe(state, { clipId, target: 'opacity', frame: 55 }).receipt.changed).toBe(false)
  })
})

describe('animatableTargets', () => {
  it('lists the built-in targets with the clip values as fallbacks', () => {
    const { project, clipId } = fixture()
    const clip = project.timelines[0]!.tracks[0]!.clips[0]!
    const targets = ops.animatableTargets(clip)
    const opacity = targets.find((t) => t.target === 'opacity')!
    expect(opacity.fallback).toBe(clip.opacity)
    expect([opacity.min, opacity.max]).toEqual([0, 1])
    expect(targets.map((t) => t.target)).toContain('transform.rotation')
    expect(clipId).toBeTruthy()
  })

  it('adds only the animatable parameters of the effects on the clip', () => {
    const { project, clipId } = fixture()
    let state = ops.addEffect(project, { clipIds: [clipId], definitionId: 'brightness' }).project
    state = ops.addEffect(state, { clipIds: [clipId], definitionId: 'blur' }).project
    const clip = state.timelines[0]!.tracks[0]!.clips[0]!
    const effectTargets = ops.animatableTargets(clip).filter((t) => t.target.startsWith('effect:'))
    expect(effectTargets).toHaveLength(1)
    expect(effectTargets[0]!.label).toMatch(/Brightness/i)
  })

  it('carries the curve already on a target', () => {
    const { project, clipId } = fixture()
    const state = ops.setKeyframe(project, { clipId, target: 'opacity', frame: 3, value: 0.4 }).project
    const clip = state.timelines[0]!.tracks[0]!.clips[0]!
    expect(ops.animatableTargets(clip).find((t) => t.target === 'opacity')!.keyframes).toHaveLength(1)
  })

  it('agrees with what setKeyframe accepts', () => {
    const { project, clipId } = fixture()
    const state = ops.addEffect(project, { clipIds: [clipId], definitionId: 'vignette' }).project
    const clip = state.timelines[0]!.tracks[0]!.clips[0]!
    for (const target of ops.animatableTargets(clip)) {
      expect(() =>
        ops.setKeyframe(state, { clipId, target: target.target, frame: 0, value: target.min }),
      ).not.toThrow()
    }
  })
})

describe('moveKeyframe', () => {
  function animated() {
    const { project, clipId } = fixture()
    let state = ops.setKeyframe(project, { clipId, target: 'opacity', frame: 0, value: 0.2 }).project
    state = ops.setKeyframe(state, { clipId, target: 'opacity', frame: 40, value: 1, easing: 'smooth' }).project
    return { project: state, clipId }
  }
  const curve = (p: ReturnType<typeof animated>['project']) =>
    p.timelines[0]!.tracks[0]!.clips[0]!.keyframes.opacity!

  it('keeps the value and the easing', () => {
    const { project, clipId } = animated()
    const moved = ops.moveKeyframe(project, { clipId, target: 'opacity', fromFrame: 40, toFrame: 70 })
    expect(curve(moved.project).map((k) => [k.frame, k.value, k.easing])).toEqual([
      [0, 0.2, 'linear'],
      [70, 1, 'smooth'],
    ])
  })

  it('is one undoable step, so the curve survives a single undo', () => {
    const { project, clipId } = animated()
    const moved = ops.moveKeyframe(project, { clipId, target: 'opacity', fromFrame: 40, toFrame: 70 })
    expect(moved.receipt.operation).toBe('move_keyframe')
    expect(moved.receipt.changed).toBe(true)
  })

  it('replaces whatever was on the landing frame, and says so', () => {
    const { project, clipId } = animated()
    const crowded = ops.setKeyframe(project, { clipId, target: 'opacity', frame: 20, value: 0.5 }).project
    const moved = ops.moveKeyframe(crowded, { clipId, target: 'opacity', fromFrame: 40, toFrame: 20 })
    expect(curve(moved.project).map((k) => k.frame)).toEqual([0, 20])
    expect(curve(moved.project)[1]!.value).toBe(1)
    expect(moved.receipt.warnings.join(' ')).toMatch(/already at frame 20/)
  })

  it('names the frames it does have when the source is empty', () => {
    const { project, clipId } = animated()
    expect(() =>
      ops.moveKeyframe(project, { clipId, target: 'opacity', fromFrame: 17, toFrame: 5 }),
    ).toThrow(/has no keyframe at clip frame 17 \(it has 0, 40\)/)
  })

  it('refuses to park a keyframe past the end of the clip', () => {
    const { project, clipId } = animated()
    expect(() =>
      ops.moveKeyframe(project, { clipId, target: 'opacity', fromFrame: 40, toFrame: 900 }),
    ).toThrow(/past the end of the clip/)
  })

  it('reports a move to the same frame as a no-op', () => {
    const { project, clipId } = animated()
    expect(
      ops.moveKeyframe(project, { clipId, target: 'opacity', fromFrame: 40, toFrame: 40 }).receipt.changed,
    ).toBe(false)
  })
})
