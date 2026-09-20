import { useState, type ReactNode } from 'react'

export type DockSide = 'left' | 'right'

export interface DockPanel {
  id: string
  label: string
  render: () => ReactNode
}

interface Props {
  side: DockSide
  panels: DockPanel[]
  activeId: string | null
  onActivate: (panelId: string) => void
  /** Called when a panel is dragged onto this dock from the other one. */
  onAdopt: (panelId: string) => void
}

const MIME = 'application/x-palmier-panel'

/**
 * A dock with tabs, as Qt has.
 *
 * Panels are dragged between the two docks by their tab, which is how anyone
 * who has rearranged a Qt application expects to do it. Detaching into a
 * floating window is the part that is not here: it needs a second renderer
 * process, and moving a panel from one side to the other is what people
 * actually do day to day.
 */
export function Dock(props: Props) {
  const [over, setOver] = useState(false)
  const active = props.panels.find((panel) => panel.id === props.activeId) ?? props.panels[0] ?? null

  if (props.panels.length === 0) {
    return (
      <div
        className={`panel side empty-dock${over ? ' over' : ''}`}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(MIME)) return
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault()
          setOver(false)
          const panelId = event.dataTransfer.getData(MIME)
          if (panelId) props.onAdopt(panelId)
        }}
      >
        <p className="hint">Drag a panel tab here.</p>
      </div>
    )
  }

  return (
    <div className="panel side">
      <div
        className={`tabs${over ? ' drop' : ''}`}
        role="tablist"
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(MIME)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault()
          setOver(false)
          const panelId = event.dataTransfer.getData(MIME)
          if (panelId && !props.panels.some((panel) => panel.id === panelId)) props.onAdopt(panelId)
        }}
      >
        {props.panels.map((panel) => (
          <button
            key={panel.id}
            role="tab"
            draggable
            aria-selected={active?.id === panel.id}
            className={active?.id === panel.id ? 'on' : ''}
            title={`${panel.label} — drag to the other dock to move it`}
            onClick={() => props.onActivate(panel.id)}
            onDragStart={(event) => {
              event.dataTransfer.setData(MIME, panel.id)
              event.dataTransfer.effectAllowed = 'move'
            }}
          >
            {panel.label}
          </button>
        ))}
      </div>

      {active?.render()}
    </div>
  )
}
