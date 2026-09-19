/** Frame <-> time conversions. Frames are the source of truth; seconds are a boundary format. */

export function framesToSeconds(frames: number, fps: number): number {
  if (!Number.isFinite(frames) || !Number.isFinite(fps) || fps <= 0) {
    throw new Error(`invalid frames/fps: ${frames}/${fps}`)
  }
  return frames / fps
}

/** Rounds to the nearest frame. Callers that need floor/ceil must say so explicitly. */
export function secondsToFrames(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || !Number.isFinite(fps) || fps <= 0) {
    throw new Error(`invalid seconds/fps: ${seconds}/${fps}`)
  }
  return Math.round(seconds * fps)
}

/** Non-drop-frame HH:MM:SS:FF. */
export function framesToTimecode(frames: number, fps: number): string {
  const rounded = Math.max(0, Math.round(fps))
  if (rounded <= 0) throw new Error(`invalid fps: ${fps}`)
  const total = Math.max(0, Math.round(frames))
  const f = total % rounded
  const totalSeconds = Math.floor(total / rounded)
  const s = totalSeconds % 60
  const m = Math.floor(totalSeconds / 60) % 60
  const h = Math.floor(totalSeconds / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`
}

/** Parses HH:MM:SS:FF, MM:SS:FF, or a bare frame count. Returns null when malformed. */
export function timecodeToFrames(timecode: string, fps: number): number | null {
  const rounded = Math.max(0, Math.round(fps))
  if (rounded <= 0) return null
  const trimmed = timecode.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const parts = trimmed.split(':')
  if (parts.length < 3 || parts.length > 4) return null
  if (!parts.every((p) => /^\d+$/.test(p))) return null
  const nums = parts.map(Number)
  const [h, m, s, f] = nums.length === 4 ? nums : [0, ...nums]
  if (f! >= rounded || m! >= 60 || s! >= 60) return null
  return ((h! * 60 + m!) * 60 + s!) * rounded + f!
}

/** FFmpeg wants a plain seconds value; six decimals is well under one frame at 240 fps. */
export function ffmpegTime(frames: number, fps: number): string {
  return framesToSeconds(frames, fps).toFixed(6)
}
