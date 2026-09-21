/**
 * Voice activity detection.
 *
 * The parsing is unit-tested because FFmpeg's silence log is the only contract
 * here and it is easy to get the open-ended final gap wrong. The detection
 * itself runs against a file built with sound and silence at known places, so a
 * threshold that quietly stops finding anything cannot pass.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MediaAsset } from '../src/core/model.js'
import { FFMPEG_PATH } from '../src/main/media/ffmpeg.js'
import { detectSpeech, invert, parseSilences, SpeechError } from '../src/main/media/speech.js'

const exec = promisify(execFile)

describe('parseSilences', () => {
  it('reads the gaps FFmpeg reported', () => {
    const log = `
[silencedetect @ 0x1] silence_start: 1.5
[silencedetect @ 0x1] silence_end: 3.25 | silence_duration: 1.75
[silencedetect @ 0x1] silence_start: 6
[silencedetect @ 0x1] silence_end: 7.5 | silence_duration: 1.5
`
    expect(parseSilences(log, 10)).toEqual([
      { startSeconds: 1.5, endSeconds: 3.25 },
      { startSeconds: 6, endSeconds: 7.5 },
    ])
  })

  it('closes a final gap that has no end, because the take ends in silence', () => {
    const log = '[silencedetect @ 0x1] silence_start: 8.2\n'
    expect(parseSilences(log, 10)).toEqual([{ startSeconds: 8.2, endSeconds: 10 }])
  })

  it('clamps a negative start and an end past the file', () => {
    const log = '[silencedetect @ 0x1] silence_start: -0.02\n[silencedetect @ 0x1] silence_end: 99\n'
    expect(parseSilences(log, 10)).toEqual([{ startSeconds: 0, endSeconds: 10 }])
  })

  it('returns nothing for a log with no silence at all', () => {
    expect(parseSilences('nothing to report here\n', 10)).toEqual([])
  })
})

describe('invert', () => {
  it('returns the sound between the gaps', () => {
    const gaps = [
      { startSeconds: 2, endSeconds: 3 },
      { startSeconds: 5, endSeconds: 6 },
    ]
    expect(invert(gaps, 8)).toEqual([
      { startSeconds: 0, endSeconds: 2 },
      { startSeconds: 3, endSeconds: 5 },
      { startSeconds: 6, endSeconds: 8 },
    ])
  })

  it('gives the whole file when nothing was silent', () => {
    expect(invert([], 4)).toEqual([{ startSeconds: 0, endSeconds: 4 }])
  })

  it('gives nothing when the whole file was silent', () => {
    expect(invert([{ startSeconds: 0, endSeconds: 4 }], 4)).toEqual([])
  })

  it('drops a sliver too short to be a line', () => {
    const gaps = [
      { startSeconds: 0, endSeconds: 2 },
      { startSeconds: 2.04, endSeconds: 5 },
    ]
    expect(invert(gaps, 5)).toEqual([])
  })
})

// --- Against a real file ---------------------------------------------------

describe('detectSpeech', () => {
  let workDir: string
  let asset: MediaAsset

  /** Sound from 0-2 s and 4-6 s, silence in between and at the end. */
  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'palmier-speech-'))
    const path = join(workDir, 'take.wav')
    await exec(FFMPEG_PATH, [
      '-hide_banner', '-v', 'error', '-y',
      '-f', 'lavfi',
      '-i',
      "sine=frequency=300:duration=8," +
        "volume='if(lt(t,2),1,if(lt(t,4),0,if(lt(t,6),1,0)))':eval=frame",
      path,
    ])
    asset = {
      id: crypto.randomUUID(), path, name: 'take.wav', type: 'audio',
      durationSeconds: 8, width: 0, height: 0, fps: 0,
      hasAudio: true, sampleRate: 44100, channels: 1, thumbnailPath: null,
    }
  }, 120_000)

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  it('finds the two passages that carry sound, and neither of the gaps', async () => {
    const segments = await detectSpeech(asset)
    expect(segments).toHaveLength(2)

    expect(segments[0]!.startSeconds).toBeCloseTo(0, 1)
    expect(segments[0]!.endSeconds).toBeCloseTo(2, 1)
    expect(segments[1]!.startSeconds).toBeCloseTo(4, 1)
    expect(segments[1]!.endSeconds).toBeCloseTo(6, 1)
  }, 120_000)

  it('merges everything when no gap reaches the minimum', async () => {
    // Both gaps are 2 s, so at a 3 s minimum neither is reported and the whole
    // take reads as one continuous passage — the trailing silence included.
    const segments = await detectSpeech(asset, { minSilenceSeconds: 3 })
    expect(segments).toEqual([{ startSeconds: 0, endSeconds: 8 }])
  }, 120_000)

  it('splits on a shorter gap when asked to', async () => {
    const segments = await detectSpeech(asset, { minSilenceSeconds: 1 })
    expect(segments).toHaveLength(2)
    expect(segments[1]!.startSeconds).toBeCloseTo(4, 1)
  }, 120_000)

  it('says plainly when there is no audio to listen to', async () => {
    await expect(detectSpeech({ ...asset, hasAudio: false })).rejects.toBeInstanceOf(SpeechError)
  })
})
