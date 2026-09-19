import { useCallback, useMemo, useRef, useState } from 'react'

import {
  clipEndFrame,
  timelineDisplayFrames,
  type MediaAsset,
  type Timeline,
} from '../../core/model.js'
import { framesToTimecode } from '../../core/timecode.js'
import {
  IconEye,
  IconEyeOff,
  IconLock,
  IconMute,
  IconRazor,
  IconSelect,
  IconSpacer,
  IconUnlock,
  IconVolume,
  IconZoomIn,
  IconZoomOut,
} from './Icons.js'

export type TimelineTool = 'select' | 'razor' | 'spacer'

interface Props {
  timeline: Timeline
  assets: MediaAsset[]
  thumbnails: Record<string, string>
  playhead: number
  selectedClipIds: string[]
  pixelsPerFrame: number
  tool: TimelineTool
  snapEnabled: boolean
  onScrub: (frame: number) => void
  onSelect: (clipIds: string[]) => void
  onMoveClip: (clipId: string, startFrame: number, trackId: string) => void
  onDropAsset: (assetId: string, trackId: string, startFrame: number) => void
  onDropEffect: (definitionId: string, clipId: string) => void
  onRazor: (trackId: string, frame: number) => void
  onSpacer: (trackId: string, fromFrame: number, deltaFrames: number) => void
  onToggleTrack: (trackId: string, field: 'muted' | 'hidden' | 'locked') => void
  onAddTrack: (type: 'video' | 'audio') => void
  onZoom: (pixelsPerFrame: number) => void
  onSetTool: (tool: TimelineTool) => void
  onToggleSnap: () => void
}

const MIN_PPF = 0.02
const MAX_PPF = 40
/** Snap distance in screen pixels, converted to frames at the current zoom. */
const SNAP_PIXELS = 8

/** Ruler tick spacing that keeps labels roughly 90px apart at any zoom. */
function tickStepFrames(fps: number, pixelsPerFrame: number): number {
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].map((s) => s * fps)
  return candidates.find((step) => step * pixelsPerFrame >= 90) ?? candidates[candidates.length - 1]!
}

export function TimelineView(props: Props) {
  const { timeline, playhead, pixelsPerFrame, tool, snapEnabled } = props

  /**
   * Display order: video tracks top-down (highest layer first), then audio
   * beneath. The model's array order stays the compositing order; only the
   * presentation groups them, the way every NLE does.
   */
  const displayTracks = useMemo(() => {
    const indexed = timeline.tracks.map((track, layer) => ({ track, layer }))
    const video = indexed.filter((t) => t.track.type !== 'audio').sort((a, b) => b.layer - a.layer)
    const audio = indexed.filter((t) => t.track.type === 'audio').sort((a, b) => a.layer - b.layer)
    return [...video, ...audio].map((t) => t.track)
  }, [timeline.tracks])
  const lanesRef = useRef<HTMLDivElement>(null)
  const [dragClipId, setDragClipId] = useState<string | null>(null)
  const [dropTrackId, setDropTrackId] = useState<string | null>(null)
  const [spacerFrom, setSpacerFrom] = useState<{ trackId: string; frame: number } | null>(null)
  const [snapLine, setSnapLine] = useState<number | null>(null)

  const contentFrames = Math.max(
    timelineDisplayFrames(timeline) + Math.round(600 / pixelsPerFrame),
    timeline.fps * 10,
  )
  const contentWidth = Math.round(contentFrames * pixelsPerFrame)

  const frameAt = useCallback(
    (clientX: number): number => {
      const lanes = lanesRef.current
      if (!lanes) return 0
      const rect = lanes.getBoundingClientRect()
      const x = clientX - rect.left + lanes.scrollLeft
      return Math.max(0, Math.round(x / pixelsPerFrame))
    },
    [pixelsPerFrame],
  )

  /**
   * Every edge worth landing on: clip boundaries, markers, the playhead, zero.
   * Computed per gesture rather than per pointer move.
   */
  const snapTargets = useMemo(() => {
    const targets = new Set<number>([0, playhead])
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        targets.add(clip.startFrame)
        targets.add(clipEndFrame(clip))
      }
    }
    for (const marker of timeline.markers) targets.add(marker.startFrame)
    return [...targets].sort((a, b) => a - b)
  }, [timeline, playhead])

  const snap = useCallback(
    (frame: number, ignoreIds: Set<string> = new Set()): number => {
      if (!snapEnabled) return frame
      const tolerance = Math.max(1, Math.round(SNAP_PIXELS / pixelsPerFrame))
      let best: number | null = null
      let bestDistance = tolerance + 1
      for (const target of snapTargets) {
        const distance = Math.abs(target - frame)
        if (distance <= tolerance && distance < bestDistance) {
          best = target
          bestDistance = distance
        }
      }
      // Ignored ids matter for the dragged clip's own edges, which must not
      // snap to themselves; recomputing the set is cheaper than tracking it.
      void ignoreIds
      setSnapLine(best)
      return best ?? frame
    },
    [snapEnabled, pixelsPerFrame, snapTargets],
  )

  const scrubTo = useCallback(
    (clientX: number) => props.onScrub(Math.min(frameAt(clientX), Math.max(0, contentFrames - 1))),
    [frameAt, contentFrames, props],
  )

  const ticks = useMemo(() => {
    const step = tickStepFrames(timeline.fps, pixelsPerFrame)
    const out: { frame: number; label: string }[] = []
    for (let frame = 0; frame <= contentFrames; frame += step) {
      out.push({ frame, label: framesToTimecode(frame, timeline.fps) })
    }
    return out
  }, [timeline.fps, pixelsPerFrame, contentFrames])

  const assetName = useCallback(
    (mediaRef: string) => props.assets.find((a) => a.id === mediaRef)?.name ?? null,
    [props.assets],
  )

  /**
   * Only picture clips get the filmstrip. A linked audio clip references the
   * same asset, so keying on the asset alone would paint video frames onto a
   * sound clip and hide that it is audio at all.
   */
  const posterStyle = useCallback(
    (clip: { mediaRef: string; mediaType: string }): React.CSSProperties | undefined => {
      if (clip.mediaType === 'audio' || clip.mediaType === 'subtitle') return undefined
      const poster = props.thumbnails[clip.mediaRef]
      return poster ? { backgroundImage: `url(${poster})` } : undefined
    },
    [props.thumbnails],
  )

  const fitZoom = () => {
    const lanes = lanesRef.current
    const total = timelineDisplayFrames(timeline)
    if (!lanes || total === 0) return
    props.onZoom(Math.max(MIN_PPF, Math.min(MAX_PPF, (lanes.clientWidth - 24) / total)))
  }

  return (
    <div className="timeline-shell">
      <div className="timeline-tools">
        <div className="tool-group" role="group" aria-label="Timeline tool">
          <button
            className={`icon-btn${tool === 'select' ? ' on' : ''}`}
            title="Selection tool (V)"
            onClick={() => props.onSetTool('select')}
          >
            <IconSelect />
          </button>
          <button
            className={`icon-btn${tool === 'razor' ? ' on' : ''}`}
            title="Razor — click a clip to cut it (X)"
            onClick={() => props.onSetTool('razor')}
          >
            <IconRazor />
          </button>
          <button
            className={`icon-btn${tool === 'spacer' ? ' on' : ''}`}
            title="Spacer — drag to open or close a gap (B)"
            onClick={() => props.onSetTool('spacer')}
          >
            <IconSpacer />
          </button>
        </div>

        <span className="divider" />

        <button
          className={`icon-btn wide${snapEnabled ? ' on' : ''}`}
          title="Snap to clip edges, markers and the playhead (N)"
          onClick={props.onToggleSnap}
        >
          Snap
        </button>

        <span className="spacer" />

        <span className="tool-hint">
          {tool === 'razor'
            ? 'Click a clip to cut it at that point'
            : tool === 'spacer'
              ? 'Drag on a track to shift everything after it'
              : `${props.selectedClipIds.length} selected`}
        </span>

        <span className="divider" />

        <button className="icon-btn" title="Zoom out (Ctrl+−)" onClick={() => props.onZoom(Math.max(MIN_PPF, pixelsPerFrame / 1.5))}>
          <IconZoomOut />
        </button>
        <button className="icon-btn" title="Zoom in (Ctrl++)" onClick={() => props.onZoom(Math.min(MAX_PPF, pixelsPerFrame * 1.5))}>
          <IconZoomIn />
        </button>
        <button className="icon-btn wide" title="Fit the whole timeline (Ctrl+0)" onClick={fitZoom}>
          Fit
        </button>
      </div>

      <div className={`timeline tool-${tool}`}>
        <div className="track-headers">
          <div className="ruler-spacer">
            <span>{timeline.tracks.length} tracks</span>
          </div>

          {displayTracks.map((track) => (
            <div className={`track-header${track.locked ? ' locked' : ''}`} key={track.id}>
              <div className="row">
                <span className="label" title={track.name ?? track.type}>
                  {track.name ?? track.type}
                </span>
                <span className="count">{track.clips.length}</span>
              </div>
              <div className="row">
                <button
                  className={`icon-btn${track.hidden ? ' off' : ''}`}
                  title={track.hidden ? 'Show track' : 'Hide track'}
                  onClick={() => props.onToggleTrack(track.id, 'hidden')}
                >
                  {track.hidden ? <IconEyeOff /> : <IconEye />}
                </button>
                <button
                  className={`icon-btn${track.muted ? ' off' : ''}`}
                  title={track.muted ? 'Unmute track' : 'Mute track'}
                  onClick={() => props.onToggleTrack(track.id, 'muted')}
                >
                  {track.muted ? <IconMute /> : <IconVolume />}
                </button>
                <button
                  className={`icon-btn${track.locked ? ' on' : ''}`}
                  title={track.locked ? 'Unlock track' : 'Lock track — refuses every edit'}
                  onClick={() => props.onToggleTrack(track.id, 'locked')}
                >
                  {track.locked ? <IconLock /> : <IconUnlock />}
                </button>
              </div>
            </div>
          ))}

          <div className="track-header add-row">
            <div className="row">
              <button className="add" onClick={() => props.onAddTrack('video')}>
                + Video
              </button>
              <button className="add" onClick={() => props.onAddTrack('audio')}>
                + Audio
              </button>
            </div>
          </div>
        </div>

        <div className="track-lanes" ref={lanesRef}>
          <div className="lanes-inner" style={{ width: contentWidth }}>
            <div
              className="ruler"
              style={{ width: contentWidth }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId)
                scrubTo(event.clientX)
              }}
              onPointerMove={(event) => {
                if (event.buttons === 1) scrubTo(event.clientX)
              }}
            >
              {ticks.map((tick) => (
                <div className="tick" key={tick.frame} style={{ left: Math.round(tick.frame * pixelsPerFrame) }}>
                  {tick.label}
                </div>
              ))}
              {timeline.markers.map((marker) => (
                <div
                  className="marker"
                  key={marker.id}
                  title={marker.name}
                  style={{ left: Math.round(marker.startFrame * pixelsPerFrame), background: marker.color }}
                />
              ))}
            </div>

            {displayTracks.map((track) => (
              <div
                className={`lane${dropTrackId === track.id ? ' drop' : ''}${track.locked ? ' locked' : ''}`}
                key={track.id}
                onDragOver={(event) => {
                  const types = event.dataTransfer.types
                  if (!types.includes('application/x-palmier-asset') && !types.includes('application/x-palmier-clip')) {
                    return
                  }
                  if (track.locked) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = types.includes('application/x-palmier-asset') ? 'copy' : 'move'
                  setDropTrackId(track.id)
                }}
                onDragLeave={() => setDropTrackId((current) => (current === track.id ? null : current))}
                onDrop={(event) => {
                  event.preventDefault()
                  setDropTrackId(null)
                  setSnapLine(null)
                  const assetId = event.dataTransfer.getData('application/x-palmier-asset')
                  if (assetId) {
                    props.onDropAsset(assetId, track.id, snap(frameAt(event.clientX)))
                    return
                  }
                  const payload = event.dataTransfer.getData('application/x-palmier-clip')
                  if (!payload) return
                  const [clipId, grab] = payload.split(':')
                  const raw = Math.max(0, frameAt(event.clientX) - Number(grab ?? 0))
                  props.onMoveClip(clipId!, snap(raw, new Set([clipId!])), track.id)
                  setDragClipId(null)
                }}
                onPointerDown={(event) => {
                  if (event.target !== event.currentTarget) return
                  if (tool === 'spacer') {
                    setSpacerFrom({ trackId: track.id, frame: frameAt(event.clientX) })
                    event.currentTarget.setPointerCapture(event.pointerId)
                    return
                  }
                  props.onSelect([])
                }}
                onPointerUp={(event) => {
                  if (tool !== 'spacer' || !spacerFrom || spacerFrom.trackId !== track.id) return
                  const delta = frameAt(event.clientX) - spacerFrom.frame
                  if (delta !== 0) props.onSpacer(track.id, spacerFrom.frame, delta)
                  setSpacerFrom(null)
                }}
              >
                {track.clips.map((clip) => {
                  const overlap = clip.transitionIn?.durationFrames ?? 0
                  const left = Math.round(clip.startFrame * pixelsPerFrame)
                  const width = Math.max(2, Math.round(clip.durationFrames * pixelsPerFrame))
                  const selected = props.selectedClipIds.includes(clip.id)
                  const name = clip.textContent ?? assetName(clip.mediaRef) ?? clip.mediaType
                  const poster = posterStyle(clip)
                  const effectCount = clip.effects?.length ?? 0

                  return (
                    <div
                      key={clip.id}
                      className={`clip ${clip.mediaType}${selected ? ' selected' : ''}${dragClipId === clip.id ? ' dragging' : ''}${poster ? ' has-poster' : ''}`}
                      style={{ left, width, ...poster }}
                      title={`${name}\n${framesToTimecode(clip.startFrame, timeline.fps)} → ${framesToTimecode(clipEndFrame(clip), timeline.fps)}${effectCount ? `\n${effectCount} effect(s)` : ''}`}
                      draggable={tool === 'select' && !track.locked}
                      onPointerDown={(event) => {
                        event.stopPropagation()
                        if (tool === 'razor') {
                          if (!track.locked) props.onRazor(track.id, frameAt(event.clientX))
                          return
                        }
                        props.onSelect(
                          event.shiftKey
                            ? selected
                              ? props.selectedClipIds.filter((id) => id !== clip.id)
                              : [...props.selectedClipIds, clip.id]
                            : [clip.id],
                        )
                      }}
                      onDragStart={(event) => {
                        setDragClipId(clip.id)
                        const grabFrame = frameAt(event.clientX) - clip.startFrame
                        event.dataTransfer.setData('application/x-palmier-clip', `${clip.id}:${grabFrame}`)
                        event.dataTransfer.effectAllowed = 'move'
                      }}
                      onDragEnd={() => {
                        setDragClipId(null)
                        setSnapLine(null)
                      }}
                      onDragOver={(event) => {
                        if (!event.dataTransfer.types.includes('application/x-palmier-effect')) return
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'copy'
                      }}
                      onDrop={(event) => {
                        const definitionId = event.dataTransfer.getData('application/x-palmier-effect')
                        if (!definitionId) return
                        event.preventDefault()
                        event.stopPropagation()
                        props.onDropEffect(definitionId, clip.id)
                      }}
                    >
                      {overlap > 0 ? (
                        <span
                          className="clip-transition"
                          style={{ width: Math.max(3, Math.round(overlap * pixelsPerFrame)) }}
                          title={`${clip.transitionIn!.kind}, ${overlap} frames`}
                        />
                      ) : null}
                      <span className="clip-name">{name}</span>
                      <span className="clip-meta">
                        {framesToTimecode(clip.durationFrames, timeline.fps).slice(3)}
                        {clip.speed !== 1 ? ` · ${clip.speed}×` : ''}
                        {effectCount ? ` · ${effectCount}fx` : ''}
                      </span>
                    </div>
                  )
                })}
              </div>
            ))}

            {snapLine !== null && dragClipId ? (
              <div className="snap-line" style={{ left: Math.round(snapLine * pixelsPerFrame) }} />
            ) : null}
            <div className="playhead" style={{ left: Math.round(playhead * pixelsPerFrame) }} />
          </div>
        </div>
      </div>
    </div>
  )
}
