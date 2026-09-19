import { describe, expect, it } from 'vitest'

import { framesToSeconds, framesToTimecode, secondsToFrames, timecodeToFrames } from '../src/core/timecode.js'

describe('framesToTimecode', () => {
  it.each([
    [0, 30, '00:00:00:00'],
    [29, 30, '00:00:00:29'],
    [30, 30, '00:00:01:00'],
    [1800, 30, '00:01:00:00'],
    [108000, 30, '01:00:00:00'],
    [25, 25, '00:00:01:00'],
  ])('renders %i frames at %i fps as %s', (frames, fps, expected) => {
    expect(framesToTimecode(frames, fps)).toBe(expected)
  })
})

describe('timecodeToFrames', () => {
  it('round-trips through framesToTimecode', () => {
    for (const frames of [0, 1, 29, 30, 451, 3600, 108001]) {
      expect(timecodeToFrames(framesToTimecode(frames, 30), 30)).toBe(frames)
    }
  })

  it('accepts a bare frame count and the short MM:SS:FF form', () => {
    expect(timecodeToFrames('90', 30)).toBe(90)
    expect(timecodeToFrames('01:00:00', 30)).toBe(1800)
  })

  it('rejects malformed input rather than guessing', () => {
    expect(timecodeToFrames('not a timecode', 30)).toBeNull()
    expect(timecodeToFrames('00:00:00:30', 30)).toBeNull() // frame 30 does not exist at 30 fps
    expect(timecodeToFrames('00:60:00:00', 30)).toBeNull()
    expect(timecodeToFrames('1:2', 30)).toBeNull()
  })
})

describe('frame/second conversion', () => {
  it('rejects a non-finite or zero frame rate instead of returning Infinity', () => {
    expect(() => framesToSeconds(30, 0)).toThrow()
    expect(() => secondsToFrames(1, NaN)).toThrow()
    expect(() => framesToSeconds(NaN, 30)).toThrow()
  })

  it('rounds to the nearest frame', () => {
    expect(secondsToFrames(1.49 / 30, 30)).toBe(1)
    expect(secondsToFrames(1.51 / 30, 30)).toBe(2)
  })
})
