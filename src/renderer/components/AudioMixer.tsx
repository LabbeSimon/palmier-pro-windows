import type { Timeline, Track } from '../../core/model.js'
import { IconMute, IconVolume } from './Icons.js'

interface Props {
  timeline: Timeline
  onSetGain: (trackId: string, volume: number) => void
  onToggleMute: (trackId: string, muted: boolean) => void
}

/** Linear gain to decibels, with a floor label instead of -Infinity. */
function toDb(volume: number): string {
  if (volume <= 0.0001) return '−∞'
  const db = 20 * Math.log10(volume)
  return `${db > 0 ? '+' : ''}${db.toFixed(1)}`
}

function fromDb(db: number): number {
  return Math.pow(10, db / 20)
}

const MIN_DB = -40
const MAX_DB = 12

/**
 * Faders are vertical and calibrated in decibels because that is how levels are
 * read and talked about; the linear value the model stores never surfaces here.
 */
export function AudioMixer(props: Props) {
  // Text tracks carry no sound, so a fader on them would be a dead control.
  const mixable = props.timeline.tracks.filter(
    (t) => t.type === 'audio' || t.clips.some((c) => c.mediaType !== 'text' && c.mediaType !== 'subtitle'),
  )

  return (
    <div className="mixer-body">
      <p className="hint">
        {mixable.length} of {props.timeline.tracks.length} tracks can carry sound.
      </p>
      <div className="mixer">
        {mixable.length === 0 ? (
          <p className="hint">Nothing to mix yet.</p>
        ) : (
          mixable.map((track) => <Strip key={track.id} track={track} {...props} />)
        )}
      </div>
    </div>
  )
}

function Strip({ track, onSetGain, onToggleMute }: { track: Track } & Omit<Props, 'timeline'>) {
  const volume = track.volume ?? 1
  const db = volume <= 0.0001 ? MIN_DB : Math.max(MIN_DB, Math.min(MAX_DB, 20 * Math.log10(volume)))

  return (
    <div className={`strip${track.muted ? ' muted' : ''}`}>
      <span className="strip-name" title={track.name ?? track.type}>
        {track.name ?? track.type}
      </span>

      <span className="fader-well">
        <input
          className="fader"
          type="range"
          min={MIN_DB}
          max={MAX_DB}
          step={0.5}
          value={db}
          aria-label={`${track.name ?? track.type} gain`}
          onChange={(event) => onSetGain(track.id, fromDb(Number(event.target.value)))}
        />
      </span>

      <span className="strip-db">{toDb(volume)}</span>

      <button
        className={`icon-btn${track.muted ? ' off' : ''}`}
        title={track.muted ? 'Unmute' : 'Mute'}
        onClick={() => onToggleMute(track.id, !track.muted)}
      >
        {track.muted ? <IconMute /> : <IconVolume />}
      </button>
    </div>
  )
}
