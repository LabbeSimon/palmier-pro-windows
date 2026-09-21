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

import { timelineTotalFrames, type Project, type Timeline } from '../../core/model.js'
import { concatFiles, renderTimeline, type RenderHandle, type RenderProgress } from './ffmpeg.js'
import { bestEncoder, toSpec } from './encoders.js'
import { planChunks, planFingerprint, type Chunk } from './chunks.js'

/** Proxy height. 540p plays smoothly on modest hardware and still shows framing. */
const PREVIEW_HEIGHT = 540

/** How many stitched previews to keep. Slices are pruned by age separately. */
const KEEP_PREVIEWS = 4

/** Slices to keep in the cache. Generous: reusing one is the entire point. */
const KEEP_CHUNKS = 400

export interface PreviewState {
  /** Fingerprint of the plan this proxy was rendered from. */
  fingerprint: string
  path: string
  totalFrames: number
  fps: number
  /** Frame the proxy starts at — the slice containing the work zone in, or zero. */
  startFrame: number
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
  return join(cacheDir, 'preview-chunks')
}

function chunkFileName(chunk: Chunk): string {
  return `chunk-${chunk.fingerprint}.mp4`
}

function chunkPath(cacheDir: string, chunk: Chunk): string {
  return join(chunkDir(cacheDir), chunkFileName(chunk))
}

/**
 * A cached file counts only if it holds something.
 *
 * A render that failed or was cancelled leaves the output behind, and treating
 * that as a finished slice makes the preview report itself ready and then fail
 * to open — which reads as a playback bug rather than a render that died.
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
export function planPreview(project: Project, timeline: Timeline, cacheDir: string): PreviewPlan {
  const zone = timeline.workZone
  const from = zone?.inFrame ?? 0
  const to = zone?.outFrame ?? timelineTotalFrames(timeline)

  const chunks = planChunks(project, timeline, from, to)
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
export function fingerprintTimeline(project: Project, timeline: Timeline): string {
  const zone = timeline.workZone
  const from = zone?.inFrame ?? 0
  const to = zone?.outFrame ?? timelineTotalFrames(timeline)
  return planFingerprint(planChunks(project, timeline, from, to))
}

/** An already-stitched proxy for this exact edit, or null. */
export function existingPreview(
  project: Project,
  timeline: Timeline,
  cacheDir: string,
): PreviewState | null {
  const plan = planPreview(project, timeline, cacheDir)
  const path = previewPathFor(cacheDir, plan.fingerprint)
  if (!usable(path)) return null
  return {
    fingerprint: plan.fingerprint,
    path,
    startFrame: plan.startFrame,
    totalFrames: plan.totalFrames,
    fps: timeline.fps,
  }
}

export interface PreviewJob {
  promise: Promise<PreviewState>
  cancel: () => void
}

/** The half-height stand-in the preview is rendered at. */
function previewTimeline(timeline: Timeline): Timeline {
  const scale = Math.min(1, PREVIEW_HEIGHT / timeline.height)
  return {
    ...timeline,
    width: Math.max(2, Math.round((timeline.width * scale) / 2) * 2),
    height: Math.max(2, Math.round((timeline.height * scale) / 2) * 2),
  }
}

export function renderPreview(
  project: Project,
  timeline: Timeline,
  cacheDir: string,
  onProgress?: (progress: RenderProgress) => void,
): PreviewJob {
  const plan = planPreview(project, timeline, cacheDir)
  const path = previewPathFor(cacheDir, plan.fingerprint)

  const state: PreviewState = {
    fingerprint: plan.fingerprint,
    path,
    startFrame: plan.startFrame,
    totalFrames: plan.totalFrames,
    fps: timeline.fps,
  }

  if (usable(path)) {
    return { promise: Promise.resolve(state), cancel: () => {} }
  }

  let handle: RenderHandle | null = null
  let cancelled = false

  const promise = (async () => {
    await mkdir(chunkDir(cacheDir), { recursive: true })
    const small = previewTimeline(timeline)
    // A preview is throwaway, so speed beats everything: the GPU encoder is
    // used whenever the machine has a working one.
    const encoder = toSpec(await bestEncoder(), 28)

    // Progress is reported across the dirty slices only, because those are the
    // only ones costing anything. Saying "12/300 frames" while reusing 288 of
    // them would read as broken.
    const totalDirtyFrames = plan.dirty.reduce(
      (sum, chunk) => sum + (chunk.endFrame - chunk.startFrame),
      0,
    )
    let done = 0

    for (const chunk of plan.dirty) {
      if (cancelled) throw new Error('cancelled')
      const target = chunkPath(cacheDir, chunk)

      handle = renderTimeline(
        project,
        small,
        {
          outputPath: target,
          crf: 28,
          preset: 'veryfast',
          encoder,
          startFrame: chunk.startFrame,
          endFrame: chunk.endFrame,
          // A preview is a stand-in by definition, so it reads stand-ins.
          useProxies: true,
        },
        (progress) =>
          onProgress?.({
            ...progress,
            frame: done + progress.frame,
            totalFrames: totalDirtyFrames,
          }),
      )
      await handle.promise
      done += chunk.endFrame - chunk.startFrame
    }

    /*
     * Stitching is a stream copy: the slices were all encoded with the same
     * settings at the same size, so nothing is decoded again here.
     *
     * The list holds bare file names, not paths. The concat demuxer resolves
     * them against the list's own directory, and it treats a backslash inside a
     * quoted entry as an escape — so a Windows path written in full comes back
     * mangled and none of the slices open.
     */
    const list = join(chunkDir(cacheDir), `list-${plan.fingerprint}.txt`)
    await writeFile(
      list,
      plan.chunks.map((chunk) => `file '${chunkFileName(chunk)}'`).join('\n'),
      'utf8',
    )
    try {
      await concatFiles(list, path)
    } finally {
      await unlink(list).catch(() => {})
    }

    await prune(cacheDir, plan)
    return state
  })()

  return {
    promise,
    cancel: () => {
      cancelled = true
      handle?.cancel()
    },
  }
}

/** Keeps the cache bounded without throwing away slices this plan still wants. */
async function prune(cacheDir: string, plan: PreviewPlan): Promise<void> {
  const keep = new Set(plan.chunks.map((chunk) => `chunk-${chunk.fingerprint}.mp4`))
  await pruneDirectory(cacheDir, (name) => name.startsWith('preview-') && name.endsWith('.mp4'), KEEP_PREVIEWS, new Set([`preview-${plan.fingerprint}.mp4`]))
  await pruneDirectory(chunkDir(cacheDir), (name) => name.startsWith('chunk-'), KEEP_CHUNKS, keep)
}

async function pruneDirectory(
  directory: string,
  matches: (name: string) => boolean,
  limit: number,
  keep: Set<string>,
): Promise<void> {
  try {
    const entries = (await readdir(directory)).filter(matches)
    if (entries.length <= limit) return

    const dated = await Promise.all(
      entries.map(async (name) => ({ name, mtime: (await stat(join(directory, name))).mtimeMs })),
    )
    dated.sort((a, b) => b.mtime - a.mtime)
    for (const entry of dated.slice(limit)) {
      if (keep.has(entry.name)) continue
      await unlink(join(directory, entry.name)).catch(() => {})
    }
  } catch {
    // Pruning is housekeeping; failing at it must not fail the render.
  }
}
