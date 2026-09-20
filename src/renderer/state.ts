import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { activeTimeline, type Project, type Timeline } from '../core/model.js'
import type { Receipt } from '../core/ops.js'
import type { IpcResult, RenderProgress, Snapshot } from '../preload/index.js'
import type { JournalEntry } from '../main/project/store.js'

export interface StatusMessage {
  text: string
  tone: 'info' | 'ok' | 'error'
}

export interface EditorState {
  project: Project | null
  timeline: Timeline | null
  dirty: boolean
  history: { undo: string[]; redo: string[] }
  journal: JournalEntry[]
  mcp: Snapshot['mcp']
  status: StatusMessage | null
  thumbnails: Record<string, string>
  exportProgress: RenderProgress | null
}

/**
 * The renderer holds a read-only mirror of the main-process store. `run` is the
 * only way it mutates anything, so every refusal surfaces in the status bar
 * instead of silently diverging from the real project state.
 */
export function useEditor() {
  const [state, setState] = useState<EditorState>({
    project: null,
    timeline: null,
    dirty: false,
    history: { undo: [], redo: [] },
    journal: [],
    mcp: { running: false, endpoint: null, error: null },
    status: null,
    thumbnails: {},
    exportProgress: null,
  })

  const applySnapshot = useCallback((snapshot: Snapshot) => {
    setState((prev) => ({
      ...prev,
      project: snapshot.project,
      timeline: activeTimeline(snapshot.project),
      dirty: snapshot.dirty,
      history: snapshot.history,
      journal: snapshot.journal,
      mcp: snapshot.mcp,
    }))
  }, [])

  const refresh = useCallback(async () => {
    const result = await window.palmier.project.snapshot()
    if (result.ok) applySnapshot(result.value)
  }, [applySnapshot])

  useEffect(() => {
    void refresh()
    // Edits made over MCP land here too, so the UI follows the agent live.
    const offChanged = window.palmier.project.onChanged(() => void refresh())
    const offThumbnail = window.palmier.media.onThumbnail(({ assetId, thumbnailPath }) => {
      void window.palmier.media.readImage(thumbnailPath).then((result) => {
        if (result.ok) setState((prev) => ({ ...prev, thumbnails: { ...prev.thumbnails, [assetId]: result.value } }))
      })
    })
    const offMcp = window.palmier.system.onMcpStatus((mcp) => setState((prev) => ({ ...prev, mcp })))
    const offProgress = window.palmier.render.onProgress((exportProgress) =>
      setState((prev) => ({ ...prev, exportProgress })),
    )
    return () => {
      offChanged()
      offThumbnail()
      offMcp()
      offProgress()
    }
  }, [refresh])

  const setStatus = useCallback((status: StatusMessage | null) => {
    setState((prev) => ({ ...prev, status }))
  }, [])

  /** Unwraps an IPC result: success refreshes and reports, failure goes to the status bar. */
  const run = useCallback(
    async <T,>(action: () => Promise<IpcResult<T>>, describe?: (value: T) => string): Promise<T | null> => {
      const result = await action()
      if (!result.ok) {
        setStatus({ text: `${result.code}: ${result.message}`, tone: 'error' })
        return null
      }
      await refresh()
      // Mutations return a Receipt (`summary`); project-level actions return a
      // snapshot with `message`. Without the second branch, New project looked
      // like a dead button.
      const payload = result.value as unknown as Partial<Receipt> & { message?: string }
      const text =
        describe?.(result.value) ??
        (typeof payload?.summary === 'string' ? payload.summary : null) ??
        (typeof payload?.message === 'string' ? payload.message : null)
      if (text) setStatus({ text, tone: 'ok' })
      return result.value
    },
    [refresh, setStatus],
  )

  const setExportProgress = useCallback((exportProgress: RenderProgress | null) => {
    setState((prev) => ({ ...prev, exportProgress }))
  }, [])

  return { state, run, refresh, setStatus, setExportProgress }
}

/** Re-renders a preview frame when the timeline or playhead changes, coalescing bursts. */
export function usePreviewFrame(project: Project | null, frame: number, enabled: boolean) {
  const [image, setImage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  // A structural fingerprint: scrubbing must re-render, but an unrelated
  // asset-list change must not.
  const fingerprint = useMemo(() => {
    if (!project) return ''
    const timeline = project.timelines.find((t) => t.id === project.activeTimelineId)
    return JSON.stringify(timeline)
  }, [project])

  useEffect(() => {
    if (!enabled || !project) return
    const id = ++generation.current
    const timer = setTimeout(async () => {
      setBusy(true)
      const result = await window.palmier.render.frame(frame)
      // A stale response must never overwrite a newer frame.
      if (id !== generation.current) return
      setBusy(false)
      if (result.ok) {
        setImage(result.value)
        setError(null)
      } else {
        setError(result.message)
      }
    }, 180)
    return () => clearTimeout(timer)
  }, [fingerprint, frame, enabled, project])

  return { image, busy, error }
}
