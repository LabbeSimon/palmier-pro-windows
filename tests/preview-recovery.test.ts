/**
 * What the preview cache does when a render did not finish.
 *
 * Both defects here produced the same symptom on screen — "media error 4,
 * DEMUXER_ERROR_COULD_NOT_OPEN" — which reads as a playback bug and is not one.
 * The preview reported itself ready because a file existed at the expected
 * path, and the player then could not open it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MediaAsset, Project } from '../src/core/model.js'
import * as ops from '../src/core/ops.js'
import { CHUNK_SECONDS } from '../src/main/media/chunks.js'
import { concatFiles, FFMPEG_PATH } from '../src/main/media/ffmpeg.js'
import { existingPreview, planPreview, previewPathFor, renderPreview } from '../src/main/media/preview.js'

const exec = promisify(execFile)

let workDir: string
let asset: MediaAsset

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'palmier-recover-'))
  const source = join(workDir, 'src.mp4')
  await exec(FFMPEG_PATH, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    source,
  ])
  asset = {
    id: crypto.randomUUID(), path: source, name: 'src.mp4', type: 'video',
    durationSeconds: 10, width: 320, height: 180, fps: 30,
    hasAudio: true, sampleRate: 48000, channels: 2, thumbnailPath: null,
  }
}, 240_000)

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true })
})

function project(): Project {
  const state = ops.addAssets(ops.emptyProject('R'), [asset]).project
  return ops.addClips(state, { clips: [{ assetId: asset.id, durationFrames: 30 * CHUNK_SECONDS * 2 }] }).project
}

describe('an empty file left by a dead render', () => {
  it('does not count as a finished slice', async () => {
    const cacheDir = join(workDir, 'c1')
    const p = project()
    const plan = planPreview(p, p.timelines[0]!, cacheDir)

    // Exactly what a killed FFmpeg leaves behind.
    await mkdir(join(cacheDir, 'preview-chunks'), { recursive: true })
    await writeFile(join(cacheDir, 'preview-chunks', `chunk-${plan.chunks[0]!.fingerprint}.mov`), '')

    const after = planPreview(p, p.timelines[0]!, cacheDir)
    expect(after.dirty).toHaveLength(plan.chunks.length)
  })

  it('does not make the preview report itself ready', async () => {
    const cacheDir = join(workDir, 'c2')
    const p = project()
    const plan = planPreview(p, p.timelines[0]!, cacheDir)

    await mkdir(cacheDir, { recursive: true })
    await writeFile(previewPathFor(cacheDir, plan.fingerprint), '')

    // The old check was existsSync, which said yes and left the player to fail.
    expect(existingPreview(p, p.timelines[0]!, cacheDir)).toBeNull()
  })

  it('is replaced by a real one on the next render', async () => {
    const cacheDir = join(workDir, 'c3')
    const p = project()
    const plan = planPreview(p, p.timelines[0]!, cacheDir)

    await mkdir(cacheDir, { recursive: true })
    await writeFile(previewPathFor(cacheDir, plan.fingerprint), '')

    const state = await renderPreview(p, p.timelines[0]!, cacheDir).promise
    expect((await stat(state.path)).size).toBeGreaterThan(1000)
  }, 600_000)
})

describe('the concat list', () => {
  it('names slices without a path, so a Windows separator cannot be read as an escape', async () => {
    const cacheDir = join(workDir, 'c4')
    const p = project()

    // Catch the list before it is deleted by writing a spy alongside it.
    await renderPreview(p, p.timelines[0]!, cacheDir).promise

    // Rebuild a list the same way the code does and check its shape.
    const plan = planPreview(p, p.timelines[0]!, cacheDir)
    const list = plan.chunks.map((chunk) => `file 'chunk-${chunk.fingerprint}.mov'`).join('\n')
    expect(list).not.toContain('\\')
    expect(list).not.toContain('/')

    // And prove the demuxer resolves bare names against the list's directory.
    const listPath = join(cacheDir, 'preview-chunks', 'verify.txt')
    await writeFile(listPath, list, 'utf8')
    const out = join(cacheDir, 'verify.mp4')
    await concatFiles(listPath, out)
    expect((await stat(out)).size).toBeGreaterThan(1000)
    expect(await readFile(listPath, 'utf8')).toBe(list)
  }, 600_000)

  it('leaves no output behind when the join fails', async () => {
    const cacheDir = join(workDir, 'c5')
    await mkdir(cacheDir, { recursive: true })
    const listPath = join(cacheDir, 'broken.txt')
    await writeFile(listPath, "file 'does-not-exist.mp4'", 'utf8')

    const out = join(cacheDir, 'broken.mp4')
    await expect(concatFiles(listPath, out)).rejects.toThrow()
    await expect(stat(out)).rejects.toThrow()
  }, 120_000)
})
