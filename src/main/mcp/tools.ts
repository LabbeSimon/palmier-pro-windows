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
      'Render the active timeline to an H.264 MP4 and wait for it to finish. Returns the output path, or a terminal ' +
      'error with the FFmpeg diagnostics — a failed export never reports success.',
    inputSchema: object({
      timeline_id: str('Defaults to the active timeline.'),
      output_path: str('Destination .mp4. Defaults to the project folder.'),
      quality: { type: 'string', enum: ['draft', 'balanced', 'high'], description: 'Encoder preset. Default balanced.' },
    }),
    handler: async (args, ctx) => {
      const project = ctx.store.project
      const timeline = resolveTimeline(project, args.timeline_id)
      if (timelineTotalFrames(timeline) === 0) {
        throw new OpError('refused', `timeline "${timeline.name}" is empty; there is nothing to export`)
      }
      const quality = (args.quality ?? 'balanced') as 'draft' | 'balanced' | 'high'
      const encoder = {
        draft: { crf: 28, preset: 'veryfast' as const },
        balanced: { crf: 20, preset: 'medium' as const },
        high: { crf: 16, preset: 'slow' as const },
      }[quality]

      const output =
        args.output_path ?? join(project.path ?? ctx.defaultExportDir, `${timeline.name.replace(/[\\/:*?"<>|]/g, '_')}.mp4`)
      const handle = renderTimeline(project, timeline, { outputPath: output, ...encoder })
      await handle.promise
      return {
        changed: false,
        summary: `Exported "${timeline.name}" (${framesToTimecode(timelineTotalFrames(timeline), timeline.fps)}) at ${quality} quality`,
        outputPath: output,
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
