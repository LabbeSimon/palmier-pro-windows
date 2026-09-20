/**
 * Proxy clips.
 *
 * The rule that matters is that a proxy never reaches an export: everything
 * else is a performance detail, but shipping a 640-wide stand-in as the
 * finished film would be silent, unrecoverable quality loss.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MediaAsset, Project } from '../src/core/model.js'
import * as ops from '../src/core/ops.js'
import { buildFrameCommand, buildRenderCommand } from '../src/core/render.js'
import { FFMPEG_PATH, FFPROBE_PATH } from '../src/main/media/ffmpeg.js'
import { buildProxies, canProxy, existingProxy, PROXY_WIDTH } from '../src/main/media/proxy.js'

const exec = promisify(execFile)

let workDir: string
let asset: MediaAsset

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'palmier-proxy-'))
  const source = join(workDir, 'src.mp4')
  await exec(FFMPEG_PATH, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source,
  ])
  asset = {
    id: crypto.randomUUID(), path: source, name: 'src.mp4', type: 'video',
    durationSeconds: 2, width: 1280, height: 720, fps: 30,
    hasAudio: false, sampleRate: 0, channels: 0, thumbnailPath: null,
  }
}, 180_000)

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true })
})

function projectWith(proxyPath: string | null): { project: Project; timeline: Project['timelines'][0] } {
  let state = ops.addAssets(ops.emptyProject('P'), [{ ...asset, proxyPath }]).project
  state = ops.addClips(state, { clips: [{ assetId: asset.id, durationFrames: 30 }] }).project
  return { project: state, timeline: state.timelines[0]! }
}

describe('canProxy', () => {
  it('covers moving pictures only', () => {
    expect(canProxy(asset)).toBe(true)
    expect(canProxy({ ...asset, type: 'image' })).toBe(false)
    expect(canProxy({ ...asset, type: 'audio' })).toBe(false)
  })

  it('leaves footage that is already small enough alone', () => {
    // All-intra at the same size would be bigger on disk and no faster to seek.
    expect(canProxy({ ...asset, width: PROXY_WIDTH, height: 360 })).toBe(false)
    expect(canProxy({ ...asset, width: 320, height: 180 })).toBe(false)
  })
})

describe('render input selection', () => {
  it('reads the proxy for a preview frame', () => {
    const { project, timeline } = projectWith('C:/cache/proxy/abc.mp4')
    const command = buildFrameCommand(project, timeline, 5, 'out.png', '/tmp/side')
    expect(command.args).toContain('C:/cache/proxy/abc.mp4')
    expect(command.args).not.toContain(asset.path)
  })

  it('reads the original for an export, even when a proxy exists', () => {
    const { project, timeline } = projectWith('C:/cache/proxy/abc.mp4')
    const command = buildRenderCommand(project, timeline, { outputPath: 'out.mp4' }, '/tmp/side')
    expect(command.args).toContain(asset.path)
    expect(command.args).not.toContain('C:/cache/proxy/abc.mp4')
  })

  it('reads the original everywhere when there is no proxy', () => {
    const { project, timeline } = projectWith(null)
    const frame = buildFrameCommand(project, timeline, 5, 'out.png', '/tmp/side')
    expect(frame.args).toContain(asset.path)
  })
})

describe('setAssetProxies', () => {
  it('writes the paths in a single operation', () => {
    const { project } = projectWith(null)
    const { project: next, receipt } = ops.setAssetProxies(project, {
      proxies: [{ assetId: asset.id, proxyPath: 'C:/cache/proxy/abc.mp4' }],
    })
    expect(receipt.changed).toBe(true)
    expect(next.assets[0]!.proxyPath).toBe('C:/cache/proxy/abc.mp4')
  })

  it('clears them again so editing goes back to the originals', () => {
    const { project } = projectWith('C:/cache/proxy/abc.mp4')
    const next = ops.setAssetProxies(project, {
      proxies: [{ assetId: asset.id, proxyPath: null }],
    }).project
    expect(next.assets[0]!.proxyPath).toBeNull()
  })

  it('warns about an asset that has since been removed, rather than failing', () => {
    const { project } = projectWith(null)
    const { receipt } = ops.setAssetProxies(project, {
      proxies: [{ assetId: 'gone', proxyPath: 'C:/x.mp4' }],
    })
    expect(receipt.changed).toBe(false)
    expect(receipt.warnings.join(' ')).toMatch(/gone is no longer in the project/)
  })

  it('reports no change when the paths already match', () => {
    const { project } = projectWith('C:/cache/proxy/abc.mp4')
    expect(
      ops.setAssetProxies(project, {
        proxies: [{ assetId: asset.id, proxyPath: 'C:/cache/proxy/abc.mp4' }],
      }).receipt.changed,
    ).toBe(false)
  })
})

describe('buildProxies', () => {
  it('produces an all-intra copy at the proxy width, and reuses it next time', async () => {
    const cacheDir = join(workDir, 'cache')
    const updated = await buildProxies([asset], cacheDir).promise
    expect(updated).toHaveLength(1)

    const path = updated[0]!.proxyPath!
    expect((await stat(path)).size).toBeGreaterThan(0)

    const { stdout } = await exec(FFPROBE_PATH, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path,
    ])
    expect(stdout.trim().split(',')[0]).toBe(String(PROXY_WIDTH))

    // Every frame a keyframe: that is what makes a scrub cost one frame of work.
    const { stdout: frames } = await exec(FFPROBE_PATH, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'frame=key_frame', '-of', 'csv=p=0', '-read_intervals', '%+#20', path,
    ])
    // ffprobe's CSV leaves a trailing separator on rows that carry side data.
    const flags = frames.trim().split('\n').map((line) => line.replace(/,$/, '').trim()).filter(Boolean)
    expect(flags.length).toBeGreaterThan(5)
    expect(flags.every((flag) => flag === '1')).toBe(true)

    // A second run reuses it rather than transcoding again.
    expect(await existingProxy(asset, cacheDir)).toBe(path)
  }, 240_000)

  it('skips media that cannot benefit', async () => {
    const still = { ...asset, id: crypto.randomUUID(), type: 'image' as const }
    const small = { ...asset, id: crypto.randomUUID(), width: 320, height: 180 }
    expect(await buildProxies([still, small], join(workDir, 'cache2')).promise).toEqual([])
  }, 60_000)
})
