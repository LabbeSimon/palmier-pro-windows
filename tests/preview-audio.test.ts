/**
 * Sound across preview slices.
 *
 * Measured before the fix, on a 441 Hz tone over three 4-second slices: a
 * click at 4.021 s and 8.053 s, and 12.085 s of sound under 12 s of picture.
 * Every AAC stream opens with an encoder delay, and slices joined by stream
 * copy stacked one per seam — ~25 ms each, so a ten-minute edit played about
 * four seconds out of sync by the end.
 *
 * A pure tone makes both defects measurable without listening: it satisfies
 * x[n+1] + x[n-1] = 2·cos(ω)·x[n] exactly, so any sample that breaks that
 * relation is a seam.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MediaAsset, Project } from '../src/core/model.js'
import * as ops from '../src/core/ops.js'
import { FFMPEG_PATH, FFPROBE_PATH } from '../src/main/media/ffmpeg.js'
import { renderPreview } from '../src/main/media/preview.js'

const exec = promisify(execFile)
const TONE = 441
const RATE = 48000

let workDir: string

async function makeSource(name: string, channels: 1 | 2, seconds: number): Promise<MediaAsset> {
  const path = join(workDir, name)
  await exec(FFMPEG_PATH, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=${TONE}:sample_rate=${RATE}:duration=${seconds}`,
    '-ac', String(channels),
    // PCM in the source, so any glitch found comes from the preview alone.
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest',
    path,
  ])
  return {
    id: crypto.randomUUID(), path, name, type: 'video',
    durationSeconds: seconds, width: 320, height: 180, fps: 30,
    hasAudio: true, sampleRate: RATE, channels, thumbnailPath: null,
  }
}

async function decodeMono(path: string): Promise<Float32Array> {
  const { stdout } = (await exec(
    FFMPEG_PATH,
    ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'],
    { encoding: 'buffer', maxBuffer: 1e9 },
  )) as unknown as { stdout: Buffer }
  const copy = Buffer.from(stdout)
  return new Float32Array(copy.buffer, copy.byteOffset, copy.length / 4)
}

/** Seconds at which the tone breaks, one entry per burst. */
function glitches(samples: Float32Array, from = 0, to = samples.length): number[] {
  const c = 2 * Math.cos((2 * Math.PI * TONE) / RATE)
  const found: number[] = []
  let last = -Infinity
  for (let n = Math.max(1, from); n < Math.min(samples.length - 1, to); n++) {
    const residual = samples[n + 1]! + samples[n - 1]! - c * samples[n]!
    if (Math.abs(residual) > 0.02) {
      if (n - last > RATE / 100) found.push(n / RATE)
      last = n
    }
  }
  return found
}

async function streamDurations(path: string): Promise<Record<string, number>> {
  const { stdout } = await exec(FFPROBE_PATH, [
    '-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'csv=p=0', path,
  ])
  const out: Record<string, number> = {}
  for (const line of stdout.trim().split('\n')) {
    const [type, duration] = line.split(',')
    out[type!] = Number(duration)
  }
  return out
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'palmier-audio-'))
}, 60_000)

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true })
})

describe('preview audio across slices', () => {
  it('has no click at a seam and no drift at the end', async () => {
    const asset = await makeSource('tone.mov', 2, 13)
    let project: Project = ops.addAssets(ops.emptyProject('A'), [asset]).project
    project = ops.addClips(project, { clips: [{ assetId: asset.id, durationFrames: 360 }] }).project

    const state = await renderPreview(project, project.timelines[0]!, join(workDir, 'c1')).promise
    const samples = await decodeMono(state.path)

    // The last few milliseconds are the tone stopping, which is not a seam.
    expect(glitches(samples, 0, 12 * RATE - 480)).toEqual([])
    const durations = await streamDurations(state.path)
    expect(Math.abs(durations.audio! - 12)).toBeLessThan(0.03)
    expect(Math.abs(durations.audio! - durations.video!)).toBeLessThan(0.05)
  }, 300_000)

  it('keeps the sound in place after a slice with nothing audible in it', async () => {
    const asset = await makeSource('short.mov', 2, 4)
    let project: Project = ops.addAssets(ops.emptyProject('B'), [asset]).project
    // Slice 0 has the tone, slice 1 is empty, slice 2 has the tone again.
    project = ops.addClips(project, {
      clips: [
        { assetId: asset.id, startFrame: 0, durationFrames: 120 },
        { assetId: asset.id, startFrame: 240, durationFrames: 120 },
      ],
    }).project

    const state = await renderPreview(project, project.timelines[0]!, join(workDir, 'c2')).promise
    const durations = await streamDurations(state.path)
    // A silent slice with no audio stream used to shift everything after it.
    expect(Math.abs(durations.audio! - 12)).toBeLessThan(0.03)

    const samples = await decodeMono(state.path)
    const rms = (from: number, to: number) => {
      let sum = 0
      for (let n = from * RATE; n < to * RATE; n++) sum += samples[n]! ** 2
      return Math.sqrt(sum / ((to - from) * RATE))
    }
    expect(rms(1, 3)).toBeGreaterThan(0.05)
    expect(rms(5, 7)).toBeLessThan(0.001)
    // The tone comes back on time, not early.
    expect(rms(8.1, 11.9)).toBeGreaterThan(0.05)
    expect(rms(7.5, 7.95)).toBeLessThan(0.001)
  }, 300_000)

  it('joins a mono source and a stereo one', async () => {
    const mono = await makeSource('mono.mov', 1, 4)
    const stereo = await makeSource('stereo.mov', 2, 4)
    let project: Project = ops.addAssets(ops.emptyProject('C'), [mono, stereo]).project
    project = ops.addClips(project, {
      clips: [
        { assetId: mono.id, startFrame: 0, durationFrames: 120 },
        { assetId: stereo.id, startFrame: 120, durationFrames: 120 },
      ],
    }).project

    const state = await renderPreview(project, project.timelines[0]!, join(workDir, 'c3')).promise
    const { stdout } = await exec(FFPROBE_PATH, [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=channels,sample_rate', '-of', 'csv=p=0', state.path,
    ])
    expect(stdout.trim()).toBe('48000,2')
    const durations = await streamDurations(state.path)
    expect(Math.abs(durations.audio! - 8)).toBeLessThan(0.03)
  }, 300_000)
})
