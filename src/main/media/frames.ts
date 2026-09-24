/**
 * Monitor frames, cached.
 *
 * Composing one frame through the full filter graph costs ~300 ms. Scrubbing
 * back and forth over the same stretch, or stepping frame by frame around a
 * cut, asked for the same frames again and again and paid for each one every
 * time. A frame is now keyed the way a preview slice is — by what happens in
 * it, including the files on disk — so an unchanged frame is read back from
 * disk in a millisecond and any edit that touches it gets a new key.
 *
 * JPEG rather than PNG for the monitor: at 1080p a PNG costs more to write
 * and several times more to ship to the renderer as base64, for a picture
 * nobody can tell apart at monitor size. `capture_frame` keeps writing PNG.
 */

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'

import type { MediaAsset, Project, Timeline } from '../../core/model.js'
import { fingerprintRange, fileStamp } from './chunks.js'
import { FRAME_DIR } from './cache.js'
import { renderAssetFrame, renderFrame } from './ffmpeg.js'

/** Bumped when the way a monitor frame is made changes. */
const FRAME_FORMAT = 'jpg-v1'

function usable(path: string): boolean {
  try {
    return statSync(path).size > 0
  } catch {
    return false
  }
}

export function frameDir(cacheDir: string): string {
  return join(cacheDir, FRAME_DIR)
}

/** Where a composited timeline frame lives in the cache. */
export function timelineFramePath(project: Project, timeline: Timeline, frame: number, cacheDir: string): string {
  const key = fingerprintRange(project, timeline, frame, frame + 1, FRAME_FORMAT)
  return join(frameDir(cacheDir), `frame-${key}.jpg`)
}

export interface CachedFrame {
  path: string
  /** True when it came from the cache and cost no render. */
  hit: boolean
}

/**
 * A composited frame of the timeline, from the cache when it is there.
 *
 * `signal` lets the caller drop a render nobody is waiting for any more — a
 * scrub asks for a dozen frames a second and only the last one matters.
 */
export async function timelineFrame(
  project: Project,
  timeline: Timeline,
  frame: number,
  cacheDir: string,
  signal?: AbortSignal,
): Promise<CachedFrame> {
  const path = timelineFramePath(project, timeline, frame, cacheDir)
  if (usable(path)) return { path, hit: true }
  await renderFrame(project, timeline, frame, path, signal)
  return { path, hit: false }
}

/** A still of a source file for the clip monitor, cached the same way. */
export async function assetFrame(asset: MediaAsset, seconds: number, cacheDir: string): Promise<CachedFrame> {
  const key = createHash('sha1')
    .update(`${asset.path}@${fileStamp(asset.path)}|${seconds.toFixed(3)}|${FRAME_FORMAT}`)
    .digest('hex')
    .slice(0, 16)
  const path = join(frameDir(cacheDir), `clip-${key}.jpg`)
  if (usable(path)) return { path, hit: true }
  await renderAssetFrame(asset, seconds, path)
  return { path, hit: false }
}
