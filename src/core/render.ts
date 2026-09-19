/**
 * Compiles a timeline into an FFmpeg invocation.
 *
 * Pure and synchronous so it can be unit-tested without FFmpeg present: it takes
 * the project and returns argv plus any sidecar files the caller must write first
 * (drawtext payloads, which avoid filter-graph escaping entirely).
 *
 * Track order is bottom-up: tracks[0] composites first, later tracks over it.
 */

import {
  clipEndFrame,
  isVisual,
  sourceFramesConsumed,
  timelineTotalFrames,
  type Clip,
  type MediaAsset,
  type Project,
  type Timeline,
} from './model.js'
import { ffmpegTime, framesToSeconds } from './timecode.js'

export interface RenderOptions {
  outputPath: string
  /** Constant Rate Factor; lower is better quality. */
  crf?: number
  preset?: 'ultrafast' | 'veryfast' | 'fast' | 'medium' | 'slow'
  videoCodec?: 'libx264' | 'libx265'
  audioBitrate?: string
  /** Render only this frame range; defaults to the whole timeline. */
  startFrame?: number
  endFrame?: number
  /** Skip the audio graph entirely. Used by still-frame capture. */
  videoOnly?: boolean
}

export interface Sidecar {
  path: string
  content: string
}

export interface RenderCommand {
  args: string[]
  sidecars: Sidecar[]
  /** Frames the command will produce, for progress reporting. */
  totalFrames: number
}

export class RenderError extends Error {}

/** FFmpeg filter arguments treat `\`, `:`, `'` and `,` as syntax. */
function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/:/g, '\\:')
}

function even(value: number): number {
  const rounded = Math.max(2, Math.round(value))
  return rounded % 2 === 0 ? rounded : rounded + 1
}

/** atempo only accepts 0.5–2.0, so a wider change has to be chained. */
export function atempoChain(speed: number): string[] {
  if (!Number.isFinite(speed) || speed <= 0) throw new RenderError(`invalid speed ${speed}`)
  const stage = (factor: number) => `atempo=${factor.toFixed(6)}`
  const stages: string[] = []
  let remaining = speed
  while (remaining > 2) {
    stages.push(stage(2))
    remaining /= 2
  }
  while (remaining < 0.5) {
    stages.push(stage(0.5))
    remaining /= 0.5
  }
  if (Math.abs(remaining - 1) > 1e-6) stages.push(stage(remaining))
  return stages
}

/** Axis-aligned bounding box of a w×h rectangle rotated by `degrees`. */
export function rotatedBounds(width: number, height: number, degrees: number): { width: number; height: number } {
  const rad = (degrees * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  return { width: width * cos + height * sin, height: width * sin + height * cos }
}

/** Piecewise-linear alpha expression covering the clip's fade envelope, in graph time. */
function fadeAlphaExpression(clip: Clip, fps: number, timelineStartSeconds: number): string | null {
  if (clip.fadeInFrames === 0 && clip.fadeOutFrames === 0) return null
  const start = framesToSeconds(clip.startFrame, fps) - timelineStartSeconds
  const end = framesToSeconds(clipEndFrame(clip), fps) - timelineStartSeconds
  const inDur = framesToSeconds(clip.fadeInFrames, fps)
  const outDur = framesToSeconds(clip.fadeOutFrames, fps)
  const parts: string[] = []
  if (inDur > 0) parts.push(`if(lt(t,${(start + inDur).toFixed(6)}),(t-${start.toFixed(6)})/${inDur.toFixed(6)}`)
  if (outDur > 0) parts.push(`if(gt(t,${(end - outDur).toFixed(6)}),(${end.toFixed(6)}-t)/${outDur.toFixed(6)}`)
  const base = String(clip.opacity)
  const expr = parts.reduceRight((acc, part) => `${part},${acc})`, base)
  return `min(1,max(0,${expr}))*${base}`
}

interface ResolvedClip {
  clip: Clip
  asset: MediaAsset | null
  trackMuted: boolean
  trackHidden: boolean
  /** Bottom-up composite order. */
  layer: number
}

function resolveClips(project: Project, timeline: Timeline, startFrame: number, endFrame: number): ResolvedClip[] {
  const resolved: ResolvedClip[] = []
  timeline.tracks.forEach((track, layer) => {
    for (const clip of track.clips) {
      if (clipEndFrame(clip) <= startFrame || clip.startFrame >= endFrame) continue
      const asset = clip.mediaRef ? (project.assets.find((a) => a.id === clip.mediaRef) ?? null) : null
      if (clip.mediaType !== 'text' && !asset) {
        throw new RenderError(`clip ${clip.id} references missing media ${clip.mediaRef}`)
      }
      resolved.push({ clip, asset, trackMuted: track.muted, trackHidden: track.hidden, layer })
    }
  })
  return resolved.sort((a, b) => a.layer - b.layer || a.clip.startFrame - b.clip.startFrame)
}

export function buildRenderCommand(
  project: Project,
  timeline: Timeline,
  options: RenderOptions,
  sidecarDir: string,
): RenderCommand {
  const { fps, width, height } = timeline
  const startFrame = options.startFrame ?? 0
  const endFrame = options.endFrame ?? timelineTotalFrames(timeline)
  if (endFrame <= startFrame) throw new RenderError('the timeline is empty; nothing to render')

  const totalFrames = endFrame - startFrame
  const totalSeconds = framesToSeconds(totalFrames, fps)
  const timelineStartSeconds = framesToSeconds(startFrame, fps)

  const resolved = resolveClips(project, timeline, startFrame, endFrame)
  const inputArgs: string[] = []
  const filters: string[] = []
  const sidecars: Sidecar[] = []

  // Black canvas at the timeline's exact geometry; every visual clip overlays onto it.
  filters.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${totalSeconds.toFixed(6)}[base]`)

  let inputIndex = 0
  let videoLabel = 'base'
  let videoStage = 0
  const audioLabels: string[] = []

  for (const { clip, asset, trackMuted, trackHidden } of resolved) {
    const clipStartSeconds = framesToSeconds(clip.startFrame, fps) - timelineStartSeconds
    const clipEndSeconds = framesToSeconds(clipEndFrame(clip), fps) - timelineStartSeconds
    const enable = `between(t,${clipStartSeconds.toFixed(6)},${clipEndSeconds.toFixed(6)})`

    // --- Text: drawn straight onto the composite, no input stream needed.
    if (clip.mediaType === 'text') {
      if (trackHidden || !clip.textContent) continue
      const style = clip.textStyle!
      const sidecarPath = `${sidecarDir}/text-${clip.id}.txt`
      sidecars.push({ path: sidecarPath, content: clip.textContent })

      const x = `(w-text_w)*${clip.transform.centerX.toFixed(4)}`
      const y = `(h-text_h)*${clip.transform.centerY.toFixed(4)}`
      const size = Math.max(1, Math.round(style.fontSize * clip.transform.scaleY))
      const alpha = fadeAlphaExpression(clip, fps, timelineStartSeconds) ?? String(clip.opacity)

      const parts = [
        `textfile='${escapeFilterPath(sidecarPath)}'`,
        // The sidecar avoids filter-graph escaping, but drawtext still expands `%` and
        // `%{...}` in the loaded text. User titles must render literally.
        'expansion=none',
        `fontsize=${size}`,
        `fontcolor=${style.color}`,
        `alpha='${alpha}'`,
        `x=${x}`,
        `y=${y}`,
        `enable='${enable}'`,
      ]
      if (style.strokeColor && style.strokeWidth > 0) {
        parts.push(`borderw=${Math.round(style.strokeWidth)}`, `bordercolor=${style.strokeColor}`)
      }
      if (style.backgroundColor) parts.push('box=1', `boxcolor=${style.backgroundColor}`, 'boxborderw=12')

      const out = `vs${videoStage++}`
      filters.push(`[${videoLabel}]drawtext=${parts.join(':')}[${out}]`)
      videoLabel = out
      continue
    }

    const source = asset!
    const sourceStartSeconds = framesToSeconds(clip.trimStartFrame, fps)
    const sourceDurationSeconds = framesToSeconds(sourceFramesConsumed(clip), fps)

    // --- Input. -ss before -i seeks the demuxer, which is far cheaper than trimming in the graph.
    if (source.type === 'image') {
      inputArgs.push('-loop', '1', '-framerate', String(fps), '-t', sourceDurationSeconds.toFixed(6), '-i', source.path)
    } else {
      inputArgs.push('-ss', sourceStartSeconds.toFixed(6), '-t', sourceDurationSeconds.toFixed(6), '-i', source.path)
    }
    const index = inputIndex++

    // --- Video branch.
    if (isVisual(clip.mediaType) && !trackHidden && source.type !== 'audio') {
      const chain: string[] = []
      const { crop } = clip
      const cropped = crop.top + crop.bottom + crop.left + crop.right > 0
      if (cropped) {
        if (crop.left + crop.right >= 1 || crop.top + crop.bottom >= 1) {
          throw new RenderError(`clip ${clip.id}: crop removes the entire frame`)
        }
        chain.push(
          `crop=w=iw*${(1 - crop.left - crop.right).toFixed(6)}:h=ih*${(1 - crop.top - crop.bottom).toFixed(6)}` +
            `:x=iw*${crop.left.toFixed(6)}:y=ih*${crop.top.toFixed(6)}`,
        )
      }

      // Fit the (cropped) source into the canvas, then apply the clip's own scale.
      const srcW = Math.max(1, source.width * (1 - crop.left - crop.right))
      const srcH = Math.max(1, source.height * (1 - crop.top - crop.bottom))
      const fit = Math.min(width / srcW, height / srcH)
      const drawW = even(srcW * fit * clip.transform.scaleX)
      const drawH = even(srcH * fit * clip.transform.scaleY)
      chain.push(`scale=${drawW}:${drawH}:flags=bicubic`)

      let boxW = drawW
      let boxH = drawH
      if (Math.abs(clip.transform.rotation) > 1e-6) {
        const bounds = rotatedBounds(drawW, drawH, clip.transform.rotation)
        boxW = even(bounds.width)
        boxH = even(bounds.height)
        chain.push(
          `rotate=${((clip.transform.rotation * Math.PI) / 180).toFixed(6)}:ow=${boxW}:oh=${boxH}:fillcolor=none`,
        )
      }

      if (clip.speed !== 1) chain.push(`setpts=PTS/${clip.speed.toFixed(6)}`)
      chain.push(`fps=${fps}`, 'format=yuva420p')

      if (clip.fadeInFrames > 0) {
        chain.push(`fade=t=in:st=0:d=${framesToSeconds(clip.fadeInFrames, fps).toFixed(6)}:alpha=1`)
      }
      if (clip.fadeOutFrames > 0) {
        const outStart = framesToSeconds(clip.durationFrames - clip.fadeOutFrames, fps)
        chain.push(`fade=t=out:st=${outStart.toFixed(6)}:d=${framesToSeconds(clip.fadeOutFrames, fps).toFixed(6)}:alpha=1`)
      }
      if (clip.opacity < 1) chain.push(`colorchannelmixer=aa=${clip.opacity.toFixed(6)}`)

      // Shift the stream to its timeline position so `enable` and overlay agree.
      chain.push(`setpts=PTS-STARTPTS+${clipStartSeconds.toFixed(6)}/TB`)

      const prepared = `cv${index}`
      filters.push(`[${index}:v]${chain.join(',')}[${prepared}]`)

      const x = Math.round(clip.transform.centerX * width - boxW / 2)
      const y = Math.round(clip.transform.centerY * height - boxH / 2)
      const out = `vs${videoStage++}`
      filters.push(
        `[${videoLabel}][${prepared}]overlay=x=${x}:y=${y}:enable='${enable}':eof_action=pass:shortest=0[${out}]`,
      )
      videoLabel = out
    }

    // --- Audio branch.
    const carriesAudio = source.hasAudio || source.type === 'audio'
    if (carriesAudio && !trackMuted && clip.volume > 0 && !options.videoOnly) {
      const chain: string[] = ['aresample=48000', 'asetpts=PTS-STARTPTS']
      if (clip.speed !== 1) chain.push(...atempoChain(clip.speed))
      if (clip.volume !== 1) chain.push(`volume=${clip.volume.toFixed(6)}`)
      if (clip.fadeInFrames > 0) {
        chain.push(`afade=t=in:st=0:d=${framesToSeconds(clip.fadeInFrames, fps).toFixed(6)}`)
      }
      if (clip.fadeOutFrames > 0) {
        const outStart = framesToSeconds(clip.durationFrames - clip.fadeOutFrames, fps)
        chain.push(`afade=t=out:st=${outStart.toFixed(6)}:d=${framesToSeconds(clip.fadeOutFrames, fps).toFixed(6)}`)
      }
      // adelay wants integer milliseconds and one value per channel.
      const delayMs = Math.max(0, Math.round(clipStartSeconds * 1000))
      if (delayMs > 0) chain.push(`adelay=${delayMs}:all=1`)

      const label = `ca${index}`
      filters.push(`[${index}:a]${chain.join(',')}[${label}]`)
      audioLabels.push(label)
    }
  }

  if (videoStage === 0) {
    // Nothing visual: still emit a valid stream so the file is playable.
    filters.push(`[base]null[vout]`)
  } else {
    filters.push(`[${videoLabel}]format=yuv420p[vout]`)
  }

  const hasAudio = audioLabels.length > 0
  if (hasAudio) {
    filters.push(
      // duration=longest pads the shorter branches with silence, so no apad is needed.
      `${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:duration=longest:` +
        `normalize=0:dropout_transition=0,atrim=0:${totalSeconds.toFixed(6)},asetpts=PTS-STARTPTS,` +
        `alimiter=limit=0.98[aout]`,
    )
  }

  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    ...inputArgs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    ...(hasAudio ? ['-map', '[aout]'] : []),
    '-c:v',
    options.videoCodec ?? 'libx264',
    '-preset',
    options.preset ?? 'medium',
    '-crf',
    String(options.crf ?? 20),
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', options.audioBitrate ?? '192k'] : []),
    '-t',
    ffmpegTime(totalFrames, fps),
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    options.outputPath,
  ]

  return { args, sidecars, totalFrames }
}

/** Single-frame extract used by the preview and by the capture_frame MCP tool. */
export function buildFrameCommand(
  project: Project,
  timeline: Timeline,
  frame: number,
  outputPath: string,
  sidecarDir: string,
): RenderCommand {
  const command = buildRenderCommand(
    project,
    timeline,
    { outputPath, startFrame: frame, endFrame: frame + 1, preset: 'ultrafast', videoOnly: true },
    sidecarDir,
  )
  // Replace the encoder tail with a single-image sink.
  const head = command.args.slice(0, command.args.indexOf('-c:v'))
  return {
    ...command,
    args: [...head, '-frames:v', '1', '-q:v', '2', '-update', '1', outputPath],
  }
}
