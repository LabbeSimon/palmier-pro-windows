import { useEffect, useState } from 'react'

import type { MediaAsset } from '../../core/model.js'

interface Props {
  assets: MediaAsset[]
  thumbnails: Record<string, string>
  selectedAssetIds: string[]
  onSelect: (assetId: string, additive: boolean) => void
  onMulticam: (assetIds: string[]) => void
  onImport: () => void
  onRemove: (assetId: string) => void
  onError: (message: string) => void
  onDone: (message: string) => void
}

interface ProxyState {
  total: number
  ready: number
  building: boolean
  width: number
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'still'
  const total = Math.round(seconds)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export function MediaPanel(props: Props) {
  const proxies = useProxies(props.assets, props.onError, props.onDone)

  return (
    <div className="panel">
      <div className="panel-title">
        <span>{props.assets.length} file{props.assets.length === 1 ? '' : 's'}</span>
        <button onClick={props.onImport}>Import</button>
      </div>

      {multicamCandidates(props).length >= 2 ? (
        <div className="proxy-bar">
          <span className="proxy-state">{multicamCandidates(props).length} angles selected</span>
          <button
            title="Line them up by their audio and place a multicam clip"
            onClick={() => props.onMulticam(multicamCandidates(props))}
          >
            Multicam
          </button>
        </div>
      ) : null}

      {proxies.state.total > 0 ? (
        <div className="proxy-bar">
          <span className="proxy-state">
            {proxies.progress
              ? `Proxy ${proxies.progress.done + 1}/${proxies.progress.total} · ${proxies.progress.name}`
              : `${proxies.state.ready}/${proxies.state.total} proxied at ${proxies.state.width}px`}
          </span>
          {proxies.busy ? (
            <button onClick={proxies.cancel}>Stop</button>
          ) : (
            <>
              <button
                title={
                  `Transcode every video clip to a small all-intra copy for editing. ` +
                  `The export always reads the originals.`
                }
                onClick={proxies.build}
              >
                {proxies.state.ready === proxies.state.total ? 'Rebuild' : 'Build'}
              </button>
              <button
                disabled={!props.assets.some((asset) => asset.proxyPath)}
                title="Go back to editing against the original files"
                onClick={proxies.clear}
              >
                Off
              </button>
            </>
          )}
        </div>
      ) : null}
      <div className="panel-body">
        {props.assets.length === 0 ? (
          <p className="empty">
            No media yet.
            <br />
            Import files, then drag them onto a track.
          </p>
        ) : (
          props.assets.map((asset) => (
            <div
              key={asset.id}
              className={`asset${props.selectedAssetIds.includes(asset.id) ? ' selected' : ''}`}
              draggable
              onClick={(event) => props.onSelect(asset.id, event.ctrlKey || event.metaKey)}
              onDragStart={(event) => {
                event.dataTransfer.setData('application/x-palmier-asset', asset.id)
                event.dataTransfer.effectAllowed = 'copy'
                props.onSelect(asset.id, false)
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                props.onRemove(asset.id)
              }}
              title={`${asset.path}\nCtrl-click to add to the selection · right-click to remove`}
            >
              <div
                className="poster"
                style={
                  props.thumbnails[asset.id]
                    ? { backgroundImage: `url(${props.thumbnails[asset.id]})` }
                    : undefined
                }
              >
                {props.thumbnails[asset.id] ? null : asset.type === 'audio' ? '♪' : '—'}
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="name">{asset.name}</div>
                <div className="meta">
                  {asset.type} · {formatDuration(asset.durationSeconds)}
                  {asset.width > 0 ? ` · ${asset.width}×${asset.height}` : ''}
                  {asset.proxyPath ? (
                    <span className="proxy-badge" title="Edited through a proxy; exported from the original">
                      proxy
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/** Selected assets that could stand as multicam angles. */
function multicamCandidates(props: Props): string[] {
  return props.selectedAssetIds.filter((id) => {
    const asset = props.assets.find((candidate) => candidate.id === id)
    return asset !== undefined && (asset.type === 'video' || asset.type === 'audio') && asset.hasAudio
  })
}

/**
 * Proxy state for the bin header.
 *
 * Kept here rather than in the editor store because nothing else needs it: a
 * proxy changes how fast the picture arrives, never what the project contains.
 */
function useProxies(
  assets: MediaAsset[],
  onError: (message: string) => void,
  onDone: (message: string) => void,
) {
  const [state, setState] = useState<ProxyState>({ total: 0, ready: 0, building: false, width: 0 })
  const [progress, setProgress] = useState<{ name: string; done: number; total: number } | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    const result = await window.palmier.proxies.state()
    if (result.ok) setState(result.value)
  }

  useEffect(() => {
    void refresh()
    // Assets change when media is imported or removed, and both change the count.
  }, [assets])

  useEffect(() => {
    const offProgress = window.palmier.proxies.onProgress((update) =>
      setProgress(update.total > 0 && update.done < update.total ? update : null),
    )
    const offDone = window.palmier.proxies.onDone(() => {
      setProgress(null)
      setBusy(false)
      void refresh()
    })
    return () => {
      offProgress()
      offDone()
    }
  }, [])

  return {
    state,
    progress,
    busy,
    build: async () => {
      setBusy(true)
      const result = await window.palmier.proxies.build()
      if (!result.ok) {
        setBusy(false)
        onError(result.message)
        return
      }
      onDone(result.value.message)
    },
    cancel: () => void window.palmier.proxies.cancel(),
    clear: async () => {
      const result = await window.palmier.proxies.clear()
      if (result.ok) onDone(result.value.message)
      else onError(result.message)
      void refresh()
    },
  }
}
