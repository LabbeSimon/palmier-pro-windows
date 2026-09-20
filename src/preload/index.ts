import { contextBridge, ipcRenderer, webUtils } from 'electron'

import type { Project } from '../core/model.js'
import type { Receipt } from '../core/ops.js'
import type { MenuCommand } from '../main/menu.js'
import type { JournalEntry } from '../main/project/store.js'
import type { AgentEvent } from '../main/agent/session.js'
import type { UpdateState } from '../main/updater.js'

export interface Snapshot {
  project: Project
  dirty: boolean
  history: { undo: string[]; redo: string[] }
  journal: JournalEntry[]
  mcp: { running: boolean; endpoint: string | null; error: string | null }
}

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; details?: string }

/** State of the playable timeline proxy. */
export interface PreviewInfo {
  fingerprint: string
  ready: boolean
  rendering: boolean
  url?: string
  startFrame?: number
  totalFrames?: number
  fps?: number
}

export interface RenderProgress {
  frame: number
  totalFrames: number
  fps: number
  speed: string
}

const invoke = <T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> =>
  ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: unknown, payload: T) => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api = {
  project: {
    snapshot: () => invoke<Snapshot>('project:snapshot'),
    create: () => invoke<Snapshot>('project:new'),
    open: (path?: string) => invoke<Snapshot>('project:open', path),
    save: (saveAs?: boolean) => invoke<Snapshot>('project:save', saveAs),
    undo: () => invoke<Snapshot>('project:undo'),
    redo: () => invoke<Snapshot>('project:redo'),
    onChanged: (
      listener: (payload: { project: Project; receipt: Receipt; journal: JournalEntry[] }) => void,
    ) => subscribe('project:changed', listener),
  },
  ops: {
    addClips: (args: unknown) => invoke<Receipt>('ops:addClips', args),
    removeClips: (args: unknown) => invoke<Receipt>('ops:removeClips', args),
    splitClips: (args: unknown) => invoke<Receipt>('ops:splitClips', args),
    moveClips: (args: unknown) => invoke<Receipt>('ops:moveClips', args),
    setClipProperties: (args: unknown) => invoke<Receipt>('ops:setClipProperties', args),
    addTexts: (args: unknown) => invoke<Receipt>('ops:addTexts', args),
    updateText: (args: unknown) => invoke<Receipt>('ops:updateText', args),
    addTrack: (args: unknown) => invoke<Receipt>('ops:addTrack', args),
    removeTrack: (args: unknown) => invoke<Receipt>('ops:removeTrack', args),
    setTrackFlags: (args: unknown) => invoke<Receipt>('ops:setTrackFlags', args),
    addMarkers: (args: unknown) => invoke<Receipt>('ops:addMarkers', args),
    createTimeline: (args: unknown) => invoke<Receipt>('ops:createTimeline', args),
    setActiveTimeline: (args: unknown) => invoke<Receipt>('ops:setActiveTimeline', args),
    setProjectSettings: (args: unknown) => invoke<Receipt>('ops:setProjectSettings', args),
    removeAssets: (args: unknown) => invoke<Receipt>('ops:removeAssets', args),
    shiftClips: (args: unknown) => invoke<Receipt>('ops:shiftClips', args),
    setWorkZone: (args: unknown) => invoke<Receipt>('ops:setWorkZone', args),
    groupClips: (args: unknown) => invoke<Receipt>('ops:groupClips', args),
    ungroupClips: (args: unknown) => invoke<Receipt>('ops:ungroupClips', args),
    trimClip: (args: unknown) => invoke<Receipt>('ops:trimClip', args),
    setKeyframe: (args: unknown) => invoke<Receipt>('ops:setKeyframe', args),
    moveKeyframe: (args: unknown) => invoke<Receipt>('ops:moveKeyframe', args),
    removeKeyframe: (args: unknown) => invoke<Receipt>('ops:removeKeyframe', args),
    addEffect: (args: unknown) => invoke<Receipt>('ops:addEffect', args),
    removeEffect: (args: unknown) => invoke<Receipt>('ops:removeEffect', args),
    setEffectParams: (args: unknown) => invoke<Receipt>('ops:setEffectParams', args),
    setEffectCurve: (args: unknown) => invoke<Receipt>('ops:setEffectCurve', args),
    reorderEffect: (args: unknown) => invoke<Receipt>('ops:reorderEffect', args),
    addTransition: (args: unknown) => invoke<Receipt>('ops:addTransition', args),
    removeTransition: (args: unknown) => invoke<Receipt>('ops:removeTransition', args),
    addSubtitles: (args: unknown) => invoke<Receipt>('ops:addSubtitles', args),
    setAssetProxies: (args: unknown) => invoke<Receipt>('ops:setAssetProxies', args),
    createMulticam: (args: unknown) => invoke<Receipt>('ops:createMulticam', args),
    switchAngle: (args: unknown) => invoke<Receipt>('ops:switchAngle', args),
  },
  agent: {
    settings: () =>
      invoke<{ model: string; hasKey: boolean; models: readonly { id: string; label: string }[] }>(
        'agent:settings',
      ),
    configure: (update: { model?: string; apiKey?: string }) =>
      invoke<{ model: string; hasKey: boolean; models: readonly { id: string; label: string }[] }>(
        'agent:configure',
        update,
      ),
    send: (prompt: string) => invoke<{ done: boolean }>('agent:send', prompt),
    cancel: () => invoke<{ cancelled: boolean }>('agent:cancel'),
    clear: () => invoke<{ cleared: boolean }>('agent:clear'),
    onEvent: (listener: (event: AgentEvent) => void) => subscribe('agent:event', listener),
  },
  update: {
    state: () => invoke<UpdateState>('update:state'),
    check: () => invoke<UpdateState>('update:check'),
    download: () => invoke<UpdateState>('update:download'),
    install: () => invoke<{ installing: boolean }>('update:install'),
    onChanged: (listener: (state: UpdateState) => void) => subscribe('update:state', listener),
  },
  multicam: {
    sync: (assetIds: string[]) =>
      invoke<
        { assetId: string; name: string; offsetSeconds: number; confidence: number; confident: boolean }[]
      >('multicam:sync', assetIds),
  },
  proxies: {
    state: () =>
      invoke<{ total: number; ready: number; building: boolean; width: number }>('proxies:state'),
    build: () => invoke<{ built: number; message: string }>('proxies:build'),
    cancel: () => invoke<{ cancelled: boolean }>('proxies:cancel'),
    clear: () => invoke<{ message: string }>('proxies:clear'),
    onProgress: (
      listener: (progress: { assetId: string; name: string; done: number; total: number }) => void,
    ) => subscribe('proxies:progress', listener),
    onDone: (listener: () => void) => subscribe('proxies:done', listener),
  },
  subtitles: {
    import: (path?: string) =>
      invoke<{ cancelled: boolean; receipt?: Receipt; unusableLines?: string[] }>('subtitles:import', path),
    export: () =>
      invoke<{ cancelled: boolean; path?: string; cues?: number; message?: string }>('subtitles:export'),
  },
  journal: {
    list: () => invoke<JournalEntry[]>('journal:list'),
    revert: (entryId: string) =>
      invoke<{ receipt: Receipt; journal: JournalEntry[] }>('journal:revert', entryId),
  },
  media: {
    import: (paths?: string[]) => invoke<Receipt>('media:import', paths),
    readImage: (path: string) => invoke<string>('media:readImage', path),
    onThumbnail: (listener: (payload: { assetId: string; thumbnailPath: string }) => void) =>
      subscribe('media:thumbnail', listener),
  },
  render: {
    frame: (frame: number) => invoke<string>('render:frame', frame),
    assetFrame: (assetId: string, seconds: number) =>
      invoke<string>('render:assetFrame', { assetId, seconds }),
    export: (args: { outputPath?: string; quality?: 'draft' | 'balanced' | 'high' }) =>
      invoke<{ cancelled: boolean; outputPath?: string }>('render:export', args),
    cancel: () => invoke<{ cancelled: boolean }>('render:cancel'),
    onProgress: (listener: (progress: RenderProgress) => void) => subscribe('render:progress', listener),
  },
  preview: {
    state: () => invoke<PreviewInfo>('preview:state'),
    render: () => invoke<PreviewInfo>('preview:render'),
    cancel: () => invoke<{ cancelled: boolean }>('preview:cancel'),
    onProgress: (listener: (progress: RenderProgress) => void) => subscribe('preview:progress', listener),
    onDone: (listener: () => void) => subscribe('preview:done', listener),
  },
  files: {
    /**
     * Electron 32 removed `File.path`; `webUtils.getPathForFile` is the only
     * way left to turn a dropped File into a real path, and it must be called
     * in the preload because the renderer has no access to it.
     */
    pathFor: (file: File): string => webUtils.getPathForFile(file),
  },
  menu: {
    /** Menu items and their accelerators arrive here and reuse the UI's own handlers. */
    onCommand: (listener: (command: MenuCommand) => void) => subscribe('menu:command', listener),
  },
  system: {
    info: () => invoke<{ ffmpeg: string; electron: string; node: string }>('system:info'),
    reveal: (path: string) => invoke<boolean>('shell:reveal', path),
    copyToClipboard: (text: string) => invoke<boolean>('clipboard:write', text),
    onMcpStatus: (listener: (status: Snapshot['mcp']) => void) => subscribe('mcp:status', listener),
  },
}

export type PalmierApi = typeof api

contextBridge.exposeInMainWorld('palmier', api)
