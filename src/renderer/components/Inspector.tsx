import { useEffect, useState } from 'react'

import { clipEndFrame, type Clip, type MediaAsset, type Timeline } from '../../core/model.js'
import type { ClipProperties } from '../../core/ops.js'
import { framesToTimecode } from '../../core/timecode.js'
import { EffectStack } from './EffectStack.js'
import { MulticamPanel } from './MulticamPanel.js'
import { isAnimated } from '../../core/keyframes.js'
import type { CurvePoint } from '../../core/effects.js'

interface Props {
  timeline: Timeline
  clips: Clip[]
  assets: MediaAsset[]
  onApply: (properties: ClipProperties) => void
  onUpdateText: (clipId: string, content: string) => void
  onSetTimelineSettings: (settings: { fps?: number; width?: number; height?: number; name?: string }) => void
  onSetEffectParams: (clipId: string, effectId: string, params: Record<string, number>) => void
  onSetEffectCurve: (clipId: string, effectId: string, channel: string, points: CurvePoint[]) => void
  /** Timeline playhead, so the angle grid can show each camera at this moment. */
  playhead: number
  onSwitchAngle: (clipId: string, angleIndex: number, frame: number) => void
  onToggleEffect: (clipId: string, effectId: string, enabled: boolean) => void
  onRemoveEffect: (clipId: string, effectId: string) => void
  onReorderEffect: (clipId: string, effectId: string, toIndex: number) => void
  onSetTransition: (clipId: string, kind: string, durationFrames: number) => void
  onRemoveTransition: (clipId: string) => void
  onTrim: (clipId: string, kind: string, deltaFrames: number, edge?: 'start' | 'end') => void
}

/** Commits on blur or Enter so a half-typed value never reaches the domain layer. */
function NumberField(props: {
  label: string
  value: number
  step?: number
  min?: number
  /** Shown after the field — f, s, ×, °, dB. Keeps the number unambiguous. */
  unit?: string
  /** A keyframe curve is driving this value, so the field is a readout. */
  keyed?: boolean
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
    <div className={`field${props.keyed ? ' animated' : ''}`}>
      <label title={props.label}>{props.label}</label>
      <span className="value-cell">
        {props.keyed ? (
          <span className="kf-badge" title="Driven by keyframes — edit it in the keyframe bar">
            keyed
          </span>
        ) : null}
        <input
          type="number"
          step={props.step ?? 1}
          min={props.min}
          disabled={props.keyed}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') setDraft(String(props.value))
          }}
        />
        {props.unit ? <span className="unit">{props.unit}</span> : null}
      </span>
    </div>
  )
}

/** A fact, not a control — same column, no input affordance. */
function Readout(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="field">
      <label>{props.label}</label>
      <span className={`readout${props.mono ? ' mono' : ''}`} title={props.value}>
        {props.value}
      </span>
    </div>
  )
}

export function Inspector(props: Props) {
  const { timeline, clips } = props
  const clip = clips.length === 1 ? clips[0]! : null
  /** True when a curve drives this parameter, making its field a readout. */
  const keyed = (target: string) => isAnimated(clip?.keyframes?.[target])

  return (
    <div className="panel">
      <div className="panel-title">
        <span>{clips.length > 1 ? `${clips.length} clips selected` : clip ? clip.mediaType : 'timeline'}</span>
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
              unit="fps"
              value={timeline.fps}
              min={1}
              onCommit={(fps) => props.onSetTimelineSettings({ fps: Math.round(fps) })}
            />
            <NumberField
              label="Width"
              unit="px"
              value={timeline.width}
              min={2}
              onCommit={(width) => props.onSetTimelineSettings({ width: Math.round(width) })}
            />
            <NumberField
              label="Height"
              unit="px"
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
                <Readout
                  label="Source"
                  value={clip.textContent ?? props.assets.find((a) => a.id === clip.mediaRef)?.name ?? '—'}
                />
                <Readout label="In" value={framesToTimecode(clip.startFrame, timeline.fps)} mono />
                <Readout label="Out" value={framesToTimecode(clipEndFrame(clip), timeline.fps)} mono />

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
                    unit="f"
                    value={clip.startFrame}
                    min={0}
                    onCommit={(startFrame) => props.onApply({ startFrame: Math.round(startFrame) })}
                  />
                  <NumberField
                    label="Duration"
                    unit="f"
                    value={clip.durationFrames}
                    min={1}
                    onCommit={(durationFrames) => props.onApply({ durationFrames: Math.round(durationFrames) })}
                  />
                  <NumberField
                    label="Trim head"
                    unit="f"
                    value={clip.trimStartFrame}
                    min={0}
                    onCommit={(trimStartFrame) => props.onApply({ trimStartFrame: Math.round(trimStartFrame) })}
                  />
                </>
              ) : null}
              <NumberField
                label="Speed"
                unit="×"
                value={clip?.speed ?? 1}
                step={0.1}
                min={0.05}
                onCommit={(speed) => props.onApply({ speed })}
              />
            </div>

            {clip ? (
              <div className="field-group">
                <h4>Trim</h4>
                <p className="hint">
                  Ripple slides what follows · Roll moves the cut · Slip changes the shown part · Slide moves
                  the clip between its neighbours.
                </p>
                {([
                  ['ripple', 'end'],
                  ['roll', 'end'],
                  ['slip', undefined],
                  ['slide', undefined],
                ] as const).map(([kind, edge]) => (
                  <div className="field trim-row" key={kind}>
                    <label>{kind[0]!.toUpperCase() + kind.slice(1)}</label>
                    <span className="trim-buttons">
                      <button title={`${kind} by -10 frames`} onClick={() => props.onTrim(clip.id, kind, -10, edge)}>
                        −10
                      </button>
                      <button title={`${kind} by -1 frame`} onClick={() => props.onTrim(clip.id, kind, -1, edge)}>
                        −1
                      </button>
                      <button title={`${kind} by +1 frame`} onClick={() => props.onTrim(clip.id, kind, 1, edge)}>
                        +1
                      </button>
                      <button title={`${kind} by +10 frames`} onClick={() => props.onTrim(clip.id, kind, 10, edge)}>
                        +10
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="field-group">
              <h4>Levels</h4>
              <NumberField
                label="Opacity"
                value={clip?.opacity ?? 1}
                keyed={keyed('opacity')}
                step={0.05}
                min={0}
                onCommit={(opacity) => props.onApply({ opacity })}
              />
              <NumberField
                label="Volume"
                value={clip?.volume ?? 1}
                keyed={keyed('volume')}
                step={0.1}
                min={0}
                onCommit={(volume) => props.onApply({ volume })}
              />
              <NumberField
                label="Fade in"
                unit="f"
                value={clip?.fadeInFrames ?? 0}
                min={0}
                onCommit={(fadeInFrames) => props.onApply({ fadeInFrames: Math.round(fadeInFrames) })}
              />
              <NumberField
                label="Fade out"
                unit="f"
                value={clip?.fadeOutFrames ?? 0}
                min={0}
                onCommit={(fadeOutFrames) => props.onApply({ fadeOutFrames: Math.round(fadeOutFrames) })}
              />
            </div>

            {clip?.multicam ? (
              <MulticamPanel
                clip={clip}
                timeline={timeline}
                assets={props.assets}
                frame={props.playhead}
                onSwitch={(angleIndex, frame) => props.onSwitchAngle(clip.id, angleIndex, frame)}
              />
            ) : null}

            {clip ? (
              <EffectStack
                clip={clip}
                timeline={timeline}
                onSetParams={(effectId, params) => props.onSetEffectParams(clip.id, effectId, params)}
                onSetCurve={(effectId, channel, points) =>
                  props.onSetEffectCurve(clip.id, effectId, channel, points)
                }
                onToggle={(effectId, enabled) => props.onToggleEffect(clip.id, effectId, enabled)}
                onRemove={(effectId) => props.onRemoveEffect(clip.id, effectId)}
                onReorder={(effectId, toIndex) => props.onReorderEffect(clip.id, effectId, toIndex)}
                onSetTransition={(kind, durationFrames) => props.onSetTransition(clip.id, kind, durationFrames)}
                onRemoveTransition={() => props.onRemoveTransition(clip.id)}
              />
            ) : null}

            <div className="field-group">
              <h4>Transform</h4>
              <NumberField
                label="Centre X"
                value={clip?.transform.centerX ?? 0.5}
                keyed={keyed('transform.centerX')}
                step={0.01}
                onCommit={(centerX) => props.onApply({ transform: { centerX } })}
              />
              <NumberField
                label="Centre Y"
                value={clip?.transform.centerY ?? 0.5}
                keyed={keyed('transform.centerY')}
                step={0.01}
                onCommit={(centerY) => props.onApply({ transform: { centerY } })}
              />
              <NumberField
                label="Scale X"
                unit="×"
                value={clip?.transform.scaleX ?? 1}
                keyed={keyed('transform.scaleX')}
                step={0.05}
                onCommit={(scaleX) => props.onApply({ transform: { scaleX } })}
              />
              <NumberField
                label="Scale Y"
                unit="×"
                value={clip?.transform.scaleY ?? 1}
                keyed={keyed('transform.scaleY')}
                step={0.05}
                onCommit={(scaleY) => props.onApply({ transform: { scaleY } })}
              />
              <NumberField
                label="Rotation"
                unit="°"
                value={clip?.transform.rotation ?? 0}
                keyed={keyed('transform.rotation')}
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
