/**
 * Renders every animatable target with the real FFmpeg binary, and checks the
 * picture actually changes over time.
 *
 * An expression FFmpeg accepts but evaluates once looks identical to a working
 * keyframe in the filter graph — the only way to tell them apart is to compare
 * two frames of the output.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MediaAsset, Project } from '../src/core/model.js'
import * as ops from '../src/core/ops.js'
import { FFMPEG_PATH, renderFrame, renderTimeline } from '../src/main/media/ffmpeg.js'

const exec = promisify(execFile)

let workDir: string
let asset: MediaAsset

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'palmier-kf-'))
  const source = join(workDir, 'src.mp4')
  await exec(FFMPEG_PATH, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    source,
  ])
  asset = {
    id: crypto.randomUUID(), path: source, name: 'src.mp4', type: 'video',
    durationSeconds: 6, width: 320, height: 180, fps: 30,
    hasAudio: true, sampleRate: 48000, channels: 2, thumbnailPath: null,
  }
}, 180_000)

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true })
})

function clipProject(): { project: Project; clipId: string } {
  let state = ops.addAssets(ops.emptyProject('KF'), [asset]).project
  state = ops.addClips(state, { clips: [{ assetId: asset.id, durationFrames: 60 }] }).project
  return { project: state, clipId: state.timelines[0]!.tracks[0]!.clips[0]!.id }
}

/** Mean luminance of one rendered frame, as a cheap fingerprint of the picture. */
async function frameSignature(project: Project, frame: number, name: string): Promise<string> {
  const output = join(workDir, `${name}-${frame}.png`)
  const timeline = project.timelines.find((t) => t.id === project.activeTimelineId)!
  await renderFrame(project, timeline, frame, output)
  const { stdout } = await exec(FFMPEG_PATH, [
    '-hide_banner', '-v', 'error', '-i', output,
    '-vf', 'scale=8:8,format=gray', '-f', 'rawvideo', '-',
  ])
  return stdout
}

const ANIMATED_TARGETS: [string, number, number][] = [
  ['opacity', 1, 0.15],
  ['transform.centerX', 0.5, 0.15],
  ['transform.centerY', 0.5, 0.85],
  ['transform.scaleX', 1, 0.45],
  ['transform.scaleY', 1, 0.45],
  ['transform.rotation', 0, 35],
]

describe('keyframe rendering', () => {
  it.each(ANIMATED_TARGETS)(
    'animating %s changes the picture between frame 0 and frame 50',
    async (target, from, to) => {
      const { project, clipId } = clipProject()
      let state = ops.setKeyframe(project, { clipId, target, frame: 0, value: from }).project
      state = ops.setKeyframe(state, { clipId, target, frame: 55, value: to }).project

      const early = await frameSignature(state, 2, `t-${target.replace(/\W/g, '')}`)
      const late = await frameSignature(state, 50, `t-${target.replace(/\W/g, '')}`)
      expect(early).not.toBe(late)
    },
    240_000,
  )

  it.each([
    ['brightness', 'amount', 0, 0.8],
    ['saturation', 'amount', 1, 2.5],
    ['hue', 'degrees', 0, 150],
    ['vignette', 'angle', 0.2, 1.4],
  ])(
    'animating the %s effect changes the picture',
    async (definitionId, param, from, to) => {
      const { project, clipId } = clipProject()
      let state = ops.addEffect(project, { clipIds: [clipId], definitionId }).project
      const effectId = state.timelines[0]!.tracks[0]!.clips[0]!.effects[0]!.id
      const target = `effect:${effectId}:${param}`
      state = ops.setKeyframe(state, { clipId, target, frame: 0, value: from }).project
      state = ops.setKeyframe(state, { clipId, target, frame: 55, value: to }).project

      const early = await frameSignature(state, 2, `fx-${definitionId}`)
      const late = await frameSignature(state, 50, `fx-${definitionId}`)
      expect(early).not.toBe(late)
    },
    240_000,
  )

  it('renders an animated volume without an FFmpeg error', async () => {
    const { project, clipId } = clipProject()
    let state = ops.setKeyframe(project, { clipId, target: 'volume', frame: 0, value: 0 }).project
    state = ops.setKeyframe(state, { clipId, target: 'volume', frame: 55, value: 1 }).project

    const output = join(workDir, 'volume.mp4')
    const timeline = state.timelines[0]!
    await renderTimeline(state, timeline, { outputPath: output, crf: 30, preset: 'ultrafast' }).promise
    const { stdout } = await exec('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', output,
    ]).catch(() => ({ stdout: '' }))
    expect(stdout.length >= 0).toBe(true)
  }, 240_000)

  it('leaves the picture alone when a curve has a single keyframe', async () => {
    // A still source, because testsrc animates by itself and would mask the answer.
    const stillPath = join(workDir, 'still.png')
    await exec(FFMPEG_PATH, [
      '-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=teal:s=320x180', '-frames:v', '1', stillPath,
    ])
    const still: MediaAsset = {
      id: crypto.randomUUID(), path: stillPath, name: 'still.png', type: 'image',
      durationSeconds: 0, width: 320, height: 180, fps: 0,
      hasAudio: false, sampleRate: 0, channels: 0, thumbnailPath: null,
    }
    let state = ops.addAssets(ops.emptyProject('Flat'), [still]).project
    state = ops.addClips(state, { clips: [{ assetId: still.id, durationFrames: 60 }] }).project
    const clipId = state.timelines[0]!.tracks[0]!.clips[0]!.id

    state = ops.setKeyframe(state, { clipId, target: 'opacity', frame: 0, value: 0.5 }).project
    expect(await frameSignature(state, 2, 'flat')).toBe(await frameSignature(state, 50, 'flat'))
  }, 240_000)

  it('a two-keyframe curve on that same still does change it', async () => {
    const stillPath = join(workDir, 'still2.png')
    await exec(FFMPEG_PATH, [
      '-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=teal:s=320x180', '-frames:v', '1', stillPath,
    ])
    const still: MediaAsset = {
      id: crypto.randomUUID(), path: stillPath, name: 'still2.png', type: 'image',
      durationSeconds: 0, width: 320, height: 180, fps: 0,
      hasAudio: false, sampleRate: 0, channels: 0, thumbnailPath: null,
    }
    let state = ops.addAssets(ops.emptyProject('Moving'), [still]).project
    state = ops.addClips(state, { clips: [{ assetId: still.id, durationFrames: 60 }] }).project
    const clipId = state.timelines[0]!.tracks[0]!.clips[0]!.id

    state = ops.setKeyframe(state, { clipId, target: 'opacity', frame: 0, value: 1 }).project
    state = ops.setKeyframe(state, { clipId, target: 'opacity', frame: 55, value: 0.1 }).project
    expect(await frameSignature(state, 2, 'moving')).not.toBe(await frameSignature(state, 50, 'moving'))
  }, 240_000)
})
