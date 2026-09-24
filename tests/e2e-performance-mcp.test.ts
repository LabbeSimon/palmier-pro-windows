/**
 * Performance, preview and cache over MCP, end to end.
 *
 * Drives the real JSON-RPC server and the real FFmpeg. The preview claim is
 * checked on disk, not taken from the tool's word: a second render after an
 * edit must encode fewer slices than the first, and the file must play.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FFMPEG_PATH, FFPROBE_PATH } from '../src/main/media/ffmpeg.js'
import { MCPServer } from '../src/main/mcp/server.js'
import { ProjectStore } from '../src/main/project/store.js'
import { getPerformance, resetPerformance } from '../src/main/media/performance.js'

const exec = promisify(execFile)
const PORT = 19894
const ENDPOINT = `http://127.0.0.1:${PORT}/mcp`

let server: MCPServer
let store: ProjectStore
let workDir: string
let sourcePath: string
let requestId = 0

async function rpc(method: string, params?: Record<string, unknown>): Promise<any> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
  })
  return await response.json()
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const body = await rpc('tools/call', { name, arguments: args })
  if (body.result?.isError) throw new Error(`${name} failed: ${body.result.content?.[0]?.text}`)
  return body.result.structuredContent
}

async function toolError(name: string, args: Record<string, unknown>): Promise<string> {
  const body = await rpc('tools/call', { name, arguments: args })
  expect(body.result?.isError).toBe(true)
  return body.result.content[0].text as string
}

beforeAll(async () => {
  resetPerformance()
  workDir = await mkdtemp(join(tmpdir(), 'palmier-perf-'))
  sourcePath = join(workDir, 'source.mp4')
  await exec(FFMPEG_PATH, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    sourcePath,
  ])
  store = new ProjectStore()
  // A project folder of its own, so the cache under test is not the shared
  // temporary one other suites write to.
  store.markSaved(join(workDir, 'project'))
  server = new MCPServer({ store, defaultExportDir: workDir }, PORT)
  await server.start()
}, 120_000)

afterAll(async () => {
  await server?.stop()
  resetPerformance()
  await rm(workDir, { recursive: true, force: true })
})

describe('performance settings over MCP', () => {
  it('reports the settings, the machine and the cache', async () => {
    const result = await callTool('get_performance')
    expect(result.settings.previewHeight).toBe(540)
    expect(result.machine.logicalCores).toBeGreaterThan(0)
    expect(result.machine.encoder.name).toBeTruthy()
    expect(typeof result.machine.hardwareDecodeAvailable).toBe('boolean')
    expect(result.cache.categories.preview).toBeDefined()
  })

  it('names every bad value in one refusal', async () => {
    const message = await toolError('set_performance', { preview_height: 480, parallel_jobs: 0 })
    expect(message).toContain('previewHeight')
    expect(message).toContain('parallelJobs')
    // Nothing was half-applied.
    expect(getPerformance().previewHeight).toBe(540)
  })

  it('applies a valid change', async () => {
    const result = await callTool('set_performance', { preview_height: 360, parallel_jobs: 2 })
    expect(result.settings.previewHeight).toBe(360)
    expect(result.settings.parallelJobs).toBe(2)
    expect(getPerformance().previewHeight).toBe(360)
  })

  it('refuses hardware decoding where it does not work, with the reason', async () => {
    const available = (await callTool('get_performance')).machine.hardwareDecodeAvailable
    if (available) return // Nothing to refuse on a machine where it works.
    const message = await toolError('set_performance', { hardware_decode: true })
    expect(message).toMatch(/no hardware decoder works/)
  })
})

describe('preview over MCP', () => {
  it('builds the preview, then re-encodes only what an edit touched', async () => {
    const imported = await callTool('import_media', { paths: [sourcePath] })
    await callTool('add_clips', {
      clips: [{ asset_id: imported.assets[0].id, duration_frames: 360 }],
    })

    const first = await callTool('render_preview')
    expect(first.encodedSlices).toBe(3)
    expect(first.reusedSlices).toBe(0)
    // Rendered at the height set above, not the default.
    expect(first.size).toBe('640x360')

    const { stdout } = await exec(FFPROBE_PATH, [
      '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', first.path,
    ])
    expect(stdout).toContain('video')
    expect(stdout).toContain('audio')

    const again = await callTool('render_preview')
    expect(again.encodedSlices).toBe(0)

    // A title on its own track, over the last slice only.
    await callTool('add_track', { type: 'video' })
    await callTool('add_texts', { texts: [{ content: 'Fin', start_frame: 250, duration_frames: 60 }] })
    const edited = await callTool('render_preview')
    expect(edited.encodedSlices).toBe(1)
    expect(edited.reusedSlices).toBe(2)
  }, 300_000)

  it('reports the cache and clears previews on request', async () => {
    const before = await callTool('get_cache')
    expect(before.categories.preview.files).toBeGreaterThan(0)

    const cleared = await callTool('clear_cache', { categories: ['preview'] })
    expect(cleared.freedBytes).toBeGreaterThan(0)
    expect(cleared.cache.categories.preview.files).toBe(0)
    const left = await readdir(join(workDir, 'project', 'cache', 'preview-chunks')).catch(() => [])
    expect(left).toHaveLength(0)
  }, 60_000)

  it('refuses an unknown cache kind by name', async () => {
    const message = await toolError('clear_cache', { categories: ['everything'] })
    expect(message).toContain('everything')
  })
})

describe('export over MCP', () => {
  it('says which encoder did the work and how fast', async () => {
    const result = await callTool('export_project', {
      output_path: join(workDir, 'out.mp4'),
      quality: 'draft',
    })
    expect(result.encoder).toBeTruthy()
    expect(result.realtimeFactor).toBeGreaterThan(0)
    const { stdout } = await exec(FFPROBE_PATH, [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=sample_rate,channels', '-of', 'csv=p=0', result.outputPath,
    ])
    expect(stdout.trim()).toBe('48000,2')
  }, 300_000)
})
