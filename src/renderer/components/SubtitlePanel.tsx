import { useEffect, useState } from 'react'

import { clipEndFrame, type Clip, type Timeline } from '../../core/model.js'
import { framesToTimecode } from '../../core/timecode.js'
import { IconImport, IconTrash } from './Icons.js'

interface Props {
  timeline: Timeline
  /** Cues in time order, with the track they sit on. */
  cues: { clip: Clip; trackId: string }[]
  playhead: number
  selectedClipIds: string[]
  onImport: () => void
  onExport: () => void
  onAdd: () => void
  onSelect: (clipId: string) => void
  onSeek: (frame: number) => void
  onEdit: (clipId: string, text: string) => void
  onRemove: (clipId: string) => void
}

/**
 * The subtitle list.
 *
 * Cues are ordinary clips on a subtitle track, so this panel is a text editor
 * for them rather than a separate store: retiming happens on the timeline with
 * the same trim and move gestures as anything else.
 */
export function SubtitlePanel(props: Props) {
  const { timeline, cues } = props

  return (
    <div className="panel">
      <div className="panel-title">
        <span>
          {cues.length} {cues.length === 1 ? 'cue' : 'cues'}
        </span>
        <span className="title-actions">
          <button className="icon-btn" title="Add a cue at the playhead" onClick={props.onAdd}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M7.2 3h1.6v4.2H13v1.6H8.8V13H7.2V8.8H3V7.2h4.2Z" fill="currentColor" />
            </svg>
          </button>
          <button className="icon-btn" title="Import an .srt or .vtt file" onClick={props.onImport}>
            <IconImport />
          </button>
          <button
            className="icon-btn"
            title={cues.length === 0 ? 'Nothing to export yet' : 'Export as .srt or .vtt'}
            disabled={cues.length === 0}
            onClick={props.onExport}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M8 2.4a.8.8 0 0 1 .8.8v5.3l1.7-1.7a.8.8 0 0 1 1.1 1.1L8 11.5 4.4 7.9a.8.8 0 1 1 1.1-1.1l1.7 1.7V3.2a.8.8 0 0 1 .8-.8Zm-5 9.4h10v1.6H3Z"
                fill="currentColor"
              />
            </svg>
          </button>
        </span>
      </div>

      <div className="panel-body subtitle-list">
        {cues.length === 0 ? (
          <p className="hint">
            No subtitles yet. Import an .srt, or add a cue at the playhead and type into it. Cues
            land on a subtitle track and behave like any other clip.
          </p>
        ) : (
          cues.map(({ clip }) => (
            <CueRow
              key={clip.id}
              clip={clip}
              fps={timeline.fps}
              current={props.playhead >= clip.startFrame && props.playhead < clipEndFrame(clip)}
              selected={props.selectedClipIds.includes(clip.id)}
              onSelect={() => props.onSelect(clip.id)}
              onSeek={() => props.onSeek(clip.startFrame)}
              onEdit={(text) => props.onEdit(clip.id, text)}
              onRemove={() => props.onRemove(clip.id)}
            />
          ))
        )}
      </div>
    </div>
  )
}

function CueRow(props: {
  clip: Clip
  fps: number
  current: boolean
  selected: boolean
  onSelect: () => void
  onSeek: () => void
  onEdit: (text: string) => void
  onRemove: () => void
}) {
  const { clip } = props
  const [draft, setDraft] = useState(clip.textContent ?? '')

  // An edit made elsewhere — by the agent, or by undo — has to win over a
  // stale draft, or the next keystroke would resurrect the old text.
  useEffect(() => setDraft(clip.textContent ?? ''), [clip.textContent])

  const commit = () => {
    const text = draft.trim()
    if (text === '' || text === clip.textContent) {
      setDraft(clip.textContent ?? '')
      return
    }
    props.onEdit(text)
  }

  return (
    <div
      className={`cue${props.selected ? ' selected' : ''}${props.current ? ' current' : ''}`}
      onClick={props.onSelect}
    >
      <div className="cue-head">
        <button className="cue-time" title="Move the playhead here" onClick={props.onSeek}>
          {framesToTimecode(clip.startFrame, props.fps)}
        </button>
        <span className="cue-span">
          {((clipEndFrame(clip) - clip.startFrame) / props.fps).toFixed(1)} s
        </span>
        <button className="icon-btn" title="Delete this cue" onClick={props.onRemove}>
          <IconTrash />
        </button>
      </div>
      <textarea
        rows={2}
        value={draft}
        aria-label={`Subtitle at ${framesToTimecode(clip.startFrame, props.fps)}`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setDraft(clip.textContent ?? '')
          // Enter breaks the line, as a subtitle often needs two; Ctrl+Enter commits.
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) event.currentTarget.blur()
        }}
      />
    </div>
  )
}
