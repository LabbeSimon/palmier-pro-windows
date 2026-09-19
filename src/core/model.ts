/**
 * Domain model. Frame-domain integers are the source of truth for all timing;
 * seconds only appear at the FFmpeg and UI boundaries.
 */

import type { Effect } from './effects.js'

export type { Effect } from './effects.js'

export const CLIP_TYPES = ['video', 'audio', 'image', 'text', 'sequence', 'subtitle'] as const
export type ClipType = (typeof CLIP_TYPES)[number]

export function isVisual(type: ClipType): boolean {
  return type !== 'audio' && type !== 'subtitle'
}

export function isCompatible(a: ClipType, b: ClipType): boolean {
  return a === b || (isVisual(a) && isVisual(b))
}

const EXTENSION_TYPES: Record<string, ClipType> = {
  mov: 'video', mp4: 'video', m4v: 'video', mkv: 'video', avi: 'video', webm: 'video', wmv: 'video',
  mp3: 'audio', wav: 'audio', aac: 'audio', m4a: 'audio', flac: 'audio', ogg: 'audio', wma: 'audio',
  png: 'image', jpg: 'image', jpeg: 'image', bmp: 'image', tiff: 'image', webp: 'image', gif: 'image',
  srt: 'subtitle', vtt: 'subtitle',
}

export function clipTypeForExtension(ext: string): ClipType | null {
  return EXTENSION_TYPES[ext.replace(/^\./, '').toLowerCase()] ?? null
}

export type Interpolation = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

export interface Transform {
  /** Normalized canvas space: 0.5,0.5 is centre. */
  centerX: number
  centerY: number
  scaleX: number
  scaleY: number
  /** Degrees, clockwise. */
  rotation: number
}

export function defaultTransform(): Transform {
  return { centerX: 0.5, centerY: 0.5, scaleX: 1, scaleY: 1, rotation: 0 }
}

/** Fractions of the source frame trimmed from each edge. */
export interface Crop {
  top: number
  bottom: number
  left: number
  right: number
}

export function defaultCrop(): Crop {
  return { top: 0, bottom: 0, left: 0, right: 0 }
}

export interface TextStyle {
  fontFamily: string
  fontSize: number
  color: string
  bold: boolean
  italic: boolean
  alignment: 'left' | 'center' | 'right'
  backgroundColor: string | null
  strokeColor: string | null
  strokeWidth: number
}

export function defaultTextStyle(): TextStyle {
  return {
    fontFamily: 'Segoe UI',
    fontSize: 64,
    color: '#ffffff',
    bold: true,
    italic: false,
    alignment: 'center',
    backgroundColor: null,
    strokeColor: '#000000',
    strokeWidth: 2,
  }
}

export type TransitionKind =
  | 'dissolve'
  | 'fade-black'
  | 'fade-white'
  | 'wipe-left'
  | 'wipe-right'
  | 'wipe-up'
  | 'wipe-down'
  | 'slide-left'
  | 'slide-right'
  | 'circle-open'
  | 'circle-close'

export const TRANSITION_KINDS: TransitionKind[] = [
  'dissolve',
  'fade-black',
  'fade-white',
  'wipe-left',
  'wipe-right',
  'wipe-up',
  'wipe-down',
  'slide-left',
  'slide-right',
  'circle-open',
  'circle-close',
]

/**
 * A transition lives on the incoming clip and overlaps the clip before it on the
 * same track. Storing it on one side keeps a single owner and avoids the classic
 * NLE bug where both neighbours claim the same overlap.
 */
export interface Transition {
  id: string
  kind: TransitionKind
  /** Overlap length; consumes the tail of the previous clip. */
  durationFrames: number
}

export interface Clip {
  id: string
  /** Asset id, or timeline id when sourceClipType is 'sequence'. */
  mediaRef: string
  mediaType: ClipType
  /** Original media type, kept for colour-coding derived clips. */
  sourceClipType: ClipType
  startFrame: number
  durationFrames: number
  /** Source frames hidden before the visible portion. */
  trimStartFrame: number
  /** Source frames hidden after the visible portion. */
  trimEndFrame: number
  speed: number
  volume: number
  fadeInFrames: number
  fadeOutFrames: number
  fadeInInterpolation: Interpolation
  fadeOutInterpolation: Interpolation
  opacity: number
  transform: Transform
  crop: Crop
  /** Set by the A/V link when a video import places picture and sound together. */
  linkGroupId: string | null
  /** Set by the user grouping clips so they move and delete as one. */
  groupId: string | null
  /** Text clips only. */
  textContent: string | null
  textStyle: TextStyle | null
  /** Effect stack, applied in order. */
  effects: Effect[]
  /** Transition into this clip, overlapping its predecessor. */
  transitionIn: Transition | null
}

export interface Track {
  id: string
  type: ClipType
  name: string | null
  muted: boolean
  hidden: boolean
  /** A locked track refuses every edit until it is unlocked. */
  locked: boolean
  /** Linear track gain applied to the whole track in the mix. */
  volume: number
  clips: Clip[]
}

export interface TimelineMarker {
  id: string
  startFrame: number
  durationFrames: number
  name: string
  color: string
}

/**
 * The work zone (Kdenlive's "zone", in/out points on the ruler). Renders can be
 * limited to it, and it is what a preview render covers.
 */
export interface WorkZone {
  inFrame: number
  outFrame: number
}

export interface Timeline {
  id: string
  name: string
  fps: number
  width: number
  height: number
  tracks: Track[]
  markers: TimelineMarker[]
  /** Null when the whole timeline is the zone. */
  workZone: WorkZone | null
}

export interface MediaAsset {
  id: string
  /** Absolute path on disk. Windows paths are stored verbatim. */
  path: string
  name: string
  type: ClipType
  /** Native duration in seconds. Zero for stills. */
  durationSeconds: number
  width: number
  height: number
  /** Source frame rate; zero when the asset has no video track. */
  fps: number
  hasAudio: boolean
  sampleRate: number
  channels: number
  /** Cached thumbnail path, populated lazily. */
  thumbnailPath: string | null
}

export interface Project {
  id: string
  name: string
  /** Absolute path to the .palmier folder, or null for an unsaved project. */
  path: string | null
  timelines: Timeline[]
  activeTimelineId: string
  assets: MediaAsset[]
  createdAt: string
  modifiedAt: string
}

export const PROJECT_FILE_VERSION = 1

export interface ProjectFile {
  version: number
  project: Project
}

// --- Derived values -------------------------------------------------------

export function clipEndFrame(clip: Clip): number {
  return clip.startFrame + clip.durationFrames
}

/** Frames of overlap this clip's incoming transition claims from its predecessor. */
export function transitionOverlap(clip: Clip): number {
  return clip.transitionIn ? Math.max(0, clip.transitionIn.durationFrames) : 0
}

/** Source frames consumed by the visible portion, accounting for speed. */
export function sourceFramesConsumed(clip: Clip): number {
  return Math.round(clip.durationFrames * clip.speed)
}

/** Total source frames the clip references, both trims included. */
export function sourceDurationFrames(clip: Clip): number {
  return sourceFramesConsumed(clip) + clip.trimStartFrame + clip.trimEndFrame
}

export function trackEndFrame(track: Track): number {
  return track.clips.reduce((max, clip) => Math.max(max, clipEndFrame(clip)), 0)
}

export function timelineTotalFrames(timeline: Timeline): number {
  return timeline.tracks.reduce((max, track) => Math.max(max, trackEndFrame(track)), 0)
}

/** Total frames including markers past the last clip, used for the ruler. */
export function timelineDisplayFrames(timeline: Timeline): number {
  return timeline.markers.reduce(
    (max, marker) => Math.max(max, marker.startFrame + Math.max(1, marker.durationFrames)),
    timelineTotalFrames(timeline),
  )
}

export function activeTimeline(project: Project): Timeline {
  const found = project.timelines.find((t) => t.id === project.activeTimelineId)
  if (!found) throw new Error(`active timeline ${project.activeTimelineId} is missing`)
  return found
}

// --- Fade envelope --------------------------------------------------------

function interpolate(t: number, mode: Interpolation): number {
  switch (mode) {
    case 'linear':
      return t
    case 'ease-in':
      return t * t
    case 'ease-out':
      return 1 - (1 - t) * (1 - t)
    case 'ease-in-out':
      return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)
  }
}

/** Fade multiplier at an absolute timeline frame, 0…1. */
export function fadeMultiplier(clip: Clip, frame: number): number {
  const offset = frame - clip.startFrame
  if (offset < 0 || offset >= clip.durationFrames) return 0
  let value = 1
  if (clip.fadeInFrames > 0 && offset < clip.fadeInFrames) {
    value *= interpolate((offset + 1) / clip.fadeInFrames, clip.fadeInInterpolation)
  }
  if (clip.fadeOutFrames > 0) {
    const fromEnd = clip.durationFrames - offset
    if (fromEnd <= clip.fadeOutFrames) {
      value *= interpolate(fromEnd / clip.fadeOutFrames, clip.fadeOutInterpolation)
    }
  }
  return Math.max(0, Math.min(1, value))
}

/** Effective opacity at an absolute timeline frame. Audio ignores the fade envelope here. */
export function opacityAt(clip: Clip, frame: number): number {
  if (clip.mediaType === 'audio') return clip.opacity
  if (clip.fadeInFrames === 0 && clip.fadeOutFrames === 0) return clip.opacity
  return clip.opacity * fadeMultiplier(clip, frame)
}
