import { describe, expect, it } from 'vitest'

import {
  defaultParams,
  effectChain,
  EFFECT_DEFINITIONS,
  EFFECTS_BY_ID,
  type Effect,
} from '../src/core/effects.js'
import type { MediaAsset } from '../src/core/model.js'
import * as ops from '../src/core/ops.js'
import { OpError } from '../src/core/ops.js'

function fixture() {
  const media: MediaAsset = {
    id: crypto.randomUUID(), path: 'C:/m/a.mp4', name: 'a.mp4', type: 'video',
    durationSeconds: 10, width: 1920, height: 1080, fps: 30,
    hasAudio: true, sampleRate: 48000, channels: 2, thumbnailPath: null,
  }
  const base = ops.addAssets(ops.emptyProject('T'), [media]).project
  const project = ops.addClips(base, { clips: [{ assetId: media.id, durationFrames: 120 }] }).project
  return { project, clipId: project.timelines[0]!.tracks[0]!.clips[0]!.id, assetId: media.id }
}

describe('effect registry', () => {
  it('gives every definition a unique id and a usable description', () => {
    const ids = EFFECT_DEFINITIONS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const definition of EFFECT_DEFINITIONS) {
      expect(definition.description.length).toBeGreaterThan(10)
      expect(definition.name.length).toBeGreaterThan(2)
    }
  })

  it('keeps every parameter default inside its own bounds', () => {
    for (const definition of EFFECT_DEFINITIONS) {
      for (const param of definition.params) {
        expect(param.min).toBeLessThan(param.max)
        expect(param.default).toBeGreaterThanOrEqual(param.min)
        expect(param.default).toBeLessThanOrEqual(param.max)
        expect(param.step).toBeGreaterThan(0)
      }
    }
  })

  it('produces a filter for every definition at its defaults or an explicit no-op', () => {
    for (const definition of EFFECT_DEFINITIONS) {
      const result = definition.filter(defaultParams(definition))
      expect(result === null || result.length > 0).toBe(true)
    }
  })

  it('treats a neutral setting as a no-op so it costs no filter pass', () => {
    expect(EFFECTS_BY_ID.get('brightness')!.filter({ amount: 0 })).toBeNull()
    expect(EFFECTS_BY_ID.get('contrast')!.filter({ amount: 1 })).toBeNull()
    expect(EFFECTS_BY_ID.get('saturation')!.filter({ amount: 1 })).toBeNull()
    expect(EFFECTS_BY_ID.get('audio-gain')!.filter({ db: 0 })).toBeNull()
    expect(EFFECTS_BY_ID.get('brightness')!.filter({ amount: 0.5 })).toContain('eq=brightness')
  })
})

describe('effectChain', () => {
  const make = (definitionId: string, params: Record<string, number>, enabled = true): Effect => ({
    id: crypto.randomUUID(), definitionId, enabled, params,
  })

  it('keeps stack order', () => {
    const chain = effectChain(
      [make('brightness', { amount: 0.2 }), make('blur', { radius: 3 })],
      'video',
    )
    expect(chain[0]).toContain('brightness')
    expect(chain[1]).toContain('gblur')
  })

  it('skips disabled effects and the other kind', () => {
    const chain = effectChain(
      [
        make('brightness', { amount: 0.2 }, false),
        make('audio-gain', { db: 6 }),
        make('saturation', { amount: 2 }),
      ],
      'video',
    )
    expect(chain).toEqual(['eq=saturation=2.0000'])
  })

  it('returns nothing for an unknown definition rather than throwing mid-render', () => {
    expect(effectChain([make('does-not-exist', {})], 'video')).toEqual([])
  })
})

describe('addEffect', () => {
  it('fills parameters from the definition defaults', () => {
    const { project, clipId } = fixture()
    const { project: next } = ops.addEffect(project, { clipIds: [clipId], definitionId: 'blur' })
    const effect = next.timelines[0]!.tracks[0]!.clips[0]!.effects[0]!
    expect(effect.definitionId).toBe('blur')
    expect(effect.enabled).toBe(true)
    expect(effect.params.radius).toBe(4)
  })

  it('rejects an unknown parameter instead of silently dropping it', () => {
    const { project, clipId } = fixture()
    expect(() =>
      ops.addEffect(project, { clipIds: [clipId], definitionId: 'blur', params: { sigma: 3 } }),
    ).toThrow(/has no parameter "sigma"/)
  })

  it('rejects a parameter outside its bounds', () => {
    const { project, clipId } = fixture()
    expect(() =>
      ops.addEffect(project, { clipIds: [clipId], definitionId: 'blur', params: { radius: 500 } }),
    ).toThrow(/between 0 and 50/)
  })

  it('refuses an unknown effect', () => {
    const { project, clipId } = fixture()
    expect(() => ops.addEffect(project, { clipIds: [clipId], definitionId: 'nope' })).toThrow(OpError)
  })

  it('warns rather than failing when an audio effect lands on a silent clip', () => {
    const media: MediaAsset = {
      id: crypto.randomUUID(), path: 'C:/m/still.png', name: 'still.png', type: 'image',
      durationSeconds: 0, width: 800, height: 600, fps: 0,
      hasAudio: false, sampleRate: 0, channels: 0, thumbnailPath: null,
    }
    const base = ops.addAssets(ops.emptyProject('T'), [media]).project
    const placed = ops.addClips(base, { clips: [{ assetId: media.id, durationFrames: 60 }] }).project
    const clipId = placed.timelines[0]!.tracks[0]!.clips[0]!.id

    const { receipt } = ops.addEffect(placed, { clipIds: [clipId], definitionId: 'highpass' })
    expect(receipt.changed).toBe(true)
    expect(receipt.warnings.join(' ')).toMatch(/no audio/)
  })
})

describe('setEffectParams', () => {
  it('reports no change when the value already matches', () => {
    const { project, clipId } = fixture()
    const added = ops.addEffect(project, { clipIds: [clipId], definitionId: 'blur' }).project
    const effectId = added.timelines[0]!.tracks[0]!.clips[0]!.effects[0]!.id

    const { receipt } = ops.setEffectParams(added, { clipId, effectId, params: { radius: 4 } })
    expect(receipt.changed).toBe(false)
  })

  it('toggles enabled without touching parameters', () => {
    const { project, clipId } = fixture()
    const added = ops.addEffect(project, { clipIds: [clipId], definitionId: 'blur' }).project
    const effectId = added.timelines[0]!.tracks[0]!.clips[0]!.effects[0]!.id

    const { project: next } = ops.setEffectParams(added, { clipId, effectId, enabled: false })
    const effect = next.timelines[0]!.tracks[0]!.clips[0]!.effects[0]!
    expect(effect.enabled).toBe(false)
    expect(effect.params.radius).toBe(4)
  })
})

describe('reorderEffect', () => {
  it('moves an effect and reports a no-op when it is already there', () => {
    const { project, clipId } = fixture()
    let state = ops.addEffect(project, { clipIds: [clipId], definitionId: 'brightness' }).project
    state = ops.addEffect(state, { clipIds: [clipId], definitionId: 'blur' }).project
    const stack = state.timelines[0]!.tracks[0]!.clips[0]!.effects
    const blurId = stack[1]!.id

    const moved = ops.reorderEffect(state, { clipId, effectId: blurId, toIndex: 0 })
    expect(moved.project.timelines[0]!.tracks[0]!.clips[0]!.effects[0]!.id).toBe(blurId)
    expect(ops.reorderEffect(moved.project, { clipId, effectId: blurId, toIndex: 0 }).receipt.changed).toBe(false)
  })
})

describe('track lock', () => {
  it('refuses every mutation path once a track is locked', () => {
    const { project, clipId, assetId } = fixture()
    const trackId = project.timelines[0]!.tracks[0]!.id
    const locked = ops.setTrackFlags(project, { trackId, locked: true }).project

    expect(() => ops.removeClips(locked, { clipIds: [clipId] })).toThrow(/locked/)
    expect(() => ops.splitClips(locked, { frame: 60 })).toThrow(/locked/)
    expect(() => ops.moveClips(locked, { moves: [{ clipId, startFrame: 200 }] })).toThrow(/locked/)
    expect(() => ops.setClipProperties(locked, { clipIds: [clipId], properties: { opacity: 0.5 } })).toThrow(/locked/)
    expect(() => ops.addEffect(locked, { clipIds: [clipId], definitionId: 'blur' })).toThrow(/locked/)
    expect(() => ops.addClips(locked, { clips: [{ assetId, trackId, startFrame: 500, durationFrames: 30 }] })).toThrow(/locked/)
  })

  it('lets edits through again after unlocking', () => {
    const { project, clipId } = fixture()
    const trackId = project.timelines[0]!.tracks[0]!.id
    const locked = ops.setTrackFlags(project, { trackId, locked: true }).project
    const unlocked = ops.setTrackFlags(locked, { trackId, locked: false }).project
    expect(ops.setClipProperties(unlocked, { clipIds: [clipId], properties: { opacity: 0.5 } }).receipt.changed).toBe(true)
  })
})

describe('transitions', () => {
  function twoClips(trimStart = 60) {
    const media: MediaAsset = {
      id: crypto.randomUUID(), path: 'C:/m/a.mp4', name: 'a.mp4', type: 'video',
      durationSeconds: 20, width: 1920, height: 1080, fps: 30,
      hasAudio: true, sampleRate: 48000, channels: 2, thumbnailPath: null,
    }
    let state = ops.addAssets(ops.emptyProject('T'), [media]).project
    state = ops.addClips(state, { clips: [{ assetId: media.id, startFrame: 0, durationFrames: 90 }] }).project
    state = ops.addClips(state, {
      clips: [{ assetId: media.id, startFrame: 90, durationFrames: 90, trimStartFrame: trimStart }],
    }).project
    const clips = state.timelines[0]!.tracks[0]!.clips
    return { project: state, firstId: clips[0]!.id, secondId: clips[1]!.id }
  }

  it('defaults to a one-second dissolve', () => {
    const { project, secondId } = twoClips()
    const { project: next } = ops.addTransition(project, { clipId: secondId })
    const clip = next.timelines[0]!.tracks[0]!.clips[1]!
    expect(clip.transitionIn?.kind).toBe('dissolve')
    expect(clip.transitionIn?.durationFrames).toBe(30)
  })

  it('refuses on the first clip of a track', () => {
    const { project, firstId } = twoClips()
    expect(() => ops.addTransition(project, { clipId: firstId })).toThrow(/nothing to transition from/)
  })

  it('refuses when the incoming clip has no head handle to pull from', () => {
    const { project, secondId } = twoClips(0)
    expect(() => ops.addTransition(project, { clipId: secondId, durationFrames: 30 })).toThrow(
      /head handle/,
    )
  })

  it('refuses a transition longer than the shorter neighbour', () => {
    const { project, secondId } = twoClips()
    expect(() => ops.addTransition(project, { clipId: secondId, durationFrames: 200 })).toThrow(
      /frames on both sides/,
    )
  })

  it('refuses an unknown kind', () => {
    const { project, secondId } = twoClips()
    expect(() => ops.addTransition(project, { clipId: secondId, kind: 'warp' as never })).toThrow(
      /kind must be one of/,
    )
  })

  it('removes cleanly and reports a no-op when there is none', () => {
    const { project, secondId } = twoClips()
    const added = ops.addTransition(project, { clipId: secondId }).project
    const removed = ops.removeTransition(added, { clipId: secondId })
    expect(removed.receipt.changed).toBe(true)
    expect(removed.project.timelines[0]!.tracks[0]!.clips[1]!.transitionIn).toBeNull()
    expect(ops.removeTransition(removed.project, { clipId: secondId }).receipt.changed).toBe(false)
  })

  it('leaves clip positions untouched, so removing it cannot shift the timeline', () => {
    const { project, secondId } = twoClips()
    const before = project.timelines[0]!.tracks[0]!.clips.map((c) => c.startFrame)
    const added = ops.addTransition(project, { clipId: secondId, durationFrames: 20 }).project
    expect(added.timelines[0]!.tracks[0]!.clips.map((c) => c.startFrame)).toEqual(before)
  })
})

describe('shiftClips (spacer)', () => {
  function threeClips() {
    const media: MediaAsset = {
      id: crypto.randomUUID(), path: 'C:/m/a.mp4', name: 'a.mp4', type: 'video',
      durationSeconds: 30, width: 1920, height: 1080, fps: 30,
      hasAudio: false, sampleRate: 0, channels: 0, thumbnailPath: null,
    }
    let state = ops.addAssets(ops.emptyProject('T'), [media]).project
    for (const start of [0, 60, 120]) {
      state = ops.addClips(state, {
        clips: [{ assetId: media.id, startFrame: start, durationFrames: 60 }],
      }).project
    }
    return { project: state, trackId: state.timelines[0]!.tracks[0]!.id }
  }

  it('opens a gap from a point forward', () => {
    const { project, trackId } = threeClips()
    const { project: next } = ops.shiftClips(project, { trackId, fromFrame: 60, deltaFrames: 30 })
    expect(next.timelines[0]!.tracks[0]!.clips.map((c) => c.startFrame)).toEqual([0, 90, 150])
  })

  it('closes a gap with a negative delta', () => {
    const { project, trackId } = threeClips()
    const opened = ops.shiftClips(project, { trackId, fromFrame: 120, deltaFrames: 40 }).project
    const closed = ops.shiftClips(opened, { trackId, fromFrame: 160, deltaFrames: -40 }).project
    expect(closed.timelines[0]!.tracks[0]!.clips.map((c) => c.startFrame)).toEqual([0, 60, 120])
  })

  it('refuses a shift that would overlap the clips left behind', () => {
    const { project, trackId } = threeClips()
    expect(() => ops.shiftClips(project, { trackId, fromFrame: 120, deltaFrames: -30 })).toThrow(
      /would overlap/,
    )
  })

  it('refuses a shift past frame zero', () => {
    const { project, trackId } = threeClips()
    expect(() => ops.shiftClips(project, { trackId, fromFrame: 0, deltaFrames: -10 })).toThrow(
      /before frame zero/,
    )
  })

  it('reports an honest no-op', () => {
    const { project, trackId } = threeClips()
    expect(ops.shiftClips(project, { trackId, fromFrame: 0, deltaFrames: 0 }).receipt.changed).toBe(false)
    expect(ops.shiftClips(project, { trackId, fromFrame: 9000, deltaFrames: 30 }).receipt.changed).toBe(false)
  })

  it('refuses on a locked track', () => {
    const { project, trackId } = threeClips()
    const locked = ops.setTrackFlags(project, { trackId, locked: true }).project
    expect(() => ops.shiftClips(locked, { trackId, fromFrame: 0, deltaFrames: 30 })).toThrow(/locked/)
  })
})

describe('work zone', () => {
  it('stores in/out and refuses an inverted range', () => {
    const p = ops.emptyProject('T')
    const set = ops.setWorkZone(p, { inFrame: 20, outFrame: 110 })
    expect(set.project.timelines[0]!.workZone).toEqual({ inFrame: 20, outFrame: 110 })
    expect(() => ops.setWorkZone(p, { inFrame: 100, outFrame: 40 })).toThrow(/must be after/)
  })

  it('clears to null, meaning the whole timeline', () => {
    const set = ops.setWorkZone(ops.emptyProject('T'), { inFrame: 5, outFrame: 50 }).project
    const cleared = ops.setWorkZone(set, { inFrame: null, outFrame: null })
    expect(cleared.receipt.changed).toBe(true)
    expect(cleared.project.timelines[0]!.workZone).toBeNull()
  })

  it('reports an honest no-op when the zone already matches', () => {
    const set = ops.setWorkZone(ops.emptyProject('T'), { inFrame: 5, outFrame: 50 }).project
    expect(ops.setWorkZone(set, { inFrame: 5, outFrame: 50 }).receipt.changed).toBe(false)
  })
})

describe('clip groups', () => {
  function threeOnTwoTracks() {
    const media: MediaAsset = {
      id: crypto.randomUUID(), path: 'C:/m/a.mp4', name: 'a.mp4', type: 'video',
      durationSeconds: 30, width: 1920, height: 1080, fps: 30,
      hasAudio: false, sampleRate: 0, channels: 0, thumbnailPath: null,
    }
    let state = ops.addAssets(ops.emptyProject('T'), [media]).project
    state = ops.addTrack(state, { type: 'video', name: 'V2' }).project
    const [v1, , v2] = state.timelines[0]!.tracks
    state = ops.addClips(state, { clips: [{ assetId: media.id, trackId: v1!.id, startFrame: 0, durationFrames: 60 }] }).project
    state = ops.addClips(state, { clips: [{ assetId: media.id, trackId: v2!.id, startFrame: 0, durationFrames: 60 }] }).project
    const ids = state.timelines[0]!.tracks.flatMap((t) => t.clips.map((c) => c.id))
    return { project: state, ids, assetId: media.id }
  }

  it('moves grouped clips together', () => {
    const { project, ids } = threeOnTwoTracks()
    const grouped = ops.groupClips(project, { clipIds: ids }).project
    const moved = ops.moveClips(grouped, { moves: [{ clipId: ids[0]!, startFrame: 120 }] }).project
    const starts = moved.timelines[0]!.tracks.flatMap((t) => t.clips.map((c) => c.startFrame))
    expect(starts).toEqual([120, 120])
  })

  it('deletes grouped clips together', () => {
    const { project, ids } = threeOnTwoTracks()
    const grouped = ops.groupClips(project, { clipIds: ids }).project
    const removed = ops.removeClips(grouped, { clipIds: [ids[0]!] }).project
    expect(removed.timelines[0]!.tracks.flatMap((t) => t.clips)).toHaveLength(0)
  })

  it('refuses a group of fewer than two clips', () => {
    const { project, ids } = threeOnTwoTracks()
    expect(() => ops.groupClips(project, { clipIds: [ids[0]!] })).toThrow(/at least two/)
  })

  it('ungroups and reports a no-op when nothing was grouped', () => {
    const { project, ids } = threeOnTwoTracks()
    const grouped = ops.groupClips(project, { clipIds: ids }).project
    const freed = ops.ungroupClips(grouped, { clipIds: [ids[0]!] })
    expect(freed.receipt.changed).toBe(true)
    expect(freed.project.timelines[0]!.tracks.flatMap((t) => t.clips).every((c) => c.groupId === null)).toBe(true)
    expect(ops.ungroupClips(freed.project, { clipIds: ids }).receipt.changed).toBe(false)
  })
})

describe('edit modes', () => {
  function oneLongClip() {
    const media: MediaAsset = {
      id: crypto.randomUUID(), path: 'C:/m/a.mp4', name: 'a.mp4', type: 'video',
      durationSeconds: 30, width: 1920, height: 1080, fps: 30,
      hasAudio: false, sampleRate: 0, channels: 0, thumbnailPath: null,
    }
    let state = ops.addAssets(ops.emptyProject('T'), [media]).project
    state = ops.addClips(state, { clips: [{ assetId: media.id, startFrame: 0, durationFrames: 120 }] }).project
    return { project: state, assetId: media.id, trackId: state.timelines[0]!.tracks[0]!.id }
  }

  it('refuses in normal mode and says which mode would work', () => {
    const { project, assetId, trackId } = oneLongClip()
    expect(() =>
      ops.addClips(project, { clips: [{ assetId, trackId, startFrame: 30, durationFrames: 30 }] }),
    ).toThrow(/overwrite.*insert/)
  })

  it('overwrite splits the clip underneath and leaves an exact hole', () => {
    const { project, assetId, trackId } = oneLongClip()
    const { project: next, receipt } = ops.addClips(project, {
      clips: [{ assetId, trackId, startFrame: 40, durationFrames: 30 }],
      mode: 'overwrite',
    })
    const clips = next.timelines[0]!.tracks[0]!.clips
    expect(clips.map((c) => [c.startFrame, c.durationFrames])).toEqual([
      [0, 40],
      [40, 30],
      [70, 50],
    ])
    expect(receipt.warnings.join(' ')).toMatch(/overwrote/)
  })

  it('overwrite trims a clip it only partly covers', () => {
    const { project, assetId, trackId } = oneLongClip()
    const next = ops.addClips(project, {
      clips: [{ assetId, trackId, startFrame: 100, durationFrames: 60 }],
      mode: 'overwrite',
    }).project
    const clips = next.timelines[0]!.tracks[0]!.clips
    expect(clips.map((c) => [c.startFrame, c.durationFrames])).toEqual([
      [0, 100],
      [100, 60],
    ])
  })

  it('insert pushes everything at or after the point rightwards', () => {
    const { project, assetId, trackId } = oneLongClip()
    const next = ops.addClips(project, {
      clips: [{ assetId, trackId, startFrame: 0, durationFrames: 45 }],
      mode: 'insert',
    }).project
    const clips = next.timelines[0]!.tracks[0]!.clips
    expect(clips.map((c) => [c.startFrame, c.durationFrames])).toEqual([
      [0, 45],
      [45, 120],
    ])
  })
})
