import { useCallback, useEffect, useState } from 'react'

import type { CacheCategory, PerformanceSettings, PerformanceSnapshot } from '../../preload/index.js'

interface Props {
  onClose: () => void
  onStatus: (text: string, tone: 'ok' | 'error') => void
}

const CATEGORY_LABELS: Record<CacheCategory, { name: string; detail: string }> = {
  preview: { name: 'Timeline preview', detail: 'Rendered slices; rebuilt on demand' },
  frames: { name: 'Monitor frames', detail: 'Stills shown while scrubbing' },
  proxies: { name: 'Proxy clips', detail: 'Slow to rebuild — never evicted automatically' },
  thumbnails: { name: 'Thumbnails', detail: 'Posters in the project bin' },
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

/**
 * Performance settings and the cached-data manager, in one dialog.
 *
 * Kdenlive keeps these on separate configuration pages; together they answer
 * the one question people actually have — "why is this slow, and what is all
 * that disk?" Every change applies at once, as the MCP tools do, so the dialog
 * and an agent can never disagree about what is set.
 */
export function PerformanceDialog(props: Props) {
  const [snapshot, setSnapshot] = useState<PerformanceSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const { onClose, onStatus } = props

  useEffect(() => {
    void window.palmier.performance.get().then((result) => {
      if (result.ok) setSnapshot(result.value)
      else onStatus(result.message, 'error')
    })
  }, [onStatus])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const update = useCallback(
    async (change: Partial<PerformanceSettings>) => {
      setBusy(true)
      const result = await window.palmier.performance.set(change)
      setBusy(false)
      if (result.ok) setSnapshot(result.value)
      else onStatus(result.message, 'error')
    },
    [onStatus],
  )

  const clear = useCallback(
    async (categories: CacheCategory[]) => {
      setBusy(true)
      const result = await window.palmier.performance.clearCache(categories)
      setBusy(false)
      if (!result.ok) return onStatus(result.message, 'error')
      setSnapshot(result.value)
      const freed = result.value.freed
      onStatus(`Freed ${formatBytes(freed?.bytes ?? 0)} in ${freed?.files ?? 0} file(s)`, 'ok')
    },
    [onStatus],
  )

  const settings = snapshot?.settings
  const machine = snapshot?.machine
  const limitBytes = (settings?.cacheLimitGB ?? 0) * 1024 ** 3

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal performance" role="dialog" aria-modal="true" aria-labelledby="performance-title">
        <header>
          <h2 id="performance-title">Performance and cached data</h2>
          <button className="icon" onClick={onClose} aria-label="Close" title="Close (Esc)">×</button>
        </header>

        {!snapshot || !settings || !machine ? (
          <p className="loading">Probing this machine…</p>
        ) : (
          <div className="modal-body">
            <section>
              <h3>Timeline preview</h3>
              <div className="setting">
                <label htmlFor="preview-height">Preview resolution</label>
                <select
                  id="preview-height"
                  value={settings.previewHeight}
                  disabled={busy}
                  onChange={(event) => void update({ previewHeight: Number(event.target.value) })}
                >
                  {snapshot.options.previewHeights.map((height) => (
                    <option key={height} value={height}>{height}p</option>
                  ))}
                </select>
                <span className="hint">Lower plays smoother. The export is always full size.</span>
              </div>
              <div className="setting">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={settings.autoPreview}
                    disabled={busy}
                    onChange={(event) => void update({ autoPreview: event.target.checked })}
                  />
                  Render changed parts after a pause in editing
                </label>
                <span className="hint">
                  Runs in the background below normal priority and stops at the next edit; finished slices are kept.
                </span>
              </div>
            </section>

            <section>
              <h3>Encoding</h3>
              <div className="setting">
                <label>Video encoder</label>
                <span className={`readout${machine.hardwareEncoder ? ' hardware' : ''}`}>{machine.encoder}</span>
                <span className="hint">
                  {machine.hardwareEncoder
                    ? 'Probed and working on this machine.'
                    : 'No working GPU encoder was found, so encoding runs on the CPU.'}
                </span>
              </div>
              <div className="setting">
                <label htmlFor="parallel-jobs">Simultaneous encodes</label>
                <input
                  id="parallel-jobs"
                  type="number"
                  min={1}
                  max={snapshot.options.maxParallelJobs}
                  value={settings.parallelJobs}
                  disabled={busy}
                  onChange={(event) => {
                    const jobs = Number(event.target.value)
                    if (Number.isInteger(jobs) && jobs >= 1 && jobs <= snapshot.options.maxParallelJobs) {
                      void update({ parallelJobs: jobs })
                    }
                  }}
                />
                <span className="hint">
                  Preview slices and proxies at once. {machine.recommendedParallelJobs} recommended for{' '}
                  {machine.logicalCores} logical cores.
                </span>
              </div>
              <div className="setting">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={settings.lowPriority}
                    disabled={busy}
                    onChange={(event) => void update({ lowPriority: event.target.checked })}
                  />
                  Encode previews and proxies at low priority
                </label>
                <span className="hint">Keeps scrubbing and editing fluid while they run.</span>
              </div>
              <div className="setting">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={settings.hardwareDecode}
                    disabled={busy || (!machine.hardwareDecodeAvailable && !settings.hardwareDecode)}
                    onChange={(event) => void update({ hardwareDecode: event.target.checked })}
                  />
                  Decode sources on the GPU
                </label>
                <span className="hint">
                  {machine.hardwareDecodeAvailable
                    ? 'Helps most with 4K and H.265 footage.'
                    : 'Not available: a test clip failed to decode on the GPU on this machine.'}
                </span>
              </div>
            </section>

            <section>
              <h3>Cached data</h3>
              <table className="cache-table">
                <tbody>
                  {(Object.keys(CATEGORY_LABELS) as CacheCategory[]).map((category) => {
                    const usage = snapshot.cache.categories[category]
                    return (
                      <tr key={category}>
                        <td>
                          <span className="name">{CATEGORY_LABELS[category].name}</span>
                          <span className="hint">{CATEGORY_LABELS[category].detail}</span>
                        </td>
                        <td className="size">{formatBytes(usage.bytes)}</td>
                        <td className="count">{usage.files} file{usage.files === 1 ? '' : 's'}</td>
                        <td>
                          <button disabled={busy || usage.files === 0} onClick={() => void clear([category])}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td><span className="name">Total</span></td>
                    <td className="size">{formatBytes(snapshot.cache.totalBytes)}</td>
                    <td colSpan={2} className="meter-cell">
                      <div className="meter" title={`${formatBytes(snapshot.cache.totalBytes)} of ${settings.cacheLimitGB} GB`}>
                        <div
                          className="fill"
                          style={{ width: `${Math.min(100, (snapshot.cache.totalBytes / Math.max(1, limitBytes)) * 100)}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                </tfoot>
              </table>
              <div className="setting">
                <label htmlFor="cache-limit">Cache ceiling (GB)</label>
                <input
                  id="cache-limit"
                  type="number"
                  min={0.5}
                  max={500}
                  step={0.5}
                  value={settings.cacheLimitGB}
                  disabled={busy}
                  onChange={(event) => {
                    const limit = Number(event.target.value)
                    if (limit >= 0.5 && limit <= 500) void update({ cacheLimitGB: limit })
                  }}
                />
                <span className="hint">Least recently used previews and frames go first. Proxies are never evicted.</span>
              </div>
              <p className="path" title={snapshot.cache.directory}>{snapshot.cache.directory}</p>
            </section>
          </div>
        )}

        <footer>
          <button className="primary" onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>
  )
}
