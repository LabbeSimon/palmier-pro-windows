import { describe, expect, it } from 'vitest'

import type { MediaAsset } from '../src/core/model.js'
import * as ops from '../src/core/ops.js'
import { atempoChain, buildFrameCommand, buildRenderCommand, RenderError, rotatedBounds } from '../src/core/render.js'

function videoAsset(name = 'a.mp4'): MediaAsset {
  return {
    id: crypto.randomUUID(), path: `C:/media/${name}`, name, type: 'video',
    durationSeconds: 10, width: 1920, height: 1080, fps: 30,
    hasAudio: true, sampleRate: 48000, channels: 2, thumbnailPath: null,
  }
}

function build(configure: (project: any, assetId: string) => any) {
  const media = videoAsset()
  const base = ops.addAssets(ops.emptyProject('T'), [media]).project
  const project = configure(base, media.id)
  const timeline = project.timelines[0]!
  return buildRenderCommand(project, timeline, { outputPath: 'C:/out/out.mp4' }, 'C:/tmp')
}

const filterGraph = (args: string[]) => args[args.indexOf('-filter_complex') + 1]!

describe('atempoChain', () => {
  it('passes 1x through untouched', () => {
    expect(atempoChain(1)).toEqual([])
  })

  it('chains stages beyond the 0.5–2.0 window', () => {
    expect(atempoChain(2)).toEqual(['atempo=2.000000'])
    expect(atempoChain(4)).toEqual(['atempo=2.000000', 'atempo=2.000000'])
    expect(atempoChain(0.25)).toEqual(['atempo=0.500000', 'atempo=0.500000'])
  })

  it('keeps every stage inside the range FFmpeg accepts', () => {
    for (const speed of [0.1, 0.25, 0.4, 3, 8, 16]) {
      for (const stage of atempoChain(speed)) {
        const factor = Number(stage.split('=')[1])
        expect(factor).toBeGreaterThanOrEqual(0.5)
        expect(factor).toBeLessThanOrEqual(2)
      }
    }
  })

  it('produces stages whose product is the requested speed', () => {
    for (const speed of [0.3, 0.75, 1.5, 3, 5.5]) {
      const product = atempoChain(speed).reduce((acc, stage) => acc * Number(stage.split('=')[1]), 1)
      expect(product).toBeCloseTo(speed, 5)
    }
  })

  it('rejects a non-positive speed', () => {
    expect(() => atempoChain(0)).toThrow(RenderError)
  })
})

describe('rotatedBounds', () => {
  it('leaves an unrotated box alone', () => {
    expect(rotatedBounds(100, 50, 0)).toEqual({ width: 100, height: 50 })
  })

  it('swaps the axes at 90 degrees', () => {
    const bounds = rotatedBounds(100, 50, 90)
    expect(bounds.width).toBeCloseTo(50, 6)
    expect(bounds.height).toBeCloseTo(100, 6)
  })

  it('grows the box at 45 degrees', () => {
    const bounds = rotatedBounds(100, 100, 45)
    expect(bounds.width).toBeCloseTo(141.42, 1)
  })
})

describe('buildRenderCommand', () => {
  it('refuses an empty timeline instead of writing a zero-length file', () => {
    const project = ops.emptyProject('T')
    expect(() => buildRenderCommand(project, project.timelines[0]!, { outputPath: 'o.mp4' }, 'tmp')).toThrow(
      /empty/,
    )
  })

  it('seeks the demuxer with the clip trim rather than trimming in the graph', () => {
    const command = build((project, assetId) =>
      ops.addClips(project, { clips: [{ assetId, trimStartFrame: 60, durationFrames: 90 }] }).project,
    )
    const ss = command.args.indexOf('-ss')
    expect(ss).toBeGreaterThanOrEqual(0)
    expect(command.args[ss + 1]).toBe('2.000000') // 60 frames at 30fps
    expect(command.args[command.args.indexOf('-t') + 1]).toBe('3.000000')
  })

  it('places each clip at its timeline offset and gates it with enable', () => {
    const command = build((project, assetId) =>
      ops.addClips(project, { clips: [{ assetId, startFrame: 90, durationFrames: 60 }] }).project,
    )
    const graph = filterGraph(command.args)
    expect(graph).toContain('setpts=PTS-STARTPTS+3.000000/TB')
    expect(graph).toContain("enable='between(t,3.000000,5.000000)'")
  })

  it('emits a video map always and an audio map only when audio exists', () => {
    const withAudio = build((project, assetId) => ops.addClips(project, { clips: [{ assetId }] }).project)
    expect(withAudio.args).toContain('[vout]')
    expect(withAudio.args).toContain('[aout]')

    const silent = build((project, assetId) => {
      const placed = ops.addClips(project, { clips: [{ assetId }] }).project
      const trackId = placed.timelines[0]!.tracks[0]!.id
      return ops.setTrackFlags(placed, { trackId, muted: true }).project
    })
    expect(silent.args).toContain('[vout]')
    expect(silent.args).not.toContain('[aout]')
  })

  it('drops a hidden track from the picture but keeps its audio', () => {
    const command = build((project, assetId) => {
      const placed = ops.addClips(project, { clips: [{ assetId }] }).project
      const trackId = placed.timelines[0]!.tracks[0]!.id
      return ops.setTrackFlags(placed, { trackId, hidden: true }).project
    })
    const graph = filterGraph(command.args)
    expect(graph).toContain('[base]null[vout]')
    expect(command.args).toContain('[aout]')
  })

  it('chains atempo for a retimed clip', () => {
    const command = build((project, assetId) =>
      ops.addClips(project, { clips: [{ assetId, durationFrames: 60, speed: 4 }] }).project,
    )
    const graph = filterGraph(command.args)
    expect(graph).toContain('setpts=PTS/4.000000')
    expect(graph).toContain('atempo=2.000000,atempo=2.000000')
  })

  it('writes text to a sidecar instead of escaping it into the graph', () => {
    const command = build((project, assetId) => {
      const placed = ops.addClips(project, { clips: [{ assetId, durationFrames: 90 }] }).project
      const withTrack = ops.addTrack(placed, { type: 'video', name: 'V2' }).project
      return ops.addTexts(withTrack, {
        texts: [{ content: "It's 50% done: a,b\\c", startFrame: 0, durationFrames: 30 }],
      }).project
    })
    expect(command.sidecars).toHaveLength(1)
    expect(command.sidecars[0]!.content).toBe("It's 50% done: a,b\\c")
    const graph = filterGraph(command.args)
    expect(graph).toContain('drawtext=')
    expect(graph).toContain('textfile=')
    expect(graph).not.toContain('50% done')
  })

  it('disables drawtext expansion so % and %{} in a title render literally', () => {
    const command = build((project, assetId) => {
      const placed = ops.addClips(project, { clips: [{ assetId, durationFrames: 90 }] }).project
      const withTrack = ops.addTrack(placed, { type: 'video', name: 'V2' }).project
      return ops.addTexts(withTrack, {
        texts: [{ content: '100% fait maison %{pts}', startFrame: 0, durationFrames: 30 }],
      }).project
    })
    expect(filterGraph(command.args)).toContain('expansion=none')
  })

  it('composites bottom-up, so a later track overlays an earlier one', () => {
    const command = build((project, assetId) => {
      const placed = ops.addClips(project, { clips: [{ assetId, durationFrames: 60 }] }).project
      const withTrack = ops.addTrack(placed, { type: 'video', name: 'V2' }).project
      const v2 = withTrack.timelines[0]!.tracks.find((t: any) => t.name === 'V2')!
      return ops.addClips(withTrack, { clips: [{ assetId, trackId: v2.id, durationFrames: 60 }] }).project
    })
    const graph = filterGraph(command.args)
    // Stage 0 overlays the bottom track onto base, stage 1 overlays the top onto stage 0.
    expect(graph).toContain('[base][cv0]overlay')
    expect(graph).toContain('[vs0][cv1]overlay')
  })

  it('refuses a crop that removes the whole frame', () => {
    expect(() =>
      build((project, assetId) => {
        const placed = ops.addClips(project, { clips: [{ assetId, durationFrames: 30 }] }).project
        const clipId = placed.timelines[0]!.tracks[0]!.clips[0]!.id
        return ops.setClipProperties(placed, { clipIds: [clipId], properties: { crop: { left: 0.5, right: 0.5 } } })
          .project
      }),
    ).toThrow(/crop removes the entire frame/)
  })

  it('reports the frame count it will produce', () => {
    const command = build((project, assetId) =>
      ops.addClips(project, { clips: [{ assetId, startFrame: 0, durationFrames: 123 }] }).project,
    )
    expect(command.totalFrames).toBe(123)
  })

  it('scales even dimensions, because yuv420p cannot encode odd ones', () => {
    const command = build((project, assetId) => {
      const placed = ops.addClips(project, { clips: [{ assetId, durationFrames: 30 }] }).project
      const clipId = placed.timelines[0]!.tracks[0]!.clips[0]!.id
      return ops.setClipProperties(placed, {
        clipIds: [clipId],
        properties: { transform: { scaleX: 0.333, scaleY: 0.333 } },
      }).project
    })
    const scale = /scale=(\d+):(\d+)/.exec(filterGraph(command.args))!
    expect(Number(scale[1]) % 2).toBe(0)
    expect(Number(scale[2]) % 2).toBe(0)
  })
})

describe('buildFrameCommand', () => {
  it('produces a single image without an audio map', () => {
    const media = videoAsset()
    const base = ops.addAssets(ops.emptyProject('T'), [media]).project
    const project = ops.addClips(base, { clips: [{ assetId: media.id, durationFrames: 90 }] }).project
    const command = buildFrameCommand(project, project.timelines[0]!, 30, 'C:/tmp/f.png', 'C:/tmp')

    expect(command.args).toContain('-frames:v')
    expect(command.args).not.toContain('[aout]')
    expect(command.args.at(-1)).toBe('C:/tmp/f.png')
  })
})
