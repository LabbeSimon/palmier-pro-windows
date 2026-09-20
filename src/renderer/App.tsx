import { useCallback, useEffect, useMemo, useState } from 'react'

import { timelineTotalFrames, type Clip } from '../core/model.js'
import type { ClipProperties, EditMode } from '../core/ops.js'
import type { MenuCommand } from '../main/menu.js'
import { AudioMixer } from './components/AudioMixer.js'
import { DropZone } from './components/DropZone.js'
import { EffectsPanel } from './components/EffectsPanel.js'
import { AgentPanel } from './components/AgentPanel.js'
import { SubtitlePanel } from './components/SubtitlePanel.js'
import { subtitleCues } from '../core/ops.js'
import { Inspector } from './components/Inspector.js'
import { MediaPanel } from './components/MediaPanel.js'
import { Monitors } from './components/Monitors.js'
import { Splitter } from './components/Splitter.js'
import { StatusBar } from './components/StatusBar.js'
import { TimelineView, type TimelineTool } from './components/TimelineView.js'
import { Toolbar } from './components/Toolbar.js'
import { useEditor, usePreviewFrame } from './state.js'
import { usePlayer } from './usePlayer.js'

type LeftTab = 'media' | 'effects' | 'subtitles'
type RightTab = 'inspector' | 'mixer' | 'agent'

/** Dock size remembered across sessions, like a Qt application's layout. */
function useStickySize(key: string, fallback: number): [number, (value: number) => void] {
  const [size, setSize] = useState(() => {
    const stored = Number(window.localStorage.getItem(key))
    return Number.isFinite(stored) && stored > 0 ? stored : fallback
  })
  const update = useCallback(
    (value: number) => {
      setSize(value)
      window.localStorage.setItem(key, String(Math.round(value)))
    },
    [key],
  )
  return [size, update]
}

export function App() {
  const { state, run, refresh, setStatus, setExportProgress } = useEditor()
  const [playhead, setPlayhead] = useState(0)
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([])
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)
  const [pixelsPerFrame, setPixelsPerFrame] = useState(2)
  const [exporting, setExporting] = useState(false)
  const [tool, setTool] = useState<TimelineTool>('select')
  const [editMode, setEditMode] = useState<EditMode>('normal')
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [leftTab, setLeftTab] = useState<LeftTab>('media')
  const [rightTab, setRightTab] = useState<RightTab>('inspector')
  // Dock sizes survive restarts, the way a Qt application remembers its layout.
  const [leftWidth, setLeftWidth] = useStickySize('dock.left', 280)
  const [rightWidth, setRightWidth] = useStickySize('dock.right', 300)
  const [timelineHeight, setTimelineHeight] = useStickySize('dock.timeline', 300)

  const { project, timeline } = state
  const timelineId = timeline?.id

  const cues = useMemo(() => (timeline ? subtitleCues(timeline) : []), [timeline])

  const selectedClips = useMemo<Clip[]>(() => {
    if (!timeline) return []
    const ids = new Set(selectedClipIds)
    return timeline.tracks.flatMap((track) => track.clips.filter((clip) => ids.has(clip.id)))
  }, [timeline, selectedClipIds])

  // An agent editing over MCP can delete a clip the UI still has selected.
  useEffect(() => {
    if (selectedClipIds.length === 0 || !timeline) return
    const alive = new Set(timeline.tracks.flatMap((t) => t.clips.map((c) => c.id)))
    const kept = selectedClipIds.filter((id) => alive.has(id))
    if (kept.length !== selectedClipIds.length) setSelectedClipIds(kept)
  }, [timeline, selectedClipIds])

  const totalFrames = timeline ? timelineTotalFrames(timeline) : 0
  const clampedPlayhead = Math.min(playhead, Math.max(0, totalFrames - 1))
  const player = usePlayer(project, timeline)
  // The still frame is only fetched when no proxy can be played; otherwise the
  // video element is the picture and a per-frame FFmpeg call would be waste.
  const preview = usePreviewFrame(project, clampedPlayhead, totalFrames > 0 && !player.state.fresh)

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

  /**
   * Import reports the lines it could not use, which `run` has nowhere to put —
   * a file where half the cues are malformed must not look like a clean import.
   */
  const importSubtitles = useCallback(() => {
    void (async () => {
      const result = await window.palmier.subtitles.import()
      if (!result.ok) {
        setStatus({ text: `${result.code}: ${result.message}`, tone: 'error' })
        return
      }
      const { cancelled, receipt, unusableLines } = result.value
      if (cancelled) return
      await refresh()
      const unusable = unusableLines?.length
        ? ` — ${unusableLines.length} line(s) unusable: ${unusableLines[0]}`
        : ''
      setStatus({ text: `${receipt?.summary ?? 'Imported'}${unusable}`, tone: unusable ? 'info' : 'ok' })
    })()
  }, [refresh, setStatus])

  /** A fresh cue is two seconds long: enough to read, short enough to retime. */
  const addSubtitleAtPlayhead = useCallback(() => {
    if (!timeline) return
    void run(() =>
      window.palmier.ops.addSubtitles({
        timelineId,
        subtitles: [
          { startFrame: playhead, durationFrames: Math.round(timeline.fps * 2), text: 'New subtitle' },
        ],
      }),
    )
  }, [run, timelineId, playhead, timeline])

  const addMarkerAtPlayhead = useCallback(() => {
    if (!timeline) return
    void run(() =>
      window.palmier.ops.addMarkers({
        timelineId,
        markers: [{ startFrame: playhead, name: `Marker ${timeline.markers.length + 1}` }],
      }),
    )
  }, [run, timeline, timelineId, playhead])

  const addEffect = useCallback(
    (definitionId: string, clipIds?: string[]) => {
      const targets = clipIds ?? selectedClipIds
      if (targets.length === 0) {
        setStatus({ text: 'Select a clip first', tone: 'error' })
        return
      }
      void run(() => window.palmier.ops.addEffect({ timelineId, clipIds: targets, definitionId }))
    },
    [run, selectedClipIds, timelineId, setStatus],
  )

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

  const selectAll = useCallback(() => {
    if (!timeline) return
    setSelectedClipIds(timeline.tracks.flatMap((t) => t.clips.map((c) => c.id)))
  }, [timeline])

  // --- Menu: the native menu and its accelerators reuse these same handlers.

  useEffect(() => {
    const off = window.palmier.menu.onCommand((command: MenuCommand) => {
      switch (command) {
        case 'project:new': void run(() => window.palmier.project.create()); break
        case 'project:open': void run(() => window.palmier.project.open()); break
        case 'project:save': void run(() => window.palmier.project.save(false)); break
        case 'project:saveAs': void run(() => window.palmier.project.save(true)); break
        case 'project:export': void exportVideo(); break
        case 'edit:undo': void run(() => window.palmier.project.undo()); break
        case 'edit:redo': void run(() => window.palmier.project.redo()); break
        case 'edit:selectAll': selectAll(); break
        case 'edit:deselect': setSelectedClipIds([]); break
        case 'edit:delete': deleteSelection(false); break
        case 'edit:rippleDelete': deleteSelection(true); break
        case 'edit:group':
          void run(() => window.palmier.ops.groupClips({ timelineId, clipIds: selectedClipIds }))
          break
        case 'edit:ungroup':
          void run(() => window.palmier.ops.ungroupClips({ timelineId, clipIds: selectedClipIds }))
          break
        case 'media:import': void run(() => window.palmier.media.import()); break
        case 'timeline:split': splitAtPlayhead(); break
        case 'timeline:addText': addTextAtPlayhead(); break
        case 'timeline:addMarker': addMarkerAtPlayhead(); break
        case 'timeline:addVideoTrack': void run(() => window.palmier.ops.addTrack({ timelineId, type: 'video' })); break
        case 'timeline:addAudioTrack': void run(() => window.palmier.ops.addTrack({ timelineId, type: 'audio' })); break
        case 'timeline:toggleSnap': setSnapEnabled((on) => !on); break
        case 'timeline:buildPreview': void player.render(); break
        case 'timeline:zoomIn': setPixelsPerFrame((z) => Math.min(40, z * 1.5)); break
        case 'timeline:zoomOut': setPixelsPerFrame((z) => Math.max(0.02, z / 1.5)); break
        case 'timeline:zoomFit': setPixelsPerFrame(totalFrames > 0 ? Math.max(0.02, 1200 / totalFrames) : 2); break
        case 'tool:select': setTool('select'); break
        case 'tool:razor': setTool('razor'); break
        case 'tool:spacer': setTool('spacer'); break
        case 'view:effects': setLeftTab('effects'); break
        case 'view:subtitles': setLeftTab('subtitles'); break
        case 'view:mixer': setRightTab('mixer'); break
        case 'view:inspector': setRightTab('inspector'); break
        case 'view:agent': setRightTab('agent'); break
        case 'playhead:start': setPlayhead(0); break
        case 'playhead:end': setPlayhead(Math.max(0, totalFrames - 1)); break
        case 'help:mcp':
          setStatus({
            text: state.mcp.endpoint
              ? `Point your agent at ${state.mcp.endpoint} — 30 tools available`
              : 'The MCP server is not running',
            tone: state.mcp.running ? 'ok' : 'error',
          })
          break
      }
    })
    return off
  }, [
    run, exportVideo, selectAll, deleteSelection, splitAtPlayhead, addTextAtPlayhead,
    addMarkerAtPlayhead, timelineId, totalFrames, state.mcp, setStatus, selectedClipIds, player,
  ])

  // --- Keyboard: only what the menu does not already own. ------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable) return
      if (event.ctrlKey || event.metaKey || event.altKey) return

      switch (event.key) {
        case ' ':
          event.preventDefault()
          if (player.state.fresh) player.setPlaying(!player.state.playing)
          else void player.render()
          break
        case 'ArrowLeft':
          event.preventDefault()
          setPlayhead((f) => Math.max(0, f - (event.shiftKey ? 10 : 1)))
          break
        case 'ArrowRight':
          event.preventDefault()
          setPlayhead((f) => Math.min(Math.max(0, totalFrames - 1), f + (event.shiftKey ? 10 : 1)))
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [totalFrames, player])

  if (!project || !timeline) {
    return <div className="empty">Loading project…</div>
  }

  const clipCount = project.timelines.reduce(
    (sum, t) => sum + t.tracks.reduce((s, track) => s + track.clips.length, 0),
    0,
  )

  return (
    <div className="app">
      <DropZone onFiles={(paths) => void run(() => window.palmier.media.import(paths))} />
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
        onAddMarker={addMarkerAtPlayhead}
        onExport={() => void exportVideo()}
        onCancelExport={() => void window.palmier.render.cancel()}
        onSelectTimeline={(id) => void run(() => window.palmier.ops.setActiveTimeline({ timelineId: id }))}
      />

      <div
        className="workspace"
        style={{ gridTemplateColumns: `${leftWidth}px auto minmax(0, 1fr) auto ${rightWidth}px` }}
      >
        <div className="panel side">
          <div className="tabs" role="tablist">
            <button
              role="tab"
              aria-selected={leftTab === 'media'}
              className={leftTab === 'media' ? 'on' : ''}
              onClick={() => setLeftTab('media')}
            >
              Project bin
            </button>
            <button
              role="tab"
              aria-selected={leftTab === 'effects'}
              className={leftTab === 'effects' ? 'on' : ''}
              onClick={() => setLeftTab('effects')}
            >
              Effects
            </button>
            <button
              role="tab"
              aria-selected={leftTab === 'subtitles'}
              className={leftTab === 'subtitles' ? 'on' : ''}
              onClick={() => setLeftTab('subtitles')}
            >
              Subtitles
            </button>
          </div>

          {leftTab === 'media' ? (
            <MediaPanel
              assets={project.assets}
              thumbnails={state.thumbnails}
              selectedAssetId={selectedAssetId}
              onSelect={setSelectedAssetId}
              onImport={() => void run(() => window.palmier.media.import())}
              onRemove={(assetId) => void run(() => window.palmier.ops.removeAssets({ assetIds: [assetId] }))}
            />
          ) : leftTab === 'effects' ? (
            <EffectsPanel selectionCount={selectedClipIds.length} onAdd={(id) => addEffect(id)} />
          ) : (
            <SubtitlePanel
              timeline={timeline}
              cues={cues}
              playhead={clampedPlayhead}
              selectedClipIds={selectedClipIds}
              onImport={importSubtitles}
              onExport={() => void run(() => window.palmier.subtitles.export())}
              onAdd={addSubtitleAtPlayhead}
              onSelect={(clipId) => setSelectedClipIds([clipId])}
              onSeek={setPlayhead}
              onEdit={(clipId, content) =>
                void run(() => window.palmier.ops.updateText({ timelineId, clipId, content }))
              }
              onRemove={(clipId) =>
                void run(() => window.palmier.ops.removeClips({ timelineId, clipIds: [clipId] }))
              }
            />
          )}
        </div>

        <Splitter
          orientation="vertical"
          size={leftWidth}
          min={200}
          max={520}
          onResize={setLeftWidth}
          label="Resize the left dock"
        />

        <Monitors
          timeline={timeline}
          frame={clampedPlayhead}
          totalFrames={totalFrames}
          image={preview.image}
          busy={preview.busy}
          error={preview.error}
          empty={totalFrames === 0}
          clipAsset={project.assets.find((a) => a.id === selectedAssetId) ?? null}
          keyframeClip={selectedClips.length === 1 ? selectedClips[0]! : null}
          player={player.state}
          onSeek={setPlayhead}
          onSplit={splitAtPlayhead}
          onSetPlaying={player.setPlaying}
          onRenderPreview={() => void player.render()}
          onCancelRender={() => void player.cancel()}
          onPlaybackError={(message) => setStatus({ text: `Playback: ${message}`, tone: 'error' })}
          onSetKeyframe={(target, frame, value, easing) => {
            const clipId = selectedClipIds[0]
            if (clipId) void run(() => window.palmier.ops.setKeyframe({ timelineId, clipId, target, frame, value, easing }))
          }}
          onMoveKeyframe={(target, fromFrame, toFrame) => {
            const clipId = selectedClipIds[0]
            if (clipId) void run(() => window.palmier.ops.moveKeyframe({ timelineId, clipId, target, fromFrame, toFrame }))
          }}
          onRemoveKeyframe={(target, frame) => {
            const clipId = selectedClipIds[0]
            if (clipId) void run(() => window.palmier.ops.removeKeyframe({ timelineId, clipId, target, frame }))
          }}
        />

        <Splitter
          orientation="vertical"
          size={rightWidth}
          min={220}
          max={560}
          inverted
          onResize={setRightWidth}
          label="Resize the right dock"
        />

        <div className="panel side">
          <div className="tabs" role="tablist">
            <button
              role="tab"
              aria-selected={rightTab === 'inspector'}
              className={rightTab === 'inspector' ? 'on' : ''}
              onClick={() => setRightTab('inspector')}
            >
              Inspector
            </button>
            <button
              role="tab"
              aria-selected={rightTab === 'mixer'}
              className={rightTab === 'mixer' ? 'on' : ''}
              onClick={() => setRightTab('mixer')}
            >
              Mixer
            </button>
            <button
              role="tab"
              aria-selected={rightTab === 'agent'}
              className={rightTab === 'agent' ? 'on' : ''}
              onClick={() => setRightTab('agent')}
            >
              Agent
            </button>
          </div>

          {rightTab === 'inspector' ? (
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
              onSetEffectParams={(clipId, effectId, params) =>
                void run(() => window.palmier.ops.setEffectParams({ timelineId, clipId, effectId, params }))
              }
              onSetEffectCurve={(clipId, effectId, channel, points) =>
                void run(() =>
                  window.palmier.ops.setEffectCurve({ timelineId, clipId, effectId, channel, points }),
                )
              }
              onToggleEffect={(clipId, effectId, enabled) =>
                void run(() => window.palmier.ops.setEffectParams({ timelineId, clipId, effectId, enabled }))
              }
              onRemoveEffect={(clipId, effectId) =>
                void run(() => window.palmier.ops.removeEffect({ timelineId, clipId, effectId }))
              }
              onReorderEffect={(clipId, effectId, toIndex) =>
                void run(() => window.palmier.ops.reorderEffect({ timelineId, clipId, effectId, toIndex }))
              }
              onSetTransition={(clipId, kind, durationFrames) =>
                void run(() => window.palmier.ops.addTransition({ timelineId, clipId, kind, durationFrames }))
              }
              onRemoveTransition={(clipId) =>
                void run(() => window.palmier.ops.removeTransition({ timelineId, clipId }))
              }
              onTrim={(clipId, kind, deltaFrames, edge) =>
                void run(() => window.palmier.ops.trimClip({ timelineId, clipId, kind, deltaFrames, edge }))
              }
            />
          ) : rightTab === 'agent' ? (
            <AgentPanel
              journal={state.journal}
              onRevert={(entryId) =>
                void run(async () => {
                  const result = await window.palmier.journal.revert(entryId)
                  return result.ok ? { ok: true, value: result.value.receipt } : result
                })
              }
              onError={(message) => setStatus({ text: message, tone: 'error' })}
            />
          ) : (
            <div className="panel">
              <div className="panel-title">
                <span>{timeline.tracks.length} tracks</span>
              </div>
              <div className="panel-body">
                <AudioMixer
                  timeline={timeline}
                  onSetGain={(trackId, volume) =>
                    void run(() => window.palmier.ops.setTrackFlags({ timelineId, trackId, volume }))
                  }
                  onToggleMute={(trackId, muted) =>
                    void run(() => window.palmier.ops.setTrackFlags({ timelineId, trackId, muted }))
                  }
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <Splitter
        orientation="horizontal"
        size={timelineHeight}
        min={160}
        max={640}
        inverted
        onResize={setTimelineHeight}
        label="Resize the timeline"
      />

      <TimelineView
        height={timelineHeight}
        timeline={timeline}
        assets={project.assets}
        thumbnails={state.thumbnails}
        playhead={playhead}
        selectedClipIds={selectedClipIds}
        pixelsPerFrame={pixelsPerFrame}
        tool={tool}
        snapEnabled={snapEnabled}
        onScrub={setPlayhead}
        onSelect={setSelectedClipIds}
        onZoom={setPixelsPerFrame}
        onSetTool={setTool}
        onToggleSnap={() => setSnapEnabled((on) => !on)}
        onSetWorkZone={(inFrame, outFrame) =>
          void run(() => window.palmier.ops.setWorkZone({ timelineId, inFrame, outFrame }))
        }
        onMoveClip={(clipId, startFrame, trackId) =>
          void run(() => window.palmier.ops.moveClips({ timelineId, moves: [{ clipId, startFrame, trackId }] }))
        }
        editMode={editMode}
        onSetEditMode={setEditMode}
        onDropAsset={(assetId, trackId, startFrame) =>
          void run(() =>
            window.palmier.ops.addClips({
              timelineId,
              clips: [{ assetId, trackId, startFrame }],
              mode: editMode,
            }),
          )
        }
        onDropEffect={(definitionId, clipId) => addEffect(definitionId, [clipId])}
        onRazor={(_trackId, frame) => void run(() => window.palmier.ops.splitClips({ timelineId, frame }))}
        onSpacer={(trackId, fromFrame, deltaFrames) =>
          void run(() => window.palmier.ops.shiftClips({ timelineId, trackId, fromFrame, deltaFrames }))
        }
        onToggleTrack={(trackId, field) => {
          const track = timeline.tracks.find((t) => t.id === trackId)
          if (!track) return
          void run(() => window.palmier.ops.setTrackFlags({ timelineId, trackId, [field]: !track[field] }))
        }}
        onRenameTrack={(trackId, name) =>
          void run(() => window.palmier.ops.setTrackFlags({ timelineId, trackId, name }))
        }
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
