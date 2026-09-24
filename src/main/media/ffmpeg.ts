/**
 * FFmpeg process management. Every call here runs off the UI thread by virtue of
 * being a child process; nothing in this module blocks the Electron main loop.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { constants as osConstants, setPriority, tmpdir } from 'node:os'

import { clipTypeForExtension, type MediaAsset, type Project, type Timeline } from '../../core/model.js'
import { buildFrameCommand, buildRenderCommand, type RenderOptions } from '../../core/render.js'

/**
 * Binary resolution, most specific first:
 *   1. PALMIER_FFMPEG / PALMIER_FFPROBE — an explicit operator override.
 *   2. The packaged app's extraResources (what a Windows install ships).
 *   3. resources/ffmpeg/<platform>-<arch>/ in the repo — populated by scripts/fetch-ffmpeg.mjs.
 *   4. PATH, which is how development on Linux works.
 */
function resolveBinary(name: 'ffmpeg' | 'ffprobe'): string {
  const override = process.env[`PALMIER_${name.toUpperCase()}`]
  if (override) return override

  const executable = process.platform === 'win32' ? `${name}.exe` : name
  const candidates: string[] = []

  // process.resourcesPath only exists inside a packaged Electron app.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) candidates.push(join(resourcesPath, 'ffmpeg', executable))

  /*
   * Walk up looking for the bundled binaries rather than counting directories.
   *
   * A fixed `../../..` is right for this file's place in `src/` and wrong for
   * the bundle's place in `out/`, where it landed one level above the repo and
   * silently fell through to whatever FFmpeg was on PATH. That is the worst
   * kind of fallback: it works on a developer's machine and ships a different
   * renderer than the one that was tested — the system build here draws a glyph
   * for a newline, so every multi-line subtitle gained a stray box.
   */
  const platformDir = join('resources', 'ffmpeg', `${process.platform}-${process.arch}`, executable)
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let up = 0; up < 5; up++) {
    candidates.push(join(directory, platformDir))
    directory = dirname(directory)
  }

  return candidates.find((candidate) => existsSync(candidate)) ?? name
}

export const FFMPEG_PATH = resolveBinary('ffmpeg')
export const FFPROBE_PATH = resolveBinary('ffprobe')

export class FFmpegError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message)
    this.name = 'FFmpegError'
  }
}

/**
 * Set PALMIER_LOG_FFMPEG=1 to print every command this spawns.
 *
 * A filter graph is built from a dozen places; when the picture is wrong, the
 * only question that matters is what FFmpeg was actually told, and guessing at
 * it from the source costs far more than printing it.
 */
const LOG_COMMANDS = process.env.PALMIER_LOG_FFMPEG === '1'

function logCommand(binary: string, args: string[]): void {
  if (!LOG_COMMANDS) return
  const quoted = args.map((arg) => (/[\s;'"]/.test(arg) ? JSON.stringify(arg) : arg))
  process.stderr.write(`[ffmpeg] ${binary} ${quoted.join(' ')}\n`)
}

/**
 * Drops a child below normal priority.
 *
 * A preview or a proxy is background work: the user is still editing while it
 * runs, and an encoder at normal priority takes every core the UI wanted for
 * the next scrub. Best-effort — a platform that refuses just runs it at normal.
 */
export function lowerPriority(pid: number | undefined): void {
  if (!pid) return
  try {
    setPriority(pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    // Not permitted here; normal priority is still correct, only less polite.
  }
}

/**
 * A sibling path to write into before the result is final.
 *
 * Every cache in this app decides "is it there?" by looking at the final path,
 * so nothing may ever appear at that path half-written. Writing beside it and
 * renaming is atomic on the same volume: the file is either complete or absent,
 * whatever kills the process — a crash or a power cut included, which no
 * cleanup handler can catch. The extension is kept so FFmpeg picks the same
 * container.
 */
export function partialPath(finalPath: string): string {
  const extension = extname(finalPath)
  return `${finalPath.slice(0, finalPath.length - extension.length)}.part-${randomUUID().slice(0, 8)}${extension}`
}

/** Marks files that {@link partialPath} produced, for cache cleanup. */
export const PARTIAL_MARKER = '.part-'

/** Moves a finished partial file into place. */
export async function commitPartial(partial: string, finalPath: string): Promise<void> {
  await rename(partial, finalPath)
}

function run(
  binary: string,
  args: string[],
  signal?: AbortSignal,
  options: { background?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    logCommand(binary, args)
    const child = spawn(binary, args, { windowsHide: true })
    if (options.background) lowerPriority(child.pid)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const abort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (error) => {
      signal?.removeEventListener('abort', abort)
      reject(new FFmpegError(`${basename(binary)} failed to start: ${error.message}`, stderr, null))
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) return reject(new FFmpegError('cancelled', stderr, code))
      if (code === 0) return resolve({ stdout, stderr })
      reject(new FFmpegError(`${basename(binary)} exited with ${code}`, stderr.slice(-4000), code))
    })
  })
}

interface ProbeStream {
  codec_type?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  sample_rate?: string
  channels?: number
  duration?: string
}

interface ProbeResult {
  streams?: ProbeStream[]
  format?: { duration?: string }
}

function parseRational(value: string | undefined): number {
  if (!value) return 0
  const [num, den] = value.split('/').map(Number)
  if (!num || !den) return 0
  return num / den
}

export async function probeAsset(path: string): Promise<MediaAsset> {
  const declaredType = clipTypeForExtension(extname(path))
  if (!declaredType) throw new FFmpegError(`unsupported file type: ${extname(path) || path}`, '', null)

  if (declaredType === 'subtitle') {
    return {
      id: randomUUID(), path, name: basename(path), type: 'subtitle',
      durationSeconds: 0, width: 0, height: 0, fps: 0,
      hasAudio: false, sampleRate: 0, channels: 0, thumbnailPath: null,
    }
  }

  const { stdout } = await run(FFPROBE_PATH, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    path,
  ])

  let probe: ProbeResult
  try {
    probe = JSON.parse(stdout) as ProbeResult
  } catch {
    throw new FFmpegError(`ffprobe returned unreadable JSON for ${path}`, stdout.slice(0, 2000), 0)
  }

  const streams = probe.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')
  const formatDuration = Number(probe.format?.duration ?? 0)

  // A still reports a video stream too; the extension is what distinguishes it.
  const type = declaredType === 'image' ? 'image' : video ? 'video' : 'audio'

  return {
    id: randomUUID(),
    path,
    name: basename(path),
    type,
    durationSeconds: type === 'image' ? 0 : Number.isFinite(formatDuration) ? formatDuration : 0,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: video ? parseRational(video.avg_frame_rate) || parseRational(video.r_frame_rate) : 0,
    hasAudio: Boolean(audio) && type !== 'image',
    sampleRate: Number(audio?.sample_rate ?? 0),
    channels: audio?.channels ?? 0,
    thumbnailPath: null,
  }
}

export async function generateThumbnail(asset: MediaAsset, cacheDir: string): Promise<string | null> {
  if (asset.type === 'audio' || asset.type === 'subtitle') return null
  await mkdir(cacheDir, { recursive: true })
  const output = join(cacheDir, `${asset.id}.jpg`)
  // Seek to 10% in so the poster is not a black lead-in frame.
  const seek = asset.durationSeconds > 0 ? (asset.durationSeconds * 0.1).toFixed(3) : '0'
  await run(FFMPEG_PATH, [
    '-hide_banner', '-nostdin', '-y',
    ...(asset.type === 'image' ? [] : ['-ss', seek]),
    '-i', asset.path,
    '-frames:v', '1',
    '-vf', 'scale=320:-2:flags=bilinear',
    '-q:v', '5',
    '-update', '1',
    output,
  ])
  return output
}

export interface RenderProgress {
  frame: number
  totalFrames: number
  fps: number
  speed: string
}

/**
 * How long a render may go without a progress report before it is killed.
 *
 * FFmpeg reports twice a second while it works. One that stops reporting is
 * not slow, it is stuck — a filter graph that loops at 100% CPU forever, which
 * is exactly what an unbounded `apad` in front of the limiter did one time in
 * ten. Without a watchdog that looks like a progress bar frozen at 97% and a
 * hot laptop, with nothing to tell anyone why.
 */
export const RENDER_STALL_MS = Number(process.env.PALMIER_RENDER_STALL_MS ?? 120_000)

export interface RenderHandle {
  promise: Promise<string>
  cancel: () => void
}

/** `-progress pipe:1` emits `key=value` blocks terminated by `progress=`. */
function parseProgress(block: string): Partial<RenderProgress> {
  const out: Partial<RenderProgress> = {}
  for (const line of block.split('\n')) {
    const [key, value] = line.split('=')
    if (!key || value === undefined) continue
    if (key === 'frame') out.frame = Number(value)
    if (key === 'fps') out.fps = Number(value)
    if (key === 'speed') out.speed = value.trim()
  }
  return out
}

async function writeSidecars(sidecars: { path: string; content: string }[]): Promise<void> {
  for (const sidecar of sidecars) {
    await mkdir(dirname(sidecar.path), { recursive: true })
    await writeFile(sidecar.path, sidecar.content, 'utf8')
  }
}

export function renderTimeline(
  project: Project,
  timeline: Timeline,
  options: RenderOptions,
  onProgress?: (progress: RenderProgress) => void,
  spawnOptions: { background?: boolean } = {},
): RenderHandle {
  const sidecarDir = join(tmpdir(), `palmier-render-${randomUUID()}`)
  const controller = new AbortController()
  let child: ChildProcessWithoutNullStreams | null = null

  const promise = (async () => {
    const command = buildRenderCommand(project, timeline, options, sidecarDir)
    await mkdir(sidecarDir, { recursive: true })
    await writeSidecars(command.sidecars)
    await mkdir(dirname(options.outputPath), { recursive: true })

    return await new Promise<string>((resolve, reject) => {
      logCommand(FFMPEG_PATH, command.args)
      child = spawn(FFMPEG_PATH, command.args, { windowsHide: true })
      if (spawnOptions.background) lowerPriority(child.pid)
      let stderr = ''
      let buffer = ''
      let stalled = false
      let watchdog: ReturnType<typeof setTimeout> | null = null
      const arm = () => {
        if (watchdog) clearTimeout(watchdog)
        watchdog = setTimeout(() => {
          stalled = true
          child?.kill('SIGKILL')
        }, RENDER_STALL_MS)
      }
      arm()

      child.stdout.on('data', (chunk: Buffer) => {
        arm()
        buffer += chunk.toString()
        let cut = buffer.lastIndexOf('progress=')
        if (cut < 0) return
        cut = buffer.indexOf('\n', cut)
        if (cut < 0) return
        const parsed = parseProgress(buffer.slice(0, cut))
        buffer = buffer.slice(cut + 1)
        if (parsed.frame !== undefined && onProgress) {
          onProgress({
            frame: parsed.frame,
            totalFrames: command.totalFrames,
            fps: parsed.fps ?? 0,
            speed: parsed.speed ?? '',
          })
        }
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
        if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
      })
      child.on('error', (error) => {
        if (watchdog) clearTimeout(watchdog)
        reject(new FFmpegError(`ffmpeg failed to start: ${error.message}`, stderr, null))
      })
      child.on('close', (code) => {
        if (watchdog) clearTimeout(watchdog)
        if (code === 0 && !controller.signal.aborted && !stalled) return resolve(options.outputPath)
        /*
         * Remove what was written before giving up.
         *
         * A cancelled or failed render leaves a truncated file behind, and
         * anything that caches by "does this path exist" then calls it ready.
         * The player opens it, fails, and reports a playback error for what was
         * really a render that died.
         */
        void rm(options.outputPath, { force: true }).finally(() => {
          if (controller.signal.aborted) {
            reject(new FFmpegError('render cancelled', stderr.slice(-2000), code))
          } else if (stalled) {
            reject(
              new FFmpegError(
                `ffmpeg stopped making progress for ${Math.round(RENDER_STALL_MS / 1000)} s and was stopped`,
                stderr.slice(-4000),
                code,
              ),
            )
          } else {
            reject(new FFmpegError(`ffmpeg exited with ${code}`, stderr.slice(-4000), code))
          }
        })
      })
    })
  })().finally(() => rm(sidecarDir, { recursive: true, force: true }).catch(() => {}))

  return {
    promise,
    cancel: () => {
      controller.abort()
      child?.kill('SIGKILL')
    },
  }
}

export interface ConcatOptions {
  /**
   * Encode the joined audio to AAC instead of copying it.
   *
   * Preview slices carry PCM precisely so that this step can encode the sound
   * once, continuously: AAC slices joined by copy click at every seam and drift
   * by one encoder delay per join (measured: +85 ms over three slices).
   */
  encodeAudio?: boolean
  background?: boolean
  signal?: AbortSignal
}

/**
 * Joins files listed in a concat-demuxer list into one, without re-encoding
 * the picture.
 *
 * The inputs must share codec, size and rate — they do, because the preview
 * encodes every slice with the same settings. The video is a remux: a long
 * timeline stitches in seconds where re-encoding it would take minutes.
 */
export async function concatFiles(listPath: string, outputPath: string, options: ConcatOptions = {}): Promise<string> {
  await mkdir(dirname(outputPath), { recursive: true })
  const partial = partialPath(outputPath)
  try {
    await run(
      FFMPEG_PATH,
      [
        '-hide_banner', '-nostdin', '-y',
        // `safe 0` because an entry may be any name the caller chose.
        '-f', 'concat', '-safe', '0',
        '-i', listPath,
        ...(options.encodeAudio ? ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k'] : ['-c', 'copy']),
        '-movflags', '+faststart',
        partial,
      ],
      options.signal,
      { background: options.background },
    )
    await commitPartial(partial, outputPath)
  } catch (error) {
    // A half-written file is worse than none: the cache would call it ready and
    // the player would fail to open it, which looks like a playback bug.
    await rm(partial, { force: true })
    throw error
  }
  return outputPath
}

export async function renderFrame(
  project: Project,
  timeline: Timeline,
  frame: number,
  outputPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const sidecarDir = join(tmpdir(), `palmier-frame-${randomUUID()}`)
  const partial = partialPath(outputPath)
  const command = buildFrameCommand(project, timeline, frame, partial, sidecarDir)
  try {
    await mkdir(sidecarDir, { recursive: true })
    await writeSidecars(command.sidecars)
    await mkdir(dirname(outputPath), { recursive: true })
    await run(FFMPEG_PATH, command.args, signal)
    await commitPartial(partial, outputPath)
  } catch (error) {
    await rm(partial, { force: true })
    throw error
  } finally {
    await rm(sidecarDir, { recursive: true, force: true }).catch(() => {})
  }
  return outputPath
}

/**
 * A single frame straight from a source file, for the clip monitor. This
 * deliberately bypasses the timeline graph: the clip monitor shows the raw
 * media, not the edit.
 */
export async function renderAssetFrame(
  asset: MediaAsset,
  seconds: number,
  outputPath: string,
  maxWidth = 960,
): Promise<string> {
  await mkdir(dirname(outputPath), { recursive: true })
  const partial = partialPath(outputPath)
  const args = ['-hide_banner', '-nostdin', '-y']
  if (asset.type !== 'image') args.push('-ss', Math.max(0, seconds).toFixed(6))
  args.push(
    '-i', asset.path,
    '-frames:v', '1',
    '-vf', `scale='min(${maxWidth},iw)':-2:flags=bicubic`,
    '-q:v', '3',
    '-update', '1',
    partial,
  )
  try {
    await run(FFMPEG_PATH, args)
    await commitPartial(partial, outputPath)
  } catch (error) {
    await rm(partial, { force: true })
    throw error
  }
  return outputPath
}

export async function ffmpegVersion(): Promise<string> {
  const { stdout } = await run(FFMPEG_PATH, ['-version'])
  return stdout.split('\n')[0] ?? 'unknown'
}
