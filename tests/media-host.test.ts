/**
 * The idle preview and who wins when two callers want a render.
 *
 * Off by default; when on, it must start after a pause, give way to anything
 * a person or an agent asks for, and never throw away a finished slice.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MediaAsset } from '../src/core/model.js'
import * as ops from '../src/core/ops.js'
import { FFMPEG_PATH } from '../src/main/media/ffmpeg.js'
import { AUTO_PREVIEW_DELAY_MS, MediaHost } from '../src/main/media/host.js'
import { resetPerformance, setPerformance } from '../src/main/media/performance.js'
import { ProjectStore } from '../src/main/project/store.js'

const exec = promisify(execFile)

let workDir: string
let asset: MediaAsset

beforeAll(async () => {
  resetPerformance()
  workDir = await mkdtemp(join(tmpdir(), 'palmier-host-'))
  const source = join(workDir, 'src.mp4')
  await exec(FFMPEG_PATH, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    source,
  ])
  asset = {
    id: crypto.randomUUID(), path: source, name: 'src.mp4', type: 'video',
    durationSeconds: 12, width: 640, height: 360, fps: 30,
    hasAudio: true, sampleRate: 48000, channels: 2, thumbnailPath: null,
  }
}, 120_000)

afterAll(async () => {
  resetPerformance()
  await rm(workDir, { recursive: true, force: true })
})

function setup(name: string): { store: ProjectStore; host: MediaHost } {
  const store = new ProjectStore()
  store.markSaved(join(workDir, name))
  const host = new MediaHost()
  host.attach(store)
  return { store, host }
}

const once = (host: MediaHost, event: string) => new Promise<void>((resolve) => host.once(event, () => resolve()))

describe('the idle preview', () => {
  it('does nothing while the setting is off', async () => {
    resetPerformance()
    const { store, host } = setup('off')
    store.apply((p) => ops.addAssets(p, [asset]))
    store.apply((p) => ops.addClips(p, { clips: [{ assetId: asset.id, durationFrames: 240 }] }))
    await new Promise((resolve) => setTimeout(resolve, AUTO_PREVIEW_DELAY_MS + 500))
    expect(host.previewRunning).toBe(false)
    const project = store.project
    expect((await host.previewState(project, project.timelines[0]!)).ready).toBe(false)
  }, 30_000)

  it('builds the preview by itself after a pause in editing', async () => {
    await setPerformance({ autoPreview: true })
    const { store, host } = setup('on')
    store.apply((p) => ops.addAssets(p, [asset]))
    const done = once(host, 'preview:done')
    store.apply((p) => ops.addClips(p, { clips: [{ assetId: asset.id, durationFrames: 240 }] }))
    await done
    const project = store.project
    expect((await host.previewState(project, project.timelines[0]!)).ready).toBe(true)
    resetPerformance()
  }, 60_000)

  it('gives way to a render someone asked for, reusing what it finished', async () => {
    await setPerformance({ autoPreview: true, parallelJobs: 1 })
    const { store, host } = setup('takeover')
    store.apply((p) => ops.addAssets(p, [asset]))
    const started = new Promise<void>((resolve) => host.once('preview:progress', () => resolve()))
    store.apply((p) => ops.addClips(p, { clips: [{ assetId: asset.id, durationFrames: 360 }] }))
    await started
    expect(host.previewRunning).toBe(true)

    // A person presses play: the background render yields instead of refusing.
    const project = store.project
    const state = await host.renderPreview(project, project.timelines[0]!)
    expect(state.encoded + state.reused).toBe(3)
    expect((await host.previewState(project, project.timelines[0]!)).ready).toBe(true)
    resetPerformance()
  }, 60_000)

  it('refuses a second render someone asked for, instead of running two', async () => {
    const { store, host } = setup('twice')
    store.apply((p) => ops.addAssets(p, [asset]))
    store.apply((p) => ops.addClips(p, { clips: [{ assetId: asset.id, durationFrames: 360 }] }))
    const project = store.project
    const first = host.renderPreview(project, project.timelines[0]!)
    await expect(host.renderPreview(project, project.timelines[0]!)).rejects.toThrow(/already running/)
    await first
  }, 60_000)
})
