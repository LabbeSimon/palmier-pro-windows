import { describe, expect, it } from 'vitest'

import type { MediaAsset, Project } from '../src/core/model.js'
import * as ops from '../src/core/ops.js'
import { fingerprintTimeline } from '../src/main/media/preview.js'

function fixture(): { project: Project; assetId: string; clipId: string } {
  const media: MediaAsset = {
    id: crypto.randomUUID(), path: 'C:/m/a.mp4', name: 'a.mp4', type: 'video',
    durationSeconds: 20, width: 1920, height: 1080, fps: 30,
    hasAudio: true, sampleRate: 48000, channels: 2, thumbnailPath: null,
  }
  let state = ops.addAssets(ops.emptyProject('T'), [media]).project
  state = ops.addClips(state, { clips: [{ assetId: media.id, durationFrames: 90 }] }).project
  return { project: state, assetId: media.id, clipId: state.timelines[0]!.tracks[0]!.clips[0]!.id }
}

const print = (project: Project) => fingerprintTimeline(project, project.timelines[0]!)

describe('preview fingerprint', () => {
  it('is stable for an unchanged edit', () => {
    const { project } = fixture()
    expect(print(project)).toBe(print(project))
  })

  it('changes when a clip moves', () => {
    const { project, clipId } = fixture()
    const moved = ops.moveClips(project, { moves: [{ clipId, startFrame: 30 }] }).project
    expect(print(moved)).not.toBe(print(project))
  })

  it('changes when an effect is added', () => {
    const { project, clipId } = fixture()
    const graded = ops.addEffect(project, { clipIds: [clipId], definitionId: 'saturation', params: { amount: 2 } }).project
    expect(print(graded)).not.toBe(print(project))
  })

  it('changes when a track is muted, because the mix changes', () => {
    const { project } = fixture()
    const trackId = project.timelines[0]!.tracks[1]!.id
    const muted = ops.setTrackFlags(project, { trackId, muted: true }).project
    expect(print(muted)).not.toBe(print(project))
  })

  it('survives a work zone that stays inside the same slices', () => {
    // Slices are aligned to absolute frames, never to the zone, so nudging the
    // in point no longer throws the whole cache away. This is the behaviour
    // chunking bought: the old whole-timeline proxy had to rebuild for this.
    const { project } = fixture()
    const zoned = ops.setWorkZone(project, { inFrame: 10, outFrame: 60 }).project
    expect(print(zoned)).toBe(print(project))
  })

  it('changes when the zone reaches into a slice it did not cover', () => {
    const { project } = fixture()
    const short = ops.setWorkZone(project, { inFrame: 0, outFrame: 30 }).project
    const long = ops.setWorkZone(project, { inFrame: 0, outFrame: 400 }).project
    expect(print(long)).not.toBe(print(short))
  })

  it('ignores importing media that no clip uses', () => {
    const { project } = fixture()
    const extra: MediaAsset = {
      id: crypto.randomUUID(), path: 'C:/m/unused.mp4', name: 'unused.mp4', type: 'video',
      durationSeconds: 5, width: 1280, height: 720, fps: 30,
      hasAudio: false, sampleRate: 0, channels: 0, thumbnailPath: null,
    }
    const withExtra = ops.addAssets(project, [extra]).project
    expect(print(withExtra)).toBe(print(project))
  })

  it('ignores renaming a track, which changes nothing on screen', () => {
    const { project } = fixture()
    const trackId = project.timelines[0]!.tracks[0]!.id
    const renamed = ops.setTrackFlags(project, { trackId, name: 'Main picture' }).project
    expect(print(renamed)).toBe(print(project))
  })

  it('is free to add an empty track', () => {
    const { project } = fixture()
    const extended = ops.addTrack(project, { type: 'video', name: 'V2' }).project
    // An empty track changes nothing on screen. The old whole-timeline proxy
    // rebuilt anyway, erring towards safety; a slice keyed on the clips that
    // actually reach into it can afford to be exact, and adding a track before
    // dropping a title on it is too common a gesture to make expensive.
    expect(print(extended)).toBe(print(project))
  })
})
