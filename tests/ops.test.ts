import { describe, expect, it } from 'vitest'

import {
  clipEndFrame,
  sourceDurationFrames,
  timelineTotalFrames,
  type MediaAsset,
  type Project,
} from '../src/core/model.js'
import * as ops from '../src/core/ops.js'
import { OpError } from '../src/core/ops.js'

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: crypto.randomUUID(),
    path: `C:/media/${overrides.name ?? 'clip.mp4'}`,
    name: 'clip.mp4',
    type: 'video',
    durationSeconds: 10,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: false,
    sampleRate: 0,
    channels: 0,
    thumbnailPath: null,
    ...overrides,
  }
}

/** A 30fps project with one 300-frame video asset already imported. */
function fixture(): { project: Project; assetId: string; videoTrackId: string; audioTrackId: string } {
  const base = ops.emptyProject('Test')
  const media = asset()
  const { project } = ops.addAssets(base, [media])
  const timeline = project.timelines[0]!
  return {
    project,
    assetId: media.id,
    videoTrackId: timeline.tracks[0]!.id,
    audioTrackId: timeline.tracks[1]!.id,
  }
}

describe('addClips', () => {
  it('derives the full media length when duration is omitted', () => {
    const { project, assetId } = fixture()
    const { project: next, receipt } = ops.addClips(project, { clips: [{ assetId }] })
    const clip = next.timelines[0]!.tracks[0]!.clips[0]!

    expect(receipt.changed).toBe(true)
    expect(clip.startFrame).toBe(0)
    expect(clip.durationFrames).toBe(300)
    expect(clip.trimEndFrame).toBe(0)
  })

  it('appends to the end of the track on repeated calls', () => {
    const { project, assetId } = fixture()
    const first = ops.addClips(project, { clips: [{ assetId, durationFrames: 60 }] }).project
    const second = ops.addClips(first, { clips: [{ assetId, durationFrames: 45 }] }).project
    const clips = second.timelines[0]!.tracks[0]!.clips

    expect(clips.map((c) => c.startFrame)).toEqual([0, 60])
    expect(timelineTotalFrames(second.timelines[0]!)).toBe(105)
  })

  it('refuses an overlapping placement instead of retargeting it', () => {
    const { project, assetId } = fixture()
    const placed = ops.addClips(project, { clips: [{ assetId, startFrame: 0, durationFrames: 100 }] }).project

    expect(() => ops.addClips(placed, { clips: [{ assetId, startFrame: 50, durationFrames: 100 }] })).toThrow(OpError)
    expect(placed.timelines[0]!.tracks[0]!.clips).toHaveLength(1)
  })

  it('refuses a duration the media cannot supply', () => {
    const { project, assetId } = fixture()
    expect(() => ops.addClips(project, { clips: [{ assetId, durationFrames: 301 }] })).toThrow(
      /only has 300/,
    )
  })

  it('accounts for speed when checking available source frames', () => {
    const { project, assetId } = fixture()
    // 200 output frames at 2x consumes 400 source frames, but only 300 exist.
    expect(() => ops.addClips(project, { clips: [{ assetId, durationFrames: 200, speed: 2 }] })).toThrow(
      /needs 400 source frames/,
    )
    const ok = ops.addClips(project, { clips: [{ assetId, durationFrames: 150, speed: 2 }] }).project
    expect(ok.timelines[0]!.tracks[0]!.clips[0]!.durationFrames).toBe(150)
  })

  it('refuses video media on an audio track', () => {
    const { project, assetId, audioTrackId } = fixture()
    expect(() => ops.addClips(project, { clips: [{ assetId, trackId: audioTrackId }] })).toThrow(
      /cannot go on a audio track/,
    )
  })

  it('does not mutate the input project', () => {
    const { project, assetId } = fixture()
    const before = JSON.stringify(project)
    ops.addClips(project, { clips: [{ assetId }] })
    expect(JSON.stringify(project)).toBe(before)
  })
})

describe('splitClips', () => {
  it('preserves total duration and source coverage across the cut', () => {
    const { project, assetId } = fixture()
    const placed = ops.addClips(project, { clips: [{ assetId, durationFrames: 300 }] }).project
    const original = placed.timelines[0]!.tracks[0]!.clips[0]!
    const originalSource = sourceDurationFrames(original)

    const { project: next } = ops.splitClips(placed, { frame: 120 })
    const [left, right] = next.timelines[0]!.tracks[0]!.clips

    expect(left!.startFrame).toBe(0)
    expect(left!.durationFrames).toBe(120)
    expect(right!.startFrame).toBe(120)
    expect(right!.durationFrames).toBe(180)
    expect(right!.trimStartFrame).toBe(120)
    expect(sourceDurationFrames(left!)).toBe(originalSource)
    expect(sourceDurationFrames(right!)).toBe(originalSource)
    expect(left!.id).not.toBe(right!.id)
  })

  it('keeps each fade on its own outer edge', () => {
    const { project, assetId } = fixture()
    let state = ops.addClips(project, { clips: [{ assetId, durationFrames: 300 }] }).project
    const clipId = state.timelines[0]!.tracks[0]!.clips[0]!.id
    state = ops.setClipProperties(state, {
      clipIds: [clipId],
      properties: { fadeInFrames: 15, fadeOutFrames: 20 },
    }).project

    const { project: next } = ops.splitClips(state, { frame: 150 })
    const [left, right] = next.timelines[0]!.tracks[0]!.clips

    expect(left!.fadeInFrames).toBe(15)
    expect(left!.fadeOutFrames).toBe(0)
    expect(right!.fadeInFrames).toBe(0)
    expect(right!.fadeOutFrames).toBe(20)
  })

  it('reports an honest no-op when nothing crosses the frame', () => {
    const { project, assetId } = fixture()
    const placed = ops.addClips(project, { clips: [{ assetId, durationFrames: 60 }] }).project
    const { project: next, receipt } = ops.splitClips(placed, { frame: 200 })

    expect(receipt.changed).toBe(false)
    expect(next).toBe(placed)
  })

  it('does not split at a clip boundary', () => {
    const { project, assetId } = fixture()
    const placed = ops.addClips(project, { clips: [{ assetId, durationFrames: 60 }] }).project
    expect(ops.splitClips(placed, { frame: 0 }).receipt.changed).toBe(false)
    expect(ops.splitClips(placed, { frame: 60 }).receipt.changed).toBe(false)
  })
})

describe('removeClips', () => {
  it('closes gaps in order when rippling', () => {
    const { project, assetId } = fixture()
    let state = project
    for (const start of [0, 60, 120]) {
      state = ops.addClips(state, { clips: [{ assetId, startFrame: start, durationFrames: 60 }] }).project
    }
    const clips = state.timelines[0]!.tracks[0]!.clips
    const { project: next } = ops.removeClips(state, { clipIds: [clips[0]!.id], ripple: true })
    const remaining = next.timelines[0]!.tracks[0]!.clips

    expect(remaining.map((c) => c.startFrame)).toEqual([0, 60])
  })

  it('leaves the gap when not rippling', () => {
    const { project, assetId } = fixture()
    let state = project
    for (const start of [0, 60]) {
      state = ops.addClips(state, { clips: [{ assetId, startFrame: start, durationFrames: 60 }] }).project
    }
    const clips = state.timelines[0]!.tracks[0]!.clips
    const { project: next } = ops.removeClips(state, { clipIds: [clips[0]!.id] })

    expect(next.timelines[0]!.tracks[0]!.clips.map((c) => c.startFrame)).toEqual([60])
  })
})

describe('moveClips', () => {
  it('lets two clips swap places in one atomic call', () => {
    const { project, assetId } = fixture()
    let state = ops.addClips(project, { clips: [{ assetId, startFrame: 0, durationFrames: 60 }] }).project
    state = ops.addClips(state, { clips: [{ assetId, startFrame: 60, durationFrames: 60 }] }).project
    const [a, b] = state.timelines[0]!.tracks[0]!.clips

    const { project: next } = ops.moveClips(state, {
      moves: [
        { clipId: a!.id, startFrame: 60 },
        { clipId: b!.id, startFrame: 0 },
      ],
    })
    const clips = next.timelines[0]!.tracks[0]!.clips
    expect(clips.find((c) => c.id === a!.id)!.startFrame).toBe(60)
    expect(clips.find((c) => c.id === b!.id)!.startFrame).toBe(0)
  })

  it('refuses a collision and leaves the timeline untouched', () => {
    const { project, assetId } = fixture()
    let state = ops.addClips(project, { clips: [{ assetId, startFrame: 0, durationFrames: 60 }] }).project
    state = ops.addClips(state, { clips: [{ assetId, startFrame: 200, durationFrames: 60 }] }).project
    const [a, b] = state.timelines[0]!.tracks[0]!.clips
    const before = JSON.stringify(state)

    expect(() => ops.moveClips(state, { moves: [{ clipId: b!.id, startFrame: 30 }] })).toThrow(/occupied/)
    expect(JSON.stringify(state)).toBe(before)
    expect(a!.startFrame).toBe(0)
  })
})

describe('setClipProperties', () => {
  it('refuses fades longer than the clip', () => {
    const { project, assetId } = fixture()
    const state = ops.addClips(project, { clips: [{ assetId, durationFrames: 30 }] }).project
    const clipId = state.timelines[0]!.tracks[0]!.clips[0]!.id

    expect(() =>
      ops.setClipProperties(state, { clipIds: [clipId], properties: { fadeInFrames: 20, fadeOutFrames: 20 } }),
    ).toThrow(/fades total 40 frames/)
  })

  it('reports no change when the values already match', () => {
    const { project, assetId } = fixture()
    const state = ops.addClips(project, { clips: [{ assetId, durationFrames: 30 }] }).project
    const clipId = state.timelines[0]!.tracks[0]!.clips[0]!.id
    const { receipt, project: next } = ops.setClipProperties(state, {
      clipIds: [clipId],
      properties: { opacity: 1 },
    })

    expect(receipt.changed).toBe(false)
    expect(next).toBe(state)
  })

  it('rejects a non-finite number rather than writing NaN into the model', () => {
    const { project, assetId } = fixture()
    const state = ops.addClips(project, { clips: [{ assetId, durationFrames: 30 }] }).project
    const clipId = state.timelines[0]!.tracks[0]!.clips[0]!.id

    expect(() => ops.setClipProperties(state, { clipIds: [clipId], properties: { speed: NaN } })).toThrow(
      /finite number/,
    )
    expect(() => ops.setClipProperties(state, { clipIds: [clipId], properties: { opacity: 1.5 } })).toThrow(
      /between 0 and 1/,
    )
  })

  it('lets a clip move within its own range without a self-collision', () => {
    const { project, assetId } = fixture()
    const state = ops.addClips(project, { clips: [{ assetId, startFrame: 100, durationFrames: 60 }] }).project
    const clipId = state.timelines[0]!.tracks[0]!.clips[0]!.id
    const { project: next } = ops.setClipProperties(state, {
      clipIds: [clipId],
      properties: { startFrame: 120 },
    })

    expect(next.timelines[0]!.tracks[0]!.clips[0]!.startFrame).toBe(120)
  })
})

describe('addTexts', () => {
  it('places text on the topmost free visual track', () => {
    const { project, assetId } = fixture()
    let state = ops.addClips(project, { clips: [{ assetId, durationFrames: 300 }] }).project
    state = ops.addTrack(state, { type: 'video', name: 'V2' }).project
    const { project: next } = ops.addTexts(state, {
      texts: [{ content: 'Hello', startFrame: 0, durationFrames: 90 }],
    })

    const v2 = next.timelines[0]!.tracks.find((t) => t.name === 'V2')!
    expect(v2.clips).toHaveLength(1)
    expect(v2.clips[0]!.textContent).toBe('Hello')
    expect(v2.clips[0]!.mediaType).toBe('text')
  })

  it('refuses text on an audio track', () => {
    const { project, audioTrackId } = fixture()
    expect(() =>
      ops.addTexts(project, {
        texts: [{ content: 'x', startFrame: 0, durationFrames: 10, trackId: audioTrackId }],
      }),
    ).toThrow(/cannot go on a audio track/)
  })
})

describe('removeAssets', () => {
  it('refuses to remove media a clip still uses', () => {
    const { project, assetId } = fixture()
    const state = ops.addClips(project, { clips: [{ assetId, durationFrames: 30 }] }).project
    expect(() => ops.removeAssets(state, [assetId])).toThrow(/still use this media/)
  })
})

describe('setProjectSettings', () => {
  it('warns that changing frame rate shifts existing clip timing', () => {
    const { project, assetId } = fixture()
    const state = ops.addClips(project, { clips: [{ assetId, durationFrames: 30 }] }).project
    const { receipt } = ops.setProjectSettings(state, { fps: 60 })

    expect(receipt.changed).toBe(true)
    expect(receipt.warnings.join(' ')).toMatch(/shifts/)
  })

  it('does not warn on an empty timeline', () => {
    const { project } = fixture()
    expect(ops.setProjectSettings(project, { fps: 60 }).receipt.warnings).toHaveLength(0)
  })
})

describe('removeTrack', () => {
  it('keeps at least one track', () => {
    const { project, videoTrackId, audioTrackId } = fixture()
    const state = ops.removeTrack(project, videoTrackId).project
    expect(() => ops.removeTrack(state, audioTrackId)).toThrow(/at least one track/)
  })
})

describe('clip derivations', () => {
  it('computes the end frame from start plus duration', () => {
    const { project, assetId } = fixture()
    const state = ops.addClips(project, { clips: [{ assetId, startFrame: 45, durationFrames: 90 }] }).project
    expect(clipEndFrame(state.timelines[0]!.tracks[0]!.clips[0]!)).toBe(135)
  })
})
