/**
 * The performance layer: settings, cache ceiling, frame cache, slice keys,
 * parallel encodes and proxies that survive a crash.
 *
 * Each block pins a behaviour that was wrong or missing before, and says so.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MediaAsset, Project } from '../src/core/model.js'
import * as ops from '../src/core/ops.js'
import { buildRenderCommand } from '../src/core/render.js'
import { cacheUsage, clearCache, enforceCacheLimit } from '../src/main/media/cache.js'
import { forgetFileStamps, planChunks } from '../src/main/media/chunks.js'
import { FFMPEG_PATH, partialPath } from '../src/main/media/ffmpeg.js'
import { timelineFrame, timelineFramePath } from '../src/main/media/frames.js'
import {
  defaultPerformance,
  getPerformance,
  loadPerformance,
  resetPerformance,
  setPerformance,
  validatePerformance,
} from '../src/main/media/performance.js'
import { runPool } from '../src/main/media/pool.js'
import { DEFAULT_SETUP, planPreview, profileKey, renderPreview } from '../src/main/media/preview.js'
import { buildProxies, existingProxy, proxyArgs, proxyPathFor } from '../src/main/media/proxy.js'
import { SOFTWARE } from '../src/main/media/encoders.js'

const exec = promisify(execFile)

let workDir: string
let asset: MediaAsset

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'palmier-perf-unit-'))
  const source = join(workDir, 'src.mp4')
  await exec(FFMPEG_PATH, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    source,
  ])
  asset = {
    id: crypto.randomUUID(), path: source, name: 'src.mp4', type: 'video',
    durationSeconds: 12, width: 1280, height: 720, fps: 30,
    hasAudio: true, sampleRate: 48000, channels: 2, thumbnailPath: null,
  }
}, 120_000)

afterAll(async () => {
  resetPerformance()
  await rm(workDir, { recursive: true, force: true })
})

afterEach(() => resetPerformance())

function project(frames = 360): Project {
  const state = ops.addAssets(ops.emptyProject('P'), [asset]).project
  return ops.addClips(state, { clips: [{ assetId: asset.id, durationFrames: frames }] }).project
}

describe('performance settings', () => {
  it('names every invalid value at once', () => {
    expect(() =>
      validatePerformance({ previewHeight: 480 as never, parallelJobs: 99, cacheLimitGB: -1, autoPreview: 'yes' as never }),
    ).toThrow(/previewHeight.*parallelJobs.*cacheLimitGB.*autoPreview/)
  })

  it('refuses a setting it does not know', () => {
    expect(() => validatePerformance({ turbo: true } as never)).toThrow(/unknown setting "turbo"/)
  })

  it('persists, and keeps the good values from a file with a bad one', async () => {
    const file = join(workDir, 'settings', 'performance.json')
    await loadPerformance(file)
    await setPerformance({ previewHeight: 720, autoPreview: true })
    expect(JSON.parse(await readFile(file, 'utf8')).previewHeight).toBe(720)

    // Hand-edited: one value no longer valid.
    await writeFile(file, JSON.stringify({ previewHeight: 720, parallelJobs: 0 }), 'utf8')
    const loaded = await loadPerformance(file)
    expect(loaded.previewHeight).toBe(720)
    expect(loaded.parallelJobs).toBe(defaultPerformance().parallelJobs)
    // No temporary file left beside it.
    expect(await readdir(join(workDir, 'settings'))).toEqual(['performance.json'])
  })
})

describe('slice keys', () => {
  it('change when the source file is replaced under the same name', async () => {
    const copy = join(workDir, 'replaced.mp4')
    await writeFile(copy, await readFile(asset.path))
    const replaced = { ...asset, id: crypto.randomUUID(), path: copy }
    let p = ops.addAssets(ops.emptyProject('R'), [replaced]).project
    p = ops.addClips(p, { clips: [{ assetId: replaced.id, durationFrames: 120 }] }).project

    forgetFileStamps()
    const before = planChunks(p, p.timelines[0]!, 0, 120)[0]!.fingerprint
    // Same path, same duration, different bytes — a re-export over the old file.
    await writeFile(copy, Buffer.concat([await readFile(copy), Buffer.from('x')]))
    forgetFileStamps()
    const after = planChunks(p, p.timelines[0]!, 0, 120)[0]!.fingerprint
    expect(after).not.toBe(before)
  })

  it('differ between encoders and preview sizes, so they are never joined', () => {
    const p = project(120)
    const t = p.timelines[0]!
    const cpu = profileKey(DEFAULT_SETUP)
    const gpu = profileKey({ ...DEFAULT_SETUP, encoder: { ...SOFTWARE, name: 'h264_nvenc', hardware: true } })
    const small = profileKey({ ...DEFAULT_SETUP, height: 360 })
    const keys = [cpu, gpu, small].map((profile) => planChunks(p, t, 0, 120, profile)[0]!.fingerprint)
    expect(new Set(keys).size).toBe(3)
  })

  it('ignore settings that do not change the picture', () => {
    expect(profileKey({ ...DEFAULT_SETUP, jobs: 3, background: true, hardwareDecode: true })).toBe(
      profileKey(DEFAULT_SETUP),
    )
  })
})

describe('the render graph', () => {
  it('writes PCM and always carries sound when asked, for slices', () => {
    let p = ops.emptyProject('S')
    p = ops.addTexts(p, { texts: [{ content: 'x', startFrame: 0, durationFrames: 30 }] }).project
    const command = buildRenderCommand(p, p.timelines[0]!, { outputPath: 'o.mov', audioCodec: 'pcm', alwaysAudio: true }, 'side')
    const graph = command.args[command.args.indexOf('-filter_complex') + 1]!
    expect(graph).toContain('anullsrc=r=48000:cl=stereo')
    expect(command.args).toContain('pcm_s16le')
    expect(command.args).not.toContain('+faststart')
  })

  it('fixes the audio layout and uses a delay in samples', () => {
    const p = ops.addAssets(ops.emptyProject('L'), [asset]).project
    const placed = ops.addClips(p, { clips: [{ assetId: asset.id, startFrame: 45, durationFrames: 30 }] }).project
    const command = buildRenderCommand(placed, placed.timelines[0]!, { outputPath: 'o.mp4' }, 'side')
    const graph = command.args[command.args.indexOf('-filter_complex') + 1]!
    expect(graph).toContain('aformat=sample_rates=48000:channel_layouts=stereo')
    expect(graph).toContain('adelay=72000S') // 45 frames at 30 fps = 1.5 s
    expect(graph).toContain('alimiter=limit=0.98:level=0:latency=1')
    expect(graph).toMatch(/apad=whole_dur=/)
    expect(command.args[command.args.indexOf('-ar') + 1]).toBe('48000')
  })

  it('asks for GPU decoding only when told to', () => {
    const p = project(30)
    const off = buildRenderCommand(p, p.timelines[0]!, { outputPath: 'o.mp4' }, 'side')
    const on = buildRenderCommand(p, p.timelines[0]!, { outputPath: 'o.mp4', hardwareDecode: true }, 'side')
    expect(off.args).not.toContain('-hwaccel')
    expect(on.args[on.args.indexOf('-hwaccel') + 1]).toBe('auto')
  })
})

describe('runPool', () => {
  it('never runs more than the given number at once', async () => {
    let running = 0
    let peak = 0
    await runPool([1, 2, 3, 4, 5, 6], 2, async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 20))
      running--
    })
    expect(peak).toBe(2)
  })

  it('stops starting work after a failure and reports it', async () => {
    const started: number[] = []
    await expect(
      runPool([1, 2, 3, 4, 5], 1, async (item) => {
        started.push(item)
        if (item === 2) throw new Error('slice 2 failed')
      }),
    ).rejects.toThrow('slice 2 failed')
    expect(started).toEqual([1, 2])
  })
})

describe('parallel preview', () => {
  it('encodes slices side by side and stitches the same timeline', async () => {
    const cacheDir = join(workDir, 'parallel')
    const p = project(360)
    const setup = { ...DEFAULT_SETUP, jobs: 3 }
    const state = await renderPreview(p, p.timelines[0]!, cacheDir, undefined, setup).promise
    expect(state.encoded).toBe(3)
    expect(state.totalFrames).toBe(360)
    expect(planPreview(p, p.timelines[0]!, cacheDir, setup).dirty).toHaveLength(0)
    // No partial file survives a clean render.
    const names = await readdir(join(cacheDir, 'preview-chunks'))
    expect(names.filter((name) => name.includes('.part-'))).toEqual([])
  }, 300_000)

  it('leaves no partial file behind when cancelled', async () => {
    const cacheDir = join(workDir, 'cancelled')
    const p = project(360)
    const job = renderPreview(p, p.timelines[0]!, cacheDir, undefined, { ...DEFAULT_SETUP, jobs: 2 })
    setTimeout(() => job.cancel(), 150)
    await expect(job.promise).rejects.toThrow()
    const names = await readdir(join(cacheDir, 'preview-chunks')).catch(() => [])
    expect(names.filter((name) => name.includes('.part-'))).toEqual([])
  }, 300_000)
})

describe('the cache', () => {
  async function fill(cacheDir: string): Promise<void> {
    await mkdir(join(cacheDir, 'preview-chunks'), { recursive: true })
    await mkdir(join(cacheDir, 'frames'), { recursive: true })
    await mkdir(join(cacheDir, 'proxy'), { recursive: true })
    const at = (path: string, content: string, secondsAgo: number) =>
      writeFile(path, content).then(() => utimes(path, new Date(Date.now() - secondsAgo * 1000), new Date(Date.now() - secondsAgo * 1000)))
    await at(join(cacheDir, 'preview-chunks', 'chunk-old.mov'), 'a'.repeat(1000), 300)
    await at(join(cacheDir, 'preview-chunks', 'chunk-new.mov'), 'b'.repeat(1000), 10)
    await at(join(cacheDir, 'frames', 'frame-x.jpg'), 'c'.repeat(1000), 200)
    await at(join(cacheDir, 'proxy', 'p.mp4'), 'd'.repeat(5000), 999)
    await at(join(cacheDir, 'asset.jpg'), 'e'.repeat(100), 999)
    await at(join(cacheDir, 'project-notes.txt'), 'untouched', 999)
  }

  it('reports usage per kind and ignores files it does not own', async () => {
    const cacheDir = join(workDir, 'usage')
    await fill(cacheDir)
    const usage = await cacheUsage(cacheDir)
    expect(usage.categories.preview).toEqual({ files: 2, bytes: 2000 })
    expect(usage.categories.frames).toEqual({ files: 1, bytes: 1000 })
    expect(usage.categories.proxies).toEqual({ files: 1, bytes: 5000 })
    expect(usage.categories.thumbnails).toEqual({ files: 1, bytes: 100 })
  })

  it('evicts least recently used first, never proxies, never what is kept', async () => {
    const cacheDir = join(workDir, 'evict')
    await fill(cacheDir)
    const keep = new Set([join(cacheDir, 'preview-chunks', 'chunk-old.mov')])
    // 8100 bytes in all; a 6500 ceiling needs 1600 gone.
    await enforceCacheLimit(cacheDir, 6500, keep)
    const left = await cacheUsage(cacheDir)
    expect(left.categories.proxies.files).toBe(1)
    // The oldest evictable file is the kept one; the frame goes, then the new slice.
    await expect(stat(join(cacheDir, 'preview-chunks', 'chunk-old.mov'))).resolves.toBeTruthy()
    await expect(stat(join(cacheDir, 'frames', 'frame-x.jpg'))).rejects.toThrow()
    await expect(stat(join(cacheDir, 'preview-chunks', 'chunk-new.mov'))).rejects.toThrow()
  })

  it('sweeps partial files from a process that died', async () => {
    const cacheDir = join(workDir, 'sweep')
    await mkdir(join(cacheDir, 'preview-chunks'), { recursive: true })
    const stale = partialPath(join(cacheDir, 'preview-chunks', 'chunk-a.mov'))
    const fresh = partialPath(join(cacheDir, 'preview-chunks', 'chunk-b.mov'))
    await writeFile(stale, 'x')
    await writeFile(fresh, 'x')
    const hourAgo = new Date(Date.now() - 3600_000)
    await utimes(stale, hourAgo, hourAgo)
    await enforceCacheLimit(cacheDir, 1e12)
    await expect(stat(stale)).rejects.toThrow()
    // One that may still be written by a live render is left alone.
    await expect(stat(fresh)).resolves.toBeTruthy()
  })

  it('clears only the kinds asked for, and leaves foreign files', async () => {
    const cacheDir = join(workDir, 'clear')
    await fill(cacheDir)
    const freed = await clearCache(cacheDir, ['preview', 'frames'])
    expect(freed).toEqual({ files: 3, bytes: 3000 })
    await expect(stat(join(cacheDir, 'proxy', 'p.mp4'))).resolves.toBeTruthy()
    await expect(stat(join(cacheDir, 'project-notes.txt'))).resolves.toBeTruthy()
  })
})

describe('the monitor frame cache', () => {
  it('renders a frame once, and again only after an edit that touches it', async () => {
    const cacheDir = join(workDir, 'frames')
    const p = project(90)
    const t = p.timelines[0]!

    const first = await timelineFrame(p, t, 10, cacheDir)
    expect(first.hit).toBe(false)
    const started = Date.now()
    const second = await timelineFrame(p, t, 10, cacheDir)
    expect(second.hit).toBe(true)
    expect(second.path).toBe(first.path)
    expect(Date.now() - started).toBeLessThan(50)

    // An edit elsewhere on the timeline leaves this frame's key alone…
    const marked = ops.addMarkers(p, { markers: [{ startFrame: 80, name: 'm' }] }).project
    expect(timelineFramePath(marked, marked.timelines[0]!, 10, cacheDir)).toBe(first.path)
    // …and one that changes it gives it a new key.
    const clipId = t.tracks[0]!.clips[0]!.id
    const faded = ops.setClipProperties(p, { clipIds: [clipId], properties: { opacity: 0.5 } }).project
    expect(timelineFramePath(faded, faded.timelines[0]!, 10, cacheDir)).not.toBe(first.path)
  }, 120_000)

  it('drops a render when asked to, without leaving a file', async () => {
    const cacheDir = join(workDir, 'frames-abort')
    const p = project(90)
    const controller = new AbortController()
    const pending = timelineFrame(p, p.timelines[0]!, 20, cacheDir, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
    const names = await readdir(join(cacheDir, 'frames')).catch(() => [])
    expect(names).toEqual([])
  }, 60_000)
})

describe('proxies', () => {
  it('does not take an empty file for a finished proxy', async () => {
    const cacheDir = join(workDir, 'proxy-empty')
    const path = await proxyPathFor(asset, cacheDir)
    await mkdir(join(cacheDir, 'proxy'), { recursive: true })
    await writeFile(path, '')
    // existsSync said yes here, and the editor then cut on nothing.
    expect(await existingProxy(asset, cacheDir)).toBeNull()
  })

  it('builds several at once and leaves no partial file', async () => {
    const cacheDir = join(workDir, 'proxy-parallel')
    const copies: MediaAsset[] = []
    for (const name of ['a.mp4', 'b.mp4', 'c.mp4']) {
      const path = join(workDir, name)
      await writeFile(path, await readFile(asset.path))
      copies.push({ ...asset, id: crypto.randomUUID(), path, name })
    }
    const updated = await buildProxies(copies, cacheDir, undefined, { jobs: 3, background: true }).promise
    // Same order as asked, whatever order the lanes finished in.
    expect(updated.map((u) => u.id)).toEqual(copies.map((c) => c.id))
    const names = await readdir(join(cacheDir, 'proxy'))
    expect(names).toHaveLength(3)
    expect(names.filter((name) => name.includes('.part-'))).toEqual([])
  }, 300_000)

  it('encodes for fast decoding', () => {
    expect(proxyArgs(asset, 'out.mp4').join(' ')).toContain('-tune fastdecode')
  })
})

describe('defaults', () => {
  it('start on the safe side: idle preview off, low priority on', () => {
    const settings = getPerformance()
    expect(settings.autoPreview).toBe(false)
    expect(settings.lowPriority).toBe(true)
    expect(settings.hardwareDecode).toBe(false)
    expect(settings.parallelJobs).toBeGreaterThanOrEqual(1)
  })
})
