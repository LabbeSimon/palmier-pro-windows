import { useMemo, useState } from 'react'

import {
  EFFECT_CATEGORIES,
  EFFECT_DEFINITIONS,
  type EffectCategory,
  type EffectDefinition,
} from '../../core/effects.js'

interface Props {
  /** Adding is only possible with a selection; the panel says so rather than failing silently. */
  selectionCount: number
  onAdd: (definitionId: string) => void
}

/**
 * Browse by category, or type to search across every category at once. Search
 * wins over the category filter, because someone typing a name already knows
 * what they want.
 */
export function EffectsPanel(props: Props) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<EffectCategory | 'All'>('All')

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return EFFECT_DEFINITIONS.filter((definition) => {
      if (needle) {
        return (
          definition.name.toLowerCase().includes(needle) ||
          definition.description.toLowerCase().includes(needle) ||
          definition.category.toLowerCase().includes(needle)
        )
      }
      return category === 'All' || definition.category === category
    })
  }, [query, category])

  const grouped = useMemo(() => {
    const map = new Map<EffectCategory, EffectDefinition[]>()
    for (const definition of results) {
      const list = map.get(definition.category) ?? []
      list.push(definition)
      map.set(definition.category, list)
    }
    return [...map.entries()].sort(
      (a, b) => EFFECT_CATEGORIES.indexOf(a[0]) - EFFECT_CATEGORIES.indexOf(b[0]),
    )
  }, [results])

  const disabled = props.selectionCount === 0

  return (
    <div className="panel effects-panel">
      <div className="effects-search">
        <input
          type="search"
          placeholder="Search effects"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search effects"
        />
      </div>

      {query.trim() ? null : (
        <div className="chips">
          {(['All', ...EFFECT_CATEGORIES] as const).map((name) => (
            <button
              key={name}
              className={`chip${category === name ? ' on' : ''}`}
              onClick={() => setCategory(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      <div className="panel-body">
        {disabled ? (
          <p className="hint">Select a clip to add an effect.</p>
        ) : null}

        {grouped.length === 0 ? (
          <p className="empty">No effect matches “{query}”.</p>
        ) : (
          grouped.map(([name, definitions]) => (
            <div className="effect-group" key={name}>
              <h4>{name}</h4>
              {definitions.map((definition) => (
                <button
                  key={definition.id}
                  className="effect-item"
                  disabled={disabled}
                  title={definition.description}
                  onClick={() => props.onAdd(definition.id)}
                  draggable={!disabled}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('application/x-palmier-effect', definition.id)
                    event.dataTransfer.effectAllowed = 'copy'
                  }}
                >
                  <span className="effect-name">{definition.name}</span>
                  <span className={`effect-kind ${definition.kind}`}>{definition.kind === 'audio' ? 'A' : 'V'}</span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
