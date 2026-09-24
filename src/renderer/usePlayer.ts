import { useCallback, useEffect, useRef, useState } from 'react'

import type { Project, Timeline } from '../core/model.js'
import type { PreviewInfo, RenderProgress } from '../preload/index.js'

export interface PlayerState {
  info: PreviewInfo | null
  /** True when the proxy matches the current edit. */
  fresh: boolean
  playing: boolean
  rendering: boolean
  progress: RenderProgress | null
  error: string | null
}

/**
 * Drives the timeline proxy: knows whether one exists, whether it still matches
 * the edit, and owns the play/pause state.
 *
 * The proxy is never rendered on every keystroke — that would burn the
 * machine. It follows Kdenlive: you ask for it, or you turn on the idle
 * preview, which waits for a pause in editing; either way the UI says plainly
 * when what you are watching is out of date. Asking to *play* counts
 * as asking — and then it plays, rather than stopping once the encode is done.
 */
export function usePlayer(project: Project | null, timeline: Timeline | null) {
  const [info, setInfo] = useState<PreviewInfo | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState<RenderProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rendering, setRendering] = useState(false)

  const refresh = useCallback(async () => {
    const result = await window.palmier.preview.state()
    if (result.ok) setInfo(result.value)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, project])

  useEffect(() => {
    // A render the idle scheduler or an agent started is still a render: the
    // monitor must say so, not sit on "no preview" while the fans spin up.
    let announced = false
    const offProgress = window.palmier.preview.onProgress((next) => {
      setProgress(next)
      setRendering(true)
      // Once per render: learn who started it, so the monitor can say.
      if (!announced) {
        announced = true
        void refresh()
      }
    })
    const offDone = window.palmier.preview.onDone(() => {
      announced = false
      setProgress(null)
      setRendering(false)
      void refresh()
    })
    return () => {
      offProgress()
      offDone()
    }
  }, [refresh])

  // `preview:state` computes the fingerprint of the *current* edit and reports
  // whether a proxy exists for it, so `ready` already means "matches the edit".
  const fresh = Boolean(info?.ready && info.url)

  // An edit that invalidates the proxy must stop playback rather than keep
  // showing a cut that no longer exists.
  const lastFingerprint = useRef<string | null>(null)
  useEffect(() => {
    if (!info) return
    if (lastFingerprint.current && lastFingerprint.current !== info.fingerprint) setPlaying(false)
    lastFingerprint.current = info.fingerprint
  }, [info])

  /** Builds the proxy. Returns whether it succeeded, so a caller can then play. */
  const render = useCallback(async (): Promise<boolean> => {
    setError(null)
    setRendering(true)
    const result = await window.palmier.preview.render()
    setRendering(false)
    if (!result.ok) {
      setError(result.message)
      setProgress(null)
      return false
    }
    setInfo(result.value)
    return true
  }, [])

  /**
   * Play, building the proxy first if there is none.
   *
   * Asking to play and getting an encode that stops when it finishes is the
   * kind of thing that makes an editor feel unfinished: the intent was to
   * watch it, so it starts as soon as it can.
   */
  const play = useCallback(async () => {
    if (fresh) {
      setPlaying((current) => !current)
      return
    }
    if (await render()) setPlaying(true)
  }, [fresh, render])

  const cancel = useCallback(async () => {
    await window.palmier.preview.cancel()
    setRendering(false)
    setProgress(null)
  }, [])

  void timeline
  return {
    state: { info, fresh, playing, rendering, progress, error } satisfies PlayerState,
    setPlaying,
    play,
    render,
    cancel,
    refresh,
  }
}
