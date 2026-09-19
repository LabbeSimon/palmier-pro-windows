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
 * The proxy is never rendered automatically. Encoding on every keystroke would
 * burn the machine, so it follows Kdenlive: you ask for it, and the UI says
 * plainly when what you are watching is out of date.
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
    const offProgress = window.palmier.preview.onProgress(setProgress)
    const offDone = window.palmier.preview.onDone(() => {
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

  const render = useCallback(async () => {
    setError(null)
    setRendering(true)
    const result = await window.palmier.preview.render()
    setRendering(false)
    if (!result.ok) {
      setError(result.message)
      setProgress(null)
      return
    }
    setInfo(result.value)
  }, [])

  const cancel = useCallback(async () => {
    await window.palmier.preview.cancel()
    setRendering(false)
    setProgress(null)
  }, [])

  void timeline
  return {
    state: { info, fresh, playing, rendering, progress, error } satisfies PlayerState,
    setPlaying,
    render,
    cancel,
    refresh,
  }
}
