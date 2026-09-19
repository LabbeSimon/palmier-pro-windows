import { useCallback, useMemo, useRef, useState } from 'react'

import {
  clipEndFrame,
  timelineDisplayFrames,
  type MediaAsset,
  type Timeline,
} from '../../core/model.js'
import { framesToTimecode } from '../../core/timecode.js'

interface Props {
  timeline: Timeline
  assets: MediaAsset[]
  playhead: number
  selectedClipIds: string[]
  pixelsPerFrame: number
  onScrub: (frame: number) => void
  onSelect: (clipIds: string[]) => void
  onMoveClip: (clipId: string, startFrame: number, trackId: string) => void
  onDropAsset: (assetId: string, trackId: string, startFrame: number) => void
  onToggleTrack: (trackId: string, field: 'muted' | 'hidden') => void
  onAddTrack: (type: 'video' | 'audio') => void
  onZoom: (pixelsPerFrame: number) => void
}

const LANE_HEIGHT = 56
const MIN_PPF = 0.05
const MAX_PPF = 40

/** Ruler tick spacing that keeps labels roughly 90px apart at any zoom. */
function tickStepFrames(fps: number, pixelsPerFrame: number): number {
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].map((s) => s * fps)
  return candidates.find((step) => step * pixelsPerFrame >= 90) ?? candidates[candidates.length - 1]!
}

export function TimelineView(props: Props) {
  const { timeline, playhead, pixelsPerFrame } = props
  const lanesRef = useRef<HTMLDivElement>(null)
  const [dragClipId, setDragClipId] = useState<string | null>(null)
  const [dropTrackId, setDropTrackId] = useState<string | null>(null)

  // Always leave a screen of runway past the last clip so there is room to drop.
  const contentFrames = Math.max(timelineDisplayFrames(timeline) + Math.round(600 / pixelsPerFrame), timeline.fps * 10)
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

  const scrubTo = useCallback(
    (clientX: number) => props.onScrub(Math.min(frameAt(clientX), Math.max(0, contentFrames - 1))),
    [frameAt, contentFrames, props],
  )

  const onRulerPointerDown = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    scrubTo(event.clientX)
  }
  const onRulerPointerMove = (event: React.PointerEvent) => {
    if (event.buttons === 1) scrubTo(event.clientX)
  }

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

  return (
    <div className="timeline">
      <div className="track-headers">
        <div className="ruler-spacer">
          <button
            className="toggle"
            title="Zoom out"
            onClick={() => props.onZoom(Math.max(MIN_PPF, pixelsPerFrame / 1.5))}
          >
            −
          </button>
          <button
            className="toggle"
            title="Zoom in"
            onClick={() => props.onZoom(Math.min(MAX_PPF, pixelsPerFrame * 1.5))}
          >
            +
          </button>
          <span style={{ marginLeft: 'auto' }}>{timeline.tracks.length} tr.</span>
        </div>

        {[...timeline.tracks].reverse().map((track) => (
          <div className="track-header" key={track.id}>
            <div className="row">
              <span className="label" title={track.name ?? track.type}>
                {track.name ?? track.type}
              </span>
            </div>
            <div className="row">
              <button
                className={`toggle${track.hidden ? ' on' : ''}`}
                title={track.hidden ? 'Show track' : 'Hide track'}
                onClick={() => props.onToggleTrack(track.id, 'hidden')}
              >
                {track.hidden ? 'H' : '👁'}
              </button>
              <button
                className={`toggle${track.muted ? ' on' : ''}`}
                title={track.muted ? 'Unmute track' : 'Mute track'}
                onClick={() => props.onToggleTrack(track.id, 'muted')}
              >
                M
              </button>
              <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)', color: 'var(--text-faint)' }}>
                {track.clips.length}
              </span>
            </div>
          </div>
        ))}

        <div className="track-header" style={{ justifyContent: 'center' }}>
          <div className="row">
            <button onClick={() => props.onAddTrack('video')}>+ Video</button>
            <button onClick={() => props.onAddTrack('audio')}>+ Audio</button>
          </div>
        </div>
      </div>

      <div className="track-lanes" ref={lanesRef}>
        <div className="lanes-inner" style={{ width: contentWidth }}>
          <div
            className="ruler"
            style={{ width: contentWidth }}
            onPointerDown={onRulerPointerDown}
            onPointerMove={onRulerPointerMove}
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

          {[...timeline.tracks].reverse().map((track) => (
            <div
              className={`lane${dropTrackId === track.id ? ' drop' : ''}`}
              key={track.id}
              onDragOver={(event) => {
                const types = event.dataTransfer.types
                const asset = types.includes('application/x-palmier-asset')
                const clip = types.includes('application/x-palmier-clip')
                if (!asset && !clip) return
                event.preventDefault()
                event.dataTransfer.dropEffect = asset ? 'copy' : 'move'
                setDropTrackId(track.id)
              }}
              onDragLeave={() => setDropTrackId((current) => (current === track.id ? null : current))}
              onDrop={(event) => {
                event.preventDefault()
                setDropTrackId(null)
                const assetId = event.dataTransfer.getData('application/x-palmier-asset')
                if (assetId) {
                  props.onDropAsset(assetId, track.id, frameAt(event.clientX))
                  return
                }
                const payload = event.dataTransfer.getData('application/x-palmier-clip')
                if (!payload) return
                const [clipId, grab] = payload.split(':')
                props.onMoveClip(clipId!, Math.max(0, frameAt(event.clientX) - Number(grab ?? 0)), track.id)
                setDragClipId(null)
              }}
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) props.onSelect([])
              }}
            >
              {track.clips.map((clip) => {
                const left = Math.round(clip.startFrame * pixelsPerFrame)
                const width = Math.max(2, Math.round(clip.durationFrames * pixelsPerFrame))
                const selected = props.selectedClipIds.includes(clip.id)
                const name = clip.textContent ?? assetName(clip.mediaRef) ?? clip.mediaType
                return (
                  <div
                    key={clip.id}
                    className={`clip ${clip.mediaType}${selected ? ' selected' : ''}${dragClipId === clip.id ? ' dragging' : ''}`}
                    style={{ left, width }}
                    title={`${name}\n${framesToTimecode(clip.startFrame, timeline.fps)} → ${framesToTimecode(clipEndFrame(clip), timeline.fps)}`}
                    draggable
                    onPointerDown={(event) => {
                      event.stopPropagation()
                      props.onSelect(
                        event.shiftKey && !selected
                          ? [...props.selectedClipIds, clip.id]
                          : selected && event.shiftKey
                            ? props.selectedClipIds.filter((id) => id !== clip.id)
                            : [clip.id],
                      )
                    }}
                    onDragStart={(event) => {
                      setDragClipId(clip.id)
                      // Grab offset keeps the clip under the cursor instead of snapping its head there.
                      const grabFrame = frameAt(event.clientX) - clip.startFrame
                      event.dataTransfer.setData('application/x-palmier-clip', `${clip.id}:${grabFrame}`)
                      event.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => setDragClipId(null)}
                  >
                    <span className="clip-name">{name}</span>
                    <span className="clip-meta">
                      {clip.durationFrames}f{clip.speed !== 1 ? ` · ${clip.speed}×` : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          ))}

          <div className="playhead" style={{ left: Math.round(playhead * pixelsPerFrame) }} />
        </div>
      </div>
    </div>
  )
}

export { LANE_HEIGHT }
