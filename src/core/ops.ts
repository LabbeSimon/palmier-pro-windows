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
  defaultSubtitleStyle,
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
  type WorkZone,
  type Transform,
  type Transition,
  type TransitionKind,
  TRANSITION_KINDS,
} from './model.js'
import {
  EASINGS,
  isEffectTarget,
  normalizeKeyframes,
  parseEffectTarget,
  STATIC_TARGETS,
  STATIC_TARGET_SPECS,
  type Easing,
  type Keyframe,
} from './keyframes.js'
import {
  defaultParams,
  EFFECTS_BY_ID,
  type Effect,
  type EffectDefinition,
  type EffectParamSpec,
} from './effects.js'
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

/**
 * Frees a frame range on a track for an overwrite: clips fully inside it are
 * removed, clips straddling an edge are trimmed, and a clip spanning the whole
 * range is split in two so the hole is exact.
 */
function clearRange(track: Track, startFrame: number, endFrame: number): string[] {
  const touched: string[] = []
  const survivors: Clip[] = []

  for (const clip of track.clips) {
    const clipEnd = clipEndFrame(clip)
    if (clipEnd <= startFrame || clip.startFrame >= endFrame) {
      survivors.push(clip)
      continue
    }
    touched.push(clip.id)

    const keepsHead = clip.startFrame < startFrame
    const keepsTail = clipEnd > endFrame

    if (keepsHead) {
      const head = structuredClone(clip)
      const cut = startFrame - clip.startFrame
      head.trimEndFrame += Math.round((head.durationFrames - cut) * head.speed)
      head.durationFrames = cut
      head.fadeOutFrames = Math.min(head.fadeOutFrames, cut)
      survivors.push(head)
    }
    if (keepsTail) {
      const tail = structuredClone(clip)
      const skipped = endFrame - clip.startFrame
      tail.trimStartFrame += Math.round(skipped * tail.speed)
      tail.startFrame = endFrame
      tail.durationFrames = clipEnd - endFrame
      tail.fadeInFrames = Math.min(tail.fadeInFrames, tail.durationFrames)
      // A split half is a new clip, so it gets its own identity.
      if (keepsHead) tail.id = newId()
      survivors.push(tail)
    }
  }

  track.clips = survivors
  sortClips(track)
  return touched
}

/**
 * Adds every clip bound to the given ones — by the automatic A/V link, or by a
 * user-made group. Both mean "these move and die together", so both expand.
 */
function expandLinked(timeline: Timeline, clipIds: string[]): Set<string> {
  const ids = new Set(clipIds)
  const keys = new Set<string>()
  const keyOf = (clip: Clip) => [clip.linkGroupId, clip.groupId].filter(Boolean) as string[]

  // Repeat until stable: a group can bridge two separate link pairs.
  let grew = true
  while (grew) {
    grew = false
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        if (ids.has(clip.id)) {
          for (const key of keyOf(clip)) if (!keys.has(key)) { keys.add(key); grew = true }
        }
      }
    }
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        if (ids.has(clip.id)) continue
        if (keyOf(clip).some((key) => keys.has(key))) { ids.add(clip.id); grew = true }
      }
    }
  }
  return ids
}

/** Clips bound to `clipId` by link or group, excluding itself. */
function linkedSiblings(timeline: Timeline, clipId: string): Clip[] {
  const ids = expandLinked(timeline, [clipId])
  ids.delete(clipId)
  return timeline.tracks.flatMap((t) => t.clips).filter((c) => ids.has(c.id))
}

/** A lock is only real if every mutation path consults it. */
function refuseIfLocked(track: Track, what: string): void {
  if (track.locked) {
    throw new OpError('refused', `track "${track.name ?? track.type}" is locked; unlock it before ${what}`)
  }
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
      { id: newId(), type: 'video', name: 'V1', muted: false, hidden: false, locked: false, volume: 1, clips: [] },
      { id: newId(), type: 'audio', name: 'A1', muted: false, hidden: false, locked: false, volume: 1, clips: [] },
    ],
    markers: [],
    workZone: null,
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
    locked: false,
    volume: 1,
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
  locked?: boolean
  volume?: number
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
  if (args.locked !== undefined && args.locked !== track.locked) {
    track.locked = args.locked
    changes.push(args.locked ? 'locked' : 'unlocked')
  }
  if (args.volume !== undefined) {
    const volume = requireFinite(args.volume, 'volume')
    if (volume < 0) throw new OpError('invalid_argument', 'volume must not be negative')
    if (volume !== track.volume) {
      track.volume = volume
      changes.push(`gain -> ${volume}`)
    }
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

/**
 * What a placement does when the target range is already occupied.
 *
 * - `normal`    refuses, leaving the edit untouched
 * - `overwrite` trims or removes whatever sits under the new clip
 * - `insert`    pushes everything from the insert point rightwards
 */
export type EditMode = 'normal' | 'overwrite' | 'insert'

export const EDIT_MODES: EditMode[] = ['normal', 'overwrite', 'insert']

export interface AddClipsArgs {
  timelineId?: string
  clips: AddClipSpec[]
  mode?: EditMode
  /**
   * Video that carries sound lands as two linked clips, picture and sound, the
   * way every NLE does it. Set false to place the picture alone.
   */
  linkAudio?: boolean
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
      refuseIfLocked(found, 'adding clips to it')
      track = found
    } else {
      const found = timeline.tracks.find((t) => isCompatible(t.type, asset.type) && !t.locked)
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

    const mode: EditMode = args.mode ?? 'normal'
    if (mode === 'insert') {
      // Everything at or after the insert point slides by the new clip's length.
      for (const existing of track.clips) {
        if (existing.startFrame >= startFrame) existing.startFrame += durationFrames
      }
    } else if (mode === 'overwrite') {
      const removedIds = clearRange(track, startFrame, startFrame + durationFrames)
      if (removedIds.length > 0) {
        warnings.push(`${label}: overwrote ${removedIds.length} clip(s) under the new one`)
      }
    }

    const blocker = overlapping(track, startFrame, startFrame + durationFrames, new Set())
    if (blocker) {
      throw new OpError(
        'refused',
        `${label}: frames ${startFrame}-${startFrame + durationFrames} on track "${track.name}" are occupied by clip ${blocker.id}` +
          (mode === 'normal' ? '. Use mode "overwrite" or "insert" to place it anyway.' : ''),
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
      groupId: null,
      textContent: null,
      textStyle: null,
      effects: [],
      keyframes: {},
      transitionIn: null,
    }

    track.clips.push(clip)
    sortClips(track)
    created.push(clip.id)

    // Picture and sound arrive together and stay together.
    if (asset.hasAudio && track.type !== 'audio' && args.linkAudio !== false) {
      const audioTrack = timeline.tracks.find(
        (t) =>
          t.type === 'audio' &&
          !t.locked &&
          !overlapping(t, startFrame, startFrame + durationFrames, new Set()),
      )
      if (!audioTrack) {
        warnings.push(
          `"${asset.name}" has sound but no free audio track was available; the picture was placed alone.`,
        )
      } else {
        const linkGroupId = newId()
        clip.linkGroupId = linkGroupId
        const audioClip: Clip = {
          ...clone(clip),
          id: newId(),
          mediaType: 'audio',
          sourceClipType: asset.type,
          linkGroupId,
          transform: defaultTransform(),
          crop: defaultCrop(),
          effects: [],
          keyframes: {},
          transitionIn: null,
        }
        audioTrack.clips.push(audioClip)
        sortClips(audioTrack)
        created.push(audioClip.id)
      }
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

    // Text always places in normal mode: a title is an overlay, so overwriting
    // or insert-shifting the picture under it would be surprising.
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
      groupId: null,
      textContent: spec.content,
      textStyle: { ...defaultTextStyle(), ...spec.style },
      effects: [],
      keyframes: {},
      transitionIn: null,
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

export interface SubtitleSpec {
  startFrame: number
  durationFrames: number
  text: string
}

/**
 * Places subtitle cues on a subtitle track, creating one if there is none.
 *
 * A cue is a clip like any other, so moving, trimming, splitting and rippling
 * them comes for free — and an imported file becomes editable material rather
 * than a sidecar the editor can only pass through.
 */
export function addSubtitles(
  project: Project,
  args: { timelineId?: string; trackId?: string; subtitles: SubtitleSpec[] },
): MutationResult {
  if (!Array.isArray(args.subtitles) || args.subtitles.length === 0) {
    throw new OpError('invalid_argument', 'subtitles must be a non-empty array')
  }
  const target = requireTimeline(project, args.timelineId)
  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!

  let track: Track | undefined
  if (args.trackId) {
    track = timeline.tracks.find((t) => t.id === args.trackId)
    if (!track) throw new OpError('not_found', `track ${args.trackId} is not on this timeline`)
    if (track.type !== 'subtitle') {
      throw new OpError('refused', `track "${track.name}" is a ${track.type} track, not a subtitle track`)
    }
  } else {
    track = timeline.tracks.find((t) => t.type === 'subtitle')
    if (!track) {
      const sameType = timeline.tracks.filter((t) => t.type === 'subtitle').length
      track = {
        id: newId(),
        type: 'subtitle',
        name: `S${sameType + 1}`,
        muted: false,
        hidden: false,
        locked: false,
        volume: 1,
        clips: [],
      }
      timeline.tracks.push(track)
    }
  }
  refuseIfLocked(track, 'adding subtitles')

  const created: string[] = []
  const warnings: string[] = []

  for (const [i, spec] of args.subtitles.entries()) {
    const label = `subtitles[${i}]`
    if (typeof spec.text !== 'string' || !spec.text.trim()) {
      throw new OpError('invalid_argument', `${label}.text must be a non-empty string`)
    }
    const startFrame = requireFrame(spec.startFrame, `${label}.startFrame`)
    const durationFrames = requireDuration(spec.durationFrames, `${label}.durationFrames`)

    // Overlapping cues are common in files authored by hand or by ASR. Rather
    // than refusing the whole import, the later cue is trimmed to start where
    // the earlier one ends, and the change is reported.
    const blocker = overlapping(track, startFrame, startFrame + durationFrames, new Set())
    let start = startFrame
    let duration = durationFrames
    if (blocker) {
      const free = clipEndFrame(blocker)
      if (free >= startFrame + durationFrames) {
        warnings.push(`${label} ("${preview(spec.text)}") overlapped an existing cue entirely and was dropped`)
        continue
      }
      warnings.push(
        `${label} ("${preview(spec.text)}") overlapped the cue before it and was moved from frame ${startFrame} to ${free}`,
      )
      start = free
      duration = startFrame + durationFrames - free
    }

    const clip: Clip = {
      id: newId(),
      mediaRef: '',
      mediaType: 'subtitle',
      sourceClipType: 'subtitle',
      startFrame: start,
      durationFrames: duration,
      trimStartFrame: 0,
      trimEndFrame: 0,
      speed: 1,
      volume: 1,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      fadeInInterpolation: 'linear',
      fadeOutInterpolation: 'linear',
      opacity: 1,
      // Anchored near the bottom, where a viewer expects to read them.
      transform: { ...defaultTransform(), centerY: 0.88 },
      crop: defaultCrop(),
      linkGroupId: null,
      groupId: null,
      textContent: spec.text.trim(),
      textStyle: defaultSubtitleStyle(),
      effects: [],
      keyframes: {},
      transitionIn: null,
    }
    track.clips.push(clip)
    sortClips(track)
    created.push(clip.id)
  }

  if (created.length === 0) {
    return {
      project,
      receipt: {
        operation: 'add_subtitles',
        changed: false,
        summary: 'No subtitle cue could be placed',
        affectedIds: [],
        warnings,
      },
    }
  }

  return {
    project: touch(next),
    receipt: {
      operation: 'add_subtitles',
      changed: true,
      summary: `Added ${created.length} subtitle cue(s) to "${track.name}"`,
      affectedIds: created,
      warnings,
    },
  }
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 32 ? `${flat.slice(0, 31)}…` : flat
}

/** Every subtitle cue on the timeline, in time order. */
export function subtitleCues(timeline: Timeline): { clip: Clip; trackId: string }[] {
  return timeline.tracks
    .filter((track) => track.type === 'subtitle')
    .flatMap((track) => track.clips.map((clip) => ({ clip, trackId: track.id })))
    .sort((a, b) => a.clip.startFrame - b.clip.startFrame)
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
  const ids = expandLinked(timeline, args.clipIds)

  for (const track of timeline.tracks) {
    const removed = track.clips.filter((c) => ids.has(c.id))
    if (removed.length === 0) continue
    refuseIfLocked(track, 'deleting its clips')
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
      summary:
        `Removed ${ids.size} clip(s)` +
        (ids.size > args.clipIds.length ? ' including linked audio' : '') +
        (args.ripple ? ' and closed the gaps' : ''),
      affectedIds: [...ids],
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
    refuseIfLocked(track, 'splitting its clips')
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

  // A linked sibling shifts by the same delta so picture and sound stay in sync.
  const expanded: MoveSpec[] = [...args.moves]
  for (const move of args.moves) {
    if (move.startFrame === undefined) continue
    const loc = findClip(timeline, move.clipId)
    if (!loc) continue
    const delta = move.startFrame - loc.clip.startFrame
    for (const sibling of linkedSiblings(timeline, move.clipId)) {
      if (expanded.some((m) => m.clipId === sibling.id)) continue
      expanded.push({ clipId: sibling.id, startFrame: Math.max(0, sibling.startFrame + delta) })
    }
  }

  const movingIds = new Set(expanded.map((m) => m.clipId))
  const touched: string[] = []

  for (const [i, move] of expanded.entries()) {
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
    refuseIfLocked(loc.track, 'moving its clips')
    refuseIfLocked(destination, 'moving clips onto it')

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
      summary:
        `Moved ${touched.length} clip(s)` +
        (touched.length > args.moves.length ? ' including linked audio' : ''),
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
    refuseIfLocked(loc.track, 'changing its clips')
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

// --- Effects --------------------------------------------------------------

/** Clamps a parameter to its declared bounds and rejects anything non-finite. */
function coerceEffectParam(spec: EffectParamSpec, raw: unknown, label: string): number {
  const value = requireFinite(raw, label)
  if (value < spec.min || value > spec.max) {
    throw new OpError(
      'invalid_argument',
      `${label} must be between ${spec.min} and ${spec.max}, got ${value}`,
    )
  }
  return value
}

function buildParams(
  definition: EffectDefinition,
  supplied: Record<string, unknown> | undefined,
  label: string,
): Record<string, number> {
  const params = defaultParams(definition)
  if (!supplied) return params
  for (const [key, raw] of Object.entries(supplied)) {
    const spec = definition.params.find((p) => p.key === key)
    if (!spec) {
      throw new OpError(
        'invalid_argument',
        `${label}: "${definition.name}" has no parameter "${key}" (has ${definition.params.map((p) => p.key).join(', ') || 'none'})`,
      )
    }
    params[key] = coerceEffectParam(spec, raw, `${label}.${key}`)
  }
  return params
}

export interface AddEffectArgs {
  timelineId?: string
  clipIds: string[]
  definitionId: string
  params?: Record<string, unknown>
  /** Stack position; appended when omitted. */
  index?: number
}

export function addEffect(project: Project, args: AddEffectArgs): MutationResult {
  if (!Array.isArray(args.clipIds) || args.clipIds.length === 0) {
    throw new OpError('invalid_argument', 'clipIds must be a non-empty array')
  }
  const definition = EFFECTS_BY_ID.get(args.definitionId)
  if (!definition) {
    throw new OpError('not_found', `no effect named "${args.definitionId}"`)
  }
  const target = requireTimeline(project, args.timelineId)
  for (const id of args.clipIds) requireClip(target, id)

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const created: string[] = []
  const warnings: string[] = []

  for (const id of args.clipIds) {
    const loc = requireClip(timeline, id)
    refuseIfLocked(loc.track, 'adding effects to its clips')
    const clip = loc.clip

    // An audio effect on a silent clip would render nothing; say so rather than pretend.
    if (definition.kind === 'audio' && !clipCarriesAudio(next, clip)) {
      warnings.push(`clip ${id} has no audio, so "${definition.name}" will have no effect`)
    }
    if (definition.kind === 'video' && clip.mediaType === 'audio') {
      throw new OpError('refused', `"${definition.name}" is a video effect; clip ${id} is audio`)
    }

    const effect: Effect = {
      id: newId(),
      definitionId: definition.id,
      enabled: true,
      params: buildParams(definition, args.params, 'params'),
    }
    clip.effects ??= []
    const index = args.index === undefined ? clip.effects.length : Math.min(Math.max(0, Math.round(args.index)), clip.effects.length)
    clip.effects.splice(index, 0, effect)
    created.push(effect.id)
  }

  return {
    project: touch(next),
    receipt: {
      operation: 'add_effect',
      changed: true,
      summary: `Added "${definition.name}" to ${args.clipIds.length} clip(s)`,
      affectedIds: created,
      warnings,
    },
  }
}

function clipCarriesAudio(project: Project, clip: Clip): boolean {
  if (clip.mediaType === 'audio') return true
  const asset = project.assets.find((a) => a.id === clip.mediaRef)
  return Boolean(asset?.hasAudio)
}

function requireEffect(clip: Clip, effectId: string): { effect: Effect; index: number } {
  const index = (clip.effects ?? []).findIndex((e) => e.id === effectId)
  if (index < 0) throw new OpError('not_found', `clip ${clip.id} has no effect ${effectId}`)
  return { effect: clip.effects[index]!, index }
}

export function removeEffect(
  project: Project,
  args: { timelineId?: string; clipId: string; effectId: string },
): MutationResult {
  const target = requireTimeline(project, args.timelineId)
  requireClip(target, args.clipId)

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const loc = requireClip(timeline, args.clipId)
  refuseIfLocked(loc.track, 'removing effects from its clips')
  const { effect, index } = requireEffect(loc.clip, args.effectId)
  const definition = EFFECTS_BY_ID.get(effect.definitionId)
  loc.clip.effects.splice(index, 1)

  return {
    project: touch(next),
    receipt: {
      operation: 'remove_effect',
      changed: true,
      summary: `Removed "${definition?.name ?? effect.definitionId}" from clip ${args.clipId}`,
      affectedIds: [args.effectId],
      warnings: [],
    },
  }
}

export function setEffectParams(
  project: Project,
  args: {
    timelineId?: string
    clipId: string
    effectId: string
    params?: Record<string, unknown>
    enabled?: boolean
  },
): MutationResult {
  const target = requireTimeline(project, args.timelineId)
  requireClip(target, args.clipId)

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const loc = requireClip(timeline, args.clipId)
  refuseIfLocked(loc.track, 'changing effects on its clips')
  const { effect } = requireEffect(loc.clip, args.effectId)
  const definition = EFFECTS_BY_ID.get(effect.definitionId)
  if (!definition) throw new OpError('not_found', `unknown effect "${effect.definitionId}"`)

  const before = JSON.stringify(effect)
  if (args.params) {
    for (const [key, raw] of Object.entries(args.params)) {
      const spec = definition.params.find((p) => p.key === key)
      if (!spec) {
        throw new OpError(
          'invalid_argument',
          `"${definition.name}" has no parameter "${key}" (has ${definition.params.map((p) => p.key).join(', ') || 'none'})`,
        )
      }
      effect.params[key] = coerceEffectParam(spec, raw, `params.${key}`)
    }
  }
  if (args.enabled !== undefined) {
    if (typeof args.enabled !== 'boolean') throw new OpError('invalid_argument', 'enabled must be a boolean')
    effect.enabled = args.enabled
  }

  const changed = JSON.stringify(effect) !== before
  return {
    project: changed ? touch(next) : project,
    receipt: {
      operation: 'set_effect_params',
      changed,
      summary: changed
        ? `Updated "${definition.name}" on clip ${args.clipId}`
        : `"${definition.name}" already matched the request`,
      affectedIds: [args.effectId],
      warnings: [],
    },
  }
}

export function reorderEffect(
  project: Project,
  args: { timelineId?: string; clipId: string; effectId: string; toIndex: number },
): MutationResult {
  const target = requireTimeline(project, args.timelineId)
  requireClip(target, args.clipId)

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const loc = requireClip(timeline, args.clipId)
  refuseIfLocked(loc.track, 'reordering effects on its clips')
  const { index } = requireEffect(loc.clip, args.effectId)
  const stack = loc.clip.effects
  const to = Math.min(Math.max(0, Math.round(args.toIndex)), stack.length - 1)

  if (to === index) {
    return {
      project,
      receipt: {
        operation: 'reorder_effect',
        changed: false,
        summary: `Effect is already at position ${to}`,
        affectedIds: [args.effectId],
        warnings: [],
      },
    }
  }
  const [moved] = stack.splice(index, 1)
  stack.splice(to, 0, moved!)

  return {
    project: touch(next),
    receipt: {
      operation: 'reorder_effect',
      changed: true,
      summary: `Moved effect from position ${index} to ${to}`,
      affectedIds: [args.effectId],
      warnings: [],
    },
  }
}

// --- Transitions ----------------------------------------------------------

/**
 * A transition needs a neighbour to dissolve from and enough material on both
 * sides to cover the overlap. Refusing beats silently shortening the handle.
 */
export function addTransition(
  project: Project,
  args: { timelineId?: string; clipId: string; kind?: TransitionKind; durationFrames?: number },
): MutationResult {
  const target = requireTimeline(project, args.timelineId)
  requireClip(target, args.clipId)

  const kind = (args.kind ?? 'dissolve') as TransitionKind
  if (!TRANSITION_KINDS.includes(kind)) {
    throw new OpError('invalid_argument', `kind must be one of ${TRANSITION_KINDS.join(', ')}`)
  }

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const loc = requireClip(timeline, args.clipId)
  refuseIfLocked(loc.track, 'adding a transition on it')

  const sorted = [...loc.track.clips].sort((a, b) => a.startFrame - b.startFrame)
  const position = sorted.findIndex((c) => c.id === args.clipId)
  const previous = position > 0 ? sorted[position - 1]! : null
  if (!previous) {
    throw new OpError('refused', `clip ${args.clipId} is first on its track; there is nothing to transition from`)
  }
  if (clipEndFrame(previous) !== loc.clip.startFrame) {
    throw new OpError(
      'refused',
      `clip ${args.clipId} does not butt against its predecessor; close the gap first`,
    )
  }

  const durationFrames =
    args.durationFrames === undefined
      ? Math.min(timeline.fps, previous.durationFrames, loc.clip.durationFrames)
      : requireDuration(args.durationFrames, 'durationFrames')

  const longest = Math.min(previous.durationFrames, loc.clip.durationFrames)
  if (durationFrames > longest) {
    throw new OpError(
      'refused',
      `a ${durationFrames}-frame transition needs ${durationFrames} frames on both sides, but the shorter clip is ${longest}`,
    )
  }
  // The incoming clip is pulled back over its predecessor using its own head
  // handle, so that handle has to exist. Refusing beats a silent short overlap.
  if (loc.clip.trimStartFrame < durationFrames) {
    throw new OpError(
      'refused',
      `a ${durationFrames}-frame transition needs ${durationFrames} frames of head handle on clip ${args.clipId}, but only ${loc.clip.trimStartFrame} are trimmed off its start`,
    )
  }

  loc.clip.transitionIn = { id: newId(), kind, durationFrames }

  return {
    project: touch(next),
    receipt: {
      operation: 'add_transition',
      changed: true,
      summary: `Added a ${durationFrames}-frame ${kind} into clip ${args.clipId}`,
      affectedIds: [loc.clip.transitionIn.id],
      warnings: [],
    },
  }
}

export function removeTransition(
  project: Project,
  args: { timelineId?: string; clipId: string },
): MutationResult {
  const target = requireTimeline(project, args.timelineId)
  requireClip(target, args.clipId)

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const loc = requireClip(timeline, args.clipId)
  refuseIfLocked(loc.track, 'removing a transition on it')

  if (!loc.clip.transitionIn) {
    return {
      project,
      receipt: {
        operation: 'remove_transition',
        changed: false,
        summary: `Clip ${args.clipId} has no transition`,
        affectedIds: [],
        warnings: [],
      },
    }
  }
  const removed = loc.clip.transitionIn
  loc.clip.transitionIn = null

  return {
    project: touch(next),
    receipt: {
      operation: 'remove_transition',
      changed: true,
      summary: `Removed the ${removed.kind} from clip ${args.clipId}`,
      affectedIds: [removed.id],
      warnings: [],
    },
  }
}

/**
 * Spacer: shifts every clip that starts at or after `fromFrame` on one track.
 * A negative delta closes a gap and is refused if it would make clips collide
 * or push anything before frame zero — the gesture reports instead of eating
 * material.
 */
export function shiftClips(
  project: Project,
  args: { timelineId?: string; trackId: string; fromFrame: number; deltaFrames: number },
): MutationResult {
  const fromFrame = requireFrame(args.fromFrame, 'fromFrame')
  const delta = Math.round(requireFinite(args.deltaFrames, 'deltaFrames'))
  const target = requireTimeline(project, args.timelineId)
  const existing = target.tracks.find((t) => t.id === args.trackId)
  if (!existing) throw new OpError('not_found', `track ${args.trackId} is not on timeline ${target.id}`)
  refuseIfLocked(existing, 'shifting its clips')

  if (delta === 0) {
    return {
      project,
      receipt: {
        operation: 'shift_clips',
        changed: false,
        summary: 'Nothing to shift',
        affectedIds: [],
        warnings: [],
      },
    }
  }

  const moving = existing.clips.filter((c) => c.startFrame >= fromFrame)
  if (moving.length === 0) {
    return {
      project,
      receipt: {
        operation: 'shift_clips',
        changed: false,
        summary: `No clip starts at or after frame ${fromFrame}`,
        affectedIds: [],
        warnings: [],
      },
    }
  }

  const earliest = Math.min(...moving.map((c) => c.startFrame))
  if (earliest + delta < 0) {
    throw new OpError('refused', `shifting by ${delta} would push a clip before frame zero`)
  }

  // Closing a gap must not overrun whatever sits before the shifted block.
  const stationary = existing.clips.filter((c) => c.startFrame < fromFrame)
  if (delta < 0 && stationary.length > 0) {
    const wall = Math.max(...stationary.map((c) => clipEndFrame(c)))
    if (earliest + delta < wall) {
      throw new OpError(
        'refused',
        `shifting by ${delta} would overlap the clip ending at frame ${wall}; the most you can close is ${earliest - wall}`,
      )
    }
  }

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const track = timeline.tracks.find((t) => t.id === args.trackId)!
  const ids: string[] = []
  for (const clip of track.clips) {
    if (clip.startFrame < fromFrame) continue
    clip.startFrame += delta
    ids.push(clip.id)
  }
  sortClips(track)

  return {
    project: touch(next),
    receipt: {
      operation: 'shift_clips',
      changed: true,
      summary: `Shifted ${ids.length} clip(s) by ${delta} frame(s) on "${track.name ?? track.type}"`,
      affectedIds: ids,
      warnings: [],
    },
  }
}

/**
 * Sets the work zone (Kdenlive's in/out points). Passing null clears it, which
 * means "the whole timeline" rather than "an empty zone".
 */
export function setWorkZone(
  project: Project,
  args: { timelineId?: string; inFrame?: number | null; outFrame?: number | null },
): MutationResult {
  const target = requireTimeline(project, args.timelineId)
  const clearing = args.inFrame === null || args.outFrame === null

  let zone: WorkZone | null = null
  if (!clearing) {
    const inFrame = args.inFrame === undefined ? (target.workZone?.inFrame ?? 0) : requireFrame(args.inFrame, 'inFrame')
    const outFrame =
      args.outFrame === undefined
        ? (target.workZone?.outFrame ?? timelineTotalFrames(target))
        : requireFrame(args.outFrame, 'outFrame')
    if (outFrame <= inFrame) {
      throw new OpError('invalid_argument', `outFrame (${outFrame}) must be after inFrame (${inFrame})`)
    }
    zone = { inFrame, outFrame }
  }

  const same = JSON.stringify(zone) === JSON.stringify(target.workZone ?? null)
  if (same) {
    return {
      project,
      receipt: {
        operation: 'set_work_zone',
        changed: false,
        summary: 'The work zone already matched the request',
        affectedIds: [target.id],
        warnings: [],
      },
    }
  }

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  timeline.workZone = zone

  return {
    project: touch(next),
    receipt: {
      operation: 'set_work_zone',
      changed: true,
      summary: zone
        ? `Work zone set to frames ${zone.inFrame}-${zone.outFrame}`
        : 'Work zone cleared; the whole timeline is in play',
      affectedIds: [target.id],
      warnings: [],
    },
  }
}

// --- Groups ---------------------------------------------------------------

/**
 * Binds clips so they move, trim and delete as one — Kdenlive's clip group.
 * Grouping an already-grouped clip merges the groups rather than nesting them,
 * because a nested group has no meaning the user can see.
 */
export function groupClips(
  project: Project,
  args: { timelineId?: string; clipIds: string[] },
): MutationResult {
  if (!Array.isArray(args.clipIds) || args.clipIds.length < 2) {
    throw new OpError('invalid_argument', 'grouping needs at least two clips')
  }
  const target = requireTimeline(project, args.timelineId)
  for (const id of args.clipIds) requireClip(target, id)

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!

  // Absorb every group already touching the selection, so no clip is orphaned.
  const absorbed = new Set<string>()
  for (const id of args.clipIds) {
    const existing = requireClip(timeline, id).clip.groupId
    if (existing) absorbed.add(existing)
  }

  const groupId = newId()
  const members: string[] = []
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      const inSelection = args.clipIds.includes(clip.id)
      const inAbsorbed = clip.groupId !== null && absorbed.has(clip.groupId)
      if (!inSelection && !inAbsorbed) continue
      refuseIfLocked(track, 'grouping its clips')
      clip.groupId = groupId
      members.push(clip.id)
    }
  }

  return {
    project: touch(next),
    receipt: {
      operation: 'group_clips',
      changed: true,
      summary: `Grouped ${members.length} clip(s)`,
      affectedIds: members,
      warnings:
        absorbed.size > 0
          ? [`${absorbed.size} existing group(s) were merged into the new one`]
          : [],
    },
  }
}

export function ungroupClips(
  project: Project,
  args: { timelineId?: string; clipIds: string[] },
): MutationResult {
  if (!Array.isArray(args.clipIds) || args.clipIds.length === 0) {
    throw new OpError('invalid_argument', 'clipIds must be a non-empty array')
  }
  const target = requireTimeline(project, args.timelineId)
  for (const id of args.clipIds) requireClip(target, id)

  const groups = new Set<string>()
  for (const id of args.clipIds) {
    const groupId = requireClip(target, id).clip.groupId
    if (groupId) groups.add(groupId)
  }
  if (groups.size === 0) {
    return {
      project,
      receipt: {
        operation: 'ungroup_clips',
        changed: false,
        summary: 'None of those clips is in a group',
        affectedIds: [],
        warnings: [],
      },
    }
  }

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const freed: string[] = []
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (!clip.groupId || !groups.has(clip.groupId)) continue
      refuseIfLocked(track, 'ungrouping its clips')
      clip.groupId = null
      freed.push(clip.id)
    }
  }

  return {
    project: touch(next),
    receipt: {
      operation: 'ungroup_clips',
      changed: true,
      summary: `Released ${freed.length} clip(s) from ${groups.size} group(s)`,
      affectedIds: freed,
      warnings: [],
    },
  }
}

// --- Advanced trim --------------------------------------------------------

/**
 * The four trims every NLE offers, on the same names editors use:
 *
 * - `ripple` moves one edge and slides everything after it, keeping the cut
 *   tight — the edit gets longer or shorter
 * - `roll`   moves the cut between two clips, one grows as the other shrinks —
 *   total length never changes
 * - `slip`   changes which part of the source a clip shows, without moving it
 * - `slide`  moves a clip in time, its neighbours absorbing the difference
 */
export type TrimKind = 'ripple' | 'roll' | 'slip' | 'slide'

export const TRIM_KINDS: TrimKind[] = ['ripple', 'roll', 'slip', 'slide']

export interface TrimArgs {
  timelineId?: string
  clipId: string
  kind: TrimKind
  /** Frames to move by. Negative shortens or moves earlier. */
  deltaFrames: number
  /** Which edge ripple and roll act on. Ignored by slip and slide. */
  edge?: 'start' | 'end'
}

/** Source frames still available beyond each edge of a clip. */
function handles(project: Project, clip: Clip): { head: number; tail: number } {
  const asset = clip.mediaRef ? project.assets.find((a) => a.id === clip.mediaRef) : undefined
  if (!asset || asset.type === 'image' || asset.durationSeconds <= 0) {
    // A still has unlimited material; only the timeline constrains it.
    return { head: Number.MAX_SAFE_INTEGER, tail: Number.MAX_SAFE_INTEGER }
  }
  return { head: clip.trimStartFrame, tail: Math.max(0, clip.trimEndFrame) }
}

export function trimClip(project: Project, args: TrimArgs): MutationResult {
  if (!TRIM_KINDS.includes(args.kind)) {
    throw new OpError('invalid_argument', `kind must be one of ${TRIM_KINDS.join(', ')}`)
  }
  const delta = Math.round(requireFinite(args.deltaFrames, 'deltaFrames'))
  const target = requireTimeline(project, args.timelineId)
  requireClip(target, args.clipId)

  if (delta === 0) {
    return {
      project,
      receipt: {
        operation: 'trim_clip',
        changed: false,
        summary: 'Nothing to trim',
        affectedIds: [args.clipId],
        warnings: [],
      },
    }
  }

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const loc = requireClip(timeline, args.clipId)
  refuseIfLocked(loc.track, 'trimming its clips')

  const clip = loc.clip
  const ordered = [...loc.track.clips].sort((a, b) => a.startFrame - b.startFrame)
  const index = ordered.findIndex((c) => c.id === clip.id)
  const previous = index > 0 ? ordered[index - 1]! : null
  const following = index < ordered.length - 1 ? ordered[index + 1]! : null
  const room = handles(next, clip)
  const edge = args.edge ?? 'end'
  const touched: string[] = [clip.id]

  // Captured before any mutation: the threshold for "downstream" has to be the
  // clip's end *before* it was resized, or the next clip is left overlapping.
  const originalEnd = clipEndFrame(clip)

  switch (args.kind) {
    case 'ripple': {
      if (edge === 'end') {
        if (delta > 0 && delta > room.tail) {
          throw new OpError('refused', `only ${room.tail} frame(s) of tail handle remain`)
        }
        if (clip.durationFrames + delta < 1) {
          throw new OpError('refused', 'a clip cannot be shortened below one frame')
        }
        clip.durationFrames += delta
        clip.trimEndFrame = Math.max(0, clip.trimEndFrame - Math.round(delta * clip.speed))
      } else {
        if (delta < 0 && -delta > room.head) {
          throw new OpError('refused', `only ${room.head} frame(s) of head handle remain`)
        }
        if (clip.durationFrames - delta < 1) {
          throw new OpError('refused', 'a clip cannot be shortened below one frame')
        }
        clip.startFrame += delta
        clip.durationFrames -= delta
        clip.trimStartFrame = Math.max(0, clip.trimStartFrame + Math.round(delta * clip.speed))
      }
      // Everything downstream follows, which is what makes it a ripple.
      for (const other of loc.track.clips) {
        if (other.id === clip.id || other.startFrame < originalEnd) continue
        other.startFrame += delta
        touched.push(other.id)
      }
      break
    }

    case 'roll': {
      const neighbour = edge === 'end' ? following : previous
      if (!neighbour) {
        throw new OpError('refused', `clip ${clip.id} has no neighbour on its ${edge} to roll against`)
      }
      if (edge === 'end') {
        if (clipEndFrame(clip) !== neighbour.startFrame) {
          throw new OpError('refused', 'roll needs the two clips to butt together')
        }
        if (delta > room.tail) throw new OpError('refused', `only ${room.tail} frame(s) of tail handle remain`)
        const neighbourRoom = handles(next, neighbour)
        if (-delta > neighbourRoom.head) {
          throw new OpError('refused', `the next clip only has ${neighbourRoom.head} frame(s) of head handle`)
        }
        if (clip.durationFrames + delta < 1 || neighbour.durationFrames - delta < 1) {
          throw new OpError('refused', 'rolling that far would empty one of the clips')
        }
        clip.durationFrames += delta
        clip.trimEndFrame = Math.max(0, clip.trimEndFrame - Math.round(delta * clip.speed))
        neighbour.startFrame += delta
        neighbour.durationFrames -= delta
        neighbour.trimStartFrame = Math.max(0, neighbour.trimStartFrame + Math.round(delta * neighbour.speed))
      } else {
        if (clipEndFrame(neighbour) !== clip.startFrame) {
          throw new OpError('refused', 'roll needs the two clips to butt together')
        }
        if (-delta > room.head) throw new OpError('refused', `only ${room.head} frame(s) of head handle remain`)
        const neighbourRoom = handles(next, neighbour)
        if (delta > neighbourRoom.tail) {
          throw new OpError('refused', `the previous clip only has ${neighbourRoom.tail} frame(s) of tail handle`)
        }
        if (clip.durationFrames - delta < 1 || neighbour.durationFrames + delta < 1) {
          throw new OpError('refused', 'rolling that far would empty one of the clips')
        }
        clip.startFrame += delta
        clip.durationFrames -= delta
        clip.trimStartFrame = Math.max(0, clip.trimStartFrame + Math.round(delta * clip.speed))
        neighbour.durationFrames += delta
        neighbour.trimEndFrame = Math.max(0, neighbour.trimEndFrame - Math.round(delta * neighbour.speed))
      }
      touched.push(neighbour.id)
      break
    }

    case 'slip': {
      // Both trims move by the same amount, so position and length hold.
      const shift = Math.round(delta * clip.speed)
      if (shift > room.tail) throw new OpError('refused', `only ${room.tail} frame(s) of tail handle remain`)
      if (-shift > room.head) throw new OpError('refused', `only ${room.head} frame(s) of head handle remain`)
      clip.trimStartFrame = Math.max(0, clip.trimStartFrame + shift)
      clip.trimEndFrame = Math.max(0, clip.trimEndFrame - shift)
      break
    }

    case 'slide': {
      if (!previous && delta < 0) {
        throw new OpError('refused', 'there is no clip before this one to slide into')
      }
      if (!following && delta > 0) {
        throw new OpError('refused', 'there is no clip after this one to slide into')
      }
      const shrinking = delta > 0 ? following! : previous!
      const growing = delta > 0 ? previous : following
      if (Math.abs(delta) >= shrinking.durationFrames) {
        throw new OpError(
          'refused',
          `sliding by ${delta} would swallow the neighbouring clip (${shrinking.durationFrames} frames)`,
        )
      }
      clip.startFrame += delta
      if (delta > 0) {
        shrinking.startFrame += delta
        shrinking.durationFrames -= delta
        shrinking.trimStartFrame = Math.max(0, shrinking.trimStartFrame + Math.round(delta * shrinking.speed))
      } else {
        shrinking.durationFrames += delta
        shrinking.trimEndFrame = Math.max(0, shrinking.trimEndFrame - Math.round(delta * shrinking.speed))
      }
      touched.push(shrinking.id)
      if (growing) {
        if (delta > 0) {
          growing.durationFrames += delta
          growing.trimEndFrame = Math.max(0, growing.trimEndFrame - Math.round(delta * growing.speed))
        } else {
          growing.startFrame += delta
          growing.durationFrames -= delta
          growing.trimStartFrame = Math.max(0, growing.trimStartFrame + Math.round(delta * growing.speed))
        }
        touched.push(growing.id)
      }
      break
    }
  }

  sortClips(loc.track)

  return {
    project: touch(next),
    receipt: {
      operation: 'trim_clip',
      changed: true,
      summary: `${args.kind} trim of ${delta} frame(s) on clip ${args.clipId}`,
      affectedIds: touched,
      warnings: [],
    },
  }
}

// --- Keyframes ------------------------------------------------------------

/**
 * Resolves a keyframe target on a clip and returns its bounds, or throws with
 * the reason. Refusing an unanimatable parameter here is the whole point: FFmpeg
 * would accept the keyframe and render it as a constant, which looks like a bug
 * in the editor rather than a limit of the filter.
 */
/** One animatable parameter of a clip, with the curve currently on it. */
export interface AnimatableTarget {
  target: string
  label: string
  min: number
  max: number
  step: number
  unit?: string
  /** Value in force when the curve is empty. */
  fallback: number
  keyframes: Keyframe[]
}

/**
 * Every parameter of this clip that FFmpeg actually re-evaluates per frame.
 *
 * The keyframe editor, the MCP `list_animatable` tool and the domain's own
 * bounds checking all read this one list, so none of them can drift from what
 * the renderer really supports.
 */
export function animatableTargets(clip: Clip): AnimatableTarget[] {
  const curves = clip.keyframes ?? {}
  const value = (target: string): number => {
    switch (target) {
      case 'opacity':
        return clip.opacity
      case 'volume':
        return clip.volume
      case 'transform.centerX':
        return clip.transform.centerX
      case 'transform.centerY':
        return clip.transform.centerY
      case 'transform.scaleX':
        return clip.transform.scaleX
      case 'transform.scaleY':
        return clip.transform.scaleY
      default:
        return clip.transform.rotation
    }
  }

  const targets: AnimatableTarget[] = STATIC_TARGETS.filter(
    // A still image has no soundtrack to ride, so offering it volume is noise.
    (target) => target !== 'volume' || clip.mediaType !== 'image',
  ).map((target) => ({
    target,
    ...STATIC_TARGET_SPECS[target],
    fallback: value(target),
    keyframes: curves[target] ?? [],
  }))

  for (const effect of clip.effects ?? []) {
    const definition = EFFECTS_BY_ID.get(effect.definitionId)
    if (!definition) continue
    for (const spec of definition.params) {
      if (!spec.animatable) continue
      const target = `effect:${effect.id}:${spec.key}`
      targets.push({
        target,
        label: `${definition.name} ${spec.label}`,
        min: spec.min,
        max: spec.max,
        step: spec.step,
        ...(spec.unit ? { unit: spec.unit } : {}),
        fallback: effect.params[spec.key] ?? spec.default,
        keyframes: curves[target] ?? [],
      })
    }
  }
  return targets
}

/**
 * Bounds for one target, or a refusal that says precisely why.
 *
 * The happy path comes straight from `animatableTargets`; everything below it
 * exists only to turn a miss into a message the caller can act on.
 */
function resolveKeyframeTarget(
  clip: Clip,
  target: string,
): { min: number; max: number; label: string } {
  const known = animatableTargets(clip).find((candidate) => candidate.target === target)
  if (known) return { min: known.min, max: known.max, label: known.label }

  if (!isEffectTarget(target)) {
    throw new OpError(
      'invalid_argument',
      `"${target}" is not an animatable target. Use one of ${STATIC_TARGETS.join(', ')} or effect:<effectId>:<param>.`,
    )
  }

  const parsed = parseEffectTarget(target)
  if (!parsed) {
    throw new OpError('invalid_argument', `"${target}" must look like effect:<effectId>:<param>`)
  }
  const effect = (clip.effects ?? []).find((e) => e.id === parsed.effectId)
  if (!effect) {
    throw new OpError('not_found', `clip ${clip.id} has no effect ${parsed.effectId}`)
  }
  const definition = EFFECTS_BY_ID.get(effect.definitionId)
  if (!definition) {
    throw new OpError('not_found', `unknown effect "${effect.definitionId}"`)
  }
  const spec = definition.params.find((p) => p.key === parsed.param)
  if (!spec) {
    throw new OpError(
      'invalid_argument',
      `"${definition.name}" has no parameter "${parsed.param}" (has ${definition.params.map((p) => p.key).join(', ') || 'none'})`,
    )
  }
  throw new OpError(
    'refused',
    `"${definition.name}" reads ${spec.key} once when the filter starts, so it cannot be animated. ` +
      `Animatable parameters in this build are on brightness, contrast, saturation, gamma, hue, vignette and gain.`,
  )
}

export interface SetKeyframeArgs {
  timelineId?: string
  clipId: string
  target: string
  /** Frames from the clip's own start. */
  frame: number
  value: number
  easing?: Easing
}

export function setKeyframe(project: Project, args: SetKeyframeArgs): MutationResult {
  const frame = requireFrame(args.frame, 'frame')
  const target = requireTimeline(project, args.timelineId)
  requireClip(target, args.clipId)

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const loc = requireClip(timeline, args.clipId)
  refuseIfLocked(loc.track, 'keyframing its clips')
  const clip = loc.clip

  if (frame >= clip.durationFrames) {
    throw new OpError(
      'invalid_argument',
      `frame ${frame} is past the end of the clip (${clip.durationFrames} frames). Keyframe frames are relative to the clip start.`,
    )
  }

  const bounds = resolveKeyframeTarget(clip, args.target)
  const value = requireFinite(args.value, 'value')
  if (value < bounds.min || value > bounds.max) {
    throw new OpError(
      'invalid_argument',
      `${bounds.label} must be between ${bounds.min} and ${bounds.max}, got ${value}`,
    )
  }
  const easing: Easing = args.easing ?? 'linear'
  if (!EASINGS.includes(easing)) {
    throw new OpError('invalid_argument', `easing must be one of ${EASINGS.join(', ')}`)
  }

  clip.keyframes ??= {}
  const existing = clip.keyframes[args.target] ?? []
  const before = JSON.stringify(existing)
  const keyframe: Keyframe = { frame, value, easing }
  clip.keyframes[args.target] = normalizeKeyframes([...existing.filter((k) => k.frame !== frame), keyframe])

  const changed = JSON.stringify(clip.keyframes[args.target]) !== before
  return {
    project: changed ? touch(next) : project,
    receipt: {
      operation: 'set_keyframe',
      changed,
      summary: changed
        ? `${bounds.label} keyframed to ${value} at clip frame ${frame} (${easing})`
        : `${bounds.label} already had that keyframe`,
      affectedIds: [args.clipId],
      warnings:
        changed && clip.keyframes[args.target]!.length === 1
          ? ['A single keyframe holds a constant value; add a second one to see movement.']
          : [],
    },
  }
}

/**
 * Move one keyframe along the ruler, keeping its value and easing.
 *
 * Dragging a diamond is a single gesture, so it has to be a single undo step:
 * doing it as a remove plus a set would make Ctrl+Z delete the keyframe instead
 * of putting it back where it was.
 */
export function moveKeyframe(
  project: Project,
  args: { timelineId?: string; clipId: string; target: string; fromFrame: number; toFrame: number },
): MutationResult {
  const fromFrame = requireFrame(args.fromFrame, 'fromFrame')
  const toFrame = requireFrame(args.toFrame, 'toFrame')
  const target = requireTimeline(project, args.timelineId)
  requireClip(target, args.clipId)

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const loc = requireClip(timeline, args.clipId)
  refuseIfLocked(loc.track, 'moving keyframes on its clips')
  const clip = loc.clip

  const existing = clip.keyframes?.[args.target] ?? []
  const moved = existing.find((k) => k.frame === fromFrame)
  if (!moved) {
    throw new OpError(
      'not_found',
      `"${args.target}" has no keyframe at clip frame ${fromFrame}` +
        (existing.length > 0 ? ` (it has ${existing.map((k) => k.frame).join(', ')})` : ''),
    )
  }
  if (toFrame >= clip.durationFrames) {
    throw new OpError(
      'invalid_argument',
      `frame ${toFrame} is past the end of the clip (${clip.durationFrames} frames)`,
    )
  }
  if (toFrame === fromFrame) {
    return {
      project,
      receipt: {
        operation: 'move_keyframe',
        changed: false,
        summary: `Keyframe on "${args.target}" is already at clip frame ${fromFrame}`,
        affectedIds: [],
        warnings: [],
      },
    }
  }

  // Landing on an occupied frame replaces it, exactly as setKeyframe does.
  const replaced = existing.some((k) => k.frame === toFrame)
  clip.keyframes![args.target] = normalizeKeyframes([
    ...existing.filter((k) => k.frame !== fromFrame && k.frame !== toFrame),
    { ...moved, frame: toFrame },
  ])

  return {
    project: touch(next),
    receipt: {
      operation: 'move_keyframe',
      changed: true,
      summary: `Moved the "${args.target}" keyframe from clip frame ${fromFrame} to ${toFrame}`,
      affectedIds: [args.clipId],
      warnings: replaced ? [`Replaced the keyframe that was already at frame ${toFrame}.`] : [],
    },
  }
}

export function removeKeyframe(
  project: Project,
  args: { timelineId?: string; clipId: string; target: string; frame?: number },
): MutationResult {
  const target = requireTimeline(project, args.timelineId)
  requireClip(target, args.clipId)

  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === target.id)!
  const loc = requireClip(timeline, args.clipId)
  refuseIfLocked(loc.track, 'removing keyframes from its clips')
  const clip = loc.clip
  const existing = clip.keyframes?.[args.target]

  if (!existing || existing.length === 0) {
    return {
      project,
      receipt: {
        operation: 'remove_keyframe',
        changed: false,
        summary: `Clip ${args.clipId} has no keyframes on "${args.target}"`,
        affectedIds: [],
        warnings: [],
      },
    }
  }

  if (args.frame === undefined) {
    delete clip.keyframes[args.target]
    return {
      project: touch(next),
      receipt: {
        operation: 'remove_keyframe',
        changed: true,
        summary: `Cleared ${existing.length} keyframe(s) on "${args.target}"`,
        affectedIds: [args.clipId],
        warnings: [],
      },
    }
  }

  const frame = requireFrame(args.frame, 'frame')
  const remaining = existing.filter((k) => k.frame !== frame)
  if (remaining.length === existing.length) {
    return {
      project,
      receipt: {
        operation: 'remove_keyframe',
        changed: false,
        summary: `No keyframe on "${args.target}" at clip frame ${frame}`,
        affectedIds: [],
        warnings: [],
      },
    }
  }
  if (remaining.length === 0) delete clip.keyframes[args.target]
  else clip.keyframes[args.target] = remaining

  return {
    project: touch(next),
    receipt: {
      operation: 'remove_keyframe',
      changed: true,
      summary: `Removed the keyframe at clip frame ${frame} on "${args.target}"`,
      affectedIds: [args.clipId],
      warnings: [],
    },
  }
}
