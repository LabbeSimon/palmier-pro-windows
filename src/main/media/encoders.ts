/**
 * Picking a video encoder, hardware first.
 *
 * Encoding H.264 on the CPU while a perfectly good encoder sits idle in the GPU
 * is the difference between a preview that takes a minute and one that takes a
 * few seconds. Every modern Windows machine has one: NVENC on NVIDIA, Quick
 * Sync on Intel, AMF on AMD.
 *
 * Presence in the FFmpeg build proves nothing — ours is compiled with all of
 * them, and none of them work on a machine without the vendor runtime. So each
 * candidate is *probed*: a fraction of a second of black is encoded, and only an
 * encoder that actually produced it is used. The result is cached for the life
 * of the process, and libx264 is always there as the answer when nothing else
 * is.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { EncoderSpec } from '../../core/render.js'
import { FFMPEG_PATH } from './ffmpeg.js'

const exec = promisify(execFile)

export interface VideoEncoder {
  /** FFmpeg encoder name. */
  name: string
  label: string
  hardware: boolean
  /** Arguments that must appear before the inputs, to open the device. */
  deviceArgs: string[]
  /** Filter appended to the video chain, to move frames onto the GPU. */
  uploadFilter: string | null
  /**
   * Quality arguments for a target roughly equivalent to x264's CRF.
   *
   * Hardware encoders do not take `-crf`: each vendor spells its rate control
   * differently, and getting it wrong silently produces either a huge file or
   * mush.
   */
  qualityArgs: (crf: number) => string[]
}

export const SOFTWARE: VideoEncoder = {
  name: 'libx264',
  label: 'libx264 (CPU)',
  hardware: false,
  deviceArgs: [],
  uploadFilter: null,
  qualityArgs: (crf) => ['-crf', String(crf)],
}

/**
 * Candidates in the order they are tried, per platform.
 *
 * NVENC first where present: it is the fastest and the most predictable. VAAPI
 * is the Linux path; on Windows the vendor encoders are the ones that exist.
 */
function candidates(): VideoEncoder[] {
  const nvenc: VideoEncoder = {
    name: 'h264_nvenc',
    label: 'NVIDIA NVENC',
    hardware: true,
    deviceArgs: [],
    uploadFilter: null,
    qualityArgs: (crf) => ['-rc', 'vbr', '-cq', String(crf), '-b:v', '0'],
  }
  const qsv: VideoEncoder = {
    name: 'h264_qsv',
    label: 'Intel Quick Sync',
    hardware: true,
    deviceArgs: [],
    uploadFilter: null,
    // QSV reads global_quality on the same 1-51 scale as CRF.
    qualityArgs: (crf) => ['-global_quality', String(crf), '-look_ahead', '0'],
  }
  const amf: VideoEncoder = {
    name: 'h264_amf',
    label: 'AMD AMF',
    hardware: true,
    deviceArgs: [],
    uploadFilter: null,
    qualityArgs: (crf) => ['-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf)],
  }
  const vaapi: VideoEncoder = {
    name: 'h264_vaapi',
    label: 'VAAPI',
    hardware: true,
    deviceArgs: ['-vaapi_device', '/dev/dri/renderD128'],
    // VAAPI encodes from GPU surfaces, so frames have to be uploaded first.
    uploadFilter: 'format=nv12,hwupload',
    qualityArgs: (crf) => ['-rc_mode', 'CQP', '-qp', String(crf)],
  }

  if (process.platform === 'win32') return [nvenc, qsv, amf]
  if (process.platform === 'linux') return [nvenc, vaapi, qsv]
  return []
}

/** Encodes a fraction of a second of black; success means the encoder works. */
async function probe(encoder: VideoEncoder): Promise<boolean> {
  const filters = ['scale=320:240', encoder.uploadFilter].filter(Boolean).join(',')
  try {
    await exec(
      FFMPEG_PATH,
      [
        '-hide_banner', '-v', 'error', '-nostdin',
        ...encoder.deviceArgs,
        '-f', 'lavfi', '-i', 'color=black:s=320x240:r=25:d=0.4',
        '-vf', filters,
        '-c:v', encoder.name,
        ...encoder.qualityArgs(28),
        '-f', 'null', '-',
      ],
      { timeout: 20_000 },
    )
    return true
  } catch {
    return false
  }
}

let cached: Promise<VideoEncoder> | null = null

/**
 * The best encoder this machine can actually use.
 *
 * Set PALMIER_ENCODER to force one by name — `libx264` to rule hardware out
 * entirely, which is the first thing to try when a render looks wrong.
 */
export function bestEncoder(): Promise<VideoEncoder> {
  if (cached) return cached
  cached = (async () => {
    const forced = process.env.PALMIER_ENCODER
    if (forced) {
      const match = [SOFTWARE, ...candidates()].find((encoder) => encoder.name === forced)
      if (match) return match
      // An unknown name is a typo worth surfacing rather than ignoring.
      return { ...SOFTWARE, name: forced, label: `${forced} (forced)`, hardware: false }
    }
    for (const candidate of candidates()) {
      if (await probe(candidate)) return candidate
    }
    return SOFTWARE
  })()
  return cached
}

/** The subset `src/core/render.ts` needs, with the quality already resolved. */
export function toSpec(encoder: VideoEncoder, crf: number): EncoderSpec {
  return {
    name: encoder.name,
    deviceArgs: encoder.deviceArgs,
    uploadFilter: encoder.uploadFilter,
    qualityArgs: encoder.qualityArgs(crf),
    // x264 preset names mean nothing to a hardware encoder and make it refuse.
    usesPreset: !encoder.hardware,
  }
}

let decodeCached: Promise<boolean> | null = null

/**
 * Whether `-hwaccel auto` actually decodes on this machine.
 *
 * Probed, not assumed, and for a worse reason than the encoders: on a machine
 * with no usable device, some FFmpeg builds do not fall back to the CPU — they
 * abort on an assertion inside the VAAPI loader. So a tiny clip is encoded in
 * software and then decoded with the flag; only a clean exit counts.
 */
export function hardwareDecodeWorks(): Promise<boolean> {
  if (decodeCached) return decodeCached
  decodeCached = (async () => {
    const sample = join(tmpdir(), `palmier-hwdec-${process.pid}-${Date.now()}.mp4`)
    try {
      await exec(
        FFMPEG_PATH,
        [
          '-hide_banner', '-v', 'error', '-nostdin', '-y',
          '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=0.4',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sample,
        ],
        { timeout: 20_000 },
      )
      await exec(
        FFMPEG_PATH,
        ['-hide_banner', '-v', 'error', '-nostdin', '-hwaccel', 'auto', '-i', sample, '-f', 'null', '-'],
        { timeout: 20_000 },
      )
      return true
    } catch {
      return false
    } finally {
      await rm(sample, { force: true }).catch(() => {})
    }
  })()
  return decodeCached
}

/** Forgets the probe result. Tests use it; nothing else should need to. */
export function resetEncoderCache(): void {
  cached = null
  decodeCached = null
}
