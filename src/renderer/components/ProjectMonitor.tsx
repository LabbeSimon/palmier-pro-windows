import { useEffect, useRef, useState } from 'react'

import type { Timeline } from '../../core/model.js'
import type { PlayerState } from '../usePlayer.js'

interface Props {
  timeline: Timeline
  frame: number
  totalFrames: number
  player: PlayerState
  /** Still frame used before a proxy exists. */
  stillImage: string | null
  stillBusy: boolean
  stillError: string | null
  empty: boolean
  onSeek: (frame: number) => void
  onSetPlaying: (playing: boolean) => void
  onRenderPreview: () => void
  onCancelRender: () => void
  /** Surfaces why playback refused to start, instead of silently un-pressing play. */
  onPlaybackError: (message: string) => void
  /** Play, building the proxy first if there is none. */
  onPlay: () => void
}

/**
 * Plays the rendered proxy when there is one, and falls back to a single
 * composited frame when there is not — so the monitor is never blank, and it
 * always states which of the two you are looking at.
 */
export function ProjectMonitor(props: Props) {
  const { player, timeline, frame } = props
  const video = useRef<HTMLVideoElement>(null)
  const seeking = useRef(false)

  const startFrame = player.info?.startFrame ?? 0
  const canPlay = player.fresh && Boolean(player.info?.url)
  const [dropped, setDropped] = useState(0)
  const [proxySize, setProxySize] = useState<string | null>(null)

  // Browsers report decode drops per element; polling while playing is the only
  // way to surface them, and a rising count is the honest sign the proxy is too
  // heavy for the machine.
  useEffect(() => {
    if (!canPlay || !player.playing) return
    const timer = window.setInterval(() => {
      const element = video.current
      if (!element?.getVideoPlaybackQuality) return
      setDropped(element.getVideoPlaybackQuality().droppedVideoFrames)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [canPlay, player.playing])

  // Playhead -> video. Guarded so the video's own timeupdate cannot fight it.
  useEffect(() => {
    const element = video.current
    if (!element || !canPlay || seeking.current) return
    const target = (frame - startFrame) / timeline.fps
    if (Math.abs(element.currentTime - target) > 1 / timeline.fps) {
      element.currentTime = Math.max(0, target)
    }
  }, [frame, startFrame, timeline.fps, canPlay])

  useEffect(() => {
    const element = video.current
    if (!element || !canPlay) return
    if (!player.playing) {
      element.pause()
      return
    }
    // A rejected play() is almost always a missing audio device or a codec the
    // build cannot decode; saying so beats the button quietly popping back out.
    void element.play().catch((error: Error) => {
      props.onSetPlaying(false)
      props.onPlaybackError(`${error.name}: ${error.message}`)
    })
  }, [player.playing, canPlay, props])

  return (
    <>
      <div className="preview">
        {props.empty ? (
          <p className="placeholder">
            The timeline is empty.
            <br />
            Drag media from the bin onto a track, or ask an agent over MCP.
          </p>
        ) : canPlay ? (
          <video
            ref={video}
            src={player.info!.url}
            preload="auto"
            onTimeUpdate={(event) => {
              if (!player.playing) return
              seeking.current = true
              const current = event.currentTarget.currentTime
              props.onSeek(Math.round(current * timeline.fps) + startFrame)
              seeking.current = false
            }}
            onLoadedMetadata={(event) =>
              setProxySize(`${event.currentTarget.videoWidth}×${event.currentTarget.videoHeight}`)
            }
            onEnded={() => props.onSetPlaying(false)}
            onError={(event) => {
              props.onSetPlaying(false)
              const code = event.currentTarget.error
              props.onPlaybackError(code ? `media error ${code.code}: ${code.message}` : 'media error')
            }}
          />
        ) : props.stillError ? (
          <p className="placeholder error">
            Preview failed
            <br />
            <span className="detail">{props.stillError}</span>
          </p>
        ) : props.stillImage ? (
          <img src={props.stillImage} alt={`Frame ${frame}`} />
        ) : (
          <p className="placeholder">Rendering the first frame…</p>
        )}

        {player.rendering ? (
          <span className="badge busy">
            Building preview{player.progress ? ` ${Math.round((player.progress.frame / Math.max(1, player.progress.totalFrames)) * 100)}%` : ''}
          </span>
        ) : props.stillBusy && !canPlay ? (
          <span className="badge busy">Rendering</span>
        ) : null}

        {/* The monitor must never let you mistake a still for playback. */}
        {props.empty ? null : (
          <span className={`badge mode${canPlay ? ' live' : ''}`}>
            {canPlay ? 'Preview' : 'Still frame'}
          </span>
        )}
      </div>

      {props.empty ? null : (
        <div className="preview-bar">
          {canPlay ? (
            <>
              <span className="ready">Preview ready — press space to play</span>
              {proxySize ? (
                <span className="proxy-note" title="The preview is a reduced-resolution proxy; the export is full size">
                  proxy {proxySize}
                </span>
              ) : null}
              {dropped > 0 ? (
                <span className="dropped" title="Frames the decoder could not keep up with">
                  {dropped} dropped
                </span>
              ) : null}
            </>
          ) : player.rendering ? (
            <>
              <span className="building">
                Building the preview{player.progress ? ` — frame ${player.progress.frame} of ${player.progress.totalFrames}` : ''}
              </span>
              <button onClick={props.onCancelRender}>Cancel</button>
            </>
          ) : (
            <>
              <span className="stale">
                {player.error ? player.error : 'No preview for this edit yet — playback needs one.'}
              </span>
              <button className="primary" onClick={props.onRenderPreview}>
                Build preview
              </button>
            </>
          )}
        </div>
      )}
    </>
  )
}
