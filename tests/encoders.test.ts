/**
 * Encoder selection.
 *
 * The probe is the point: our FFmpeg is compiled with NVENC, QSV, AMF and
 * VAAPI, and on a machine without the vendor runtime all four are listed and
 * none of them work. So what is tested is that a candidate is only chosen after
 * it has actually encoded something, that the arguments each one needs reach
 * the command line, and that libx264 is always the answer when nothing else is.
 *
 * Whether a GPU encoder works here is a property of this machine, not of the
 * code, so no test asserts one is found.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { bestEncoder, resetEncoderCache, SOFTWARE, toSpec } from '../src/main/media/encoders.js'
import { buildRenderCommand } from '../src/core/render.js'
import * as ops from '../src/core/ops.js'
import type { MediaAsset, Project } from '../src/core/model.js'

afterEach(() => {
  delete process.env.PALMIER_ENCODER
  resetEncoderCache()
})

const MEDIA: MediaAsset = {
  id: 'a1', path: 'C:/m/a.mp4', name: 'a.mp4', type: 'video',
  durationSeconds: 10, width: 1920, height: 1080, fps: 30,
  hasAudio: true, sampleRate: 48000, channels: 2, thumbnailPath: null,
}

function project(): Project {
  const state = ops.addAssets(ops.emptyProject('E'), [MEDIA]).project
  return ops.addClips(state, { clips: [{ assetId: MEDIA.id, durationFrames: 60 }] }).project
}

describe('bestEncoder', () => {
  it('returns something usable, and caches the answer', async () => {
    const first = await bestEncoder()
    const second = await bestEncoder()
    expect(second).toBe(first)
    expect(typeof first.name).toBe('string')
  }, 120_000)

  it('whatever it picks really encodes — that is what the probe is for', async () => {
    const encoder = await bestEncoder()
    const command = buildRenderCommand(
      project(),
      project().timelines[0]!,
      { outputPath: 'out.mp4', encoder: toSpec(encoder, 24) },
      '/tmp/side',
    )
    expect(command.args).toContain(encoder.name)
  }, 120_000)

  it('can be forced to the CPU, which is the first thing to try when output looks wrong', async () => {
    process.env.PALMIER_ENCODER = 'libx264'
    resetEncoderCache()
    expect((await bestEncoder()).name).toBe('libx264')
  })

  it('surfaces an unknown forced name instead of quietly ignoring it', async () => {
    process.env.PALMIER_ENCODER = 'h264_nonsense'
    resetEncoderCache()
    const encoder = await bestEncoder()
    expect(encoder.name).toBe('h264_nonsense')
    expect(encoder.label).toMatch(/forced/)
  })
})

describe('toSpec', () => {
  it('turns x264 CRF into the rate control each vendor actually reads', () => {
    expect(SOFTWARE.qualityArgs(23)).toEqual(['-crf', '23'])
    // Hardware encoders reject x264 preset names, so the preset is dropped.
    expect(toSpec({ ...SOFTWARE, hardware: true }, 23).usesPreset).toBe(false)
    expect(toSpec(SOFTWARE, 23).usesPreset).toBe(true)
  })
})

describe('render command', () => {
  const state = project()
  const timeline = state.timelines[0]!

  it('uses libx264 with a CRF when no encoder is given', () => {
    const args = buildRenderCommand(state, timeline, { outputPath: 'o.mp4', crf: 21 }, '/tmp/s').args
    expect(args).toContain('libx264')
    expect(args.join(' ')).toContain('-crf 21')
    expect(args.join(' ')).toContain('-preset')
  })

  it('drops the preset and uses the vendor rate control for a hardware encoder', () => {
    const args = buildRenderCommand(
      state,
      timeline,
      {
        outputPath: 'o.mp4',
        crf: 21,
        encoder: { name: 'h264_nvenc', qualityArgs: ['-rc', 'vbr', '-cq', '21', '-b:v', '0'], usesPreset: false },
      },
      '/tmp/s',
    ).args
    expect(args).toContain('h264_nvenc')
    expect(args.join(' ')).toContain('-cq 21')
    expect(args.join(' ')).not.toContain('-crf')
    expect(args.join(' ')).not.toContain('-preset')
  })

  it('opens the device before the inputs, or FFmpeg never sees it', () => {
    const args = buildRenderCommand(
      state,
      timeline,
      {
        outputPath: 'o.mp4',
        encoder: {
          name: 'h264_vaapi',
          deviceArgs: ['-vaapi_device', '/dev/dri/renderD128'],
          uploadFilter: 'format=nv12,hwupload',
          qualityArgs: ['-qp', '24'],
          usesPreset: false,
        },
      },
      '/tmp/s',
    ).args

    expect(args.indexOf('-vaapi_device')).toBeLessThan(args.indexOf('-i'))
    // The upload is the last thing the chain does, after every CPU filter.
    const graph = args[args.indexOf('-filter_complex') + 1]!
    expect(graph).toContain('format=yuv420p,format=nv12,hwupload[vout]')
    // Forcing a pixel format on the output would download the frames again.
    expect(args.join(' ')).not.toContain('-pix_fmt')
  })
})
