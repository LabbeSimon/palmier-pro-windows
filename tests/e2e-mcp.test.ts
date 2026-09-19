/**
 * End-to-end verification across the MCP boundary.
 *
 * This drives the real JSON-RPC server over HTTP, renders with the real FFmpeg
 * binary, and reads the result back with ffprobe — a success-shaped tool response
 * is never accepted as proof on its own.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FFMPEG_PATH, FFPROBE_PATH } from '../src/main/media/ffmpeg.js'
import { MCPServer } from '../src/main/mcp/server.js'
import { ProjectStore } from '../src/main/project/store.js'

const exec = promisify(execFile)

// A non-default port so a running editor cannot collide with the suite.
const PORT = 19893
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
  expect(response.status).toBe(200)
  return await response.json()
}

/** Calls a tool and fails the test if the tool reported an error. */
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const body = await rpc('tools/call', { name, arguments: args })
  const result = body.result
  if (result?.isError) throw new Error(`${name} failed: ${result.content?.[0]?.text}`)
  return result.structuredContent
}

async function expectToolError(name: string, args: Record<string, unknown>): Promise<string> {
  const body = await rpc('tools/call', { name, arguments: args })
  expect(body.result?.isError).toBe(true)
  return body.result.content[0].text as string
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'palmier-e2e-'))
  sourcePath = join(workDir, 'source.mp4')
  // 6 s of colour bars at 30 fps with a 440 Hz tone, so the render has real picture and sound.
  await exec(FFMPEG_PATH, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    sourcePath,
  ])

  store = new ProjectStore()
  server = new MCPServer({ store, defaultExportDir: workDir }, PORT)
  await server.start()
}, 120_000)

afterAll(async () => {
  await server?.stop()
  await rm(workDir, { recursive: true, force: true })
})

describe('MCP protocol', () => {
  it('handshakes and advertises its tools', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
    expect(init.result.serverInfo.name).toBe('palmier-win')
    expect(init.result.capabilities.tools).toBeDefined()

    const list = await rpc('tools/list')
    const names = list.result.tools.map((t: any) => t.name)
    expect(names).toContain('get_timeline')
    expect(names).toContain('add_clips')
    expect(names).toContain('export_project')
    for (const tool of list.result.tools) {
      expect(tool.description.length).toBeGreaterThan(40)
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  it('answers ping and rejects an unknown method', async () => {
    expect((await rpc('ping')).result).toEqual({})
    expect((await rpc('does/not/exist')).error.code).toBe(-32601)
  })

  it('serves a health endpoint', async () => {
    const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()
    expect(health.status).toBe('ok')
    expect(health.tools).toBeGreaterThan(10)
  })
})

describe('agent edits a real timeline', () => {
  let assetId: string
  let firstClipId: string

  it('imports media and reports its true duration', async () => {
    const result = await callTool('import_media', { paths: [sourcePath] })
    expect(result.changed).toBe(true)
    expect(result.assets).toHaveLength(1)
    assetId = result.assets[0].id
    expect(result.assets[0].durationSeconds).toBeGreaterThan(5.9)
    expect(result.assets[0].type).toBe('video')
  })

  it('builds a two-shot cut and reads it back', async () => {
    await callTool('add_clips', {
      clips: [
        { asset_id: assetId, start_frame: 0, duration_frames: 45 },
        { asset_id: assetId, start_frame: 45, duration_frames: 45, trim_start_frame: 90 },
      ],
    })

    // Verify independently rather than trusting the receipt.
    const timeline = (await callTool('get_timeline')).timeline
    const clips = timeline.tracks[0].clips
    expect(clips).toHaveLength(2)
    expect(clips[0].startFrame).toBe(0)
    expect(clips[1].startFrame).toBe(45)
    expect(clips[1].trimStartFrame).toBe(90)
    expect(timeline.totalFrames).toBe(90)
    firstClipId = clips[0].id
  })

  it('refuses an overlapping placement with an actionable error', async () => {
    const message = await expectToolError('add_clips', {
      clips: [{ asset_id: assetId, start_frame: 20, duration_frames: 30 }],
    })
    expect(message).toMatch(/refused/)
    expect(message).toMatch(/occupied/)

    // The refusal must not have half-applied anything.
    expect((await callTool('get_timeline')).timeline.tracks[0].clips).toHaveLength(2)
  })

  it('splits, then undoes the split', async () => {
    const split = await callTool('split_clips', { frame: 20 })
    expect(split.changed).toBe(true)
    expect((await callTool('get_timeline')).timeline.tracks[0].clips).toHaveLength(3)

    const undo = await callTool('undo')
    expect(undo.changed).toBe(true)
    expect((await callTool('get_timeline')).timeline.tracks[0].clips).toHaveLength(2)
  })

  it('reports an honest no-op instead of a fake success', async () => {
    const result = await callTool('split_clips', { frame: 5000 })
    expect(result.changed).toBe(false)
    expect(result.summary).toMatch(/No clip crosses/)
  })

  it('adds a title above the picture', async () => {
    await callTool('add_track', { type: 'video', name: 'V2' })
    const result = await callTool('add_texts', {
      texts: [{ content: "Rayor — 100% fait maison", start_frame: 10, duration_frames: 40, font_size: 48 }],
    })
    expect(result.changed).toBe(true)

    const timeline = (await callTool('get_timeline')).timeline
    const v2 = timeline.tracks.find((t: any) => t.name === 'V2')
    expect(v2.clips[0].textContent).toBe("Rayor — 100% fait maison")
  })

  it('applies a fade through set_clip_properties', async () => {
    await callTool('set_clip_properties', {
      clip_ids: [firstClipId],
      properties: { fade_in_frames: 10, opacity: 0.9 },
    })
    const clip = (await callTool('get_timeline')).timeline.tracks[0].clips[0]
    expect(clip.fadeInFrames).toBe(10)
    expect(clip.opacity).toBe(0.9)
  })

  it('captures a frame it can actually look at', async () => {
    const output = join(workDir, 'frame.png')
    const result = await callTool('capture_frame', { frame: 20, output_path: output })
    expect(result.imagePath).toBe(output)
    expect((await stat(output)).size).toBeGreaterThan(1000)

    const probe = await exec(FFPROBE_PATH, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', output,
    ])
    expect(probe.stdout.trim()).toBe('1920,1080')
  })

  it('exports a playable file whose duration matches the timeline', async () => {
    const output = join(workDir, 'export.mp4')
    const result = await callTool('export_project', { output_path: output, quality: 'draft' })
    expect(result.outputPath).toBe(output)

    const probe = await exec(FFPROBE_PATH, [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type',
      '-of', 'json', output,
    ])
    const info = JSON.parse(probe.stdout)
    // 90 frames at 30 fps.
    expect(Number(info.format.duration)).toBeGreaterThan(2.8)
    expect(Number(info.format.duration)).toBeLessThan(3.2)
    expect(info.streams.map((s: any) => s.codec_type).sort()).toEqual(['audio', 'video'])
  }, 180_000)

  it('refuses to export an empty timeline', async () => {
    await callTool('create_timeline', { name: 'Empty', activate: true })
    const message = await expectToolError('export_project', {})
    expect(message).toMatch(/nothing to export/)
  })
})
