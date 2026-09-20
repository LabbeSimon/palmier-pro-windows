import { describe, expect, it } from 'vitest'

import { formatSrt, formatVtt, parseSubtitles } from '../src/core/subtitles.js'
import * as ops from '../src/core/ops.js'
import { secondsToFrames } from '../src/core/timecode.js'

const SAMPLE = `1
00:00:01,000 --> 00:00:04,000
Hello there

2
00:00:05,500 --> 00:00:07,250
Line one
Line two
`

describe('parseSubtitles', () => {
  it('reads a plain SRT file, keeping internal line breaks', () => {
    const { cues, skipped } = parseSubtitles(SAMPLE)
    expect(skipped).toEqual([])
    expect(cues).toEqual([
      { startSeconds: 1, endSeconds: 4, text: 'Hello there' },
      { startSeconds: 5.5, endSeconds: 7.25, text: 'Line one\nLine two' },
    ])
  })

  it('survives a BOM, CRLF line endings and a missing trailing newline', () => {
    const gnarly = '﻿' + SAMPLE.replace(/\n/g, '\r\n').trimEnd()
    expect(parseSubtitles(gnarly).cues).toHaveLength(2)
  })

  it('accepts dots instead of commas, and cues with no index', () => {
    const { cues } = parseSubtitles('00:00:02.000 --> 00:00:03.000\nNo index here')
    expect(cues).toEqual([{ startSeconds: 2, endSeconds: 3, text: 'No index here' }])
  })

  it('reads WebVTT, header and short timestamps included', () => {
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.500\nShort form'
    expect(parseSubtitles(vtt).cues).toEqual([
      { startSeconds: 1, endSeconds: 2.5, text: 'Short form' },
    ])
  })

  it('sorts by time rather than trusting the file order', () => {
    const jumbled = `2
00:00:09,000 --> 00:00:10,000
Later

1
00:00:01,000 --> 00:00:02,000
Earlier`
    expect(parseSubtitles(jumbled).cues.map((c) => c.text)).toEqual(['Earlier', 'Later'])
  })

  it('strips the markup authoring tools leave behind', () => {
    const { cues } = parseSubtitles('00:00:01,000 --> 00:00:02,000\n<i>Italic</i> and {\\an8}positioned')
    expect(cues[0]!.text).toBe('Italic and positioned')
  })

  it('names what it skipped instead of silently dropping it', () => {
    const broken = `1
not a time range
Some text

2
00:00:05,000 --> 00:00:04,000
Ends too early

3
00:00:08,000 --> 00:00:09,000
`
    const { cues, skipped } = parseSubtitles(broken)
    expect(cues).toEqual([])
    expect(skipped).toHaveLength(3)
    expect(skipped[0]).toMatch(/no "-->" time range/)
    expect(skipped[1]).toMatch(/ends at or before it starts/)
    expect(skipped[2]).toMatch(/no text/)
  })

  it('returns nothing rather than throwing on an empty or junk file', () => {
    expect(parseSubtitles('').cues).toEqual([])
    expect(parseSubtitles('\n\n\n').cues).toEqual([])
  })
})

describe('formatSrt', () => {
  it('round-trips a file through parse and format', () => {
    const { cues } = parseSubtitles(SAMPLE)
    expect(parseSubtitles(formatSrt(cues)).cues).toEqual(cues)
  })

  it('renumbers from one in time order', () => {
    const out = formatSrt([
      { startSeconds: 9, endSeconds: 10, text: 'B' },
      { startSeconds: 1, endSeconds: 2, text: 'A' },
    ])
    expect(out).toBe('1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:09,000 --> 00:00:10,000\nB\n')
  })

  it('never prints a sixtieth second when milliseconds round up', () => {
    expect(formatSrt([{ startSeconds: 59.9999, endSeconds: 61, text: 'x' }])).toContain(
      '00:01:00,000 --> 00:01:01,000',
    )
  })

  it('writes WebVTT with dots and a header', () => {
    const out = formatVtt([{ startSeconds: 1.5, endSeconds: 2, text: 'A' }])
    expect(out).toBe('WEBVTT\n\n00:00:01.500 --> 00:00:02.000\nA\n')
  })
})

// --- Placing them on a timeline -------------------------------------------

function project() {
  return ops.emptyProject('S')
}

const cue = (startSeconds: number, endSeconds: number, text: string, fps = 30) => ({
  startFrame: secondsToFrames(startSeconds, fps),
  durationFrames: secondsToFrames(endSeconds - startSeconds, fps),
  text,
})

describe('addSubtitles', () => {
  it('creates a subtitle track on first use and places the cues on it', () => {
    const { project: state, receipt } = ops.addSubtitles(project(), {
      subtitles: [cue(1, 4, 'Hello'), cue(5, 6, 'Again')],
    })
    const track = state.timelines[0]!.tracks.find((t) => t.type === 'subtitle')!
    expect(track.name).toBe('S1')
    expect(track.clips).toHaveLength(2)
    expect(track.clips[0]!.textContent).toBe('Hello')
    expect(track.clips[0]!.mediaType).toBe('subtitle')
    expect(receipt.changed).toBe(true)
  })

  it('reuses the subtitle track that already exists', () => {
    let state = ops.addSubtitles(project(), { subtitles: [cue(1, 2, 'One')] }).project
    state = ops.addSubtitles(state, { subtitles: [cue(3, 4, 'Two')] }).project
    expect(state.timelines[0]!.tracks.filter((t) => t.type === 'subtitle')).toHaveLength(1)
  })

  it('anchors cues near the bottom of frame with a readable style', () => {
    const state = ops.addSubtitles(project(), { subtitles: [cue(1, 2, 'Hello')] }).project
    const clip = state.timelines[0]!.tracks.find((t) => t.type === 'subtitle')!.clips[0]!
    expect(clip.transform.centerY).toBeGreaterThan(0.8)
    expect(clip.textStyle!.backgroundColor).not.toBeNull()
  })

  it('moves an overlapping cue instead of refusing the whole import, and says so', () => {
    const { project: state, receipt } = ops.addSubtitles(project(), {
      subtitles: [cue(1, 4, 'First'), cue(3, 6, 'Second')],
    })
    const clips = state.timelines[0]!.tracks.find((t) => t.type === 'subtitle')!.clips
    expect(clips).toHaveLength(2)
    expect(clips[1]!.startFrame).toBe(clips[0]!.startFrame + clips[0]!.durationFrames)
    expect(receipt.warnings.join(' ')).toMatch(/overlapped the cue before it and was moved/)
  })

  it('drops a cue swallowed whole by its predecessor, naming it', () => {
    const { receipt } = ops.addSubtitles(project(), {
      subtitles: [cue(1, 10, 'Long one'), cue(2, 3, 'Swallowed')],
    })
    expect(receipt.affectedIds).toHaveLength(1)
    expect(receipt.warnings.join(' ')).toMatch(/"Swallowed".*dropped/)
  })

  it('refuses a track that is not a subtitle track, by name', () => {
    const state = project()
    const videoTrack = state.timelines[0]!.tracks[0]!.id
    expect(() =>
      ops.addSubtitles(state, { trackId: videoTrack, subtitles: [cue(1, 2, 'x')] }),
    ).toThrow(/is a video track, not a subtitle track/)
  })

  it('refuses an empty cue rather than placing a blank clip', () => {
    expect(() => ops.addSubtitles(project(), { subtitles: [cue(1, 2, '   ')] })).toThrow(
      /must be a non-empty string/,
    )
  })

  it('will not write to a locked subtitle track', () => {
    let state = ops.addSubtitles(project(), { subtitles: [cue(1, 2, 'One')] }).project
    const trackId = state.timelines[0]!.tracks.find((t) => t.type === 'subtitle')!.id
    state = ops.setTrackFlags(state, { trackId, locked: true }).project
    expect(() => ops.addSubtitles(state, { subtitles: [cue(5, 6, 'Two')] })).toThrow(/locked/i)
  })
})

describe('subtitleCues', () => {
  it('reads them back in time order, ready to be written out', () => {
    const state = ops.addSubtitles(project(), {
      subtitles: [cue(5, 6, 'Second'), cue(1, 2, 'First')],
    }).project
    expect(ops.subtitleCues(state.timelines[0]!).map((c) => c.clip.textContent)).toEqual([
      'First',
      'Second',
    ])
  })

  it('is empty on a timeline with no subtitle track', () => {
    expect(ops.subtitleCues(project().timelines[0]!)).toEqual([])
  })
})
