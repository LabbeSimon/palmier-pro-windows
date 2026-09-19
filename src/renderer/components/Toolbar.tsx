import type { Project, Timeline } from '../../core/model.js'
import { framesToTimecode } from '../../core/timecode.js'

interface Props {
  project: Project
  timeline: Timeline
  dirty: boolean
  playhead: number
  canUndo: boolean
  canRedo: boolean
  selectedClipIds: string[]
  exporting: boolean
  onNew: () => void
  onOpen: () => void
  onSave: (saveAs?: boolean) => void
  onImport: () => void
  onUndo: () => void
  onRedo: () => void
  onSplit: () => void
  onDelete: (ripple: boolean) => void
  onAddText: () => void
  onExport: () => void
  onCancelExport: () => void
  onSelectTimeline: (id: string) => void
}

export function Toolbar(props: Props) {
  const { project, timeline, selectedClipIds } = props
  const hasSelection = selectedClipIds.length > 0

  return (
    <div className="toolbar">
      <span className="title">
        {project.name}
        {props.dirty ? <span className="dirty" title="Unsaved changes"> •</span> : null}
      </span>

      <button onClick={props.onNew}>New</button>
      <button onClick={props.onOpen}>Open</button>
      <button onClick={() => props.onSave(false)}>Save</button>
      <button onClick={() => props.onSave(true)}>Save as…</button>

      <span className="divider" />

      <button onClick={props.onImport}>Import media</button>
      <button onClick={props.onAddText}>Add text</button>

      <span className="divider" />

      <button onClick={props.onUndo} disabled={!props.canUndo} title="Ctrl+Z">Undo</button>
      <button onClick={props.onRedo} disabled={!props.canRedo} title="Ctrl+Shift+Z">Redo</button>
      <button onClick={props.onSplit} title="Split at the playhead (S)">Split</button>
      <button onClick={() => props.onDelete(false)} disabled={!hasSelection} title="Delete (Del)">
        Delete
      </button>
      <button onClick={() => props.onDelete(true)} disabled={!hasSelection} title="Delete and close the gap (Shift+Del)">
        Ripple delete
      </button>

      <span className="spacer" />

      <select
        value={timeline.id}
        onChange={(event) => props.onSelectTimeline(event.target.value)}
        style={{ width: 'auto' }}
        title="Active timeline"
      >
        {project.timelines.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>

      <span className="divider" />

      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' }}>
        {framesToTimecode(props.playhead, timeline.fps)}
      </span>

      {props.exporting ? (
        <button onClick={props.onCancelExport}>Cancel export</button>
      ) : (
        <button className="primary" onClick={props.onExport}>
          Export MP4
        </button>
      )}
    </div>
  )
}
