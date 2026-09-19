import { useCallback, useEffect, useMemo, useState } from 'react'

import { timelineTotalFrames, type Clip } from '../core/model.js'
import type { ClipProperties } from '../core/ops.js'
import { Inspector } from './components/Inspector.js'
import { MediaPanel } from './components/MediaPanel.js'
import { Preview } from './components/Preview.js'
import { StatusBar } from './components/StatusBar.js'
import { TimelineView } from './components/TimelineView.js'
import { Toolbar } from './components/Toolbar.js'
import { useEditor, usePreviewFrame } from './state.js'

export function App() {
  const { state, run, setStatus, setExportProgress } = useEditor()
  const [playhead, setPlayhead] = useState(0)
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([])
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)
  const [pixelsPerFrame, setPixelsPerFrame] = useState(2)
  const [exporting, setExporting] = useState(false)

  const { project, timeline } = state
  const timelineId = timeline?.id

  const selectedClips = useMemo<Clip[]>(() => {
    if (!timeline) return []
    const ids = new Set(selectedClipIds)
    return timeline.tracks.flatMap((track) => track.clips.filter((clip) => ids.has(clip.id)))
  }, [timeline, selectedClipIds])

  // A selection can be invalidated by an agent edit arriving over MCP.
  useEffect(() => {
    if (selectedClipIds.length === 0 || !timeline) return
    const alive = new Set(timeline.tracks.flatMap((t) => t.clips.map((c) => c.id)))
    const kept = selectedClipIds.filter((id) => alive.has(id))
    if (kept.length !== selectedClipIds.length) setSelectedClipIds(kept)
  }, [timeline, selectedClipIds])

  const totalFrames = timeline ? timelineTotalFrames(timeline) : 0
  const preview = usePreviewFrame(project, Math.min(playhead, Math.max(0, totalFrames - 1)), totalFrames > 0)

  // --- Actions ------------------------------------------------------------

  const applyToSelection = useCallback(
    (properties: ClipProperties) => {
      if (selectedClipIds.length === 0) return
      void run(() => window.palmier.ops.setClipProperties({ timelineId, clipIds: selectedClipIds, properties }))
    },
    [run, selectedClipIds, timelineId],
  )

  const deleteSelection = useCallback(
    (ripple: boolean) => {
      if (selectedClipIds.length === 0) return
      void run(() => window.palmier.ops.removeClips({ timelineId, clipIds: selectedClipIds, ripple }))
      setSelectedClipIds([])
    },
    [run, selectedClipIds, timelineId],
  )

  const splitAtPlayhead = useCallback(() => {
    void run(() => window.palmier.ops.splitClips({ timelineId, frame: playhead }))
  }, [run, timelineId, playhead])

  const addTextAtPlayhead = useCallback(() => {
    if (!timeline) return
    void run(() =>
      window.palmier.ops.addTexts({
        timelineId,
        texts: [{ content: 'New title', startFrame: playhead, durationFrames: timeline.fps * 3 }],
      }),
    )
  }, [run, timeline, timelineId, playhead])

  const exportVideo = useCallback(async () => {
    setExporting(true)
    setStatus({ text: 'Export started…', tone: 'info' })
    const result = await window.palmier.render.export({ quality: 'balanced' })
    setExporting(false)
    setExportProgress(null)
    if (!result.ok) {
      setStatus({ text: `${result.code}: ${result.message}`, tone: 'error' })
      return
    }
    if (result.value.cancelled || !result.value.outputPath) {
      setStatus({ text: 'Export cancelled', tone: 'info' })
      return
    }
    setStatus({ text: `Exported to ${result.value.outputPath}`, tone: 'ok' })
    void window.palmier.system.reveal(result.value.outputPath)
  }, [setStatus, setExportProgress])

  // --- Keyboard -----------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable) return

      if (event.ctrlKey && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        void run(() => (event.shiftKey ? window.palmier.project.redo() : window.palmier.project.undo()))
        return
      }
      if (event.ctrlKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void run(() => window.palmier.project.save(false))
        return
      }
      switch (event.key) {
        case 's':
        case 'S':
          splitAtPlayhead()
          break
        case 'Delete':
        case 'Backspace':
          event.preventDefault()
          deleteSelection(event.shiftKey)
          break
        case 'ArrowLeft':
          event.preventDefault()
          setPlayhead((f) => Math.max(0, f - (event.shiftKey ? 10 : 1)))
          break
        case 'ArrowRight':
          event.preventDefault()
          setPlayhead((f) => Math.min(Math.max(0, totalFrames - 1), f + (event.shiftKey ? 10 : 1)))
          break
        case 'Home':
          setPlayhead(0)
          break
        case 'End':
          setPlayhead(Math.max(0, totalFrames - 1))
          break
        case 'Escape':
          setSelectedClipIds([])
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [run, splitAtPlayhead, deleteSelection, totalFrames])

  if (!project || !timeline) {
    return <div className="empty">Loading project…</div>
  }

  const clipCount = project.timelines.reduce(
    (sum, t) => sum + t.tracks.reduce((s, track) => s + track.clips.length, 0),
    0,
  )

  return (
    <div className="app">
      <Toolbar
        project={project}
        timeline={timeline}
        dirty={state.dirty}
        playhead={playhead}
        canUndo={state.history.undo.length > 0}
        canRedo={state.history.redo.length > 0}
        selectedClipIds={selectedClipIds}
        exporting={exporting}
        onNew={() => void run(() => window.palmier.project.create())}
        onOpen={() => void run(() => window.palmier.project.open())}
        onSave={(saveAs) => void run(() => window.palmier.project.save(saveAs))}
        onImport={() => void run(() => window.palmier.media.import())}
        onUndo={() => void run(() => window.palmier.project.undo())}
        onRedo={() => void run(() => window.palmier.project.redo())}
        onSplit={splitAtPlayhead}
        onDelete={deleteSelection}
        onAddText={addTextAtPlayhead}
        onExport={() => void exportVideo()}
        onCancelExport={() => void window.palmier.render.cancel()}
        onSelectTimeline={(id) => void run(() => window.palmier.ops.setActiveTimeline({ timelineId: id }))}
      />

      <div className="workspace">
        <MediaPanel
          assets={project.assets}
          thumbnails={state.thumbnails}
          selectedAssetId={selectedAssetId}
          onSelect={setSelectedAssetId}
          onImport={() => void run(() => window.palmier.media.import())}
          onRemove={(assetId) => void run(() => window.palmier.ops.removeAssets({ assetIds: [assetId] }))}
        />

        <Preview
          timeline={timeline}
          frame={Math.min(playhead, Math.max(0, totalFrames - 1))}
          image={preview.image}
          busy={preview.busy}
          error={preview.error}
          empty={totalFrames === 0}
        />

        <Inspector
          timeline={timeline}
          clips={selectedClips}
          assets={project.assets}
          onApply={applyToSelection}
          onUpdateText={(clipId, content) =>
            void run(() => window.palmier.ops.updateText({ timelineId, clipId, content }))
          }
          onSetTimelineSettings={(settings) =>
            void run(() => window.palmier.ops.setProjectSettings({ timelineId, ...settings }))
          }
        />
      </div>

      <TimelineView
        timeline={timeline}
        assets={project.assets}
        playhead={playhead}
        selectedClipIds={selectedClipIds}
        pixelsPerFrame={pixelsPerFrame}
        onScrub={setPlayhead}
        onSelect={setSelectedClipIds}
        onZoom={setPixelsPerFrame}
        onMoveClip={(clipId, startFrame, trackId) =>
          void run(() => window.palmier.ops.moveClips({ timelineId, moves: [{ clipId, startFrame, trackId }] }))
        }
        onDropAsset={(assetId, trackId, startFrame) =>
          void run(() => window.palmier.ops.addClips({ timelineId, clips: [{ assetId, trackId, startFrame }] }))
        }
        onToggleTrack={(trackId, field) => {
          const track = timeline.tracks.find((t) => t.id === trackId)
          if (!track) return
          void run(() => window.palmier.ops.setTrackFlags({ timelineId, trackId, [field]: !track[field] }))
        }}
        onAddTrack={(type) => void run(() => window.palmier.ops.addTrack({ timelineId, type }))}
      />

      <StatusBar
        mcp={state.mcp}
        status={state.status}
        progress={state.exportProgress}
        clipCount={clipCount}
        assetCount={project.assets.length}
      />
    </div>
  )
}
