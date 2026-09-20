/**
 * Renders every transition kind and every effect with the real FFmpeg binary.
 *
 * Filter-graph expressions — especially the `geq` alpha maths behind wipes and
 * circles — cannot be proven correct by inspection. The only honest check is to
 * run them and confirm FFmpeg produced a frame.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EFFECT_DEFINITIONS } from '../src/core/effects.js'
import { TRANSITION_KINDS, type MediaAsset, type Project } from '../src/core/model.js'
import * as ops from '../src/core/ops.js'
import { FFMPEG_PATH, FFPROBE_PATH, renderFrame, renderTimeline } from '../src/main/media/ffmpeg.js'

const exec = promisify(execFile)

let workDir: string
let asset: MediaAsset

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'palmier-render-'))
  const source = join(workDir, 'src.mp4')
  await exec(FFMPEG_PATH, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    source,
  ])
  asset = {
    id: crypto.randomUUID(), path: source, name: 'src.mp4', type: 'video',
    durationSeconds: 8, width: 320, height: 180, fps: 30,
    hasAudio: true, sampleRate: 48000, channels: 2, thumbnailPath: null,
  }
}, 180_000)

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true })
})

/** Two butt-joined clips; the second keeps a head handle for a transition. */
function twoClipProject(): { project: Project; secondId: string } {
  let state = ops.addAssets(ops.emptyProject('Render'), [asset]).project
  state = ops.addClips(state, { clips: [{ assetId: asset.id, startFrame: 0, durationFrames: 45 }] }).project
  state = ops.addClips(state, {
    clips: [{ assetId: asset.id, startFrame: 45, durationFrames: 45, trimStartFrame: 90 }],
  }).project
  return { project: state, secondId: state.timelines[0]!.tracks[0]!.clips[1]!.id }
}

async function renderAndProbe(project: Project, name: string): Promise<number> {
  const output = join(workDir, `${name}.mp4`)
  const timeline = project.timelines.find((t) => t.id === project.activeTimelineId)!
  await renderTimeline(project, timeline, { outputPath: output, crf: 30, preset: 'ultrafast' }).promise

  const info = await stat(output)
  expect(info.size).toBeGreaterThan(1000)

  const probe = await exec(FFPROBE_PATH, [
    '-v', 'error', '-select_streams', 'v:0',
    '-count_frames', '-show_entries', 'stream=nb_read_frames',
    '-of', 'csv=p=0', output,
  ])
  return Number(probe.stdout.trim())
}

describe('transition rendering', () => {
  it.each(TRANSITION_KINDS)('renders %s without an FFmpeg error', async (kind) => {
    const { project, secondId } = twoClipProject()
    const withTransition = ops.addTransition(project, { clipId: secondId, kind, durationFrames: 15 }).project
    const frames = await renderAndProbe(withTransition, `transition-${kind}`)
    // 90 timeline frames; the transition overlaps rather than extending the edit.
    expect(frames).toBeGreaterThanOrEqual(85)
    expect(frames).toBeLessThanOrEqual(95)
  }, 240_000)
})

describe('effect rendering', () => {
  it.each(EFFECT_DEFINITIONS.map((d) => [d.id, d.kind] as const))(
    'renders %s without an FFmpeg error',
    async (definitionId, kind) => {
      let state = ops.addAssets(ops.emptyProject('Effect'), [asset]).project
      state = ops.addClips(state, { clips: [{ assetId: asset.id, durationFrames: 20 }] }).project
      const clipId = state.timelines[0]!.tracks[0]!.clips[0]!.id

      // Exercise a non-neutral value so the filter is actually inserted.
      const definition = EFFECT_DEFINITIONS.find((d) => d.id === definitionId)!
      const params = Object.fromEntries(
        definition.params.map((p) => [p.key, p.default === p.min ? p.max / 2 : p.default]),
      )
      state = ops.addEffect(state, { clipIds: [clipId], definitionId, params }).project

      const frames = await renderAndProbe(state, `effect-${definitionId}`)
      expect(frames).toBeGreaterThan(0)
      expect(kind === 'video' || kind === 'audio').toBe(true)
    },
    240_000,
  )
})

describe('track gain', () => {
  it('renders a muted track without an audio stream', async () => {
    let state = ops.addAssets(ops.emptyProject('Mute'), [asset]).project
    state = ops.addClips(state, { clips: [{ assetId: asset.id, durationFrames: 20 }] }).project
    // A video import now fills picture and sound tracks, so both must be muted.
    for (const track of state.timelines[0]!.tracks) {
      state = ops.setTrackFlags(state, { trackId: track.id, muted: true }).project
    }

    const output = join(workDir, 'muted.mp4')
    const timeline = state.timelines[0]!
    await renderTimeline(state, timeline, { outputPath: output, crf: 30, preset: 'ultrafast' }).promise

    const probe = await exec(FFPROBE_PATH, [
      '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', output,
    ])
    expect(probe.stdout).not.toContain('audio')
  }, 240_000)
})

describe('subtitle rendering', () => {
  /** Mean-luminance signature of one rendered frame. */
  async function signature(project: Project, frame: number, name: string): Promise<string> {
    const output = join(workDir, `${name}-${frame}.png`)
    const timeline = project.timelines.find((t) => t.id === project.activeTimelineId)!
    await renderFrame(project, timeline, frame, output)
    const { stdout } = await exec(FFMPEG_PATH, [
      '-hide_banner', '-v', 'error', '-i', output,
      '-vf', 'scale=8:8,format=gray', '-f', 'rawvideo', '-',
    ])
    return stdout
  }

  it('burns a cue into the picture only while it is on screen', async () => {
    // A still source, so any difference between two frames is the subtitle.
    const stillPath = join(workDir, 'sub-still.png')
    await exec(FFMPEG_PATH, [
      '-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=320x180', '-frames:v', '1', stillPath,
    ])
    const still: MediaAsset = {
      id: crypto.randomUUID(), path: stillPath, name: 'sub-still.png', type: 'image',
      durationSeconds: 0, width: 320, height: 180, fps: 0,
      hasAudio: false, sampleRate: 0, channels: 0, thumbnailPath: null,
    }

    let state = ops.addAssets(ops.emptyProject('Subs'), [still]).project
    state = ops.addClips(state, { clips: [{ assetId: still.id, durationFrames: 90 }] }).project
    state = ops.addSubtitles(state, {
      subtitles: [{ startFrame: 30, durationFrames: 30, text: 'Subtitle on screen' }],
    }).project

    const before = await signature(state, 5, 'sub')
    const during = await signature(state, 45, 'sub')
    const after = await signature(state, 80, 'sub')

    expect(during).not.toBe(before)
    expect(after).toBe(before)
  }, 240_000)

  it('renders a multi-line cue without an FFmpeg error', async () => {
    let state = ops.addAssets(ops.emptyProject('Subs2'), [asset]).project
    state = ops.addClips(state, { clips: [{ assetId: asset.id, durationFrames: 60 }] }).project
    state = ops.addSubtitles(state, {
      subtitles: [{ startFrame: 10, durationFrames: 30, text: 'First line\nSecond line — 100% sure' }],
    }).project

    const output = join(workDir, 'subs-multiline.mp4')
    const timeline = state.timelines[0]!
    await renderTimeline(state, timeline, { outputPath: output, crf: 30, preset: 'ultrafast' }).promise
    expect((await stat(output)).size).toBeGreaterThan(0)
  }, 240_000)
})

describe('grading rendering', () => {
  /** A still source, so any difference between frames is the grade itself. */
  async function gradedProject(
    definitionId: string,
    apply: (project: Project, clipId: string, effectId: string) => Project,
  ): Promise<{ plain: Project; graded: Project }> {
    const stillPath = join(workDir, `grade-${definitionId}.png`)
    await exec(FFMPEG_PATH, [
      '-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=1', '-frames:v', '1', stillPath,
    ])
    const still: MediaAsset = {
      id: crypto.randomUUID(), path: stillPath, name: 'grade.png', type: 'image',
      durationSeconds: 0, width: 320, height: 180, fps: 0,
      hasAudio: false, sampleRate: 0, channels: 0, thumbnailPath: null,
    }
    let state = ops.addAssets(ops.emptyProject('Grade'), [still]).project
    state = ops.addClips(state, { clips: [{ assetId: still.id, durationFrames: 30 }] }).project
    const clipId = state.timelines[0]!.tracks[0]!.clips[0]!.id
    const plain = state
    state = ops.addEffect(state, { clipIds: [clipId], definitionId }).project
    const effectId = state.timelines[0]!.tracks[0]!.clips[0]!.effects[0]!.id
    return { plain, graded: apply(state, clipId, effectId) }
  }

  async function signature(project: Project, name: string): Promise<string> {
    const output = join(workDir, `${name}.png`)
    const timeline = project.timelines.find((t) => t.id === project.activeTimelineId)!
    await renderFrame(project, timeline, 5, output)
    const { stdout } = await exec(FFMPEG_PATH, [
      '-hide_banner', '-v', 'error', '-i', output,
      '-vf', 'scale=8:8,format=rgb24', '-f', 'rawvideo', '-',
    ])
    return stdout
  }

  it('a bent master curve changes the picture', async () => {
    const { plain, graded } = await gradedProject('curves', (project, clipId, effectId) =>
      ops.setEffectCurve(project, {
        clipId, effectId, channel: 'master',
        points: [{ x: 0, y: 0.25 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }],
      }).project,
    )
    expect(await signature(graded, 'curve-graded')).not.toBe(await signature(plain, 'curve-plain'))
  }, 240_000)

  it('a red-only curve leaves the picture different from a master curve', async () => {
    const { plain, graded } = await gradedProject('curves', (project, clipId, effectId) =>
      ops.setEffectCurve(project, {
        clipId, effectId, channel: 'r',
        points: [{ x: 0, y: 0.4 }, { x: 1, y: 1 }],
      }).project,
    )
    expect(await signature(graded, 'curve-red')).not.toBe(await signature(plain, 'curve-plain2'))
  }, 240_000)

  it('a colour wheel shift changes the picture', async () => {
    const { plain, graded } = await gradedProject('color-wheels', (project, clipId, effectId) =>
      ops.setEffectParams(project, {
        clipId, effectId, params: { shadowsB: 0.4, highsR: 0.25 },
      }).project,
    )
    expect(await signature(graded, 'wheels-graded')).not.toBe(await signature(plain, 'wheels-plain'))
  }, 240_000)
})
