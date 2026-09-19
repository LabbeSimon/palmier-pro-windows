import { describe, expect, it } from 'vitest'

import type { MediaAsset, Project } from '../src/core/model.js'
import * as ops from '../src/core/ops.js'

/**
 * Three butt-joined clips, each with handles on both sides, so every trim has
 * material to work with. Source is 600 frames; each clip shows 60 of them.
 */
function threeClips(): { project: Project; ids: string[]; trackId: string } {
  const media: MediaAsset = {
    id: crypto.randomUUID(), path: 'C:/m/a.mp4', name: 'a.mp4', type: 'video',
    durationSeconds: 20, width: 1920, height: 1080, fps: 30,
    hasAudio: false, sampleRate: 0, channels: 0, thumbnailPath: null,
  }
  let state = ops.addAssets(ops.emptyProject('T'), [media]).project
  for (const [index, start] of [0, 60, 120].entries()) {
    state = ops.addClips(state, {
      clips: [
        {
          assetId: media.id,
          startFrame: start,
          durationFrames: 60,
          // A head handle of 120 frames leaves room to trim either way.
          trimStartFrame: 120 + index * 10,
        },
      ],
    }).project
  }
  const track = state.timelines[0]!.tracks[0]!
  return { project: state, ids: track.clips.map((c) => c.id), trackId: track.id }
}

const layout = (project: Project) =>
  project.timelines[0]!.tracks[0]!.clips.map((c) => [c.startFrame, c.durationFrames])

const totalLength = (project: Project) => {
  const clips = project.timelines[0]!.tracks[0]!.clips
  return Math.max(...clips.map((c) => c.startFrame + c.durationFrames))
}

describe('ripple trim', () => {
  it('lengthening the end pushes every later clip', () => {
    const { project, ids } = threeClips()
    const next = ops.trimClip(project, { clipId: ids[0]!, kind: 'ripple', deltaFrames: 20, edge: 'end' }).project
    expect(layout(next)).toEqual([
      [0, 80],
      [80, 60],
      [140, 60],
    ])
  })

  it('shortening the end pulls every later clip back', () => {
    const { project, ids } = threeClips()
    const next = ops.trimClip(project, { clipId: ids[1]!, kind: 'ripple', deltaFrames: -20, edge: 'end' }).project
    expect(layout(next)).toEqual([
      [0, 60],
      [60, 40],
      [100, 60],
    ])
  })

  it('refuses to shorten a clip below one frame', () => {
    const { project, ids } = threeClips()
    expect(() =>
      ops.trimClip(project, { clipId: ids[0]!, kind: 'ripple', deltaFrames: -60, edge: 'end' }),
    ).toThrow(/below one frame/)
  })

  it('refuses to pull more than the head handle holds', () => {
    const { project, ids } = threeClips()
    expect(() =>
      ops.trimClip(project, { clipId: ids[0]!, kind: 'ripple', deltaFrames: -500, edge: 'start' }),
    ).toThrow(/head handle/)
  })
})

describe('roll trim', () => {
  it('moves the cut without changing total length', () => {
    const { project, ids } = threeClips()
    const before = totalLength(project)
    const next = ops.trimClip(project, { clipId: ids[0]!, kind: 'roll', deltaFrames: 15, edge: 'end' }).project
    expect(layout(next)).toEqual([
      [0, 75],
      [75, 45],
      [120, 60],
    ])
    expect(totalLength(next)).toBe(before)
  })

  it('refuses without a neighbour to roll against', () => {
    const { project, ids } = threeClips()
    expect(() =>
      ops.trimClip(project, { clipId: ids[2]!, kind: 'roll', deltaFrames: 10, edge: 'end' }),
    ).toThrow(/no neighbour/)
  })

  it('refuses to roll one of the clips out of existence', () => {
    const { project, ids } = threeClips()
    expect(() =>
      ops.trimClip(project, { clipId: ids[0]!, kind: 'roll', deltaFrames: 70, edge: 'end' }),
    ).toThrow(/tail handle|empty one of the clips/)
  })
})

describe('slip trim', () => {
  it('changes the visible part without moving or resizing the clip', () => {
    const { project, ids } = threeClips()
    const before = project.timelines[0]!.tracks[0]!.clips[1]!
    const next = ops.trimClip(project, { clipId: ids[1]!, kind: 'slip', deltaFrames: 25 }).project
    const after = next.timelines[0]!.tracks[0]!.clips[1]!

    expect(after.startFrame).toBe(before.startFrame)
    expect(after.durationFrames).toBe(before.durationFrames)
    expect(after.trimStartFrame).toBe(before.trimStartFrame + 25)
    expect(layout(next)).toEqual(layout(project))
  })

  it('refuses to slip past the available handle', () => {
    const { project, ids } = threeClips()
    expect(() => ops.trimClip(project, { clipId: ids[0]!, kind: 'slip', deltaFrames: -500 })).toThrow(
      /head handle/,
    )
  })
})

describe('slide trim', () => {
  it('moves the clip while its neighbours absorb the difference', () => {
    const { project, ids } = threeClips()
    const before = totalLength(project)
    const next = ops.trimClip(project, { clipId: ids[1]!, kind: 'slide', deltaFrames: 20 }).project
    expect(layout(next)).toEqual([
      [0, 80],
      [80, 60],
      [140, 40],
    ])
    expect(totalLength(next)).toBe(before)
  })

  it('refuses to slide further than the neighbour is long', () => {
    const { project, ids } = threeClips()
    expect(() => ops.trimClip(project, { clipId: ids[1]!, kind: 'slide', deltaFrames: 90 })).toThrow(
      /swallow the neighbouring clip/,
    )
  })

  it('refuses to slide off the front', () => {
    const { project, ids } = threeClips()
    expect(() => ops.trimClip(project, { clipId: ids[0]!, kind: 'slide', deltaFrames: -10 })).toThrow(
      /no clip before/,
    )
  })
})

describe('trim guards', () => {
  it('reports an honest no-op for a zero delta', () => {
    const { project, ids } = threeClips()
    expect(ops.trimClip(project, { clipId: ids[0]!, kind: 'slip', deltaFrames: 0 }).receipt.changed).toBe(false)
  })

  it('rejects an unknown kind', () => {
    const { project, ids } = threeClips()
    expect(() => ops.trimClip(project, { clipId: ids[0]!, kind: 'stretch' as never, deltaFrames: 5 })).toThrow(
      /kind must be one of/,
    )
  })

  it('refuses on a locked track', () => {
    const { project, ids, trackId } = threeClips()
    const locked = ops.setTrackFlags(project, { trackId, locked: true }).project
    expect(() => ops.trimClip(locked, { clipId: ids[0]!, kind: 'slip', deltaFrames: 5 })).toThrow(/locked/)
  })

  it('does not mutate the input project', () => {
    const { project, ids } = threeClips()
    const before = JSON.stringify(project)
    ops.trimClip(project, { clipId: ids[1]!, kind: 'slide', deltaFrames: 10 })
    expect(JSON.stringify(project)).toBe(before)
  })
})
