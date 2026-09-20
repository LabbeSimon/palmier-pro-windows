/**
 * Audio sync for multicam angles.
 *
 * Two cameras pointed at the same scene hear the same sound at the same moment,
 * so the offset between their files is the lag that best lines up their
 * loudness envelopes. Correlating envelopes rather than samples is what makes
 * this cheap enough to do in the editor: at 50 Hz a ten-minute take is 30 000
 * numbers, and level differences between cameras stop mattering once each
 * envelope is normalised.
 *
 * It is a measurement, not a guarantee. Every result carries a confidence, and
 * a weak peak is reported as such instead of being applied silently.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { MediaAsset } from '../../core/model.js'
import { FFMPEG_PATH } from './ffmpeg.js'

const exec = promisify(execFile)

/** Envelope rate. 50 Hz resolves a 20 ms offset — well under a frame at 25fps. */
const ENVELOPE_HZ = 50

/** Sample rate the audio is decoded at before being reduced to an envelope. */
const SAMPLE_HZ = 4000

/** How far apart two cameras may have started rolling, in seconds. */
export const MAX_LAG_SECONDS = 120

export interface SyncResult {
  assetId: string
  /** Seconds this angle must be entered at to line up with the reference. */
  offsetSeconds: number
  /** Peak correlation, 0..1. Below `CONFIDENT` the answer is a guess. */
  confidence: number
}

/** Below this, the peak is not clearly above the noise and should not be trusted. */
export const CONFIDENT = 0.5

export class SyncError extends Error {}

/** Loudness envelope of a file's audio, as mean absolute level per bucket. */
async function envelope(asset: MediaAsset): Promise<Float32Array> {
  if (!asset.hasAudio) {
    throw new SyncError(`"${asset.name}" has no audio track to sync on`)
  }

  const { stdout } = await exec(
    FFMPEG_PATH,
    [
      '-hide_banner', '-v', 'error', '-nostdin',
      '-i', asset.path,
      '-map', 'a:0',
      '-ac', '1', '-ar', String(SAMPLE_HZ),
      '-f', 's16le', '-',
    ],
    { maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' },
  )

  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2))
  const per = Math.round(SAMPLE_HZ / ENVELOPE_HZ)
  const buckets = Math.floor(samples.length / per)
  if (buckets < ENVELOPE_HZ) {
    throw new SyncError(`"${asset.name}" has less than a second of audio to sync on`)
  }

  const out = new Float32Array(buckets)
  for (let i = 0; i < buckets; i++) {
    let total = 0
    for (let j = 0; j < per; j++) total += Math.abs(samples[i * per + j]!)
    out[i] = total / per
  }
  return normalise(out)
}

/** Zero mean, unit variance, so correlation measures shape rather than level. */
function normalise(values: Float32Array): Float32Array {
  let mean = 0
  for (const value of values) mean += value
  mean /= values.length

  let variance = 0
  for (const value of values) variance += (value - mean) ** 2
  const deviation = Math.sqrt(variance / values.length) || 1

  const out = new Float32Array(values.length)
  for (let i = 0; i < values.length; i++) out[i] = (values[i]! - mean) / deviation
  return out
}

/**
 * Lag, in envelope buckets, at which `candidate` best matches `reference`.
 *
 * Positive means the candidate started rolling first, so its footage has to be
 * entered further in to line up.
 */
function bestLag(
  reference: Float32Array,
  candidate: Float32Array,
  maxLag: number,
): { lag: number; confidence: number } {
  let bestScore = -Infinity
  let bestLagValue = 0
  let total = 0
  let count = 0

  /*
   * A lag that leaves only a sliver overlapping is not a candidate.
   *
   * The score is a mean of products, so its spread grows as the overlap
   * shrinks: a few seconds of coincidence will out-score a real match across
   * the whole take. Measured on a deliberately offset pair, a 1-second floor
   * picked a lag 6 seconds wrong; half the shorter take picks the right one.
   */
  const minOverlap = Math.max(
    ENVELOPE_HZ * 2,
    Math.floor(Math.min(reference.length, candidate.length) / 2),
  )

  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const from = Math.max(0, -lag)
    const to = Math.min(reference.length, candidate.length - lag)
    const overlap = to - from
    if (overlap < minOverlap) continue

    let sum = 0
    for (let i = from; i < to; i++) sum += reference[i]! * candidate[i + lag]!
    const score = sum / overlap
    total += Math.abs(score)
    count++
    if (score > bestScore) {
      bestScore = score
      bestLagValue = lag
    }
  }

  if (count === 0) {
    throw new SyncError(
      'no lag leaves enough of the two takes overlapping to measure — ' +
        'they may be different recordings, or too far apart to sync automatically',
    )
  }

  // Confidence is how far the peak stands above the average response: a real
  // match towers over it, noise does not.
  const average = total / count
  const confidence = bestScore <= 0 ? 0 : Math.min(1, 1 - average / bestScore)
  return { lag: bestLagValue, confidence }
}

/**
 * Offsets that line every angle up with the first one.
 *
 * The reference always comes back at zero, so the caller can apply the list
 * without special-casing it.
 */
export async function syncByAudio(assets: MediaAsset[]): Promise<SyncResult[]> {
  if (assets.length < 2) throw new SyncError('syncing needs at least two angles')

  const envelopes = await Promise.all(assets.map(envelope))
  const reference = envelopes[0]!
  const maxLag = Math.round(MAX_LAG_SECONDS * ENVELOPE_HZ)

  const results: SyncResult[] = [{ assetId: assets[0]!.id, offsetSeconds: 0, confidence: 1 }]
  for (let i = 1; i < assets.length; i++) {
    const { lag, confidence } = bestLag(reference, envelopes[i]!, maxLag)
    results.push({
      assetId: assets[i]!.id,
      offsetSeconds: lag / ENVELOPE_HZ,
      confidence: Number(confidence.toFixed(3)),
    })
  }

  // Offsets are stored as "frames to skip", which cannot be negative, so the
  // whole set is shifted until the earliest angle sits at zero.
  const earliest = Math.min(...results.map((result) => result.offsetSeconds))
  return results.map((result) => ({
    ...result,
    offsetSeconds: Number((result.offsetSeconds - earliest).toFixed(3)),
  }))
}
