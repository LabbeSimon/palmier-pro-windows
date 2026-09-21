/**
 * Where someone is speaking, and where they are not.
 *
 * An agent writing subtitles has the words — the user pasted them, or they came
 * from a script — but no ears. This gives it the timings: the stretches of a
 * take that carry sound, so a line can be placed on the moment it is said
 * instead of guessed at from the clip length.
 *
 * It is voice *activity*, not speech recognition. Nothing here turns audio into
 * words; music and traffic count as sound like anything else. The honest use is
 * aligning text you already have.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { MediaAsset } from '../../core/model.js'
import { FFMPEG_PATH } from './ffmpeg.js'

const exec = promisify(execFile)

/** Level below which a passage counts as silence. Speech sits well above this. */
export const DEFAULT_THRESHOLD_DB = -30

/**
 * Shortest gap that splits two segments.
 *
 * Below about a third of a second you are cutting inside sentences, at the
 * pauses between words, which produces cues no one can read.
 */
export const DEFAULT_MIN_SILENCE = 0.35

export interface Segment {
  startSeconds: number
  endSeconds: number
}

export class SpeechError extends Error {}

const SILENCE_START = /silence_start:\s*(-?[\d.]+)/
const SILENCE_END = /silence_end:\s*(-?[\d.]+)/

/**
 * Turns FFmpeg's silence log into the gaps it describes.
 *
 * A final `silence_start` with no matching end means the take finishes in
 * silence, so the gap runs to the end of the file.
 */
export function parseSilences(stderr: string, durationSeconds: number): Segment[] {
  const gaps: Segment[] = []
  let open: number | null = null

  for (const line of stderr.split('\n')) {
    const start = SILENCE_START.exec(line)
    if (start) {
      open = Math.max(0, Number(start[1]))
      continue
    }
    const end = SILENCE_END.exec(line)
    if (end && open !== null) {
      gaps.push({ startSeconds: open, endSeconds: Math.min(durationSeconds, Number(end[1])) })
      open = null
    }
  }
  if (open !== null && open < durationSeconds) {
    gaps.push({ startSeconds: open, endSeconds: durationSeconds })
  }
  return gaps
}

/** The complement of the gaps: everything left is sound. */
export function invert(gaps: Segment[], durationSeconds: number): Segment[] {
  const sound: Segment[] = []
  let cursor = 0
  for (const gap of gaps) {
    if (gap.startSeconds > cursor) sound.push({ startSeconds: cursor, endSeconds: gap.startSeconds })
    cursor = Math.max(cursor, gap.endSeconds)
  }
  if (cursor < durationSeconds) sound.push({ startSeconds: cursor, endSeconds: durationSeconds })
  // A segment shorter than a frame or two is a click, not a line of dialogue.
  return sound.filter((segment) => segment.endSeconds - segment.startSeconds >= 0.1)
}

export async function detectSpeech(
  asset: MediaAsset,
  options: { thresholdDb?: number; minSilenceSeconds?: number } = {},
): Promise<Segment[]> {
  if (!asset.hasAudio) {
    throw new SpeechError(`"${asset.name}" has no audio track to listen to`)
  }
  const threshold = options.thresholdDb ?? DEFAULT_THRESHOLD_DB
  const minSilence = options.minSilenceSeconds ?? DEFAULT_MIN_SILENCE

  // silencedetect reports on stderr and produces no output stream, so the
  // decode is thrown away rather than written anywhere.
  const { stderr } = await exec(
    FFMPEG_PATH,
    [
      '-hide_banner', '-nostdin',
      '-i', asset.path,
      '-map', 'a:0',
      '-af', `silencedetect=noise=${threshold}dB:d=${minSilence}`,
      '-f', 'null', '-',
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  )

  return invert(parseSilences(stderr, asset.durationSeconds), asset.durationSeconds)
}
