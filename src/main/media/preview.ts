/**
 * Timeline preview rendering.
 *
 * Playing an edit frame by frame through FFmpeg costs ~300 ms per frame, which
 * is a slideshow, not playback. So the timeline is rendered once to a small
 * proxy file and played back as ordinary video — the same trick Kdenlive calls
 * timeline preview rendering.
 *
 * The proxy is keyed by a fingerprint of the timeline. Any edit changes the
 * fingerprint, which marks the proxy stale rather than silently playing an old
 * cut.
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { timelineTotalFrames, type Project, type Timeline } from '../../core/model.js'
import { renderTimeline, type RenderHandle, type RenderProgress } from './ffmpeg.js'

/** Proxy height. 540p plays smoothly on modest hardware and still shows framing. */
const PREVIEW_HEIGHT = 540
const KEEP_PROXIES = 4

export interface PreviewState {
  /** Fingerprint of the timeline this proxy was rendered from. */
  fingerprint: string
  path: string
  totalFrames: number
  fps: number
  /** Frame the proxy starts at — the work zone in, or zero. */
  startFrame: number
}

/**
 * Everything that changes the picture or the sound. Panel layout, selection and
 * playhead deliberately do not, or every click would invalidate the proxy.
 */
export function fingerprintTimeline(project: Project, timeline: Timeline): string {
  const relevant = {
    fps: timeline.fps,
    width: timeline.width,
    height: timeline.height,
    zone: timeline.workZone,
    tracks: timeline.tracks.map((track) => ({
      muted: track.muted,
      hidden: track.hidden,
      volume: track.volume,
      clips: track.clips.map((clip) => ({
        ...clip,
        // Ids are stable across an edit that does not change the result.
        id: undefined,
      })),
    })),
    // Only the assets actually used, so importing a file does not invalidate.
    assets: timeline.tracks
      .flatMap((t) => t.clips.map((c) => c.mediaRef))
      .filter(Boolean)
      .sort()
      .map((id) => {
        const asset = project.assets.find((a) => a.id === id)
        return asset ? `${asset.path}:${asset.durationSeconds}` : id
      }),
  }
  return createHash('sha1').update(JSON.stringify(relevant)).digest('hex').slice(0, 16)
}

export function previewPathFor(cacheDir: string, fingerprint: string): string {
  return join(cacheDir, `preview-${fingerprint}.mp4`)
}

/** An already-rendered proxy for this exact edit, or null. */
export function existingPreview(
  project: Project,
  timeline: Timeline,
  cacheDir: string,
): PreviewState | null {
  const fingerprint = fingerprintTimeline(project, timeline)
  const path = previewPathFor(cacheDir, fingerprint)
  if (!existsSync(path)) return null
  const zone = timeline.workZone
  return {
    fingerprint,
    path,
    startFrame: zone?.inFrame ?? 0,
    totalFrames: (zone?.outFrame ?? timelineTotalFrames(timeline)) - (zone?.inFrame ?? 0),
    fps: timeline.fps,
  }
}

export interface PreviewJob {
  promise: Promise<PreviewState>
  cancel: () => void
}

/**
 * Renders the work zone — or the whole timeline when there is none — to a proxy.
 * Reuses an existing proxy for the same fingerprint instead of re-encoding.
 */
export function renderPreview(
  project: Project,
  timeline: Timeline,
  cacheDir: string,
  onProgress?: (progress: RenderProgress) => void,
): PreviewJob {
  const fingerprint = fingerprintTimeline(project, timeline)
  const path = previewPathFor(cacheDir, fingerprint)
  const zone = timeline.workZone
  const startFrame = zone?.inFrame ?? 0
  const endFrame = zone?.outFrame ?? timelineTotalFrames(timeline)

  const state: PreviewState = {
    fingerprint,
    path,
    startFrame,
    totalFrames: endFrame - startFrame,
    fps: timeline.fps,
  }

  if (existsSync(path)) {
    return { promise: Promise.resolve(state), cancel: () => {} }
  }

  let handle: RenderHandle | null = null
  const promise = (async () => {
    await mkdir(cacheDir, { recursive: true })

    // Half-height proxy, keeping the timeline's aspect and an even width.
    const scale = Math.min(1, PREVIEW_HEIGHT / timeline.height)
    const previewTimeline: Timeline = {
      ...timeline,
      width: Math.max(2, Math.round((timeline.width * scale) / 2) * 2),
      height: Math.max(2, Math.round((timeline.height * scale) / 2) * 2),
    }

    handle = renderTimeline(
      project,
      previewTimeline,
      {
        outputPath: path,
        crf: 28,
        preset: 'veryfast',
        startFrame,
        endFrame,
        // A preview is a stand-in by definition, so it reads stand-ins.
        useProxies: true,
      },
      onProgress,
    )
    await handle.promise
    await pruneOldPreviews(cacheDir, fingerprint)
    return state
  })()

  return { promise, cancel: () => handle?.cancel() }
}

/** Keeps the cache from growing without bound as the edit evolves. */
async function pruneOldPreviews(cacheDir: string, keepFingerprint: string): Promise<void> {
  try {
    const entries = await readdir(cacheDir)
    const proxies = entries.filter((name) => name.startsWith('preview-') && name.endsWith('.mp4'))
    if (proxies.length <= KEEP_PROXIES) return

    const dated = await Promise.all(
      proxies.map(async (name) => ({
        name,
        mtime: (await stat(join(cacheDir, name))).mtimeMs,
      })),
    )
    dated.sort((a, b) => b.mtime - a.mtime)
    for (const entry of dated.slice(KEEP_PROXIES)) {
      if (entry.name.includes(keepFingerprint)) continue
      await unlink(join(cacheDir, entry.name)).catch(() => {})
    }
  } catch {
    // Pruning is housekeeping; failing at it must not fail the render.
  }
}
