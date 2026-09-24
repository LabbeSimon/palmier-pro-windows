/**
 * What an export quality means, once.
 *
 * The UI's export dialog and the `export_project` tool each carried their own
 * copy of this table, and the tool's copy had quietly stayed on the CPU when
 * the dialog moved to the GPU — an agent exporting the same edit waited several
 * times longer for no reason anyone could see. One table, one encoder choice.
 */

import type { RenderOptions } from '../../core/render.js'
import { bestEncoder, hardwareDecodeWorks, SOFTWARE, toSpec, type VideoEncoder } from './encoders.js'
import { getPerformance } from './performance.js'

export const EXPORT_QUALITIES = ['draft', 'balanced', 'high'] as const
export type ExportQuality = (typeof EXPORT_QUALITIES)[number]

const QUALITY: Record<ExportQuality, { crf: number; preset: NonNullable<RenderOptions['preset']> }> = {
  draft: { crf: 28, preset: 'veryfast' },
  balanced: { crf: 20, preset: 'medium' },
  high: { crf: 16, preset: 'slow' },
}

export interface ExportSetup {
  options: Omit<RenderOptions, 'outputPath'>
  encoder: VideoEncoder
}

/**
 * Render options for an export.
 *
 * Hardware by default, because the wait is what people actually feel. At the
 * same target a GPU encoder gives up some efficiency against x264 on a slow
 * preset — a slightly larger file for the same picture — and it can be turned
 * off per export when the size matters more.
 *
 * Never proxies: an export always reads the originals. That is the one rule of
 * proxy editing that matters, and it is enforced by never setting the flag.
 */
export async function exportSetup(quality: ExportQuality = 'balanced', hardware = true): Promise<ExportSetup> {
  const settings = QUALITY[quality]
  const encoder = hardware ? await bestEncoder() : SOFTWARE
  const hardwareDecode = getPerformance().hardwareDecode && (await hardwareDecodeWorks())
  return {
    encoder,
    options: {
      ...settings,
      encoder: toSpec(encoder, settings.crf),
      hardwareDecode,
    },
  }
}
