/**
 * Subtitle files.
 *
 * SRT is not a specification so much as a convention, and real files break every
 * rule of it: BOMs, CRLF, missing blank lines, indices out of order or absent,
 * dots instead of commas. The parser is deliberately forgiving about all of
 * that and strict about only one thing — a cue must have a usable time range,
 * because a cue without one has nowhere to go on a timeline.
 *
 * WebVTT is read by the same parser: the body is close enough that rejecting it
 * would be pedantry. Only writing distinguishes the two.
 */

export interface Cue {
  /** Seconds from the start of the file. */
  startSeconds: number
  endSeconds: number
  /** Newlines are kept; they are meaningful line breaks in a subtitle. */
  text: string
}

export interface ParseResult {
  cues: Cue[]
  /** Lines that looked like cues but could not be used, with the reason. */
  skipped: string[]
}

const TIME_RANGE =
  /^\s*(\d{1,3}):([0-5]?\d):([0-5]?\d)[,.](\d{1,3})\s*-->\s*(\d{1,3}):([0-5]?\d):([0-5]?\d)[,.](\d{1,3})/

/** Also accepts the `MM:SS.mmm` form WebVTT allows for files under an hour. */
const SHORT_RANGE = /^\s*(\d{1,3}):([0-5]?\d)[,.](\d{1,3})\s*-->\s*(\d{1,3}):([0-5]?\d)[,.](\d{1,3})/

function seconds(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000
}

export function parseSubtitles(source: string): ParseResult {
  const text = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const blocks = text.split(/\n{2,}/)
  const cues: Cue[] = []
  const skipped: string[] = []

  for (const block of blocks) {
    const lines = block.split('\n').filter((line, index) => !(index === 0 && line.trim() === ''))
    if (lines.length === 0 || lines.every((line) => line.trim() === '')) continue
    if (lines[0]?.trim().toUpperCase().startsWith('WEBVTT')) continue

    // A bare number on the first line is an index, which carries no information
    // worth keeping: the order on the timeline is the order in time.
    let cursor = 0
    if (/^\s*\d+\s*$/.test(lines[0] ?? '') && lines.length > 1) cursor = 1

    const header = lines[cursor] ?? ''
    const full = TIME_RANGE.exec(header)
    const short = full ? null : SHORT_RANGE.exec(header)
    if (!full && !short) {
      skipped.push(`${lines[0]?.slice(0, 60) ?? ''} — no "-->" time range`)
      continue
    }

    const startSeconds = full
      ? seconds(full[1]!, full[2]!, full[3]!, full[4]!)
      : seconds('0', short![1]!, short![2]!, short![3]!)
    const endSeconds = full
      ? seconds(full[5]!, full[6]!, full[7]!, full[8]!)
      : seconds('0', short![4]!, short![5]!, short![6]!)

    if (endSeconds <= startSeconds) {
      skipped.push(`${header.trim().slice(0, 60)} — ends at or before it starts`)
      continue
    }

    const body = lines
      .slice(cursor + 1)
      .join('\n')
      .trim()
    if (body === '') {
      skipped.push(`${header.trim().slice(0, 60)} — no text`)
      continue
    }
    cues.push({ startSeconds, endSeconds, text: stripTags(body) })
  }

  cues.sort((a, b) => a.startSeconds - b.startSeconds)
  return { cues, skipped }
}

/**
 * Drops the inline markup SRT files pick up from authoring tools.
 *
 * The renderer draws plain text, so leaving `<i>` in would put the tag on
 * screen — worse than losing the italics it asked for.
 */
function stripTags(text: string): string {
  return text
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .trim()
}

function timecode(totalSeconds: number, separator: ',' | '.'): string {
  const clamped = Math.max(0, totalSeconds)
  const whole = Math.floor(clamped)
  const ms = Math.round((clamped - whole) * 1000)
  // Rounding up to 1000 ms would print :60.000 without this.
  const carry = ms === 1000 ? 1 : 0
  const value = whole + carry
  const h = String(Math.floor(value / 3600)).padStart(2, '0')
  const m = String(Math.floor((value % 3600) / 60)).padStart(2, '0')
  const s = String(value % 60).padStart(2, '0')
  return `${h}:${m}:${s}${separator}${String(carry ? 0 : ms).padStart(3, '0')}`
}

export function formatSrt(cues: Cue[]): string {
  return (
    cues
      .slice()
      .sort((a, b) => a.startSeconds - b.startSeconds)
      .map(
        (cue, index) =>
          `${index + 1}\n${timecode(cue.startSeconds, ',')} --> ${timecode(cue.endSeconds, ',')}\n${cue.text}`,
      )
      .join('\n\n') + '\n'
  )
}

export function formatVtt(cues: Cue[]): string {
  return (
    'WEBVTT\n\n' +
    cues
      .slice()
      .sort((a, b) => a.startSeconds - b.startSeconds)
      .map(
        (cue) =>
          `${timecode(cue.startSeconds, '.')} --> ${timecode(cue.endSeconds, '.')}\n${cue.text}`,
      )
      .join('\n\n') +
    '\n'
  )
}
