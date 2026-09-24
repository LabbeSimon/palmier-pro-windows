/**
 * A render that stops reporting progress is stopped.
 *
 * Found while testing the audio fixes: one graph in ten looped forever at
 * 100% CPU, and the test runner's timeouts left those FFmpeg processes
 * spinning for twenty minutes after the tests had given up. A stand-in binary
 * that never writes a byte plays the stuck FFmpeg here, deterministically.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as ops from '../src/core/ops.js'

let workDir: string

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'palmier-watchdog-'))
})

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('the render watchdog', () => {
  it('kills an FFmpeg that goes silent, and says why', async () => {
    const fake = join(workDir, 'ffmpeg')
    await writeFile(fake, '#!/bin/sh\nexec sleep 30\n', 'utf8')
    await chmod(fake, 0o755)

    // Both are read when the module loads, so they are set before importing it.
    process.env.PALMIER_FFMPEG = fake
    process.env.PALMIER_RENDER_STALL_MS = '400'
    const { renderTimeline } = await import('../src/main/media/ffmpeg.js')

    let project = ops.emptyProject('W')
    project = ops.addTexts(project, { texts: [{ content: 'x', startFrame: 0, durationFrames: 30 }] }).project

    const started = Date.now()
    const handle = renderTimeline(project, project.timelines[0]!, { outputPath: join(workDir, 'out.mp4') })
    await expect(handle.promise).rejects.toThrow(/stopped making progress/)
    expect(Date.now() - started).toBeLessThan(5000)

    delete process.env.PALMIER_FFMPEG
    delete process.env.PALMIER_RENDER_STALL_MS
  }, 20_000)
})
