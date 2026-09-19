import { useEffect, useState } from 'react'

import { clipEndFrame, type Clip, type MediaAsset, type Timeline } from '../../core/model.js'
import type { ClipProperties } from '../../core/ops.js'
import { framesToTimecode } from '../../core/timecode.js'

interface Props {
  timeline: Timeline
  clips: Clip[]
  assets: MediaAsset[]
  onApply: (properties: ClipProperties) => void
  onUpdateText: (clipId: string, content: string) => void
  onSetTimelineSettings: (settings: { fps?: number; width?: number; height?: number; name?: string }) => void
}

/** Commits on blur or Enter so a half-typed value never reaches the domain layer. */
function NumberField(props: {
  label: string
  value: number
  step?: number
  min?: number
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(props.value))
  useEffect(() => setDraft(String(props.value)), [props.value])

  const commit = () => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed) || parsed === props.value) {
      setDraft(String(props.value))
      return
    }
    props.onCommit(parsed)
  }

  return (
    <div className="field">
      <label>{props.label}</label>
      <input
        type="number"
        step={props.step ?? 1}
        min={props.min}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') setDraft(String(props.value))
        }}
      />
    </div>
  )
}

export function Inspector(props: Props) {
  const { timeline, clips } = props
  const clip = clips.length === 1 ? clips[0]! : null

  return (
    <div className="panel">
      <div className="panel-title">
        <span>Inspector</span>
        <span>{clips.length > 1 ? `${clips.length} clips` : clip ? clip.mediaType : 'timeline'}</span>
      </div>
      <div className="panel-body">
        {clips.length === 0 ? (
          <>
            <div className="field">
              <label>Name</label>
              <input
                defaultValue={timeline.name}
                onBlur={(event) => {
                  if (event.target.value.trim() && event.target.value !== timeline.name) {
                    props.onSetTimelineSettings({ name: event.target.value.trim() })
                  }
                }}
              />
            </div>
            <NumberField
              label="Frame rate"
              value={timeline.fps}
              min={1}
              onCommit={(fps) => props.onSetTimelineSettings({ fps: Math.round(fps) })}
            />
            <NumberField
              label="Width"
              value={timeline.width}
              min={2}
              onCommit={(width) => props.onSetTimelineSettings({ width: Math.round(width) })}
            />
            <NumberField
              label="Height"
              value={timeline.height}
              min={2}
              onCommit={(height) => props.onSetTimelineSettings({ height: Math.round(height) })}
            />
            <p className="empty">Select a clip to edit it.</p>
          </>
        ) : (
          <>
            {clip ? (
              <>
                <div className="field">
                  <label>Source</label>
                  <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {clip.textContent ?? props.assets.find((a) => a.id === clip.mediaRef)?.name ?? '—'}
                  </span>
                </div>
                <div className="field">
                  <label>Range</label>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                    {framesToTimecode(clip.startFrame, timeline.fps)} → {framesToTimecode(clipEndFrame(clip), timeline.fps)}
                  </span>
                </div>

                {clip.mediaType === 'text' ? (
                  <div className="field-group">
                    <h4>Text</h4>
                    <input
                      defaultValue={clip.textContent ?? ''}
                      key={clip.id}
                      onBlur={(event) => {
                        if (event.target.value.trim() && event.target.value !== clip.textContent) {
                          props.onUpdateText(clip.id, event.target.value)
                        }
                      }}
                    />
                  </div>
                ) : null}
              </>
            ) : null}

            <div className="field-group">
              <h4>Timing</h4>
              {clip ? (
                <>
                  <NumberField
                    label="Start frame"
                    value={clip.startFrame}
                    min={0}
                    onCommit={(startFrame) => props.onApply({ startFrame: Math.round(startFrame) })}
                  />
                  <NumberField
                    label="Duration"
                    value={clip.durationFrames}
                    min={1}
                    onCommit={(durationFrames) => props.onApply({ durationFrames: Math.round(durationFrames) })}
                  />
                  <NumberField
                    label="Trim head"
                    value={clip.trimStartFrame}
                    min={0}
                    onCommit={(trimStartFrame) => props.onApply({ trimStartFrame: Math.round(trimStartFrame) })}
                  />
                </>
              ) : null}
              <NumberField
                label="Speed"
                value={clip?.speed ?? 1}
                step={0.1}
                min={0.05}
                onCommit={(speed) => props.onApply({ speed })}
              />
            </div>

            <div className="field-group">
              <h4>Levels</h4>
              <NumberField
                label="Opacity"
                value={clip?.opacity ?? 1}
                step={0.05}
                min={0}
                onCommit={(opacity) => props.onApply({ opacity })}
              />
              <NumberField
                label="Volume"
                value={clip?.volume ?? 1}
                step={0.1}
                min={0}
                onCommit={(volume) => props.onApply({ volume })}
              />
              <NumberField
                label="Fade in"
                value={clip?.fadeInFrames ?? 0}
                min={0}
                onCommit={(fadeInFrames) => props.onApply({ fadeInFrames: Math.round(fadeInFrames) })}
              />
              <NumberField
                label="Fade out"
                value={clip?.fadeOutFrames ?? 0}
                min={0}
                onCommit={(fadeOutFrames) => props.onApply({ fadeOutFrames: Math.round(fadeOutFrames) })}
              />
            </div>

            <div className="field-group">
              <h4>Transform</h4>
              <NumberField
                label="Centre X"
                value={clip?.transform.centerX ?? 0.5}
                step={0.01}
                onCommit={(centerX) => props.onApply({ transform: { centerX } })}
              />
              <NumberField
                label="Centre Y"
                value={clip?.transform.centerY ?? 0.5}
                step={0.01}
                onCommit={(centerY) => props.onApply({ transform: { centerY } })}
              />
              <NumberField
                label="Scale X"
                value={clip?.transform.scaleX ?? 1}
                step={0.05}
                onCommit={(scaleX) => props.onApply({ transform: { scaleX } })}
              />
              <NumberField
                label="Scale Y"
                value={clip?.transform.scaleY ?? 1}
                step={0.05}
                onCommit={(scaleY) => props.onApply({ transform: { scaleY } })}
              />
              <NumberField
                label="Rotation"
                value={clip?.transform.rotation ?? 0}
                step={1}
                onCommit={(rotation) => props.onApply({ transform: { rotation } })}
              />
            </div>

            <div className="field-group">
              <h4>Crop</h4>
              <NumberField
                label="Top"
                value={clip?.crop.top ?? 0}
                step={0.01}
                min={0}
                onCommit={(top) => props.onApply({ crop: { top } })}
              />
              <NumberField
                label="Bottom"
                value={clip?.crop.bottom ?? 0}
                step={0.01}
                min={0}
                onCommit={(bottom) => props.onApply({ crop: { bottom } })}
              />
              <NumberField
                label="Left"
                value={clip?.crop.left ?? 0}
                step={0.01}
                min={0}
                onCommit={(left) => props.onApply({ crop: { left } })}
              />
              <NumberField
                label="Right"
                value={clip?.crop.right ?? 0}
                step={0.01}
                min={0}
                onCommit={(right) => props.onApply({ crop: { right } })}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
