/**
 * Multicam.
 *
 * Switching angle is a cut plus a retarget, so most of what matters is that the
 * retarget lands on the same moment in the other camera — verified here by the
 * source frames the clip ends up reading, and end to end by syncing two files
 * that really are offset.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MediaAsset, Project } from '../src/core/model.js'
import * as ops from '../src/core/ops.js'
import { FFMPEG_PATH } from '../src/main/media/ffmpeg.js'
import { CONFIDENT, syncByAudio, SyncError } from '../src/main/media/sync.js'

const exec = promisify(execFile)

function camera(name: string, durationSeconds = 20): MediaAsset {
  return {
    id: crypto.randomUUID(), path: `C:/m/${name}.mp4`, name: `${name}.mp4`, type: 'video',
    durationSeconds, width: 1920, height: 1080, fps: 30,
    hasAudio: true, sampleRate: 48000, channels: 2, thumbnailPath: null,
  }
}

function withCameras(...assets: MediaAsset[]): Project {
  return ops.addAssets(ops.emptyProject('M'), assets).project
}

const clipsOf = (project: Project) => project.timelines[0]!.tracks[0]!.clips

describe('createMulticam', () => {
  it('places the first angle and remembers the others', () => {
    const [a, b] = [camera('a'), camera('b')]
    const { project, receipt } = ops.createMulticam(withCameras(a, b), {
      angles: [{ assetId: a.id }, { assetId: b.id }],
    })
    const clip = clipsOf(project)[0]!
    expect(clip.mediaRef).toBe(a.id)
    expect(clip.multicam!.angles.map((angle) => angle.name)).toEqual(['a.mp4', 'b.mp4'])
    expect(clip.multicam!.activeIndex).toBe(0)
    expect(receipt.summary).toMatch(/2 angles/)
  })

  it('enters each angle at its offset, and runs only as long as they all overlap', () => {
    const [a, b] = [camera('a', 20), camera('b', 20)]
    const { project } = ops.createMulticam(withCameras(a, b), {
      angles: [{ assetId: a.id, offsetFrames: 90 }, { assetId: b.id, offsetFrames: 0 }],
    })
    const clip = clipsOf(project)[0]!
    expect(clip.trimStartFrame).toBe(90)
    // 20 s at 30 fps is 600 frames; the offset angle has 510 left.
    expect(clip.durationFrames).toBe(510)
  })

  it('refuses a set of one', () => {
    const a = camera('a')
    expect(() => ops.createMulticam(withCameras(a), { angles: [{ assetId: a.id }] })).toThrow(
      /at least two angles/,
    )
  })

  it('refuses angles that do not overlap, naming the one that ran out', () => {
    const [a, b] = [camera('a', 3), camera('b', 20)]
    expect(() =>
      ops.createMulticam(withCameras(a, b), {
        angles: [{ assetId: a.id, offsetFrames: 500 }, { assetId: b.id }],
      }),
    ).toThrow(/"a.mp4" has nothing left after its 500-frame offset/)
  })

  it('refuses a duration longer than the overlap, with the number', () => {
    const [a, b] = [camera('a', 10), camera('b', 10)]
    expect(() =>
      ops.createMulticam(withCameras(a, b), {
        angles: [{ assetId: a.id }, { assetId: b.id }],
        durationFrames: 900,
      }),
    ).toThrow(/only overlap for 300 frames, 900 were asked for/)
  })

  it('refuses media that cannot be an angle', () => {
    const a = camera('a')
    const still: MediaAsset = { ...camera('poster'), type: 'image', hasAudio: false }
    expect(() =>
      ops.createMulticam(withCameras(a, still), { angles: [{ assetId: a.id }, { assetId: still.id }] }),
    ).toThrow(/is a image, which cannot be an angle/)
  })
})

describe('switchAngle', () => {
  function set(offsets: [number, number] = [0, 0]) {
    const [a, b] = [camera('a'), camera('b')]
    const { project } = ops.createMulticam(withCameras(a, b), {
      angles: [
        { assetId: a.id, offsetFrames: offsets[0] },
        { assetId: b.id, offsetFrames: offsets[1] },
      ],
      durationFrames: 300,
    })
    return { project, clipId: clipsOf(project)[0]!.id, a, b }
  }

  it('retargets the whole clip when given no frame', () => {
    const { project, clipId, b } = set()
    const { project: next } = ops.switchAngle(project, { clipId, angleIndex: 1 })
    const clip = clipsOf(next)[0]!
    expect(clip.mediaRef).toBe(b.id)
    expect(clip.multicam!.activeIndex).toBe(1)
    expect(clipsOf(next)).toHaveLength(1)
  })

  it('cuts at the frame and leaves the part before on the old angle', () => {
    const { project, clipId, a, b } = set()
    const { project: next, receipt } = ops.switchAngle(project, { clipId, angleIndex: 1, frame: 120 })
    const clips = clipsOf(next)
    expect(clips).toHaveLength(2)
    expect(clips[0]!.mediaRef).toBe(a.id)
    expect(clips[0]!.durationFrames).toBe(120)
    expect(clips[1]!.mediaRef).toBe(b.id)
    expect(clips[1]!.startFrame).toBe(120)
    expect(receipt.summary).toMatch(/Switched to "b.mp4" from frame 120/)
  })

  it('lands on the same moment when the angles are offset', () => {
    // A started 60 frames earlier, so the same instant is 60 frames further in.
    const { project, clipId } = set([60, 0])
    const { project: next } = ops.switchAngle(project, { clipId, angleIndex: 1, frame: 90 })
    const clips = clipsOf(next)
    expect(clips[0]!.trimStartFrame).toBe(60)
    // 60 (offset) + 90 (elapsed) - 60 (reference offset) + 0 (new offset)
    expect(clips[1]!.trimStartFrame).toBe(90)
  })

  it('keeps the angle set on both halves so the cut can be switched again', () => {
    const { project, clipId } = set()
    const once = ops.switchAngle(project, { clipId, angleIndex: 1, frame: 100 }).project
    const second = clipsOf(once)[1]!
    expect(second.multicam!.angles).toHaveLength(2)

    const twice = ops.switchAngle(once, { clipId: second.id, angleIndex: 0, frame: 200 }).project
    expect(clipsOf(twice)).toHaveLength(3)
    expect(clipsOf(twice).map((clip) => clip.multicam!.activeIndex)).toEqual([0, 1, 0])
  })

  it('refuses an angle that has no footage there, with the frame numbers', () => {
    const [a, b] = [camera('a', 20), camera('b', 4)]
    const { project } = ops.createMulticam(withCameras(a, b), {
      angles: [{ assetId: a.id }, { assetId: b.id }],
      durationFrames: 120,
    })
    // b only has 120 source frames, so a switch at 60 needs frames 60-120... fits.
    // Trim the request past its end instead.
    const clipId = clipsOf(project)[0]!.id
    const cut = ops.switchAngle(project, { clipId, angleIndex: 1, frame: 100 }).project
    expect(clipsOf(cut)[1]!.mediaRef).toBe(b.id)

    const longer = ops.createMulticam(withCameras(a, b), {
      angles: [{ assetId: a.id }, { assetId: b.id }],
      durationFrames: 120,
    }).project
    const trimmed = ops.trimClip(longer, {
      clipId: clipsOf(longer)[0]!.id,
      kind: 'slip',
      deltaFrames: 60,
    }).project
    expect(() =>
      ops.switchAngle(trimmed, { clipId: clipsOf(trimmed)[0]!.id, angleIndex: 1 }),
    ).toThrow(/has no footage for this stretch/)
  })

  it('refuses an angle index that does not exist, listing the ones that do', () => {
    const { project, clipId } = set()
    expect(() => ops.switchAngle(project, { clipId, angleIndex: 7 })).toThrow(
      /angle 7 does not exist .*0=a.mp4, 1=b.mp4/,
    )
  })

  it('refuses a clip that is not multicam', () => {
    const a = camera('a')
    let state = withCameras(a)
    state = ops.addClips(state, { clips: [{ assetId: a.id, durationFrames: 60 }] }).project
    expect(() =>
      ops.switchAngle(state, { clipId: clipsOf(state)[0]!.id, angleIndex: 1 }),
    ).toThrow(/not part of a multicam set/)
  })

  it('reports switching to the angle already showing as no change', () => {
    const { project, clipId } = set()
    expect(ops.switchAngle(project, { clipId, angleIndex: 0 }).receipt.changed).toBe(false)
  })

  it('will not switch on a locked track', () => {
    const { project, clipId } = set()
    const trackId = project.timelines[0]!.tracks[0]!.id
    const locked = ops.setTrackFlags(project, { trackId, locked: true }).project
    expect(() => ops.switchAngle(locked, { clipId, angleIndex: 1 })).toThrow(/locked/i)
  })
})

describe('multicamSets', () => {
  it('groups every piece of a set back together, picture only', () => {
    const [a, b] = [camera('a'), camera('b')]
    let state = ops.createMulticam(withCameras(a, b), {
      angles: [{ assetId: a.id }, { assetId: b.id }],
      durationFrames: 300,
    }).project
    state = ops.switchAngle(state, { clipId: clipsOf(state)[0]!.id, angleIndex: 1, frame: 100 }).project

    const sets = ops.multicamSets(state.timelines[0]!)
    expect(sets.size).toBe(1)
    // Two picture cuts; the linked audio clip is deliberately not in the set.
    expect([...sets.values()][0]!.clips).toHaveLength(2)
    expect(state.timelines[0]!.tracks[1]!.clips[0]!.multicam).toBeUndefined()
  })
})

// --- Audio sync -----------------------------------------------------------

describe('syncByAudio', () => {
  let workDir: string
  let reference: MediaAsset
  let delayed: MediaAsset

  /** Two recordings of the same sound, one starting 2.5 s earlier. */
  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'palmier-sync-'))
    /*
     * Noise under a non-repeating envelope.
     *
     * A periodic pattern correlates equally well at every multiple of its
     * period, so a rhythmic test signal has no single right answer — the
     * product of two incommensurate slow sines does not repeat inside the take.
     */
    const pattern =
      'anoisesrc=color=white:seed=7:duration=14:sample_rate=44100,' +
      "volume='0.05+abs(sin(2*PI*0.31*t)*sin(2*PI*0.13*t))':eval=frame"

    const full = join(workDir, 'full.wav')
    await exec(FFMPEG_PATH, ['-hide_banner', '-y', '-f', 'lavfi', '-i', pattern, full])

    // The "early" camera holds the whole take; the other starts 2.5 s in.
    const late = join(workDir, 'late.wav')
    await exec(FFMPEG_PATH, ['-hide_banner', '-y', '-ss', '2.5', '-i', full, late])

    reference = {
      id: 'ref', path: full, name: 'full.wav', type: 'audio',
      durationSeconds: 14, width: 0, height: 0, fps: 0,
      hasAudio: true, sampleRate: 44100, channels: 1, thumbnailPath: null,
    }
    delayed = { ...reference, id: 'late', path: late, name: 'late.wav', durationSeconds: 11.5 }
  }, 180_000)

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  it('measures the real offset between two recordings of the same sound', async () => {
    const results = await syncByAudio([reference, delayed])
    expect(results).toHaveLength(2)

    // The reference holds 2.5 s the other does not, so it is entered 2.5 s in.
    const ref = results.find((result) => result.assetId === 'ref')!
    const late = results.find((result) => result.assetId === 'late')!
    expect(ref.offsetSeconds).toBeCloseTo(2.5, 1)
    expect(late.offsetSeconds).toBeCloseTo(0, 1)
    expect(late.confidence).toBeGreaterThan(CONFIDENT)
  }, 240_000)

  it('never returns a negative offset, because offsets are frames to skip', async () => {
    const results = await syncByAudio([delayed, reference])
    expect(results.every((result) => result.offsetSeconds >= 0)).toBe(true)
  }, 240_000)

  it('refuses a single angle', async () => {
    await expect(syncByAudio([reference])).rejects.toBeInstanceOf(SyncError)
  })

  it('says plainly when a file has no audio to sync on', async () => {
    const silent = { ...reference, id: 'x', hasAudio: false }
    await expect(syncByAudio([reference, silent])).rejects.toThrow(/no audio track to sync on/)
  }, 60_000)
})
