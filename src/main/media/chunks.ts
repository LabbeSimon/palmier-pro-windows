/**
 * Which slices of a preview actually need re-encoding.
 *
 * Rendering the whole timeline again because one clip moved is the kind of
 * waste you feel: a ten-minute edit costs a minute of encoding to see a cut you
 * changed at the end. So the timeline is cut into fixed slices, each keyed by a
 * fingerprint of only what happens inside it. Moving a clip dirties the slice
 * it left and the slice it landed in, and nothing else.
 *
 * Slices are aligned to absolute timeline frames, never to the work zone, so
 * the same slice keeps the same key whatever is being previewed.
 */

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'

import { clipEndFrame, type Clip, type Project, type Timeline } from '../../core/model.js'

/**
 * Slice length in seconds.
 *
 * Short enough that one change is cheap, long enough that the joins stay rare
 * and the per-process overhead of FFmpeg does not dominate. Four seconds means
 * a typical tweak re-encodes four seconds instead of the whole edit.
 */
export const CHUNK_SECONDS = 4

export interface Chunk {
  index: number
  startFrame: number
  /** Exclusive. */
  endFrame: number
  fingerprint: string
}

export function chunkFrames(fps: number): number {
  return Math.max(1, Math.round(fps * CHUNK_SECONDS))
}

/**
 * Size and modification time of a file on disk.
 *
 * Part of the key because the path alone lies: re-exporting a shot over the
 * same name, with the same length, kept serving the old picture from cache.
 * Remembered for a moment, since the UI asks for the plan on every edit and a
 * stat per asset per slice adds up on a long timeline.
 */
const stamps = new Map<string, { stamp: string; at: number }>()
const STAMP_TTL_MS = 1500

export function fileStamp(path: string): string {
  const now = Date.now()
  const known = stamps.get(path)
  if (known && now - known.at < STAMP_TTL_MS) return known.stamp
  let stamp = 'missing'
  try {
    const info = statSync(path)
    stamp = `${info.size}:${Math.round(info.mtimeMs)}`
  } catch {
    // A missing file keys differently from any real one, and a file that
    // comes back later gets a fresh key.
  }
  stamps.set(path, { stamp, at: now })
  return stamp
}

/** Forgets remembered stamps. Tests that rewrite a file use it. */
export function forgetFileStamps(): void {
  stamps.clear()
}

/**
 * Everything inside this range that changes the picture or the sound.
 *
 * `profile` names how the range is rendered — encoder, size, format. Two
 * slices of the same edit made by different encoders are different files: an
 * NVENC slice and an x264 slice may not even join, so they must never share a
 * key. It is exported for the monitor's frame cache, which keys single frames
 * the same way.
 */
export function fingerprintRange(
  project: Project,
  timeline: Timeline,
  startFrame: number,
  endFrame: number,
  profile = '',
): string {
  const overlapping = (clip: Clip): boolean => {
    // A transition pulls the incoming clip back over its predecessor, so its
    // visible span starts earlier than its start frame.
    const from = clip.startFrame - (clip.transitionIn?.durationFrames ?? 0)
    return from < endFrame && clipEndFrame(clip) > startFrame
  }

  /*
   * Only tracks that reach into this slice.
   *
   * Including the empty ones made adding a track dirty the entire timeline,
   * which defeats the whole point. A track with nothing here changes nothing
   * here — and the relative order of the ones that do carry clips is kept, so
   * compositing order is still part of the key.
   */
  const contributing = timeline.tracks
    .map((track) => ({ track, clips: track.clips.filter(overlapping) }))
    .filter((entry) => entry.clips.length > 0)

  const relevant = {
    profile,
    fps: timeline.fps,
    width: timeline.width,
    height: timeline.height,
    startFrame,
    endFrame,
    tracks: contributing.map(({ track, clips }) => ({
      // The index keeps layering in the key: a clip that moves down a track
      // composites differently even if nothing else changed.
      layer: timeline.tracks.indexOf(track),
      muted: track.muted,
      hidden: track.hidden,
      volume: track.volume,
      // Ids are stable across an edit that does not change the result.
      clips: clips.map((clip) => ({ ...clip, id: undefined })),
    })),
    assets: contributing
      .flatMap(({ clips }) => clips.map((clip) => clip.mediaRef))
      .filter(Boolean)
      .sort()
      .map((id) => {
        const asset = project.assets.find((a) => a.id === id)
        // The proxy path counts: switching a clip to its proxy changes the picture.
        // The stamps count too: a file replaced on disk is a different picture.
        if (!asset) return id
        const proxy = asset.proxyPath ? `${asset.proxyPath}@${fileStamp(asset.proxyPath)}` : ''
        return `${asset.path}@${fileStamp(asset.path)}:${asset.durationSeconds}:${proxy}`
      }),
  }
  return createHash('sha1').update(JSON.stringify(relevant)).digest('hex').slice(0, 16)
}

/**
 * The slices covering a frame range, snapped outwards to slice boundaries.
 *
 * Snapping outwards matters: a work zone starting mid-slice must still get a
 * whole slice, or its key would depend on the zone and every nudge of the in
 * point would invalidate the cache.
 */
export function planChunks(
  project: Project,
  timeline: Timeline,
  startFrame: number,
  endFrame: number,
  profile = '',
): Chunk[] {
  const size = chunkFrames(timeline.fps)
  const first = Math.floor(Math.max(0, startFrame) / size)
  const last = Math.max(first, Math.ceil(Math.max(startFrame + 1, endFrame) / size) - 1)

  const chunks: Chunk[] = []
  for (let index = first; index <= last; index++) {
    const from = index * size
    const to = (index + 1) * size
    chunks.push({
      index,
      startFrame: from,
      endFrame: to,
      fingerprint: fingerprintRange(project, timeline, from, to, profile),
    })
  }
  return chunks
}

/** Fingerprint of a whole plan, for naming the concatenated result. */
export function planFingerprint(chunks: Chunk[]): string {
  return createHash('sha1')
    .update(chunks.map((chunk) => `${chunk.index}:${chunk.fingerprint}`).join('|'))
    .digest('hex')
    .slice(0, 16)
}
