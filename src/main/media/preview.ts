/**
 * Timeline preview rendering.
 *
 * Playing an edit frame by frame through FFmpeg costs ~300 ms per frame, which
 * is a slideshow, not playback. So the timeline is rendered to a small proxy
 * file and played back as ordinary video — the trick Kdenlive calls timeline
 * preview rendering.
 *
 * It is rendered in slices. Re-encoding the whole edit because one clip moved
 * costs minutes on a long timeline to see a change that affects four seconds of
 * it, so each slice is keyed by a fingerprint of what happens inside it alone,
 * and only the dirty ones are encoded. The rest are reused from the cache and
 * the lot is stitched together by stream copy, which is a remux rather than a
 * re-encode: seconds instead of minutes.
 */

import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { timelineTotalFrames, type Project, type Timeline } from '../../core/model.js'
import {
  commitPartial,
  concatFiles,
  PARTIAL_MARKER,
  partialPath,
  renderTimeline,
  type RenderHandle,
  type RenderProgress,
} from './ffmpeg.js'
import { bestEncoder, hardwareDecodeWorks, SOFTWARE, toSpec, type VideoEncoder } from './encoders.js'
import { planChunks, planFingerprint, type Chunk } from './chunks.js'
import { enforceCacheLimit, PREVIEW_CHUNK_DIR, touch } from './cache.js'
import { getPerformance } from './performance.js'
import { runPool } from './pool.js'

/** How many stitched previews to keep. Slices are bounded by the cache ceiling. */
const KEEP_PREVIEWS = 4

/** Quality of a preview slice. Throwaway by nature, so speed wins. */
const PREVIEW_CRF = 28

/**
 * Bumped whenever the layout of a slice changes, so slices written by an older
 * build are never joined with new ones. v2: PCM audio in a .mov, always present.
 */
const SLICE_FORMAT = 'v2'

/** Hardware encoders have a session limit per GPU; stay well inside it. */
const MAX_HARDWARE_JOBS = 3

/** How a preview is rendered on this machine, right now. */
export interface PreviewSetup {
  encoder: VideoEncoder
  /** Proxy height; the timeline is never scaled up. */
  height: number
  /** Slices encoded at the same time. */
  jobs: number
  /** Run the encoders below normal priority. */
  background: boolean
  /** Decode sources on the GPU — only ever true once the probe has passed. */
  hardwareDecode: boolean
}

/**
 * The setup tests and callers without settings get: CPU, 540p, one at a time.
 * Everything in it is explicit so a plan and its render always agree on keys.
 */
export const DEFAULT_SETUP: PreviewSetup = {
  encoder: SOFTWARE,
  height: 540,
  jobs: 1,
  background: false,
  hardwareDecode: false,
}

/** The setup the settings and the hardware probes call for. */
export async function previewSetup(): Promise<PreviewSetup> {
  const settings = getPerformance()
  const encoder = await bestEncoder()
  return {
    encoder,
    height: settings.previewHeight,
    jobs: settings.parallelJobs,
    background: settings.lowPriority,
    hardwareDecode: settings.hardwareDecode && (await hardwareDecodeWorks()),
  }
}

/**
 * What makes two slices of the same edit different files.
 *
 * Priority, parallelism and decoding do not change the picture, so they are
 * not in it — switching them must not throw the cache away.
 */
export function profileKey(setup: PreviewSetup): string {
  return `${setup.encoder.name}|h${setup.height}|crf${PREVIEW_CRF}|${SLICE_FORMAT}`
}

export interface PreviewState {
  /** Fingerprint of the plan this proxy was rendered from. */
  fingerprint: string
  path: string
  totalFrames: number
  fps: number
  /** Frame the proxy starts at — the slice containing the work zone in, or zero. */
  startFrame: number
  /** Slices encoded by this call, and slices taken from the cache. */
  encoded: number
  reused: number
  /** Proxy size, as rendered. */
  width: number
  height: number
  encoder: string
}

export interface PreviewPlan {
  chunks: Chunk[]
  /** Slices that have no cached file and must be encoded. */
  dirty: Chunk[]
  fingerprint: string
  startFrame: number
  totalFrames: number
}

function chunkDir(cacheDir: string): string {
  return join(cacheDir, PREVIEW_CHUNK_DIR)
}

/**
 * A slice is a .mov: it carries PCM audio, which MP4 does not take, so that
 * the join can encode the sound once instead of gluing AAC streams together.
 */
export function chunkFileName(chunk: Chunk): string {
  return `chunk-${chunk.fingerprint}.mov`
}

function chunkPath(cacheDir: string, chunk: Chunk): string {
  return join(chunkDir(cacheDir), chunkFileName(chunk))
}

/**
 * A cached file counts only if it holds something.
 *
 * Belt and braces now that every write is staged and renamed: an empty file
 * can still be left by a disk that filled up, or put there by hand.
 */
function usable(path: string): boolean {
  try {
    return statSync(path).size > 0
  } catch {
    return false
  }
}

export function previewPathFor(cacheDir: string, fingerprint: string): string {
  return join(cacheDir, `preview-${fingerprint}.mp4`)
}

/** The slices this preview needs, and which of them are missing. */
export function planPreview(
  project: Project,
  timeline: Timeline,
  cacheDir: string,
  setup: PreviewSetup = DEFAULT_SETUP,
): PreviewPlan {
  const zone = timeline.workZone
  const from = zone?.inFrame ?? 0
  const to = zone?.outFrame ?? timelineTotalFrames(timeline)

  const chunks = planChunks(project, timeline, from, to, profileKey(setup))
  const dirty = chunks.filter((chunk) => !usable(chunkPath(cacheDir, chunk)))
  const startFrame = chunks[0]?.startFrame ?? 0
  const endFrame = chunks[chunks.length - 1]?.endFrame ?? startFrame

  return {
    chunks,
    dirty,
    fingerprint: planFingerprint(chunks),
    startFrame,
    totalFrames: endFrame - startFrame,
  }
}

/**
 * Kept for the fingerprint the UI shows; a plan's fingerprint changes exactly
 * when at least one of its slices does.
 */
export function fingerprintTimeline(
  project: Project,
  timeline: Timeline,
  setup: PreviewSetup = DEFAULT_SETUP,
): string {
  const zone = timeline.workZone
  const from = zone?.inFrame ?? 0
  const to = zone?.outFrame ?? timelineTotalFrames(timeline)
  return planFingerprint(planChunks(project, timeline, from, to, profileKey(setup)))
}

/** The half-height stand-in the preview is rendered at. */
function previewTimeline(timeline: Timeline, height: number): Timeline {
  const scale = Math.min(1, height / timeline.height)
  return {
    ...timeline,
    width: Math.max(2, Math.round((timeline.width * scale) / 2) * 2),
    height: Math.max(2, Math.round((timeline.height * scale) / 2) * 2),
  }
}

function stateFor(plan: PreviewPlan, path: string, timeline: Timeline, setup: PreviewSetup): PreviewState {
  const small = previewTimeline(timeline, setup.height)
  return {
    fingerprint: plan.fingerprint,
    path,
    startFrame: plan.startFrame,
    totalFrames: plan.totalFrames,
    fps: timeline.fps,
    encoded: 0,
    reused: plan.chunks.length,
    width: small.width,
    height: small.height,
    encoder: setup.encoder.label,
  }
}

/** An already-stitched proxy for this exact edit, or null. */
export function existingPreview(
  project: Project,
  timeline: Timeline,
  cacheDir: string,
  setup: PreviewSetup = DEFAULT_SETUP,
): PreviewState | null {
  const plan = planPreview(project, timeline, cacheDir, setup)
  const path = previewPathFor(cacheDir, plan.fingerprint)
  if (!usable(path)) return null
  return stateFor(plan, path, timeline, setup)
}

export interface PreviewJob {
  promise: Promise<PreviewState>
  cancel: () => void
}

export function renderPreview(
  project: Project,
  timeline: Timeline,
  cacheDir: string,
  onProgress?: (progress: RenderProgress) => void,
  setup: PreviewSetup = DEFAULT_SETUP,
): PreviewJob {
  const plan = planPreview(project, timeline, cacheDir, setup)
  const path = previewPathFor(cacheDir, plan.fingerprint)
  const state = stateFor(plan, path, timeline, setup)

  if (usable(path)) {
    void touch([path, ...plan.chunks.map((chunk) => chunkPath(cacheDir, chunk))])
    return { promise: Promise.resolve(state), cancel: () => {} }
  }

  const running = new Set<RenderHandle>()
  const controller = new AbortController()

  const promise = (async () => {
    await mkdir(chunkDir(cacheDir), { recursive: true })
    const small = previewTimeline(timeline, setup.height)
    const encoder = toSpec(setup.encoder, PREVIEW_CRF)
    const jobs = setup.encoder.hardware ? Math.min(setup.jobs, MAX_HARDWARE_JOBS) : setup.jobs

    // Progress is reported across the dirty slices only, because those are the
    // only ones costing anything. Saying "12/300 frames" while reusing 288 of
    // them would read as broken. With slices in flight side by side, the
    // count is the sum of what each has done so far.
    const totalDirtyFrames = plan.dirty.reduce(
      (sum, chunk) => sum + (chunk.endFrame - chunk.startFrame),
      0,
    )
    const doneBySlice = new Map<number, number>()
    let lastFps = 0
    let lastSpeed = ''
    const report = () =>
      onProgress?.({
        frame: [...doneBySlice.values()].reduce((sum, frames) => sum + frames, 0),
        totalFrames: totalDirtyFrames,
        // Several encoders at once: the throughput is their sum, roughly.
        fps: lastFps,
        speed: lastSpeed,
      })

    await runPool(plan.dirty, jobs, async (chunk) => {
      if (controller.signal.aborted) throw new Error('cancelled')
      const target = chunkPath(cacheDir, chunk)
      const partial = partialPath(target)

      const handle = renderTimeline(
        project,
        small,
        {
          outputPath: partial,
          crf: PREVIEW_CRF,
          preset: 'veryfast',
          encoder,
          startFrame: chunk.startFrame,
          endFrame: chunk.endFrame,
          // A preview is a stand-in by definition, so it reads stand-ins.
          useProxies: true,
          audioCodec: 'pcm',
          alwaysAudio: true,
          hardwareDecode: setup.hardwareDecode,
        },
        (progress) => {
          doneBySlice.set(chunk.index, progress.frame)
          lastFps = progress.fps * Math.min(jobs, plan.dirty.length)
          lastSpeed = progress.speed
          report()
        },
        { background: setup.background },
      )
      running.add(handle)
      try {
        await handle.promise
      } finally {
        running.delete(handle)
      }
      await commitPartial(partial, target)
      doneBySlice.set(chunk.index, chunk.endFrame - chunk.startFrame)
      report()
    })
    if (controller.signal.aborted) throw new Error('cancelled')

    /*
     * The picture is a stream copy: the slices were all encoded with the same
     * settings at the same size, so nothing is decoded again here. The sound is
     * encoded once, continuously, from the PCM in the slices.
     *
     * The list holds bare file names, not paths. The concat demuxer resolves
     * them against the list's own directory, and it treats a backslash inside a
     * quoted entry as an escape — so a Windows path written in full comes back
     * mangled and none of the slices open.
     */
    const list = join(chunkDir(cacheDir), `list-${plan.fingerprint}-${randomUUID().slice(0, 8)}.txt`)
    await writeFile(
      list,
      plan.chunks.map((chunk) => `file '${chunkFileName(chunk)}'`).join('\n'),
      'utf8',
    )
    try {
      await concatFiles(list, path, {
        encodeAudio: true,
        background: setup.background,
        signal: controller.signal,
      })
    } finally {
      await unlink(list).catch(() => {})
    }

    await prune(cacheDir, plan)
    return { ...state, encoded: plan.dirty.length, reused: plan.chunks.length - plan.dirty.length }
  })()

  return {
    promise,
    cancel: () => {
      controller.abort()
      for (const handle of running) handle.cancel()
    },
  }
}

/** Keeps the cache bounded without throwing away what this plan still wants. */
async function prune(cacheDir: string, plan: PreviewPlan): Promise<void> {
  const keep = new Set([
    previewPathFor(cacheDir, plan.fingerprint),
    ...plan.chunks.map((chunk) => chunkPath(cacheDir, chunk)),
  ])
  // Reused slices must look recent, or the ones watched most would go first.
  await touch([...keep])
  await pruneStitched(cacheDir, keep)
  await enforceCacheLimit(cacheDir, getPerformance().cacheLimitGB * 1024 ** 3, keep)
}

/**
 * Stitched previews are copies of their slices, so only the latest few are
 * worth their disk space.
 */
async function pruneStitched(cacheDir: string, keep: Set<string>): Promise<void> {
  try {
    // A partial file is another render's work in progress, not an old preview.
    const entries = (await readdir(cacheDir)).filter(
      (name) => name.startsWith('preview-') && name.endsWith('.mp4') && !name.includes(PARTIAL_MARKER),
    )
    if (entries.length <= KEEP_PREVIEWS) return
    const dated = await Promise.all(
      entries.map(async (name) => ({ name, mtime: (await stat(join(cacheDir, name))).mtimeMs })),
    )
    dated.sort((a, b) => b.mtime - a.mtime)
    for (const entry of dated.slice(KEEP_PREVIEWS)) {
      const path = join(cacheDir, entry.name)
      if (keep.has(path)) continue
      await unlink(path).catch(() => {})
    }
  } catch {
    // Pruning is housekeeping; failing at it must not fail the render.
  }
}
