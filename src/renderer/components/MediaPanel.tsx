import type { MediaAsset } from '../../core/model.js'

interface Props {
  assets: MediaAsset[]
  thumbnails: Record<string, string>
  selectedAssetId: string | null
  onSelect: (assetId: string) => void
  onImport: () => void
  onRemove: (assetId: string) => void
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'still'
  const total = Math.round(seconds)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export function MediaPanel(props: Props) {
  return (
    <div className="panel">
      <div className="panel-title">
        <span>Media · {props.assets.length}</span>
        <button onClick={props.onImport}>Import</button>
      </div>
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
              className={`asset${props.selectedAssetId === asset.id ? ' selected' : ''}`}
              draggable
              onClick={() => props.onSelect(asset.id)}
              onDragStart={(event) => {
                event.dataTransfer.setData('application/x-palmier-asset', asset.id)
                event.dataTransfer.effectAllowed = 'copy'
                props.onSelect(asset.id)
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                props.onRemove(asset.id)
              }}
              title={`${asset.path}\nRight-click to remove from the project`}
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
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
