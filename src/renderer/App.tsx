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
import { Dock, type DockPanel, type DockSide } from './components/Dock.js'
import { Splitter } from './components/Splitter.js'
import { StatusBar } from './components/StatusBar.js'
import { TimelineView, type TimelineTool } from './components/TimelineView.js'
import { Toolbar } from './components/Toolbar.js'
import { useEditor, usePreviewFrame } from './state.js'
import { usePlayer } from './usePlayer.js'

type PanelId = 'media' | 'effects' | 'subtitles' | 'inspector' | 'mixer' | 'agent'

/** Where each panel starts out, matching Kdenlive's default arrangement. */
const DEFAULT_LAYOUT: Record<PanelId, DockSide> = {
  media: 'left',
  effects: 'left',
  subtitles: 'left',
  inspector: 'right',
  mixer: 'right',
  agent: 'right',
}

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

const LAYOUT_KEY = 'dock.layout'

/** Width of a dock with nothing in it — enough to aim a tab at. */
const EMPTY_DOCK_WIDTH = 34

/**
 * Which dock each panel sits in, remembered between sessions the way a Qt
 * application remembers its arrangement.
 *
 * An unknown or missing entry falls back to the default rather than vanishing:
 * a panel added in a later version must still appear for someone who has
 * already rearranged theirs.
 */
function useStickyLayout(): [
  Record<string, DockSide>,
  (update: (current: Record<string, DockSide>) => Record<string, DockSide>) => void,
] {
  const [layout, setLayout] = useState<Record<string, DockSide>>(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) ?? '{}') as Record<string, DockSide>
      return { ...DEFAULT_LAYOUT, ...stored }
    } catch {
      return { ...DEFAULT_LAYOUT }
    }
  })

  const update = useCallback(
    (fn: (current: Record<string, DockSide>) => Record<string, DockSide>) => {
      setLayout((current) => {
        const next = fn(current)
        window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(next))
        return next
      })
    },
    [],
  )
  return [layout, update]
}

export function App() {
  const { state, run, refresh, setStatus, setExportProgress } = useEditor()
  const [playhead, setPlayhead] = useState(0)
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([])
  /**
   * Bin selection. The last entry is the "current" one the clip monitor shows;
   * the rest exist so several angles can be picked for a multicam set.
   */
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([])
  const selectedAssetId = selectedAssetIds.at(-1) ?? null
  const [pixelsPerFrame, setPixelsPerFrame] = useState(2)
  const [exporting, setExporting] = useState(false)
  const [tool, setTool] = useState<TimelineTool>('select')
  const [editMode, setEditMode] = useState<EditMode>('normal')
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [leftTab, setLeftTab] = useState<string>('media')
  const [rightTab, setRightTab] = useState<string>('inspector')
  const [layout, setLayout] = useStickyLayout()

  /**
   * Moves a panel to the other dock and brings it to the front there.
   *
   * Arriving behind whatever was already showing would look like the drag had
   * done nothing at all.
   */
  const movePanel = useCallback(
    (panelId: string, side: DockSide) => {
      setLayout((current) => ({ ...current, [panelId]: side }))
      if (side === 'left') setLeftTab(panelId)
      else setRightTab(panelId)
    },
    [setLayout],
  )

  /** Brings a panel forward wherever it currently lives. */
  const showPanel = useCallback(
    (panelId: PanelId) => {
      if (layout[panelId] === 'left') setLeftTab(panelId)
      else setRightTab(panelId)
    },
    [layout],
  )
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

  /** The selected clip, when it is one and it has angles. */
  const multicamClip = useMemo<Clip | null>(
    () => (selectedClips.length === 1 && selectedClips[0]!.multicam ? selectedClips[0]! : null),
    [selectedClips],
  )

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

  /**
   * Builds a multicam set from the bin selection, measuring the offsets first.
   *
   * The measurement is reported with its confidence rather than applied
   * silently: a weak peak means the cameras may not be lined up, and finding
   * that out from a wrong cut much later is far worse than a sentence here.
   */
  const createMulticam = useCallback(
    (assetIds: string[]) => {
      void (async () => {
        setStatus({ text: `Listening to ${assetIds.length} angles…`, tone: 'info' })
        const sync = await window.palmier.multicam.sync(assetIds)
        if (!sync.ok) {
          setStatus({ text: `${sync.code}: ${sync.message}`, tone: 'error' })
          return
        }
        const fps = timeline?.fps ?? 30
        const angles = sync.value.map((result) => ({
          assetId: result.assetId,
          offsetFrames: Math.round(result.offsetSeconds * fps),
        }))
        const unsure = sync.value.filter((result) => !result.confident)

        const receipt = await run(() =>
          window.palmier.ops.createMulticam({ timelineId, angles, startFrame: playhead }),
        )
        if (receipt && unsure.length > 0) {
          setStatus({
            text:
              `${receipt.summary} — but the sync is uncertain for ` +
              `${unsure.map((result) => `${result.name} (${result.confidence})`).join(', ')}. Check a cut.`,
            tone: 'info',
          })
        }
      })()
    },
    [run, setStatus, timeline, timelineId, playhead],
  )

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
        case 'view:effects': showPanel('effects'); break
        case 'view:subtitles': showPanel('subtitles'); break
        case 'view:resetLayout':
          setLayout(() => ({ ...DEFAULT_LAYOUT }))
          setLeftTab('media')
          setRightTab('inspector')
          setStatus({ text: 'Panels back where they started', tone: 'ok' })
          break
        case 'view:mixer': showPanel('mixer'); break
        case 'view:inspector': showPanel('inspector'); break
        case 'view:agent': showPanel('agent'); break
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
    showPanel, setLayout,
  ])

  // --- Keyboard: only what the menu does not already own. ------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return

      // 1-9 cut to that camera, the way every multicam editor works. Only when
      // the selected clip has angles, so the keys stay free otherwise.
      if (/^[1-9]$/.test(event.key) && multicamClip) {
        event.preventDefault()
        void run(() =>
          window.palmier.ops.switchAngle({
            timelineId,
            clipId: multicamClip.id,
            angleIndex: Number(event.key) - 1,
            frame: playhead,
          }),
        )
        return
      }

      switch (event.key) {
        case ' ':
          event.preventDefault()
          void player.play()
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
  }, [totalFrames, player, multicamClip, run, timelineId, playhead])

  if (!project || !timeline) {
    return <div className="empty">Loading project…</div>
  }

  /**
   * Every dockable panel, with where it currently lives.
   *
   * The content is built lazily per render so a panel keeps working wherever
   * it is dragged — nothing about these bodies knows which dock it is in.
   */
  const PANELS: DockPanel[] = [
    {
      id: 'media',
      label: 'Project bin',
      render: () => (
          <MediaPanel
            assets={project.assets}
            thumbnails={state.thumbnails}
            selectedAssetIds={selectedAssetIds}
            onSelect={(assetId, additive) =>
              setSelectedAssetIds((current) =>
                additive
                  ? current.includes(assetId)
                    ? current.filter((id) => id !== assetId)
                    : [...current, assetId]
                  : [assetId],
              )
            }
            onMulticam={createMulticam}
            onImport={() => void run(() => window.palmier.media.import())}
            onRemove={(assetId) => void run(() => window.palmier.ops.removeAssets({ assetIds: [assetId] }))}
            onError={(message) => setStatus({ text: message, tone: 'error' })}
            onDone={(message) => {
              setStatus({ text: message, tone: 'ok' })
              void refresh()
            }}
          />
      ),
    },
    {
      id: 'effects',
      label: 'Effects',
      render: () => (
          <EffectsPanel selectionCount={selectedClipIds.length} onAdd={(id) => addEffect(id)} />
      ),
    },
    {
      id: 'subtitles',
      label: 'Subtitles',
      render: () => (
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
      ),
    },
    {
      id: 'inspector',
      label: 'Inspector',
      render: () => (
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
            playhead={clampedPlayhead}
            onSwitchAngle={(clipId, angleIndex, frame) =>
              void run(() => window.palmier.ops.switchAngle({ timelineId, clipId, angleIndex, frame }))
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
      ),
    },
    {
      id: 'mixer',
      label: 'Mixer',
      render: () => (
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
      ),
    },
    {
      id: 'agent',
      label: 'Agent',
      render: () => (
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
      ),
    },
  ]

  const panelsFor = (side: DockSide) => PANELS.filter((panel) => layout[panel.id] === side)

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
        // An emptied dock keeps a narrow strip rather than disappearing: with
        // nowhere to drop a tab, a panel dragged out would be unreachable.
        style={{
          gridTemplateColumns:
            `${panelsFor('left').length > 0 ? leftWidth : EMPTY_DOCK_WIDTH}px auto ` +
            `minmax(0, 1fr) auto ` +
            `${panelsFor('right').length > 0 ? rightWidth : EMPTY_DOCK_WIDTH}px`,
        }}
      >
        <Dock
          side="left"
          panels={panelsFor('left')}
          activeId={leftTab}
          onActivate={setLeftTab}
          onAdopt={(panelId) => movePanel(panelId, 'left')}
        />

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
          onPlay={() => void player.play()}
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

        <Dock
          side="right"
          panels={panelsFor('right')}
          activeId={rightTab}
          onActivate={setRightTab}
          onAdopt={(panelId) => movePanel(panelId, 'right')}
        />
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
