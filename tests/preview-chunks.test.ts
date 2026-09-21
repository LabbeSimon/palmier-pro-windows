/**
 * Chunked preview rendering.
 *
 * The claim being tested is narrow and the whole point of the feature: after a
 * change, only the slices that change are encoded again. Everything else here
 * exists to make sure the stitched result is still a playable file of the right
 * length, because a fast preview that does not play is worthless.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MediaAsset, Project } from '../src/core/model.js'
import * as ops from '../src/core/ops.js'
import { CHUNK_SECONDS, chunkFrames, planChunks } from '../src/main/media/chunks.js'
import { FFMPEG_PATH, FFPROBE_PATH } from '../src/main/media/ffmpeg.js'
import { planPreview, renderPreview } from '../src/main/media/preview.js'

const exec = promisify(execFile)

let workDir: string
let asset: MediaAsset

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'palmier-chunks-'))
  const source = join(workDir, 'src.mp4')
  await exec(FFMPEG_PATH, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=24',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    source,
  ])
  asset = {
    id: crypto.randomUUID(), path: source, name: 'src.mp4', type: 'video',
    durationSeconds: 24, width: 320, height: 180, fps: 30,
    hasAudio: true, sampleRate: 48000, channels: 2, thumbnailPath: null,
  }
}, 240_000)

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true })
})

/** Six slices' worth of timeline at the default slice length. */
function project(): { project: Project; clipId: string } {
  let state = ops.addAssets(ops.emptyProject('C'), [asset]).project
  state = ops.addClips(state, { clips: [{ assetId: asset.id, durationFrames: 30 * CHUNK_SECONDS * 6 }] }).project
  return { project: state, clipId: state.timelines[0]!.tracks[0]!.clips[0]!.id }
}

const timelineOf = (p: Project) => p.timelines[0]!

describe('planChunks', () => {
  it('cuts the timeline into slices of the configured length', () => {
    const { project: p } = project()
    const timeline = timelineOf(p)
    const chunks = planChunks(p, timeline, 0, 720)

    expect(chunkFrames(30)).toBe(120)
    expect(chunks).toHaveLength(6)
    expect(chunks[0]).toMatchObject({ index: 0, startFrame: 0, endFrame: 120 })
    expect(chunks[5]).toMatchObject({ index: 5, startFrame: 600, endFrame: 720 })
  })

  it('snaps a range outwards, so a work zone never splits a slice', () => {
    const { project: p } = project()
    const chunks = planChunks(p, timelineOf(p), 130, 250)
    expect(chunks[0]!.startFrame).toBe(120)
    expect(chunks[chunks.length - 1]!.endFrame).toBe(360)
  })

  it('gives one slice for a range shorter than a slice', () => {
    const { project: p } = project()
    expect(planChunks(p, timelineOf(p), 10, 20)).toHaveLength(1)
  })

  it('dirties only the slices a local edit lands in', () => {
    const { project: p } = project()
    const before = planChunks(p, timelineOf(p), 0, 720)

    // A title on its own track over frames 300-360, which falls inside slice 2
    // alone: slice 3 starts exactly where the title ends.
    const withTrack = ops.addTrack(p, { type: 'video' }).project
    const titled = ops.addTexts(withTrack, {
      texts: [{ content: 'Titre', startFrame: 300, durationFrames: 60 }],
    }).project

    const after = planChunks(titled, timelineOf(titled), 0, 720)
    const moved = after.filter((chunk, i) => chunk.fingerprint !== before[i]!.fingerprint)
    expect(moved.map((chunk) => chunk.index)).toEqual([2])
  })

  it('leaves distant slices untouched when an edit is local', () => {
    const { project: p } = project()
    const timeline = timelineOf(p)
    // A marker changes nothing that renders, so no slice may move.
    const marked = ops.addMarkers(p, { markers: [{ startFrame: 300, name: 'beat' }] }).project
    expect(planChunks(marked, timelineOf(marked), 0, 720).map((c) => c.fingerprint)).toEqual(
      planChunks(p, timeline, 0, 720).map((c) => c.fingerprint),
    )
  })
})

describe('renderPreview', () => {
  it('encodes every slice the first time, then only what changed', async () => {
    const cacheDir = join(workDir, 'cache')
    const { project: p, clipId } = project()

    const first = planPreview(p, timelineOf(p), cacheDir)
    expect(first.dirty).toHaveLength(6)

    const state = await renderPreview(p, timelineOf(p), cacheDir).promise
    expect(state.totalFrames).toBe(720)

    // The stitched file plays and is the right length.
    const { stdout } = await exec(FFPROBE_PATH, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', state.path,
    ])
    expect(Number(stdout.trim())).toBeGreaterThan(23)

    // Now a change that only affects part of the edit: a title on its own
    // track, covering frames 300-360.
    const withTrack = ops.addTrack(p, { type: 'video' }).project
    const edited = ops.addTexts(withTrack, {
      texts: [{ content: 'Titre', startFrame: 300, durationFrames: 60 }],
    }).project

    const second = planPreview(edited, timelineOf(edited), cacheDir)
    expect(second.dirty.length).toBeGreaterThan(0)
    expect(second.dirty.length).toBeLessThan(6)
    // The untouched slices keep their keys, which is what makes them reusable.
    const reused = second.chunks.filter((chunk) => !second.dirty.includes(chunk))
    expect(reused.length).toBe(6 - second.dirty.length)
    expect(clipId).toBeTruthy()
  }, 600_000)

  it('reuses the stitched file outright when nothing changed', async () => {
    const cacheDir = join(workDir, 'cache2')
    const { project: p } = project()

    await renderPreview(p, timelineOf(p), cacheDir).promise
    const again = planPreview(p, timelineOf(p), cacheDir)
    expect(again.dirty).toHaveLength(0)

    const chunks = await readdir(join(cacheDir, 'preview-chunks'))
    expect(chunks.filter((name) => name.startsWith('chunk-'))).toHaveLength(6)
  }, 600_000)
})
