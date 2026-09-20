import { EFFECTS_BY_ID, type CurvePoint, type Effect } from '../../core/effects.js'
import { ColorWheels } from './ColorWheels.js'
import { CurveEditor } from './CurveEditor.js'
import { isAnimated, type KeyframeMap } from '../../core/keyframes.js'
import { TRANSITION_LABELS } from '../../core/transitions.js'
import { TRANSITION_KINDS, type Clip, type Timeline } from '../../core/model.js'
import { IconEye, IconEyeOff, IconTrash } from './Icons.js'

interface Props {
  clip: Clip
  timeline: Timeline
  onSetParams: (effectId: string, params: Record<string, number>) => void
  onSetCurve: (effectId: string, channel: string, points: CurvePoint[]) => void
  onToggle: (effectId: string, enabled: boolean) => void
  onRemove: (effectId: string) => void
  onReorder: (effectId: string, toIndex: number) => void
  onSetTransition: (kind: string, durationFrames: number) => void
  onRemoveTransition: () => void
}

/**
 * The stack renders in evaluation order, top to bottom, because that is the
 * order the result is computed in — showing it reversed would misrepresent what
 * moving an effect does.
 */
export function EffectStack(props: Props) {
  const { clip } = props
  const effects = clip.effects ?? []

  return (
    <>
      <div className="field-group">
        <h4>Transition in</h4>
        {clip.transitionIn ? (
          <>
            <div className="field">
              <label>Type</label>
              <select
                value={clip.transitionIn.kind}
                onChange={(event) =>
                  props.onSetTransition(event.target.value, clip.transitionIn!.durationFrames)
                }
              >
                {TRANSITION_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {TRANSITION_LABELS[kind]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Length</label>
              <span className="value-cell">
                <input
                  type="number"
                  min={1}
                  value={clip.transitionIn.durationFrames}
                  onChange={(event) => {
                    const frames = Math.round(Number(event.target.value))
                    if (Number.isFinite(frames) && frames >= 1) {
                      props.onSetTransition(clip.transitionIn!.kind, frames)
                    }
                  }}
                />
                <span className="unit">f</span>
              </span>
            </div>
            <button className="stack-remove" onClick={props.onRemoveTransition}>
              Remove transition
            </button>
          </>
        ) : (
          <p className="hint">
            None. Needs a clip before it on the same track and some head handle to pull from.
          </p>
        )}
      </div>

      <div className="field-group">
        <h4>Effects · {effects.length}</h4>
        {effects.length === 0 ? (
          <p className="hint">Drop an effect from the Effects panel.</p>
        ) : (
          effects.map((effect, index) => (
            <EffectRow
              key={effect.id}
              effect={effect}
              keyframes={clip.keyframes ?? {}}
              index={index}
              count={effects.length}
              onSetParams={props.onSetParams}
              onSetCurve={props.onSetCurve}
              onToggle={props.onToggle}
              onRemove={props.onRemove}
              onReorder={props.onReorder}
            />
          ))
        )}
      </div>
    </>
  )
}

function EffectRow(props: {
  effect: Effect
  keyframes: KeyframeMap
  index: number
  count: number
  onSetParams: (effectId: string, params: Record<string, number>) => void
  onSetCurve: (effectId: string, channel: string, points: CurvePoint[]) => void
  onToggle: (effectId: string, enabled: boolean) => void
  onRemove: (effectId: string) => void
  onReorder: (effectId: string, toIndex: number) => void
}) {
  const { effect } = props
  const definition = EFFECTS_BY_ID.get(effect.definitionId)
  if (!definition) {
    return (
      <div className="effect-card missing">
        <span>Unknown effect “{effect.definitionId}”</span>
        <button className="icon-btn" onClick={() => props.onRemove(effect.id)} title="Remove">
          <IconTrash />
        </button>
      </div>
    )
  }

  return (
    <div className={`effect-card${effect.enabled ? '' : ' bypassed'}`}>
      <div className="effect-head">
        <button
          className="icon-btn"
          title={effect.enabled ? 'Bypass this effect' : 'Enable this effect'}
          onClick={() => props.onToggle(effect.id, !effect.enabled)}
        >
          {effect.enabled ? <IconEye /> : <IconEyeOff />}
        </button>
        <span className="effect-title">{definition.name}</span>
        <button
          className="icon-btn"
          disabled={props.index === 0}
          title="Move up in the stack"
          onClick={() => props.onReorder(effect.id, props.index - 1)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 4.2 3.4 9.4a.8.8 0 0 0 1.2 1l3.4-3.9 3.4 3.9a.8.8 0 0 0 1.2-1Z" fill="currentColor" />
          </svg>
        </button>
        <button
          className="icon-btn"
          disabled={props.index === props.count - 1}
          title="Move down in the stack"
          onClick={() => props.onReorder(effect.id, props.index + 1)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 11.8 12.6 6.6a.8.8 0 0 0-1.2-1L8 9.5 4.6 5.6a.8.8 0 0 0-1.2 1Z" fill="currentColor" />
          </svg>
        </button>
        <button className="icon-btn" title="Remove this effect" onClick={() => props.onRemove(effect.id)}>
          <IconTrash />
        </button>
      </div>

      {/* Colour wheels are nine numbers that only make sense as three pucks. */}
      {definition.id === 'color-wheels' ? (
        <ColorWheels
          params={effect.params}
          onChange={(params) => props.onSetParams(effect.id, params)}
        />
      ) : null}

      {(definition.curveChannels ?? []).map((channel) => (
        <CurveEditor
          key={channel.key}
          channel={channel.key}
          label={channel.label}
          points={effect.curves?.[channel.key]}
          onChange={(points) => props.onSetCurve(effect.id, channel.key, points)}
        />
      ))}

      {definition.params.length === 0 || definition.id === 'color-wheels' ? (
        definition.curveChannels?.length || definition.id === 'color-wheels' ? null : (
          <p className="hint">No settings.</p>
        )
      ) : (
        definition.params.map((param) => {
          // A curve overrides the slider at render time; saying so beats letting
          // someone drag a control that no longer affects the picture.
          const animated = isAnimated(props.keyframes[`effect:${effect.id}:${param.key}`])
          return (
            <div className={`field slider${animated ? ' animated' : ''}`} key={param.key}>
              <label title={param.label}>{param.label}</label>
              <input
                type="range"
                min={param.min}
                max={param.max}
                step={param.step}
                disabled={animated}
                value={effect.params[param.key] ?? param.default}
                onChange={(event) =>
                  props.onSetParams(effect.id, { [param.key]: Number(event.target.value) })
                }
              />
              <span className="readout">
                {animated ? (
                  <span className="kf-badge" title="Driven by keyframes — edit it in the keyframe bar">
                    keyed
                  </span>
                ) : (
                  <>
                    {(effect.params[param.key] ?? param.default).toFixed(param.step < 1 ? 2 : 0)}
                    {param.unit ? <span className="unit">{param.unit}</span> : null}
                  </>
                )}
              </span>
            </div>
          )
        })
      )}
    </div>
  )
}
