import type { Project, Timeline } from '../../core/model.js'
import {
  IconImport,
  IconMarkerAdd,
  IconNew,
  IconOpen,
  IconRedo,
  IconRender,
  IconRipple,
  IconSave,
  IconSplit,
  IconText,
  IconTrash,
  IconUndo,
} from './Icons.js'

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
  onAddMarker: () => void
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

      {/* Icon-only, as a KDE main toolbar is: the tooltip carries the name and
          its shortcut, and the row stays readable at any window width. */}
      <button className="icon-btn" onClick={props.onNew} title="New project (Ctrl+N)">
        <IconNew />
      </button>
      <button className="icon-btn" onClick={props.onOpen} title="Open project (Ctrl+O)">
        <IconOpen />
      </button>
      <button className="icon-btn" onClick={() => props.onSave(false)} title="Save (Ctrl+S)">
        <IconSave />
      </button>

      <span className="divider" />

      <button className="icon-btn" onClick={props.onImport} title="Import media (Ctrl+I)">
        <IconImport />
      </button>
      <button className="icon-btn" onClick={props.onAddText} title="Add text at the playhead (Ctrl+T)">
        <IconText />
      </button>
      <button className="icon-btn" onClick={props.onAddMarker} title="Add marker at the playhead (M)">
        <IconMarkerAdd />
      </button>
      <button className="icon-btn" onClick={props.onSplit} title="Split at the playhead (S)">
        <IconSplit />
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
        <button onClick={props.onCancelExport}>Cancel render</button>
      ) : (
        <button className="icon-btn wide primary" onClick={props.onExport} title="Render to MP4 (Ctrl+E)">
          <IconRender /> Render
        </button>
      )}
    </div>
  )
}
