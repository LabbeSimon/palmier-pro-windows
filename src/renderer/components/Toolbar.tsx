import type { Project, Timeline } from '../../core/model.js'
import { IconImport, IconRedo, IconRipple, IconText, IconTrash, IconUndo } from './Icons.js'

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

      <button className="icon-btn wide" onClick={props.onImport} title="Import media files">
        <IconImport /> Import
      </button>
      <button className="icon-btn wide" onClick={props.onAddText} title="Add a text clip at the playhead">
        <IconText /> Text
      </button>

      <span className="divider" />

      <button className="icon-btn" onClick={props.onUndo} disabled={!props.canUndo} title="Undo (Ctrl+Z)">
        <IconUndo />
      </button>
      <button className="icon-btn" onClick={props.onRedo} disabled={!props.canRedo} title="Redo (Ctrl+Shift+Z)">
        <IconRedo />
      </button>
      <button
        className="icon-btn"
        onClick={() => props.onDelete(false)}
        disabled={!hasSelection}
        title="Delete selection (Del)"
      >
        <IconTrash />
      </button>
      <button
        className="icon-btn"
        onClick={() => props.onDelete(true)}
        disabled={!hasSelection}
        title="Ripple delete — remove and close the gap (Shift+Del)"
      >
        <IconRipple />
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
