/**
 * Domain operations on a Project. Every mutation — UI, MCP tool, or test — goes
 * through this module, so eligibility rules, clamping and receipts stay identical
 * across surfaces.
 *
 * Operations are pure: they take a project, return a new one plus a receipt, and
 * never mutate the input. That makes undo a plain snapshot stack.
 */

import {
  activeTimeline,
  clipEndFrame,
  CLIP_TYPES,
  defaultCrop,
  defaultTextStyle,
  defaultTransform,
  isCompatible,
  isVisual,
  sourceDurationFrames,
  timelineTotalFrames,
  type Clip,
  type ClipType,
  type Crop,
  type Interpolation,
  type MediaAsset,
  type Project,
  type TextStyle,
  type Timeline,
  type TimelineMarker,
  type Track,
  type Transform,
} from './model.js'
import { secondsToFrames } from './timecode.js'

export class OpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'OpError'
  }
}

/** Structured receipt. `changed: false` marks an honest no-op, never a fake success. */
export interface Receipt {
  operation: string
  changed: boolean
  summary: string
  /** Stable ids of entities the operation created or touched. */
  affectedIds: string[]
  warnings: string[]
}

export interface MutationResult {
  project: Project
  receipt: Receipt
}

const newId = (): string => globalThis.crypto.randomUUID()

// --- Validation helpers ---------------------------------------------------

function requireFrame(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new OpError('invalid_argument', `${field} must be a non-negative integer frame, got ${String(value)}`)
  }
  return value
}

function requireDuration(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new OpError('invalid_argument', `${field} must be an integer of at least 1 frame, got ${String(value)}`)
  }
  return value
}

function requireUnit(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new OpError('invalid_argument', `${field} must be between 0 and 1, got ${String(value)}`)
  }
  return value
}

function requireFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new OpError('invalid_argument', `${field} must be a finite number, got ${String(value)}`)
  }
  return value
}

function requireClipType(value: unknown, field: string): ClipType {
  if (typeof value !== 'string' || !(CLIP_TYPES as readonly string[]).includes(value)) {
    throw new OpError('invalid_argument', `${field} must be one of ${CLIP_TYPES.join(', ')}, got ${String(value)}`)
  }
  return value as ClipType
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

// --- Lookups --------------------------------------------------------------

export interface ClipLocation {
  timeline: Timeline
  track: Track
  clip: Clip
  trackIndex: number
  clipIndex: number
}

export function findClip(timeline: Timeline, clipId: string): ClipLocation | null {
  for (let trackIndex = 0; trackIndex < timeline.tracks.length; trackIndex++) {
    const track = timeline.tracks[trackIndex]!
    const clipIndex = track.clips.findIndex((c) => c.id === clipId)
    if (clipIndex >= 0) {
      return { timeline, track, clip: track.clips[clipIndex]!, trackIndex, clipIndex }
    }
  }
  return null
}

function requireClip(timeline: Timeline, clipId: string): ClipLocation {
  const found = findClip(timeline, clipId)
  if (!found) throw new OpError('not_found', `clip ${clipId} is not on timeline ${timeline.id}`)
  return found
}

function requireTimeline(project: Project, timelineId?: string | null): Timeline {
  if (!timelineId) return activeTimeline(project)
  const found = project.timelines.find((t) => t.id === timelineId)
  if (!found) throw new OpError('not_found', `timeline ${timelineId} does not exist`)
  return found
}

function requireAsset(project: Project, assetId: string): MediaAsset {
  const found = project.assets.find((a) => a.id === assetId)
  if (!found) throw new OpError('not_found', `media asset ${assetId} is not in this project`)
  return found
}

/** Track holding a clip range, or null when the range is free. */
function overlapping(track: Track, startFrame: number, endFrame: number, ignoreIds: Set<string>): Clip | null {
  return (
    track.clips.find(
      (c) => !ignoreIds.has(c.id) && startFrame < clipEndFrame(c) && endFrame > c.startFrame,
    ) ?? null
  )
}

function sortClips(track: Track): void {
  track.clips.sort((a, b) => a.startFrame - b.startFrame)
}

// --- Project / timeline lifecycle ----------------------------------------

export function emptyTimeline(name: string, fps = 30, width = 1920, height = 1080): Timeline {
  return {
    id: newId(),
    name,
    fps,
    width,
    height,
    tracks: [
      { id: newId(), type: 'video', name: 'V1', muted: false, hidden: false, clips: [] },
      { id: newId(), type: 'audio', name: 'A1', muted: false, hidden: false, clips: [] },
    ],
    markers: [],
  }
}

export function emptyProject(name = 'Untitled'): Project {
  const timeline = emptyTimeline('Timeline 1')
  const now = new Date().toISOString()
  return {
    id: newId(),
    name,
    path: null,
    timelines: [timeline],
    activeTimelineId: timeline.id,
    assets: [],
    createdAt: now,
    modifiedAt: now,
  }
}

export interface CreateTimelineArgs {
  name?: string
  fps?: number
  width?: number
  height?: number
  activate?: boolean
}

export function createTimeline(project: Project, args: CreateTimelineArgs): MutationResult {
  const fps = args.fps === undefined ? 30 : requireDuration(args.fps, 'fps')
  const width = args.width === undefined ? 1920 : requireDuration(args.width, 'width')
  const height = args.height === undefined ? 1080 : requireDuration(args.height, 'height')
  const name = args.name?.trim() || `Timeline ${project.timelines.length + 1}`

  const next = clone(project)
  const timeline = emptyTimeline(name, fps, width, height)
  next.timelines.push(timeline)
  if (args.activate !== false) next.activeTimelineId = timeline.id

  return {
    project: touch(next),
    receipt: {
      operation: 'create_timeline',
      changed: true,
      summary: `Created timeline "${name}" at ${width}x${height} ${fps} fps`,
      affectedIds: [timeline.id],
      warnings: [],
    },
  }
}

export function setActiveTimeline(project: Project, timelineId: string): MutationResult {
  const timeline = requireTimeline(project, timelineId)
  if (project.activeTimelineId === timeline.id) {
    return {
      project,
      receipt: {
        operation: 'set_active_timeline',
        changed: false,
        summary: `Timeline "${timeline.name}" was already active`,
        affectedIds: [timeline.id],
        warnings: [],
      },
    }
  }
  const next = clone(project)
  next.activeTimelineId = timeline.id
  return {
    project: touch(next),
    receipt: {
      operation: 'set_active_timeline',
      changed: true,
      summary: `Activated timeline "${timeline.name}"`,
      affectedIds: [timeline.id],
      warnings: [],
    },
  }
}

export interface ProjectSettingsArgs {
  timelineId?: string
  name?: string
  fps?: number
  width?: number
  height?: number
}

export function setProjectSettings(project: Project, args: ProjectSettingsArgs): MutationResult {
  const target = requireTimeline(project, args.timelineId)
  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const warnings: string[] = []
  const changes: string[] = []

  if (args.name !== undefined) {
    const name = args.name.trim()
    if (!name) throw new OpError('invalid_argument', 'name must not be empty')
    if (name !== timeline.name) {
      timeline.name = name
      changes.push(`name -> "${name}"`)
    }
  }
  if (args.fps !== undefined) {
    const fps = requireDuration(args.fps, 'fps')
    if (fps !== timeline.fps) {
      if (timelineTotalFrames(timeline) > 0) {
        warnings.push(
          `Frame rate changed from ${timeline.fps} to ${fps}; existing clip frame positions are kept as-is, so clip timing in seconds shifts.`,
        )
      }
      timeline.fps = fps
      changes.push(`fps -> ${fps}`)
    }
  }
  if (args.width !== undefined) {
    const width = requireDuration(args.width, 'width')
    if (width !== timeline.width) {
      timeline.width = width
      changes.push(`width -> ${width}`)
    }
  }
  if (args.height !== undefined) {
    const height = requireDuration(args.height, 'height')
    if (height !== timeline.height) {
      timeline.height = height
      changes.push(`height -> ${height}`)
    }
  }

  if (changes.length === 0) {
    return {
      project,
      receipt: {
        operation: 'set_project_settings',
        changed: false,
        summary: 'Settings already matched the request',
        affectedIds: [timeline.id],
        warnings,
      },
    }
  }
  return {
    project: touch(next),
    receipt: {
      operation: 'set_project_settings',
      changed: true,
      summary: `Updated ${timeline.name}: ${changes.join(', ')}`,
      affectedIds: [timeline.id],
      warnings,
    },
  }
}

// --- Tracks ---------------------------------------------------------------

export interface AddTrackArgs {
  timelineId?: string
  type: ClipType
  name?: string
  /** Insertion index; appended when omitted. */
  index?: number
}

export function addTrack(project: Project, args: AddTrackArgs): MutationResult {
  const target = requireTimeline(project, args.timelineId)
  const type = requireClipType(args.type, 'type')
  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!

  const sameType = timeline.tracks.filter((t) => t.type === type).length
  const prefix = type === 'audio' ? 'A' : type === 'subtitle' ? 'S' : 'V'
  const track: Track = {
    id: newId(),
    type,
    name: args.name?.trim() || `${prefix}${sameType + 1}`,
    muted: false,
    hidden: false,
    clips: [],
  }

  const index =
    args.index === undefined
      ? timeline.tracks.length
      : Math.min(requireFrame(args.index, 'index'), timeline.tracks.length)
  timeline.tracks.splice(index, 0, track)

  return {
    project: touch(next),
    receipt: {
      operation: 'add_track',
      changed: true,
      summary: `Added ${type} track "${track.name}" at index ${index}`,
      affectedIds: [track.id],
      warnings: [],
    },
  }
}

export interface TrackFlagsArgs {
  timelineId?: string
  trackId: string
  muted?: boolean
  hidden?: boolean
  name?: string
}

export function setTrackFlags(project: Project, args: TrackFlagsArgs): MutationResult {
  const target = requireTimeline(project, args.timelineId)
  const existing = target.tracks.find((t) => t.id === args.trackId)
  if (!existing) throw new OpError('not_found', `track ${args.trackId} is not on timeline ${target.id}`)

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const track = timeline.tracks.find((t) => t.id === args.trackId)!
  const changes: string[] = []

  if (args.muted !== undefined && args.muted !== track.muted) {
    track.muted = args.muted
    changes.push(args.muted ? 'muted' : 'unmuted')
  }
  if (args.hidden !== undefined && args.hidden !== track.hidden) {
    track.hidden = args.hidden
    changes.push(args.hidden ? 'hidden' : 'shown')
  }
  if (args.name !== undefined) {
    const name = args.name.trim()
    if (!name) throw new OpError('invalid_argument', 'name must not be empty')
    if (name !== track.name) {
      track.name = name
      changes.push(`renamed to "${name}"`)
    }
  }

  if (changes.length === 0) {
    return {
      project,
      receipt: {
        operation: 'set_track_flags',
        changed: false,
        summary: `Track "${track.name}" already matched the request`,
        affectedIds: [track.id],
        warnings: [],
      },
    }
  }
  return {
    project: touch(next),
    receipt: {
      operation: 'set_track_flags',
      changed: true,
      summary: `Track "${track.name}" ${changes.join(', ')}`,
      affectedIds: [track.id],
      warnings: [],
    },
  }
}

export function removeTrack(project: Project, trackId: string, timelineId?: string): MutationResult {
  const target = requireTimeline(project, timelineId)
  const index = target.tracks.findIndex((t) => t.id === trackId)
  if (index < 0) throw new OpError('not_found', `track ${trackId} is not on timeline ${target.id}`)
  if (target.tracks.length === 1) {
    throw new OpError('refused', 'a timeline must keep at least one track')
  }

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const [removed] = timeline.tracks.splice(index, 1)

  return {
    project: touch(next),
    receipt: {
      operation: 'remove_track',
      changed: true,
      summary: `Removed track "${removed!.name}" and its ${removed!.clips.length} clip(s)`,
      affectedIds: [trackId, ...removed!.clips.map((c) => c.id)],
      warnings: [],
    },
  }
}

// --- Clips ----------------------------------------------------------------

export interface AddClipSpec {
  assetId: string
  /** Target track; the first compatible track is used when omitted. */
  trackId?: string
  /** Defaults to the end of the chosen track, so repeated calls append. */
  startFrame?: number
  /** Defaults to the asset's full remaining duration. */
  durationFrames?: number
  trimStartFrame?: number
  speed?: number
  volume?: number
}

export interface AddClipsArgs {
  timelineId?: string
  clips: AddClipSpec[]
}

/** Frames an asset provides at a given timeline rate. Stills have no intrinsic length. */
function assetDurationFrames(asset: MediaAsset, fps: number): number | null {
  if (asset.type === 'image' || asset.type === 'text') return null
  if (asset.durationSeconds <= 0) return null
  return Math.max(1, secondsToFrames(asset.durationSeconds, fps))
}

const DEFAULT_STILL_FRAMES = 5

export function addClips(project: Project, args: AddClipsArgs): MutationResult {
  if (!Array.isArray(args.clips) || args.clips.length === 0) {
    throw new OpError('invalid_argument', 'clips must be a non-empty array')
  }
  const target = requireTimeline(project, args.timelineId)
  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const warnings: string[] = []
  const created: string[] = []

  for (const [i, spec] of args.clips.entries()) {
    const asset = requireAsset(next, spec.assetId)
    const label = `clips[${i}]`

    let track: Track
    if (spec.trackId) {
      const found = timeline.tracks.find((t) => t.id === spec.trackId)
      if (!found) throw new OpError('not_found', `${label}: track ${spec.trackId} is not on this timeline`)
      if (!isCompatible(found.type, asset.type)) {
        throw new OpError(
          'refused',
          `${label}: ${asset.type} media cannot go on a ${found.type} track`,
        )
      }
      track = found
    } else {
      const found = timeline.tracks.find((t) => isCompatible(t.type, asset.type))
      if (!found) {
        throw new OpError(
          'refused',
          `${label}: no ${isVisual(asset.type) ? 'video' : asset.type} track exists; add one first`,
        )
      }
      track = found
    }

    const trimStartFrame = spec.trimStartFrame === undefined ? 0 : requireFrame(spec.trimStartFrame, `${label}.trimStartFrame`)
    const speed = spec.speed === undefined ? 1 : requireFinite(spec.speed, `${label}.speed`)
    if (speed <= 0) throw new OpError('invalid_argument', `${label}.speed must be greater than 0`)

    const available = assetDurationFrames(asset, timeline.fps)
    let durationFrames: number
    if (spec.durationFrames !== undefined) {
      durationFrames = requireDuration(spec.durationFrames, `${label}.durationFrames`)
    } else if (available !== null) {
      const remaining = available - trimStartFrame
      if (remaining < 1) {
        throw new OpError(
          'refused',
          `${label}: trimStartFrame ${trimStartFrame} is at or past the end of "${asset.name}" (${available} frames)`,
        )
      }
      durationFrames = Math.max(1, Math.round(remaining / speed))
    } else {
      durationFrames = DEFAULT_STILL_FRAMES * timeline.fps
    }

    if (available !== null) {
      const consumed = Math.round(durationFrames * speed) + trimStartFrame
      if (consumed > available) {
        throw new OpError(
          'refused',
          `${label}: needs ${consumed} source frames but "${asset.name}" only has ${available}`,
        )
      }
    }

    const startFrame =
      spec.startFrame === undefined
        ? track.clips.reduce((max, c) => Math.max(max, clipEndFrame(c)), 0)
        : requireFrame(spec.startFrame, `${label}.startFrame`)

    const blocker = overlapping(track, startFrame, startFrame + durationFrames, new Set())
    if (blocker) {
      throw new OpError(
        'refused',
        `${label}: frames ${startFrame}-${startFrame + durationFrames} on track "${track.name}" are occupied by clip ${blocker.id}`,
      )
    }

    const clip: Clip = {
      id: newId(),
      mediaRef: asset.id,
      mediaType: asset.type,
      sourceClipType: asset.type,
      startFrame,
      durationFrames,
      trimStartFrame,
      trimEndFrame: available === null ? 0 : Math.max(0, available - trimStartFrame - Math.round(durationFrames * speed)),
      speed,
      volume: spec.volume === undefined ? 1 : requireFinite(spec.volume, `${label}.volume`),
      fadeInFrames: 0,
      fadeOutFrames: 0,
      fadeInInterpolation: 'linear',
      fadeOutInterpolation: 'linear',
      opacity: 1,
      transform: defaultTransform(),
      crop: defaultCrop(),
      linkGroupId: null,
      textContent: null,
      textStyle: null,
    }

    track.clips.push(clip)
    sortClips(track)
    created.push(clip.id)

    if (asset.type === 'video' && asset.hasAudio && track.type !== 'audio') {
      warnings.push(
        `"${asset.name}" has an audio track; add it separately to an audio track if you want it in the mix.`,
      )
    }
  }

  return {
    project: touch(next),
    receipt: {
      operation: 'add_clips',
      changed: true,
      summary: `Added ${created.length} clip(s) to "${timeline.name}"`,
      affectedIds: created,
      warnings,
    },
  }
}

export interface AddTextSpec {
  content: string
  startFrame: number
  durationFrames: number
  trackId?: string
  style?: Partial<TextStyle>
}

export function addTexts(
  project: Project,
  args: { timelineId?: string; texts: AddTextSpec[] },
): MutationResult {
  if (!Array.isArray(args.texts) || args.texts.length === 0) {
    throw new OpError('invalid_argument', 'texts must be a non-empty array')
  }
  const target = requireTimeline(project, args.timelineId)
  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const created: string[] = []

  for (const [i, spec] of args.texts.entries()) {
    const label = `texts[${i}]`
    if (typeof spec.content !== 'string' || !spec.content.trim()) {
      throw new OpError('invalid_argument', `${label}.content must be a non-empty string`)
    }
    const startFrame = requireFrame(spec.startFrame, `${label}.startFrame`)
    const durationFrames = requireDuration(spec.durationFrames, `${label}.durationFrames`)

    let track: Track
    if (spec.trackId) {
      const found = timeline.tracks.find((t) => t.id === spec.trackId)
      if (!found) throw new OpError('not_found', `${label}: track ${spec.trackId} is not on this timeline`)
      if (!isVisual(found.type)) {
        throw new OpError('refused', `${label}: text cannot go on a ${found.type} track`)
      }
      track = found
    } else {
      // Text belongs above the picture: prefer the topmost free visual track.
      const visual = timeline.tracks.filter((t) => isVisual(t.type))
      const free = [...visual]
        .reverse()
        .find((t) => !overlapping(t, startFrame, startFrame + durationFrames, new Set()))
      if (!free) {
        throw new OpError(
          'refused',
          `${label}: every visual track is occupied at frames ${startFrame}-${startFrame + durationFrames}; add a track first`,
        )
      }
      track = free
    }

    const blocker = overlapping(track, startFrame, startFrame + durationFrames, new Set())
    if (blocker) {
      throw new OpError(
        'refused',
        `${label}: frames ${startFrame}-${startFrame + durationFrames} on track "${track.name}" are occupied by clip ${blocker.id}`,
      )
    }

    const clip: Clip = {
      id: newId(),
      mediaRef: '',
      mediaType: 'text',
      sourceClipType: 'text',
      startFrame,
      durationFrames,
      trimStartFrame: 0,
      trimEndFrame: 0,
      speed: 1,
      volume: 1,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      fadeInInterpolation: 'linear',
      fadeOutInterpolation: 'linear',
      opacity: 1,
      transform: defaultTransform(),
      crop: defaultCrop(),
      linkGroupId: null,
      textContent: spec.content,
      textStyle: { ...defaultTextStyle(), ...spec.style },
    }
    track.clips.push(clip)
    sortClips(track)
    created.push(clip.id)
  }

  return {
    project: touch(next),
    receipt: {
      operation: 'add_texts',
      changed: true,
      summary: `Added ${created.length} text clip(s)`,
      affectedIds: created,
      warnings: [],
    },
  }
}

export function updateText(
  project: Project,
  args: { clipId: string; content?: string; style?: Partial<TextStyle>; timelineId?: string },
): MutationResult {
  const target = requireTimeline(project, args.timelineId)
  requireClip(target, args.clipId)

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const { clip } = requireClip(timeline, args.clipId)
  if (clip.mediaType !== 'text') {
    throw new OpError('refused', `clip ${args.clipId} is a ${clip.mediaType} clip, not text`)
  }

  let changed = false
  if (args.content !== undefined) {
    if (!args.content.trim()) throw new OpError('invalid_argument', 'content must not be empty')
    if (args.content !== clip.textContent) {
      clip.textContent = args.content
      changed = true
    }
  }
  if (args.style) {
    const merged = { ...(clip.textStyle ?? defaultTextStyle()), ...args.style }
    if (JSON.stringify(merged) !== JSON.stringify(clip.textStyle)) {
      clip.textStyle = merged
      changed = true
    }
  }

  return {
    project: changed ? touch(next) : project,
    receipt: {
      operation: 'update_text',
      changed,
      summary: changed ? `Updated text clip ${args.clipId}` : 'Text already matched the request',
      affectedIds: [args.clipId],
      warnings: [],
    },
  }
}

export interface RemoveClipsArgs {
  timelineId?: string
  clipIds: string[]
  /** Close the gap by pulling later clips on the same track back. */
  ripple?: boolean
}

export function removeClips(project: Project, args: RemoveClipsArgs): MutationResult {
  if (!Array.isArray(args.clipIds) || args.clipIds.length === 0) {
    throw new OpError('invalid_argument', 'clipIds must be a non-empty array')
  }
  const target = requireTimeline(project, args.timelineId)
  for (const id of args.clipIds) requireClip(target, id)

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const ids = new Set(args.clipIds)

  for (const track of timeline.tracks) {
    const removed = track.clips.filter((c) => ids.has(c.id))
    if (removed.length === 0) continue
    track.clips = track.clips.filter((c) => !ids.has(c.id))
    if (args.ripple) {
      // Shift later clips back by each gap, oldest gap first, so shifts compose.
      for (const gone of [...removed].sort((a, b) => a.startFrame - b.startFrame)) {
        for (const clip of track.clips) {
          if (clip.startFrame >= gone.startFrame) clip.startFrame -= gone.durationFrames
        }
      }
    }
    sortClips(track)
  }

  return {
    project: touch(next),
    receipt: {
      operation: 'remove_clips',
      changed: true,
      summary: `Removed ${args.clipIds.length} clip(s)${args.ripple ? ' and closed the gaps' : ''}`,
      affectedIds: args.clipIds,
      warnings: [],
    },
  }
}

export interface SplitArgs {
  timelineId?: string
  frame: number
  /** Clips to split; every clip crossing `frame` when omitted. */
  clipIds?: string[]
}

export function splitClips(project: Project, args: SplitArgs): MutationResult {
  const frame = requireFrame(args.frame, 'frame')
  const target = requireTimeline(project, args.timelineId)

  const candidates = args.clipIds
    ? args.clipIds.map((id) => requireClip(target, id))
    : target.tracks.flatMap((track) =>
        track.clips.filter((c) => frame > c.startFrame && frame < clipEndFrame(c)).map((c) => requireClip(target, c.id)),
      )

  const splittable = candidates.filter((loc) => frame > loc.clip.startFrame && frame < clipEndFrame(loc.clip))
  const skipped = candidates.filter((loc) => !splittable.includes(loc))

  if (splittable.length === 0) {
    return {
      project,
      receipt: {
        operation: 'split_clips',
        changed: false,
        summary: `No clip crosses frame ${frame}`,
        affectedIds: [],
        warnings: skipped.map((loc) => `clip ${loc.clip.id} does not cross frame ${frame}`),
      },
    }
  }

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const created: string[] = []

  for (const loc of splittable) {
    const track = timeline.tracks.find((t) => t.id === loc.track.id)!
    const clip = track.clips.find((c) => c.id === loc.clip.id)!
    const leftFrames = frame - clip.startFrame
    const rightFrames = clip.durationFrames - leftFrames
    const leftSource = Math.round(leftFrames * clip.speed)
    // Derived from the original so the two halves still sum to the source length exactly.
    const totalSource = sourceDurationFrames(clip)

    const right: Clip = {
      ...clone(clip),
      id: newId(),
      startFrame: frame,
      durationFrames: rightFrames,
      trimStartFrame: clip.trimStartFrame + leftSource,
      // Each half keeps only the fade on its outer edge.
      fadeInFrames: 0,
      fadeOutFrames: Math.min(clip.fadeOutFrames, rightFrames),
    }
    clip.durationFrames = leftFrames
    clip.trimEndFrame = Math.max(0, totalSource - clip.trimStartFrame - leftSource)
    clip.fadeOutFrames = 0
    clip.fadeInFrames = Math.min(clip.fadeInFrames, leftFrames)

    track.clips.push(right)
    sortClips(track)
    created.push(right.id)
  }

  return {
    project: touch(next),
    receipt: {
      operation: 'split_clips',
      changed: true,
      summary: `Split ${splittable.length} clip(s) at frame ${frame}`,
      affectedIds: [...splittable.map((l) => l.clip.id), ...created],
      warnings: skipped.map((loc) => `clip ${loc.clip.id} does not cross frame ${frame}, left untouched`),
    },
  }
}

export interface MoveSpec {
  clipId: string
  startFrame?: number
  trackId?: string
}

export function moveClips(
  project: Project,
  args: { timelineId?: string; moves: MoveSpec[] },
): MutationResult {
  if (!Array.isArray(args.moves) || args.moves.length === 0) {
    throw new OpError('invalid_argument', 'moves must be a non-empty array')
  }
  const target = requireTimeline(project, args.timelineId)
  for (const move of args.moves) requireClip(target, move.clipId)

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const movingIds = new Set(args.moves.map((m) => m.clipId))
  const touched: string[] = []

  for (const [i, move] of args.moves.entries()) {
    const label = `moves[${i}]`
    const loc = requireClip(timeline, move.clipId)
    const startFrame = move.startFrame === undefined ? loc.clip.startFrame : requireFrame(move.startFrame, `${label}.startFrame`)

    let destination = loc.track
    if (move.trackId && move.trackId !== loc.track.id) {
      const found = timeline.tracks.find((t) => t.id === move.trackId)
      if (!found) throw new OpError('not_found', `${label}: track ${move.trackId} is not on this timeline`)
      if (!isCompatible(found.type, loc.clip.mediaType)) {
        throw new OpError('refused', `${label}: a ${loc.clip.mediaType} clip cannot go on a ${found.type} track`)
      }
      destination = found
    }

    const blocker = overlapping(destination, startFrame, startFrame + loc.clip.durationFrames, movingIds)
    if (blocker) {
      throw new OpError(
        'refused',
        `${label}: frames ${startFrame}-${startFrame + loc.clip.durationFrames} on track "${destination.name}" are occupied by clip ${blocker.id}`,
      )
    }

    const moved = loc.track.clips.splice(loc.clipIndex, 1)[0]!
    moved.startFrame = startFrame
    destination.clips.push(moved)
    sortClips(loc.track)
    sortClips(destination)
    touched.push(moved.id)
  }

  return {
    project: touch(next),
    receipt: {
      operation: 'move_clips',
      changed: true,
      summary: `Moved ${touched.length} clip(s)`,
      affectedIds: touched,
      warnings: [],
    },
  }
}

export interface ClipProperties {
  startFrame?: number
  durationFrames?: number
  trimStartFrame?: number
  speed?: number
  volume?: number
  opacity?: number
  fadeInFrames?: number
  fadeOutFrames?: number
  fadeInInterpolation?: Interpolation
  fadeOutInterpolation?: Interpolation
  transform?: Partial<Transform>
  crop?: Partial<Crop>
}

export function setClipProperties(
  project: Project,
  args: { timelineId?: string; clipIds: string[]; properties: ClipProperties },
): MutationResult {
  if (!Array.isArray(args.clipIds) || args.clipIds.length === 0) {
    throw new OpError('invalid_argument', 'clipIds must be a non-empty array')
  }
  const props = args.properties
  if (!props || Object.keys(props).length === 0) {
    throw new OpError('invalid_argument', 'properties must contain at least one field')
  }
  const target = requireTimeline(project, args.timelineId)
  for (const id of args.clipIds) requireClip(target, id)

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const ids = new Set(args.clipIds)
  const warnings: string[] = []
  let changed = false

  for (const id of args.clipIds) {
    const loc = requireClip(timeline, id)
    const clip = loc.clip
    const before = JSON.stringify(clip)

    if (props.speed !== undefined) {
      const speed = requireFinite(props.speed, 'properties.speed')
      if (speed <= 0) throw new OpError('invalid_argument', 'properties.speed must be greater than 0')
      if (clip.sourceClipType === 'sequence') {
        throw new OpError('refused', `clip ${id} is a nested sequence and cannot be retimed`)
      }
      clip.speed = speed
    }
    if (props.trimStartFrame !== undefined) {
      clip.trimStartFrame = requireFrame(props.trimStartFrame, 'properties.trimStartFrame')
    }
    if (props.durationFrames !== undefined) {
      clip.durationFrames = requireDuration(props.durationFrames, 'properties.durationFrames')
    }
    if (props.startFrame !== undefined) {
      clip.startFrame = requireFrame(props.startFrame, 'properties.startFrame')
    }
    if (props.volume !== undefined) {
      const volume = requireFinite(props.volume, 'properties.volume')
      if (volume < 0) throw new OpError('invalid_argument', 'properties.volume must not be negative')
      clip.volume = volume
    }
    if (props.opacity !== undefined) clip.opacity = requireUnit(props.opacity, 'properties.opacity')
    if (props.fadeInFrames !== undefined) {
      clip.fadeInFrames = requireFrame(props.fadeInFrames, 'properties.fadeInFrames')
    }
    if (props.fadeOutFrames !== undefined) {
      clip.fadeOutFrames = requireFrame(props.fadeOutFrames, 'properties.fadeOutFrames')
    }
    if (props.fadeInInterpolation) clip.fadeInInterpolation = props.fadeInInterpolation
    if (props.fadeOutInterpolation) clip.fadeOutInterpolation = props.fadeOutInterpolation
    if (props.transform) {
      for (const [key, value] of Object.entries(props.transform)) {
        requireFinite(value, `properties.transform.${key}`)
      }
      clip.transform = { ...clip.transform, ...props.transform }
    }
    if (props.crop) {
      for (const [key, value] of Object.entries(props.crop)) {
        requireUnit(value, `properties.crop.${key}`)
      }
      clip.crop = { ...clip.crop, ...props.crop }
    }

    if (clip.fadeInFrames + clip.fadeOutFrames > clip.durationFrames) {
      throw new OpError(
        'refused',
        `clip ${id}: fades total ${clip.fadeInFrames + clip.fadeOutFrames} frames but the clip is only ${clip.durationFrames}`,
      )
    }

    const blocker = overlapping(loc.track, clip.startFrame, clipEndFrame(clip), ids)
    if (blocker) {
      throw new OpError(
        'refused',
        `clip ${id}: the new range ${clip.startFrame}-${clipEndFrame(clip)} collides with clip ${blocker.id}`,
      )
    }

    const asset = clip.mediaRef ? next.assets.find((a) => a.id === clip.mediaRef) : undefined
    if (asset) {
      const available = assetDurationFrames(asset, timeline.fps)
      if (available !== null && sourceDurationFrames(clip) - clip.trimEndFrame > available) {
        throw new OpError(
          'refused',
          `clip ${id}: needs ${sourceDurationFrames(clip) - clip.trimEndFrame} source frames but "${asset.name}" only has ${available}`,
        )
      }
    }

    sortClips(loc.track)
    if (JSON.stringify(clip) !== before) changed = true
  }

  if (!changed) {
    return {
      project,
      receipt: {
        operation: 'set_clip_properties',
        changed: false,
        summary: 'Clips already matched the requested properties',
        affectedIds: args.clipIds,
        warnings,
      },
    }
  }
  return {
    project: touch(next),
    receipt: {
      operation: 'set_clip_properties',
      changed: true,
      summary: `Updated ${args.clipIds.length} clip(s)`,
      affectedIds: args.clipIds,
      warnings,
    },
  }
}

// --- Markers --------------------------------------------------------------

export function addMarkers(
  project: Project,
  args: { timelineId?: string; markers: { startFrame: number; durationFrames?: number; name: string; color?: string }[] },
): MutationResult {
  if (!Array.isArray(args.markers) || args.markers.length === 0) {
    throw new OpError('invalid_argument', 'markers must be a non-empty array')
  }
  const target = requireTimeline(project, args.timelineId)
  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const created: string[] = []

  for (const [i, spec] of args.markers.entries()) {
    const marker: TimelineMarker = {
      id: newId(),
      startFrame: requireFrame(spec.startFrame, `markers[${i}].startFrame`),
      durationFrames: spec.durationFrames === undefined ? 1 : requireDuration(spec.durationFrames, `markers[${i}].durationFrames`),
      name: String(spec.name ?? '').trim() || `Marker ${timeline.markers.length + 1}`,
      color: spec.color ?? '#f0b400',
    }
    timeline.markers.push(marker)
    created.push(marker.id)
  }
  timeline.markers.sort((a, b) => a.startFrame - b.startFrame)

  return {
    project: touch(next),
    receipt: {
      operation: 'add_markers',
      changed: true,
      summary: `Added ${created.length} marker(s)`,
      affectedIds: created,
      warnings: [],
    },
  }
}

// --- Assets ---------------------------------------------------------------

export function addAssets(project: Project, assets: MediaAsset[]): MutationResult {
  const next = clone(project)
  const added: string[] = []
  const warnings: string[] = []

  for (const asset of assets) {
    const existing = next.assets.find((a) => a.path === asset.path)
    if (existing) {
      warnings.push(`"${asset.name}" was already imported as ${existing.id}`)
      continue
    }
    next.assets.push(asset)
    added.push(asset.id)
  }

  if (added.length === 0) {
    return {
      project,
      receipt: {
        operation: 'import_media',
        changed: false,
        summary: 'Every file was already in the project',
        affectedIds: [],
        warnings,
      },
    }
  }
  return {
    project: touch(next),
    receipt: {
      operation: 'import_media',
      changed: true,
      summary: `Imported ${added.length} file(s)`,
      affectedIds: added,
      warnings,
    },
  }
}

export function removeAssets(project: Project, assetIds: string[]): MutationResult {
  const ids = new Set(assetIds)
  const inUse = project.timelines.flatMap((t) =>
    t.tracks.flatMap((tr) => tr.clips.filter((c) => ids.has(c.mediaRef)).map((c) => c.id)),
  )
  if (inUse.length > 0) {
    throw new OpError(
      'refused',
      `${inUse.length} clip(s) still use this media; remove them first: ${inUse.slice(0, 5).join(', ')}`,
    )
  }
  const next = clone(project)
  const before = next.assets.length
  next.assets = next.assets.filter((a) => !ids.has(a.id))
  const removed = before - next.assets.length

  return {
    project: removed > 0 ? touch(next) : project,
    receipt: {
      operation: 'remove_media',
      changed: removed > 0,
      summary: removed > 0 ? `Removed ${removed} asset(s)` : 'No matching asset in the project',
      affectedIds: assetIds,
      warnings: [],
    },
  }
}

function touch(project: Project): Project {
  project.modifiedAt = new Date().toISOString()
  return project
}
