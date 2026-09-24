/**
 * MCP tool surface.
 *
 * Tools are written from filmmaker intent, not from internal APIs: one call
 * completes one coherent, undoable action and returns a structured receipt.
 * Every handler goes through the same `ops` functions the UI uses.
 */

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import {
  activeTimeline,
  clipEndFrame,
  timelineDisplayFrames,
  timelineTotalFrames,
  type MediaAsset,
  type Project,
  type Timeline,
} from '../../core/model.js'
import * as ops from '../../core/ops.js'
import {
  EFFECT_CATEGORIES,
  EFFECT_DEFINITIONS,
  EFFECTS_BY_ID,
} from '../../core/effects.js'
import { TRANSITION_LABELS } from '../../core/transitions.js'
import { TRANSITION_KINDS } from '../../core/model.js'
import { OpError, type Receipt } from '../../core/ops.js'
import { framesToTimecode } from '../../core/timecode.js'
import { probeAsset, renderFrame, renderTimeline } from '../media/ffmpeg.js'
import { PROXY_WIDTH } from '../media/proxy.js'
import { media } from '../media/host.js'
import { exportSetup, EXPORT_QUALITIES, type ExportQuality } from '../media/export.js'
import {
  defaultParallelJobs,
  getPerformance,
  MAX_PARALLEL_JOBS,
  PREVIEW_HEIGHTS,
  setPerformance,
  type PerformanceSettings,
} from '../media/performance.js'
import { CACHE_CATEGORIES, formatBytes, type CacheCategory } from '../media/cache.js'
import { bestEncoder, hardwareDecodeWorks } from '../media/encoders.js'
import { cpus } from 'node:os'
import { CONFIDENT, syncByAudio, SyncError } from '../media/sync.js'
import { detectSpeech, SpeechError } from '../media/speech.js'
import { formatSrt, formatVtt, parseSubtitles } from '../../core/subtitles.js'
import { framesToSeconds, secondsToFrames } from '../../core/timecode.js'
import { readFile, writeFile } from 'node:fs/promises'
import { ProjectStore } from '../project/store.js'

export interface ToolContext {
  store: ProjectStore
  /** Where export_project writes when the caller gives no path. */
  defaultExportDir: string
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, any>, ctx: ToolContext) => Promise<unknown> | unknown
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const str = (description: string) => ({ type: 'string', description })
const int = (description: string) => ({ type: 'integer', description })
const num = (description: string) => ({ type: 'number', description })
const bool = (description: string) => ({ type: 'boolean', description })
const arr = (items: unknown, description: string) => ({ type: 'array', items, description })

function receiptPayload(receipt: Receipt, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    changed: receipt.changed,
    summary: receipt.summary,
    affectedIds: receipt.affectedIds,
    ...(receipt.warnings.length > 0 ? { warnings: receipt.warnings } : {}),
    ...extra,
  }
}

function timelineSnapshot(project: Project, timeline: Timeline): Record<string, unknown> {
  return {
    id: timeline.id,
    name: timeline.name,
    fps: timeline.fps,
    width: timeline.width,
    height: timeline.height,
    totalFrames: timelineTotalFrames(timeline),
    duration: framesToTimecode(timelineTotalFrames(timeline), timeline.fps),
    tracks: timeline.tracks.map((track, index) => ({
      id: track.id,
      index,
      type: track.type,
      name: track.name,
      muted: track.muted,
      hidden: track.hidden,
      locked: track.locked,
      volume: track.volume,
      clips: track.clips.map((clip) => ({
        id: clip.id,
        mediaType: clip.mediaType,
        mediaRef: clip.mediaRef || null,
        mediaName: project.assets.find((a) => a.id === clip.mediaRef)?.name ?? null,
        startFrame: clip.startFrame,
        endFrame: clipEndFrame(clip),
        durationFrames: clip.durationFrames,
        timecode: framesToTimecode(clip.startFrame, timeline.fps),
        trimStartFrame: clip.trimStartFrame,
        speed: clip.speed,
        volume: clip.volume,
        opacity: clip.opacity,
        fadeInFrames: clip.fadeInFrames,
        fadeOutFrames: clip.fadeOutFrames,
        effectCount: clip.effects?.length ?? 0,
        ...(Object.keys(clip.keyframes ?? {}).length > 0
          ? { animatedTargets: Object.keys(clip.keyframes) }
          : {}),
        ...(clip.groupId ? { groupId: clip.groupId } : {}),
        ...(clip.linkGroupId ? { linkGroupId: clip.linkGroupId } : {}),
        ...(clip.transitionIn
          ? { transitionIn: { kind: clip.transitionIn.kind, durationFrames: clip.transitionIn.durationFrames } }
          : {}),
        ...(clip.textContent ? { textContent: clip.textContent } : {}),
        ...(clip.multicam
          ? {
              multicam: {
                activeIndex: clip.multicam.activeIndex,
                angles: clip.multicam.angles.map((angle, index) => ({ index, name: angle.name })),
              },
            }
          : {}),
      })),
    })),
    workZone: timeline.workZone,
    markers: timeline.markers.map((m) => ({
      id: m.id,
      name: m.name,
      startFrame: m.startFrame,
      timecode: framesToTimecode(m.startFrame, timeline.fps),
    })),
  }
}

function resolveTimeline(project: Project, timelineId?: string): Timeline {
  if (!timelineId) return activeTimeline(project)
  const found = project.timelines.find((t) => t.id === timelineId)
  if (!found) throw new OpError('not_found', `timeline ${timelineId} does not exist`)
  return found
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'get_timeline',
    description:
      'Read the full structure of a timeline: tracks, clips with stable ids and frame positions, and markers. ' +
      'Call this before any edit so you target real clip ids — positional indexes are not stable across edits.',
    inputSchema: object({
      timeline_id: str('Timeline to read. Defaults to the active timeline.'),
    }),
    handler: (args, ctx) => {
      const project = ctx.store.project
      const timeline = resolveTimeline(project, args.timeline_id)
      return {
        project: { id: project.id, name: project.name, activeTimelineId: project.activeTimelineId },
        timelines: project.timelines.map((t) => ({ id: t.id, name: t.name })),
        timeline: timelineSnapshot(project, timeline),
      }
    },
  },
  {
    name: 'inspect_timeline',
    description:
      'Compact human-readable overview of a timeline, one line per clip. Cheaper than get_timeline when you only ' +
      'need to understand the shape of the edit rather than act on specific clips.',
    inputSchema: object({ timeline_id: str('Timeline to inspect. Defaults to the active timeline.') }),
    handler: (args, ctx) => {
      const project = ctx.store.project
      const timeline = resolveTimeline(project, args.timeline_id)
      const lines: string[] = [
        `${timeline.name} — ${timeline.width}x${timeline.height} @ ${timeline.fps}fps — ` +
          `${framesToTimecode(timelineDisplayFrames(timeline), timeline.fps)}`,
      ]
      timeline.tracks.forEach((track, index) => {
        const flags = [
          track.muted ? 'muted' : null,
          track.hidden ? 'hidden' : null,
          track.locked ? 'locked' : null,
        ]
          .filter(Boolean)
          .join(' ')
        lines.push(`[${index}] ${track.name ?? track.type} (${track.type})${flags ? ` — ${flags}` : ''}`)
        if (track.clips.length === 0) lines.push('     (empty)')
        for (const clip of track.clips) {
          const name = clip.textContent ?? project.assets.find((a) => a.id === clip.mediaRef)?.name ?? clip.mediaType
          const extras = [
            clip.transitionIn ? `${clip.transitionIn.kind} ${clip.transitionIn.durationFrames}f` : null,
            clip.effects?.length ? `${clip.effects.length} fx` : null,
          ].filter(Boolean)
          lines.push(
            `     ${framesToTimecode(clip.startFrame, timeline.fps)} → ` +
              `${framesToTimecode(clipEndFrame(clip), timeline.fps)}  ${JSON.stringify(name)}` +
              `${extras.length ? `  [${extras.join(', ')}]` : ''}  ${clip.id}`,
          )
        }
      })
      return { overview: lines.join('\n') }
    },
  },
  {
    name: 'get_media',
    description: 'List every media asset imported into the project, with stable ids to use in add_clips.',
    inputSchema: object({}),
    handler: (_args, ctx) => ({
      assets: ctx.store.project.assets.map((a) => ({
        id: a.id,
        name: a.name,
        path: a.path,
        type: a.type,
        durationSeconds: a.durationSeconds,
        width: a.width,
        height: a.height,
        fps: a.fps,
        hasAudio: a.hasAudio,
        // Present only when a proxy exists, so a project without any stays terse.
        ...(a.proxyPath ? { proxied: true } : {}),
      })),
    }),
  },
  {
    name: 'search_media',
    description: 'Find imported assets whose file name matches a query. Use it to turn a description into an asset id.',
    inputSchema: object({ query: str('Case-insensitive substring of the file name.') }, ['query']),
    handler: (args, ctx) => {
      if (typeof args.query !== 'string' || !args.query.trim()) {
        throw new OpError('invalid_argument', 'query must be a non-empty string')
      }
      const needle = args.query.trim().toLowerCase()
      const matches = ctx.store.project.assets.filter((a) => a.name.toLowerCase().includes(needle))
      return {
        query: args.query,
        matchCount: matches.length,
        assets: matches.map((a) => ({ id: a.id, name: a.name, type: a.type, durationSeconds: a.durationSeconds })),
      }
    },
  },
  {
    name: 'import_media',
    description:
      'Import files from disk into the project so they can be placed on a timeline. Files are referenced in place, ' +
      'not copied. Already-imported paths are reported as skipped rather than duplicated.',
    inputSchema: object({ paths: arr(str('Absolute file path.'), 'Files to import.') }, ['paths']),
    handler: async (args, ctx) => {
      if (!Array.isArray(args.paths) || args.paths.length === 0) {
        throw new OpError('invalid_argument', 'paths must be a non-empty array')
      }
      const assets: MediaAsset[] = []
      const failures: { path: string; error: string }[] = []
      for (const path of args.paths) {
        try {
          assets.push(await probeAsset(String(path)))
        } catch (error) {
          failures.push({ path: String(path), error: (error as Error).message })
        }
      }
      if (assets.length === 0) {
        throw new OpError('refused', `no file could be imported: ${failures.map((f) => f.error).join('; ')}`)
      }
      const receipt = ctx.store.apply((project) => ops.addAssets(project, assets))
      return receiptPayload(receipt, {
        assets: assets
          .filter((a) => receipt.affectedIds.includes(a.id))
          .map((a) => ({ id: a.id, name: a.name, type: a.type, durationSeconds: a.durationSeconds })),
        ...(failures.length > 0 ? { failures } : {}),
      })
    },
  },
  {
    name: 'create_timeline',
    description: 'Create an additional timeline in the project and make it active unless told otherwise.',
    inputSchema: object({
      name: str('Display name.'),
      fps: int('Frame rate. Default 30.'),
      width: int('Canvas width in pixels. Default 1920.'),
      height: int('Canvas height in pixels. Default 1080.'),
      activate: bool('Make this the active timeline. Default true.'),
    }),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((project) =>
          ops.createTimeline(project, {
            name: args.name,
            fps: args.fps,
            width: args.width,
            height: args.height,
            activate: args.activate,
          }),
        ),
      ),
  },
  {
    name: 'set_active_timeline',
    description: 'Switch which timeline subsequent edits and exports target.',
    inputSchema: object({ timeline_id: str('Timeline to activate.') }, ['timeline_id']),
    handler: (args, ctx) => receiptPayload(ctx.store.apply((p) => ops.setActiveTimeline(p, args.timeline_id))),
  },
  {
    name: 'set_project_settings',
    description:
      'Change a timeline’s name, frame rate, or canvas size. Changing frame rate keeps clip frame positions, which ' +
      'shifts their timing in seconds — the receipt warns when that happens.',
    inputSchema: object({
      timeline_id: str('Timeline to change. Defaults to the active timeline.'),
      name: str('New name.'),
      fps: int('New frame rate.'),
      width: int('New canvas width.'),
      height: int('New canvas height.'),
    }),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.setProjectSettings(p, {
            timelineId: args.timeline_id,
            name: args.name,
            fps: args.fps,
            width: args.width,
            height: args.height,
          }),
        ),
      ),
  },
  {
    name: 'add_track',
    description: 'Add a video, audio, or subtitle track. Later tracks composite above earlier ones.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        type: { type: 'string', enum: ['video', 'audio', 'subtitle'], description: 'Track kind.' },
        name: str('Display name. Auto-numbered when omitted.'),
        index: int('Insertion index, bottom-up. Appended when omitted.'),
      },
      ['type'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.addTrack(p, { timelineId: args.timeline_id, type: args.type, name: args.name, index: args.index }),
        ),
      ),
  },
  {
    name: 'set_track_flags',
    description:
      'Mute or hide a whole track, or rename it. Muting keeps the clips but drops the track from the audio mix; ' +
      'hiding drops it from the picture. Prefer this over deleting clips when you want an A/B comparison.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        track_id: str('Track to change.'),
        muted: bool('Exclude this track from the audio mix.'),
        hidden: bool('Exclude this track from the picture.'),
        locked: bool('Refuse every edit on this track until unlocked.'),
        volume: num('Linear track gain applied to the whole track in the mix.'),
        name: str('New display name.'),
      },
      ['track_id'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.setTrackFlags(p, {
            timelineId: args.timeline_id,
            trackId: args.track_id,
            muted: args.muted,
            hidden: args.hidden,
            locked: args.locked,
            volume: args.volume,
            name: args.name,
          }),
        ),
      ),
  },
  {
    name: 'add_clips',
    description:
      'Place imported media on a timeline. Omitting start_frame appends to the end of the chosen track, so repeated ' +
      'calls build a cut in order. The call is refused — never silently retargeted — if the range is occupied or the ' +
      'media is too short for the requested trim and duration.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        mode: {
          type: 'string',
          enum: ['normal', 'overwrite', 'insert'],
          description:
            'What to do when the range is occupied. normal refuses; overwrite trims or removes what is under; ' +
            'insert pushes everything after the point rightwards. Default normal.',
        },
        clips: arr(
          object(
            {
              asset_id: str('Asset id from import_media, get_media, or search_media.'),
              track_id: str('Target track. First compatible track when omitted.'),
              start_frame: int('Timeline frame to place the clip at. Appends when omitted.'),
              duration_frames: int('Visible length. Full remaining media when omitted.'),
              trim_start_frame: int('Source frames to skip from the head. Default 0.'),
              speed: num('Playback rate; 2 is double speed. Default 1.'),
              volume: num('Linear gain. Default 1.'),
            },
            ['asset_id'],
          ),
          'Clips to place, applied in order.',
        ),
      },
      ['clips'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.addClips(p, {
            timelineId: args.timeline_id,
            mode: args.mode,
            clips: (args.clips as any[]).map((c) => ({
              assetId: c.asset_id,
              trackId: c.track_id,
              startFrame: c.start_frame,
              durationFrames: c.duration_frames,
              trimStartFrame: c.trim_start_frame,
              speed: c.speed,
              volume: c.volume,
            })),
          }),
        ),
      ),
  },
  {
    name: 'remove_clips',
    description:
      'Delete clips by id. Set ripple to true to close the resulting gaps by pulling later clips on the same track back.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        clip_ids: arr(str('Clip id.'), 'Clips to delete.'),
        ripple: bool('Close the gaps left behind. Default false.'),
      },
      ['clip_ids'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.removeClips(p, { timelineId: args.timeline_id, clipIds: args.clip_ids, ripple: args.ripple }),
        ),
      ),
  },
  {
    name: 'split_clips',
    description:
      'Cut clips at a timeline frame. With no clip_ids, every clip crossing that frame is split. Clips that do not ' +
      'cross the frame are reported as skipped instead of failing the whole call.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        frame: int('Timeline frame to cut at.'),
        clip_ids: arr(str('Clip id.'), 'Restrict the cut to these clips.'),
      },
      ['frame'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.splitClips(p, { timelineId: args.timeline_id, frame: args.frame, clipIds: args.clip_ids }),
        ),
      ),
  },
  {
    name: 'move_clips',
    description:
      'Move clips in time, to another track, or both. All moves are validated together and applied atomically, so a ' +
      'collision leaves the timeline untouched.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        moves: arr(
          object(
            {
              clip_id: str('Clip to move.'),
              start_frame: int('New timeline frame. Unchanged when omitted.'),
              track_id: str('Destination track. Unchanged when omitted.'),
            },
            ['clip_id'],
          ),
          'Moves to apply.',
        ),
      },
      ['moves'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.moveClips(p, {
            timelineId: args.timeline_id,
            moves: (args.moves as any[]).map((m) => ({
              clipId: m.clip_id,
              startFrame: m.start_frame,
              trackId: m.track_id,
            })),
          }),
        ),
      ),
  },
  {
    name: 'set_clip_properties',
    description:
      'Change timing, level, opacity, fades, scale, position, rotation, or crop on one or more clips at once. Use ' +
      'this for retiming, fade handles, and reframing rather than deleting and re-adding a clip.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        clip_ids: arr(str('Clip id.'), 'Clips to update.'),
        properties: object({
          start_frame: int('New timeline position.'),
          duration_frames: int('New visible length.'),
          trim_start_frame: int('Source frames skipped from the head.'),
          speed: num('Playback rate.'),
          volume: num('Linear gain.'),
          opacity: num('0 to 1.'),
          fade_in_frames: int('Fade-in length.'),
          fade_out_frames: int('Fade-out length.'),
          fade_in_interpolation: { type: 'string', enum: ['linear', 'ease-in', 'ease-out', 'ease-in-out'] },
          fade_out_interpolation: { type: 'string', enum: ['linear', 'ease-in', 'ease-out', 'ease-in-out'] },
          transform: object({
            center_x: num('0 to 1 across the canvas; 0.5 is centre.'),
            center_y: num('0 to 1 down the canvas; 0.5 is centre.'),
            scale_x: num('Horizontal scale relative to a fit-to-canvas frame.'),
            scale_y: num('Vertical scale relative to a fit-to-canvas frame.'),
            rotation: num('Degrees, clockwise.'),
          }),
          crop: object({
            top: num('Fraction removed from the top.'),
            bottom: num('Fraction removed from the bottom.'),
            left: num('Fraction removed from the left.'),
            right: num('Fraction removed from the right.'),
          }),
        }),
      },
      ['clip_ids', 'properties'],
    ),
    handler: (args, ctx) => {
      const p = args.properties ?? {}
      const transform = p.transform
        ? {
            centerX: p.transform.center_x,
            centerY: p.transform.center_y,
            scaleX: p.transform.scale_x,
            scaleY: p.transform.scale_y,
            rotation: p.transform.rotation,
          }
        : undefined
      const properties: ops.ClipProperties = {
        startFrame: p.start_frame,
        durationFrames: p.duration_frames,
        trimStartFrame: p.trim_start_frame,
        speed: p.speed,
        volume: p.volume,
        opacity: p.opacity,
        fadeInFrames: p.fade_in_frames,
        fadeOutFrames: p.fade_out_frames,
        fadeInInterpolation: p.fade_in_interpolation,
        fadeOutInterpolation: p.fade_out_interpolation,
        ...(transform ? { transform: prune(transform) } : {}),
        ...(p.crop ? { crop: prune(p.crop) } : {}),
      }
      return receiptPayload(
        ctx.store.apply((project) =>
          ops.setClipProperties(project, {
            timelineId: args.timeline_id,
            clipIds: args.clip_ids,
            properties: prune(properties),
          }),
        ),
      )
    },
  },
  {
    name: 'add_texts',
    description:
      'Add text clips (titles, lower thirds, captions) on a visual track. With no track_id, the topmost track that is ' +
      'free over the requested range is used, so text lands above the picture.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        texts: arr(
          object(
            {
              content: str('Text to display. Newlines are honoured.'),
              start_frame: int('Timeline frame the text appears at.'),
              duration_frames: int('How long it stays on screen.'),
              track_id: str('Target track. Topmost free visual track when omitted.'),
              font_size: int('Point size at the canvas resolution. Default 64.'),
              color: str('Hex colour such as #ffffff.'),
              center_x: num('0 to 1 across the canvas. Default 0.5.'),
              center_y: num('0 to 1 down the canvas. Default 0.5.'),
            },
            ['content', 'start_frame', 'duration_frames'],
          ),
          'Text clips to add.',
        ),
      },
      ['texts'],
    ),
    handler: (args, ctx) => {
      const receipt = ctx.store.apply((p) =>
        ops.addTexts(p, {
          timelineId: args.timeline_id,
          texts: (args.texts as any[]).map((t) => ({
            content: t.content,
            startFrame: t.start_frame,
            durationFrames: t.duration_frames,
            trackId: t.track_id,
            style: prune({ fontSize: t.font_size, color: t.color }),
          })),
        }),
      )
      // Placement is expressed on the clip transform, applied as a follow-up on the new ids.
      const placements = (args.texts as any[])
        .map((t, i) => ({ t, id: receipt.affectedIds[i] }))
        .filter((p) => p.id && (p.t.center_x !== undefined || p.t.center_y !== undefined))
      for (const { t, id } of placements) {
        ctx.store.apply((p) =>
          ops.setClipProperties(p, {
            timelineId: args.timeline_id,
            clipIds: [id!],
            properties: { transform: prune({ centerX: t.center_x, centerY: t.center_y }) },
          }),
        )
      }
      return receiptPayload(receipt)
    },
  },
  {
    name: 'update_text',
    description: 'Change the wording or styling of an existing text clip without moving or re-timing it.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        clip_id: str('Text clip to update.'),
        content: str('New text.'),
        font_size: int('New point size.'),
        color: str('New hex colour.'),
      },
      ['clip_id'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.updateText(p, {
            timelineId: args.timeline_id,
            clipId: args.clip_id,
            content: args.content,
            style: prune({ fontSize: args.font_size, color: args.color }),
          }),
        ),
      ),
  },
  {
    name: 'list_animatable',
    description:
      'The targets that can actually be keyframed on a clip, with their bounds. Only parameters FFmpeg re-evaluates ' +
      'every frame are listed: a keyframe on anything else would render as a constant, so set_keyframe refuses it. ' +
      'Call this before set_keyframe rather than guessing a target name.',
    inputSchema: object(
      { timeline_id: str('Defaults to the active timeline.'), clip_id: str('Clip to inspect.') },
      ['clip_id'],
    ),
    handler: (args, ctx) => {
      const timeline = resolveTimeline(ctx.store.project, args.timeline_id)
      const found = ops.findClip(timeline, args.clip_id)
      if (!found) throw new OpError('not_found', `clip ${args.clip_id} is not on timeline ${timeline.id}`)

      return {
        clipId: args.clip_id,
        durationFrames: found.clip.durationFrames,
        note: 'Keyframe frames are relative to the clip start, so moving the clip carries its animation.',
        targets: ops.animatableTargets(found.clip).map((target) => ({
          target: target.target,
          label: target.label,
          min: target.min,
          max: target.max,
          currentValue: target.fallback,
          keyframes: target.keyframes,
        })),
      }
    },
  },
  {
    name: 'set_keyframe',
    description:
      'Place or replace a keyframe on an animatable target. Frames are relative to the clip start. One keyframe ' +
      'alone holds a constant — two or more make motion. Use list_animatable to find valid targets and bounds.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        clip_id: str('Clip to animate.'),
        target: str('Target from list_animatable, e.g. transform.scaleX or effect:<id>:amount.'),
        frame: int('Frames from the clip start, not from the timeline start.'),
        value: num('Value at that frame.'),
        easing: {
          type: 'string',
          enum: ['linear', 'smooth', 'hold'],
          description: 'How the value travels to the next keyframe. Default linear.',
        },
      },
      ['clip_id', 'target', 'frame', 'value'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.setKeyframe(p, {
            timelineId: args.timeline_id,
            clipId: args.clip_id,
            target: args.target,
            frame: args.frame,
            value: args.value,
            easing: args.easing,
          }),
        ),
      ),
  },
  {
    name: 'move_keyframe',
    description:
      'Slide one keyframe to another frame, keeping its value and easing. One undoable step, unlike removing ' +
      'and re-adding it. Landing on an occupied frame replaces the keyframe that was there.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        clip_id: str('Clip holding the curve.'),
        target: str('Target path.'),
        from_frame: int('Clip-relative frame the keyframe is on now.'),
        to_frame: int('Clip-relative frame to move it to.'),
      },
      ['clip_id', 'target', 'from_frame', 'to_frame'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.moveKeyframe(p, {
            timelineId: args.timeline_id,
            clipId: args.clip_id,
            target: args.target,
            fromFrame: args.from_frame,
            toFrame: args.to_frame,
          }),
        ),
      ),
  },
  {
    name: 'remove_keyframe',
    description: 'Remove one keyframe, or the whole curve when no frame is given. Reports honestly when there is none.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        clip_id: str('Clip holding the curve.'),
        target: str('Target path.'),
        frame: int('Clip-relative frame. Omit to clear the entire curve.'),
      },
      ['clip_id', 'target'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.removeKeyframe(p, {
            timelineId: args.timeline_id,
            clipId: args.clip_id,
            target: args.target,
            frame: args.frame,
          }),
        ),
      ),
  },
  {
    name: 'trim_clip',
    description:
      'The four trims editors name: ripple moves one edge and slides everything after it; roll moves the cut ' +
      'between two butted clips so one grows as the other shrinks; slip changes which part of the source a clip ' +
      'shows without moving it; slide moves a clip while its neighbours absorb the difference. Each is refused ' +
      'with the exact figure when there is not enough handle or the neighbour is too short.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        clip_id: str('Clip to trim.'),
        kind: { type: 'string', enum: ops.TRIM_KINDS, description: 'Which trim to perform.' },
        delta_frames: int('Frames to move by. Negative shortens or moves earlier.'),
        edge: {
          type: 'string',
          enum: ['start', 'end'],
          description: 'Which edge ripple and roll act on. Ignored by slip and slide. Default end.',
        },
      },
      ['clip_id', 'kind', 'delta_frames'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.trimClip(p, {
            timelineId: args.timeline_id,
            clipId: args.clip_id,
            kind: args.kind,
            deltaFrames: args.delta_frames,
            edge: args.edge,
          }),
        ),
      ),
  },
  {
    name: 'group_clips',
    description:
      'Bind clips so they move, trim and delete as one. Grouping a clip that is already grouped merges the two ' +
      'groups rather than nesting them. Audio linked to a video import is already bound and needs no grouping.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        clip_ids: arr(str('Clip id.'), 'At least two clips.'),
      },
      ['clip_ids'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) => ops.groupClips(p, { timelineId: args.timeline_id, clipIds: args.clip_ids })),
      ),
  },
  {
    name: 'ungroup_clips',
    description: 'Release clips from their group. Reports honestly when none of them was grouped.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        clip_ids: arr(str('Clip id.'), 'Clips whose groups should be dissolved.'),
      },
      ['clip_ids'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) => ops.ungroupClips(p, { timelineId: args.timeline_id, clipIds: args.clip_ids })),
      ),
  },
  {
    name: 'set_work_zone',
    description:
      'Set or clear the work zone — the in/out band on the ruler that marks the part of the edit you are working ' +
      'on. Pass null for either bound to clear it, which means the whole timeline is in play.',
    inputSchema: object({
      timeline_id: str('Defaults to the active timeline.'),
      in_frame: int('Zone start. Null clears the zone.'),
      out_frame: int('Zone end, exclusive. Null clears the zone.'),
    }),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.setWorkZone(p, {
            timelineId: args.timeline_id,
            inFrame: args.in_frame,
            outFrame: args.out_frame,
          }),
        ),
      ),
  },
  {
    name: 'sync_angles',
    description:
      'Measure how far apart several recordings of the same scene started, by correlating their loudness ' +
      'envelopes. Returns one offset per asset in seconds, plus a confidence: below 0.5 the peak is not clearly ' +
      'above the noise and the answer should be treated as a guess. This only measures — nothing is changed.',
    inputSchema: object(
      { asset_ids: arr(str('Media asset id.'), 'At least two assets, all with audio.') },
      ['asset_ids'],
    ),
    handler: async (args, ctx) => {
      const assets = (args.asset_ids as string[]).map((id) => {
        const found = ctx.store.project.assets.find((a) => a.id === id)
        if (!found) throw new OpError('not_found', `media asset ${id} is not in this project`)
        return found
      })
      try {
        const results = await syncByAudio(assets)
        return {
          reference: assets[0]!.name,
          offsets: results.map((result) => ({
            ...result,
            name: assets.find((a) => a.id === result.assetId)!.name,
            confident: result.confidence >= CONFIDENT,
          })),
        }
      } catch (error) {
        if (error instanceof SyncError) throw new OpError('refused', error.message)
        throw error
      }
    },
  },
  {
    name: 'create_multicam',
    description:
      'Place a multicam clip: one angle on the timeline that remembers the others, so cuts between cameras are ' +
      'ordinary cuts on an ordinary track. With auto_sync the offsets are measured from the audio first. ' +
      'Switching angle changes the picture only — the sound stays on the first angle, as a multicam edit should.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        angles: arr(
          object(
            {
              asset_id: str('Media asset for this camera.'),
              offset_frames: int('Source frames to skip so this angle lines up. Default 0.'),
            },
            ['asset_id'],
          ),
          'At least two angles, in the order they should be numbered.',
        ),
        auto_sync: bool('Measure the offsets from the audio instead of using the given ones.'),
        start_frame: int('Where the multicam clip starts on the timeline. Default 0.'),
        duration_frames: int('Defaults to the whole stretch where every angle has footage.'),
        track_id: str('Track to place it on. Defaults to the first free video track.'),
      },
      ['angles'],
    ),
    handler: async (args, ctx) => {
      const timeline = resolveTimeline(ctx.store.project, args.timeline_id)
      let angles = (args.angles as { asset_id: string; offset_frames?: number }[]).map((angle) => ({
        assetId: angle.asset_id,
        offsetFrames: angle.offset_frames ?? 0,
      }))
      const measured: Record<string, unknown>[] = []

      if (args.auto_sync) {
        const assets = angles.map((angle) => {
          const found = ctx.store.project.assets.find((a) => a.id === angle.assetId)
          if (!found) throw new OpError('not_found', `media asset ${angle.assetId} is not in this project`)
          return found
        })
        try {
          const results = await syncByAudio(assets)
          angles = angles.map((angle) => {
            const result = results.find((r) => r.assetId === angle.assetId)!
            measured.push({
              name: assets.find((a) => a.id === angle.assetId)!.name,
              offsetSeconds: result.offsetSeconds,
              confidence: result.confidence,
            })
            return { ...angle, offsetFrames: secondsToFrames(result.offsetSeconds, timeline.fps) }
          })
        } catch (error) {
          if (error instanceof SyncError) throw new OpError('refused', error.message)
          throw error
        }
      }

      const receipt = ctx.store.apply((p) =>
        ops.createMulticam(p, {
          timelineId: timeline.id,
          angles,
          startFrame: args.start_frame,
          durationFrames: args.duration_frames,
          trackId: args.track_id,
        }),
      )
      return receiptPayload(receipt, {
        angles: angles.map((angle, index) => ({ index, assetId: angle.assetId, offsetFrames: angle.offsetFrames })),
        ...(measured.length > 0 ? { measured } : {}),
      })
    },
  },
  {
    name: 'switch_angle',
    description:
      'Cut to another camera. With a frame the clip is cut there and only the part after changes, which is how a ' +
      'multicam edit is built; without one the whole clip changes. Refused with the frame numbers when the ' +
      'chosen angle has no footage covering that stretch.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        clip_id: str('A multicam clip. get_timeline reports which clips have angles.'),
        angle_index: int('Zero-based index into the angle set.'),
        frame: int('Timeline frame to cut at. Omit to change the whole clip.'),
      },
      ['clip_id', 'angle_index'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.switchAngle(p, {
            timelineId: args.timeline_id,
            clipId: args.clip_id,
            angleIndex: args.angle_index,
            frame: args.frame,
          }),
        ),
      ),
  },
  {
    name: 'build_proxies',
    description:
      'Transcode every video clip to a small all-intra copy, so editing and preview stay responsive on a modest ' +
      'machine. Proxies are used for preview only — an export always reads the original files, so this never ' +
      'costs delivered quality. Already-current proxies are skipped. Runs as many transcodes at once as the ' +
      'parallelJobs setting allows (see get_performance).',
    inputSchema: object({}),
    handler: async (_args, ctx) => {
      const { built, receipt } = await media.buildProxies(ctx.store, (proxyArgs) => ctx.store.apply((p) => ops.setAssetProxies(p, proxyArgs)))
      if (!receipt) {
        return { built: 0, summary: 'every clip already had a current proxy', width: PROXY_WIDTH }
      }
      return receiptPayload(receipt, { built, width: PROXY_WIDTH })
    },
  },
  {
    name: 'get_subtitles',
    description:
      'Every subtitle cue on the timeline, in time order, with its clip id so it can be moved, trimmed or ' +
      'retimed like any other clip. Cue text is editable with update_text.',
    inputSchema: object({ timeline_id: str('Defaults to the active timeline.') }),
    handler: (args, ctx) => {
      const timeline = resolveTimeline(ctx.store.project, args.timeline_id)
      return {
        timelineId: timeline.id,
        fps: timeline.fps,
        cues: ops.subtitleCues(timeline).map(({ clip, trackId }) => ({
          clipId: clip.id,
          trackId,
          startFrame: clip.startFrame,
          endFrame: clipEndFrame(clip),
          start: framesToTimecode(clip.startFrame, timeline.fps),
          end: framesToTimecode(clipEndFrame(clip), timeline.fps),
          text: clip.textContent ?? '',
        })),
      }
    },
  },
  {
    name: 'add_subtitles',
    description:
      'Write subtitle cues straight onto a subtitle track, creating one if needed. This is how you caption ' +
      'something without a file: you supply the text and the timings. Cues become ordinary clips, so they can be ' +
      'moved and trimmed afterwards. A cue that lands on top of an earlier one is pushed to start where that one ' +
      'ends, and the move is reported. There is no speech recognition in this build — the words have to come from ' +
      'somewhere, and detect_speech gives you the timings to hang them on.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        track_id: str('Subtitle track to write to. Defaults to the first one, created if absent.'),
        subtitles: arr(
          object(
            {
              start_frame: int('Timeline frame the cue appears on.'),
              duration_frames: int('How long it stays on screen.'),
              text: str('The line. Newlines are kept as line breaks.'),
            },
            ['start_frame', 'duration_frames', 'text'],
          ),
          'Cues to add, in any order.',
        ),
      },
      ['subtitles'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.addSubtitles(p, {
            timelineId: args.timeline_id,
            trackId: args.track_id,
            subtitles: (args.subtitles as Record<string, any>[]).map((cue) => ({
              startFrame: cue.start_frame,
              durationFrames: cue.duration_frames,
              text: cue.text,
            })),
          }),
        ),
      ),
  },
  {
    name: 'detect_speech',
    description:
      'Find the stretches of a clip that carry sound, so text can be placed on the moment it is spoken rather ' +
      'than spread evenly over the clip. Returns segments in both seconds and timeline frames, ready to pass to ' +
      'add_subtitles. This is voice activity, not recognition: it hears that someone is talking, never what they ' +
      'said, and music counts as sound. Pair it with text you already have.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline; sets the frame rate of the answer.'),
        clip_id: str('Clip to listen to. Its position sets the timeline frames returned.'),
        asset_id: str('Media asset to listen to instead, reported from its own start.'),
        threshold_db: num('Level below which a passage is silence. Default -30.'),
        min_silence_seconds: num('Shortest gap that splits two segments. Default 0.35.'),
      },
    ),
    handler: async (args, ctx) => {
      const project = ctx.store.project
      const timeline = resolveTimeline(project, args.timeline_id)

      let asset: MediaAsset | undefined
      let offsetFrames = 0
      let limitFrames = Infinity
      if (args.clip_id) {
        const found = ops.findClip(timeline, args.clip_id)
        if (!found) throw new OpError('not_found', `clip ${args.clip_id} is not on timeline ${timeline.id}`)
        asset = project.assets.find((a) => a.id === found.clip.mediaRef)
        if (!asset) throw new OpError('refused', `clip ${args.clip_id} has no media to listen to`)
        // Segments come back in source time; the clip's trim and position move
        // them onto the timeline.
        offsetFrames = found.clip.startFrame - found.clip.trimStartFrame
        limitFrames = clipEndFrame(found.clip)
      } else if (args.asset_id) {
        asset = project.assets.find((a) => a.id === args.asset_id)
        if (!asset) throw new OpError('not_found', `media asset ${args.asset_id} is not in this project`)
      } else {
        throw new OpError('invalid_argument', 'give either clip_id or asset_id')
      }

      let segments
      try {
        segments = await detectSpeech(asset, {
          thresholdDb: args.threshold_db,
          minSilenceSeconds: args.min_silence_seconds,
        })
      } catch (error) {
        if (error instanceof SpeechError) throw new OpError('refused', error.message)
        throw error
      }

      const placed = segments
        .map((segment) => {
          const startFrame = offsetFrames + secondsToFrames(segment.startSeconds, timeline.fps)
          const endFrame = offsetFrames + secondsToFrames(segment.endSeconds, timeline.fps)
          return {
            startSeconds: Number(segment.startSeconds.toFixed(3)),
            endSeconds: Number(segment.endSeconds.toFixed(3)),
            startFrame,
            endFrame: Math.min(endFrame, limitFrames),
            durationFrames: Math.max(1, Math.min(endFrame, limitFrames) - startFrame),
            timecode: framesToTimecode(startFrame, timeline.fps),
          }
        })
        .filter((segment) => segment.startFrame < limitFrames && segment.durationFrames > 0)

      return {
        source: asset.name,
        fps: timeline.fps,
        note:
          'Voice activity only — no words are recognised. Use these timings with text you already have, ' +
          'via add_subtitles.',
        segments: placed,
      }
    },
  },
  {
    name: 'import_subtitles',
    description:
      'Read an .srt or .vtt file and place its cues on a subtitle track, creating one if needed. Cues become ' +
      'ordinary clips, so they can then be moved and trimmed. Lines the file could not supply are reported ' +
      'rather than dropped in silence.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        path: str('Absolute path to the subtitle file.'),
        offset_seconds: num('Shift every cue by this much. Negative moves them earlier. Default 0.'),
      },
      ['path'],
    ),
    handler: async (args, ctx) => {
      const timeline = resolveTimeline(ctx.store.project, args.timeline_id)
      let source: string
      try {
        source = await readFile(String(args.path), 'utf8')
      } catch (error) {
        throw new OpError('not_found', `cannot read ${args.path}: ${(error as Error).message}`)
      }

      const { cues, skipped } = parseSubtitles(source)
      if (cues.length === 0) {
        throw new OpError(
          'refused',
          `${args.path} contains no usable cue` +
            (skipped.length > 0 ? ` (${skipped.length} unusable: ${skipped.slice(0, 3).join('; ')})` : ''),
        )
      }

      const offset = Number(args.offset_seconds ?? 0)
      const subtitles = cues.map((cue) => ({
        startFrame: Math.max(0, secondsToFrames(cue.startSeconds + offset, timeline.fps)),
        durationFrames: Math.max(1, secondsToFrames(cue.endSeconds - cue.startSeconds, timeline.fps)),
        text: cue.text,
      }))

      const receipt = ctx.store.apply((project) =>
        ops.addSubtitles(project, { timelineId: timeline.id, subtitles }),
      )
      return receiptPayload(receipt, {
        read: cues.length,
        ...(skipped.length > 0 ? { unusableLines: skipped } : {}),
      })
    },
  },
  {
    name: 'export_subtitles',
    description:
      'Write the timeline\'s subtitle cues out as .srt or .vtt. The format follows the file extension unless ' +
      'given explicitly. This writes a sidecar file; it does not burn the subtitles into a render.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        path: str('Absolute path to write.'),
        format: { type: 'string', enum: ['srt', 'vtt'], description: 'Defaults to the path extension.' },
      },
      ['path'],
    ),
    handler: async (args, ctx) => {
      const timeline = resolveTimeline(ctx.store.project, args.timeline_id)
      const cues = ops.subtitleCues(timeline).map(({ clip }) => ({
        startSeconds: framesToSeconds(clip.startFrame, timeline.fps),
        endSeconds: framesToSeconds(clipEndFrame(clip), timeline.fps),
        text: clip.textContent ?? '',
      }))
      if (cues.length === 0) {
        throw new OpError('refused', `timeline "${timeline.name}" has no subtitle cue to write`)
      }

      const path = String(args.path)
      const format = args.format ?? (path.toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt')
      await writeFile(path, format === 'vtt' ? formatVtt(cues) : formatSrt(cues), 'utf8')
      return { path, format, cues: cues.length }
    },
  },
  {
    name: 'add_markers',
    description: 'Drop named markers on the timeline to record beats, notes, or intended cut points.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        markers: arr(
          object(
            {
              start_frame: int('Timeline frame.'),
              name: str('Marker label.'),
              duration_frames: int('Span in frames. Default 1.'),
              color: str('Hex colour. Default #f0b400.'),
            },
            ['start_frame', 'name'],
          ),
          'Markers to add.',
        ),
      },
      ['markers'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.addMarkers(p, {
            timelineId: args.timeline_id,
            markers: (args.markers as any[]).map((m) => ({
              startFrame: m.start_frame,
              name: m.name,
              durationFrames: m.duration_frames,
              color: m.color,
            })),
          }),
        ),
      ),
  },
  {
    name: 'capture_frame',
    description:
      'Render a single composited frame to a PNG and return its path, so you can look at the edit instead of ' +
      'guessing. Use it to verify framing, text placement, and layer order after a change.',
    inputSchema: object(
      {
        frame: int('Timeline frame to capture.'),
        timeline_id: str('Defaults to the active timeline.'),
        output_path: str('Where to write the PNG. A temporary file is used when omitted.'),
      },
      ['frame'],
    ),
    handler: async (args, ctx) => {
      const project = ctx.store.project
      const timeline = resolveTimeline(project, args.timeline_id)
      if (!Number.isInteger(args.frame) || args.frame < 0) {
        throw new OpError('invalid_argument', 'frame must be a non-negative integer')
      }
      const total = timelineTotalFrames(timeline)
      if (args.frame >= total) {
        throw new OpError('refused', `frame ${args.frame} is past the end of the timeline (${total} frames)`)
      }
      const output = args.output_path ?? join(tmpdir(), `palmier-frame-${randomUUID()}.png`)
      await renderFrame(project, timeline, args.frame, output)
      return {
        changed: false,
        frame: args.frame,
        timecode: framesToTimecode(args.frame, timeline.fps),
        imagePath: output,
      }
    },
  },
  {
    name: 'export_project',
    description:
      'Render the active timeline to an H.264 MP4 and wait for it to finish. Uses the GPU encoder when the machine ' +
      'has a working one, like the export dialog. Returns the output path and the encoder used, or a terminal ' +
      'error with the FFmpeg diagnostics — a failed export never reports success.',
    inputSchema: object({
      timeline_id: str('Defaults to the active timeline.'),
      output_path: str('Destination .mp4. Defaults to the project folder.'),
      quality: { type: 'string', enum: [...EXPORT_QUALITIES], description: 'Encoder preset. Default balanced.' },
      hardware: bool('Use the GPU encoder when one works. Default true; false forces x264 on the CPU, which gives a slightly smaller file at the same quality and takes several times longer.'),
    }),
    handler: async (args, ctx) => {
      const project = ctx.store.project
      const timeline = resolveTimeline(project, args.timeline_id)
      if (timelineTotalFrames(timeline) === 0) {
        throw new OpError('refused', `timeline "${timeline.name}" is empty; there is nothing to export`)
      }
      const quality = (args.quality ?? 'balanced') as ExportQuality
      if (!EXPORT_QUALITIES.includes(quality)) {
        throw new OpError('invalid_argument', `quality must be one of ${EXPORT_QUALITIES.join(', ')}`)
      }
      const setup = await exportSetup(quality, args.hardware !== false)

      const output =
        args.output_path ?? join(project.path ?? ctx.defaultExportDir, `${timeline.name.replace(/[\\/:*?"<>|]/g, '_')}.mp4`)
      const started = Date.now()
      const handle = renderTimeline(project, timeline, { outputPath: output, ...setup.options })
      await media.trackExport(handle.promise)
      const seconds = (Date.now() - started) / 1000
      const duration = framesToSeconds(timelineTotalFrames(timeline), timeline.fps)
      return {
        changed: false,
        summary: `Exported "${timeline.name}" (${framesToTimecode(timelineTotalFrames(timeline), timeline.fps)}) at ${quality} quality with ${setup.encoder.label}`,
        outputPath: output,
        encoder: setup.encoder.label,
        renderSeconds: Number(seconds.toFixed(2)),
        realtimeFactor: Number((duration / Math.max(0.001, seconds)).toFixed(2)),
      }
    },
  },
  {
    name: 'undo',
    description: 'Undo the last edit, whether it came from the UI or from a tool call. Reports honestly when there is nothing to undo.',
    inputSchema: object({}),
    handler: (_args, ctx) => receiptPayload(ctx.store.undo(), { history: ctx.store.history }),
  },
]

/** Drops undefined values so partial updates never clobber fields with `undefined`. */
function prune<T extends Record<string, any>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]))

// --- Effects, transitions and tracks -------------------------------------

const EFFECT_TOOLS: ToolDefinition[] = [
  {
    name: 'list_effects',
    description:
      'Catalogue of every available effect with its parameters and bounds. Call this before apply_effect so you use ' +
      'real parameter names and stay inside the accepted range, instead of guessing and being refused.',
    inputSchema: object({
      category: {
        type: 'string',
        enum: EFFECT_CATEGORIES,
        description: 'Restrict to one category.',
      },
      kind: { type: 'string', enum: ['video', 'audio'], description: 'Restrict to video or audio effects.' },
    }),
    handler: (args) => {
      const matches = EFFECT_DEFINITIONS.filter(
        (d) => (!args.category || d.category === args.category) && (!args.kind || d.kind === args.kind),
      )
      return {
        count: matches.length,
        effects: matches.map((d) => ({
          id: d.id,
          name: d.name,
          category: d.category,
          kind: d.kind,
          description: d.description,
          params: d.params.map((p) => ({
            key: p.key,
            label: p.label,
            min: p.min,
            max: p.max,
            default: p.default,
            ...(p.unit ? { unit: p.unit } : {}),
          })),
        })),
      }
    },
  },
  {
    name: 'apply_effect',
    description:
      'Add an effect to one or more clips. Effects render in stack order, so a grade added before a blur is blurred ' +
      'too. Parameters outside their declared bounds are refused rather than clamped.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        clip_ids: arr(str('Clip id.'), 'Clips to affect.'),
        effect: str('Effect id from list_effects.'),
        params: { type: 'object', description: 'Parameter values by key. Defaults are used for anything omitted.' },
        index: int('Stack position. Appended when omitted.'),
      },
      ['clip_ids', 'effect'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.addEffect(p, {
            timelineId: args.timeline_id,
            clipIds: args.clip_ids,
            definitionId: args.effect,
            params: args.params,
            index: args.index,
          }),
        ),
      ),
  },
  {
    name: 'get_clip_effects',
    description: 'Read the effect stack on a clip, with each effect’s stable id and current parameter values.',
    inputSchema: object({ timeline_id: str('Defaults to the active timeline.'), clip_id: str('Clip to read.') }, ['clip_id']),
    handler: (args, ctx) => {
      const timeline = resolveTimeline(ctx.store.project, args.timeline_id)
      const found = ops.findClip(timeline, args.clip_id)
      if (!found) throw new OpError('not_found', `clip ${args.clip_id} is not on timeline ${timeline.id}`)
      return {
        clipId: args.clip_id,
        effects: (found.clip.effects ?? []).map((e, index) => {
          const definition = EFFECTS_BY_ID.get(e.definitionId)
          return {
            id: e.id,
            index,
            effect: e.definitionId,
            name: definition?.name ?? e.definitionId,
            kind: definition?.kind ?? 'video',
            enabled: e.enabled,
            params: e.params,
            // Omitted when identity, so a stack with no grading stays readable.
            ...(e.curves && Object.keys(e.curves).length > 0 ? { curves: e.curves } : {}),
            ...(definition?.curveChannels
              ? { curveChannels: definition.curveChannels.map((c) => c.key) }
              : {}),
          }
        }),
        transitionIn: found.clip.transitionIn
          ? {
              id: found.clip.transitionIn.id,
              kind: found.clip.transitionIn.kind,
              durationFrames: found.clip.transitionIn.durationFrames,
            }
          : null,
      }
    },
  },
  {
    name: 'set_effect',
    description:
      'Change an effect’s parameters, or bypass it with enabled=false. Bypassing is how you A/B a look without ' +
      'losing the settings.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        clip_id: str('Clip holding the effect.'),
        effect_id: str('Effect id from get_clip_effects.'),
        params: { type: 'object', description: 'Parameter values to change.' },
        enabled: bool('Set false to bypass without removing.'),
      },
      ['clip_id', 'effect_id'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.setEffectParams(p, {
            timelineId: args.timeline_id,
            clipId: args.clip_id,
            effectId: args.effect_id,
            params: args.params,
            enabled: args.enabled,
          }),
        ),
      ),
  },
  {
    name: 'set_effect_curve',
    description:
      'Set one channel of a curve effect. Points are {x, y} in 0..1, input against output; the identity is a ' +
      'straight diagonal. An S-shape adds contrast, a lifted first point raises the black level. Points are ' +
      'sorted and clamped, so they need not arrive in order.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        clip_id: str('Clip holding the effect.'),
        effect_id: str('Effect instance id from get_clip_effects.'),
        channel: {
          type: 'string',
          enum: ['master', 'r', 'g', 'b'],
          description: 'Which channel to shape.',
        },
        points: arr(
          object({ x: num('Input level, 0..1.'), y: num('Output level, 0..1.') }, ['x', 'y']),
          'At least two points.',
        ),
      },
      ['clip_id', 'effect_id', 'channel', 'points'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.setEffectCurve(p, {
            timelineId: args.timeline_id,
            clipId: args.clip_id,
            effectId: args.effect_id,
            channel: args.channel,
            points: args.points,
          }),
        ),
      ),
  },
  {
    name: 'remove_effect',
    description:
      'Delete an effect from a clip’s stack permanently. To compare a look without losing its settings, use ' +
      'set_effect with enabled=false instead.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        clip_id: str('Clip holding the effect.'),
        effect_id: str('Effect to remove.'),
      },
      ['clip_id', 'effect_id'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.removeEffect(p, { timelineId: args.timeline_id, clipId: args.clip_id, effectId: args.effect_id }),
        ),
      ),
  },
  {
    name: 'reorder_effect',
    description:
      'Move an effect within a clip’s stack. Order matters: a blur before a grade looks different from a grade ' +
      'before a blur.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        clip_id: str('Clip holding the effect.'),
        effect_id: str('Effect to move.'),
        to_index: int('Zero-based destination position.'),
      },
      ['clip_id', 'effect_id', 'to_index'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.reorderEffect(p, {
            timelineId: args.timeline_id,
            clipId: args.clip_id,
            effectId: args.effect_id,
            toIndex: args.to_index,
          }),
        ),
      ),
  },
  {
    name: 'list_transitions',
    description:
      'The transition kinds add_transition accepts, with their display names. Fades are cheap; wipes and circles ' +
      'evaluate per pixel and render several times slower.',
    inputSchema: object({}),
    handler: () => ({
      transitions: TRANSITION_KINDS.map((kind) => ({ kind, name: TRANSITION_LABELS[kind] })),
    }),
  },
  {
    name: 'add_transition',
    description:
      'Place a transition between a clip and the one before it on the same track. The incoming clip is pulled back ' +
      'over its predecessor using its own head handle, so it needs at least that many frames trimmed off its start — ' +
      'the call is refused, not shortened, when it does not. Clip positions never move, so removing it is lossless.',
    inputSchema: object(
      {
        timeline_id: str('Defaults to the active timeline.'),
        clip_id: str('Incoming clip — the one the transition leads into.'),
        kind: { type: 'string', enum: TRANSITION_KINDS, description: 'Default dissolve.' },
        duration_frames: int('Overlap length. Defaults to one second.'),
      },
      ['clip_id'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.addTransition(p, {
            timelineId: args.timeline_id,
            clipId: args.clip_id,
            kind: args.kind,
            durationFrames: args.duration_frames,
          }),
        ),
      ),
  },
  {
    name: 'remove_transition',
    description: 'Remove the transition leading into a clip. Reports honestly when there is none.',
    inputSchema: object(
      { timeline_id: str('Defaults to the active timeline.'), clip_id: str('Clip to clear.') },
      ['clip_id'],
    ),
    handler: (args, ctx) =>
      receiptPayload(
        ctx.store.apply((p) =>
          ops.removeTransition(p, { timelineId: args.timeline_id, clipId: args.clip_id }),
        ),
      ),
  },
]

TOOLS.push(...EFFECT_TOOLS)
for (const tool of EFFECT_TOOLS) TOOLS_BY_NAME.set(tool.name, tool)

// --- Performance, preview and cache ---------------------------------------

const PERFORMANCE_FIELDS = {
  preview_height: { type: 'integer', enum: [...PREVIEW_HEIGHTS], description: 'Height the timeline preview is rendered at. Lower plays smoother on a weak machine; the export is always full size.' },
  parallel_jobs: { type: 'integer', minimum: 1, maximum: MAX_PARALLEL_JOBS, description: 'Preview slices and proxies encoded at the same time.' },
  low_priority: bool('Run preview and proxy encodes below normal priority so editing stays fluid.'),
  hardware_decode: bool('Decode sources on the GPU. Refused, with the reason, when no hardware decoder works on this machine.'),
  auto_preview: bool('Encode changed preview slices by themselves after a pause in editing, below normal priority. Off by default.'),
  cache_limit_gb: { type: 'number', minimum: 0.5, maximum: 500, description: 'Ceiling for regenerable cache data (preview slices, monitor frames). Proxies are never evicted automatically.' },
}

const SNAKE_TO_SETTING: Record<string, keyof PerformanceSettings> = {
  preview_height: 'previewHeight',
  parallel_jobs: 'parallelJobs',
  low_priority: 'lowPriority',
  hardware_decode: 'hardwareDecode',
  auto_preview: 'autoPreview',
  cache_limit_gb: 'cacheLimitGB',
}

function usagePayload(usage: Awaited<ReturnType<typeof media.usage>>): Record<string, unknown> {
  return {
    directory: usage.directory,
    total: formatBytes(usage.totalBytes),
    totalBytes: usage.totalBytes,
    categories: Object.fromEntries(
      Object.entries(usage.categories).map(([name, value]) => [
        name,
        { files: value.files, size: formatBytes(value.bytes), bytes: value.bytes },
      ]),
    ),
  }
}

async function performancePayload(ctx: ToolContext): Promise<Record<string, unknown>> {
  const encoder = await bestEncoder()
  return {
    settings: getPerformance(),
    machine: {
      logicalCores: cpus().length,
      recommendedParallelJobs: defaultParallelJobs(),
      encoder: { name: encoder.name, label: encoder.label, hardware: encoder.hardware },
      hardwareDecodeAvailable: await hardwareDecodeWorks(),
    },
    cache: usagePayload(await media.usage(ctx.store.project)),
  }
}

const PERFORMANCE_TOOLS: ToolDefinition[] = [
  {
    name: 'get_performance',
    description:
      'Read the performance settings (preview resolution, parallel encodes, priority, hardware decoding, idle ' +
      'preview, cache ceiling), what this machine offers (cores, the GPU encoder actually working, whether hardware ' +
      'decoding works) and how much disk the project cache uses. Call it before set_performance.',
    inputSchema: object({}),
    handler: (_args, ctx) => performancePayload(ctx),
  },
  {
    name: 'set_performance',
    description:
      'Change performance settings. These belong to the machine, not the project: they are not part of the edit ' +
      'and not undoable with undo. Every invalid value is named in one error. Changing preview_height makes the ' +
      'next preview render at the new size; the slices already cached for the old size stay usable if it is set back.',
    inputSchema: object(PERFORMANCE_FIELDS),
    handler: async (args, ctx) => {
      const update: Partial<PerformanceSettings> = {}
      for (const [key, value] of Object.entries(args)) {
        const setting = SNAKE_TO_SETTING[key]
        if (!setting) throw new OpError('invalid_argument', `unknown setting "${key}"`)
        ;(update as Record<string, unknown>)[setting] = value
      }
      if (Object.keys(update).length === 0) {
        throw new OpError('invalid_argument', `name at least one setting: ${Object.keys(SNAKE_TO_SETTING).join(', ')}`)
      }
      if (update.hardwareDecode && !(await hardwareDecodeWorks())) {
        throw new OpError(
          'refused',
          'no hardware decoder works on this machine: a test clip decoded with -hwaccel auto failed, so enabling ' +
            'it would only make renders fail',
        )
      }
      const settings = await setPerformance(update)
      media.editHappened()
      return { changed: true, summary: `Updated ${Object.keys(update).join(', ')}`, settings, ...(await performancePayload(ctx)) }
    },
  },
  {
    name: 'render_preview',
    description:
      'Build the playable timeline preview (the work zone if one is set), exactly like Ctrl+Shift+Enter in the ' +
      'editor: only the 4-second slices changed since the last preview are encoded, the rest come from the cache. ' +
      'Waits for it to finish and reports how many slices were encoded versus reused. The user can then play it.',
    inputSchema: object({ timeline_id: str('Defaults to the active timeline.') }),
    handler: async (args, ctx) => {
      const project = ctx.store.project
      const timeline = resolveTimeline(project, args.timeline_id)
      const started = Date.now()
      const state = await media.renderPreview(project, timeline)
      const seconds = (Date.now() - started) / 1000
      return {
        changed: false,
        summary:
          state.encoded === 0
            ? `Preview already up to date (${state.reused} slice(s) reused)`
            : `Preview built in ${seconds.toFixed(1)} s — ${state.encoded} slice(s) encoded, ${state.reused} reused`,
        encodedSlices: state.encoded,
        reusedSlices: state.reused,
        renderSeconds: Number(seconds.toFixed(2)),
        size: `${state.width}x${state.height}`,
        encoder: state.encoder,
        startFrame: state.startFrame,
        totalFrames: state.totalFrames,
        path: state.path,
      }
    },
  },
  {
    name: 'get_cache',
    description:
      'Disk used by the project cache, per kind: preview (timeline preview slices), frames (monitor stills), ' +
      'proxies, thumbnails.',
    inputSchema: object({}),
    handler: async (_args, ctx) => usagePayload(await media.usage(ctx.store.project)),
  },
  {
    name: 'clear_cache',
    description:
      'Delete cached data of the given kinds. Preview and frames regenerate on demand; clearing proxies also ' +
      'switches the clips back to their originals in one undoable step, since a clip pointing at a deleted proxy ' +
      'could not render.',
    inputSchema: object(
      {
        categories: arr(
          { type: 'string', enum: [...CACHE_CATEGORIES] },
          `Kinds to clear: ${CACHE_CATEGORIES.join(', ')}.`,
        ),
      },
      ['categories'],
    ),
    handler: async (args, ctx) => {
      const categories = (args.categories ?? []) as CacheCategory[]
      const unknown = categories.filter((c) => !CACHE_CATEGORIES.includes(c))
      if (categories.length === 0 || unknown.length > 0) {
        throw new OpError(
          'invalid_argument',
          `categories must name at least one of ${CACHE_CATEGORIES.join(', ')}` +
            (unknown.length > 0 ? ` (unknown: ${unknown.join(', ')})` : ''),
        )
      }
      const result = await media.clearCache(ctx.store, categories, (proxyArgs) => ctx.store.apply((p) => ops.setAssetProxies(p, proxyArgs)))
      return {
        changed: result.receipt?.changed ?? false,
        summary: `Freed ${formatBytes(result.bytes)} in ${result.files} file(s) from ${categories.join(', ')}` +
          (result.receipt ? ` — ${result.receipt.summary}` : ''),
        freedBytes: result.bytes,
        files: result.files,
        ...(result.receipt ? { affectedIds: result.receipt.affectedIds } : {}),
        cache: usagePayload(await media.usage(ctx.store.project)),
      }
    },
  },
]

TOOLS.push(...PERFORMANCE_TOOLS)
for (const tool of PERFORMANCE_TOOLS) TOOLS_BY_NAME.set(tool.name, tool)
